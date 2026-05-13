import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  OPENCLAW_AGENT_CAPABILITIES,
  OPENCLAW_THINKING_LEVELS,
  type AgentCreateOptions,
  type AgentFastModeResult,
  type AgentHandbackResult,
  type AgentLaunchProfileRecord,
  type AgentModelRecord,
  type AgentPromptInput,
  type AgentSessionCallbacks,
  type AgentSessionInfo,
  type AgentSessionService,
  type AgentSettingResult,
  type AgentSyncResult,
  type AgentThreadRecord,
} from "./agent.js";
import type { CodexLaunchProfile } from "./codex-launch.js";
import type { ConnectorConfig } from "./config.js";
import { OpenClawGatewayClient, extractOpenClawOutputText, type OpenClawGatewayEvent } from "./openclaw-gateway.js";
import {
  findOpenClawLaunchProfile,
  listOpenClawLaunchProfiles,
  openClawProfileAsLaunchProfile,
  type OpenClawLaunchProfile,
} from "./openclaw-launch.js";
import { resolveOpenClawCli } from "./openclaw-cli.js";
import {
  getOpenClawSession,
  listOpenClawSessions,
  listOpenClawWorkspaces,
  type OpenClawSessionRecord,
} from "./openclaw-state.js";

type OpenTool = {
  id: string;
  name: string;
};

export class OpenClawSessionService implements AgentSessionService {
  private readonly cliPath?: string;
  private currentWorkspace: string;
  private currentThreadId: string | null = null;
  private currentModel: string | undefined;
  private currentThinking: string | undefined;
  private currentLaunchProfile: OpenClawLaunchProfile;
  private currentOpenClawAgentId: string;
  private cachedModels: AgentModelRecord[] = [];
  private cachedUsage: AgentSessionInfo["sessionUsage"];
  private processing = false;
  private abortController: AbortController | null = null;
  private currentGateway: OpenClawGatewayClient | null = null;
  private currentRunId: string | null = null;
  private modelsLoadedAt = 0;
  private lastStateRefreshAt = 0;

  private static readonly MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
  private static readonly STATE_CACHE_TTL_MS = 5_000;

  private constructor(private readonly config: ConnectorConfig) {
    this.cliPath = resolveOpenClawCli(process.env, config.openClawCliPath).path;
    this.currentWorkspace = config.workspace;
    this.currentModel = config.openClawDefaultModel;
    this.currentThinking = config.openClawDefaultThinking;
    this.currentLaunchProfile = findOpenClawLaunchProfile(config.openClawDefaultLaunchProfileId);
    this.currentOpenClawAgentId = config.openClawAgentId;
  }

  static async create(config: ConnectorConfig, options?: AgentCreateOptions): Promise<OpenClawSessionService> {
    const service = new OpenClawSessionService(config);
    service.currentWorkspace = options?.workspace ?? config.workspace;
    service.currentModel = options?.model ?? config.openClawDefaultModel;
    service.currentThinking = normalizeOpenClawThinking(options?.reasoningEffort ?? config.openClawDefaultThinking);
    service.currentLaunchProfile = findOpenClawLaunchProfile(options?.launchProfileId ?? config.openClawDefaultLaunchProfileId);
    await service.refreshModels().catch(() => {});

    if (options?.resumeThreadId) {
      await service.resumeThread(options.resumeThreadId);
      return service;
    }
    if (!options?.deferThreadStart) {
      await service.newThread(service.currentWorkspace, service.currentModel);
    }
    return service;
  }

  getInfo(): AgentSessionInfo {
    this.refreshFromState();
    return {
      agentId: "openclaw",
      agentLabel: "OpenClaw",
      threadId: this.currentThreadId,
      workspace: this.currentWorkspace,
      model: this.currentModel,
      reasoningEffort: this.currentThinking,
      launchProfileId: this.currentLaunchProfile.id,
      launchProfileLabel: this.currentLaunchProfile.label,
      launchProfileBehavior: this.currentLaunchProfile.behavior,
      sandboxMode: "host",
      approvalPolicy: "never",
      fastMode: false,
      unsafeLaunch: this.currentLaunchProfile.unsafe,
      sessionUsage: this.cachedUsage,
      capabilities: OPENCLAW_AGENT_CAPABILITIES,
    };
  }

  isProcessing(): boolean {
    return this.processing;
  }

  getActiveThreadId(): string | null {
    return this.currentThreadId;
  }

  hasActiveThread(): boolean {
    return Boolean(this.currentThreadId);
  }

  getCurrentWorkspace(): string {
    return this.currentWorkspace;
  }

  async prompt(input: AgentPromptInput, callbacks: AgentSessionCallbacks): Promise<void> {
    if (this.processing) {
      throw new Error("An OpenClaw turn is already in progress");
    }
    await this.ensureSessionStarted();

    const threadId = this.currentThreadId!;
    const prompt = await this.buildPrompt(input);
    const attachments = await this.buildAttachments(input);
    const abortController = new AbortController();
    const gateway = this.createGatewayClient();
    const openTools = new Map<string, OpenTool[]>();
    let streamedOutput = "";
    let didEnd = false;
    let toolCounter = 0;

    this.processing = true;
    this.abortController = abortController;
    this.currentGateway = gateway;

    try {
      const result = await gateway.runAgent({
        message: prompt,
        sessionId: threadId,
        agentId: this.currentOpenClawAgentId,
        model: this.currentModel,
        thinking: this.currentThinking,
        workspace: this.currentWorkspace,
        local: this.currentLaunchProfile.local,
        deliver: this.currentLaunchProfile.deliver,
        instructions: this.currentLaunchProfile.instructions,
        attachments,
        onRunId: (runId) => {
          this.currentRunId = runId;
        },
      }, (event) => {
        const eventName = stringValue(event.event) ?? stringValue(event.type);
        const payload = objectValue(event.payload) ?? event;
        switch (eventName) {
          case "agent.delta":
          case "message.delta":
          case "session.message.delta": {
            const delta = stringValue(payload.delta) ?? stringValue(payload.text_delta) ?? stringValue(payload.text);
            if (delta) {
              streamedOutput += delta;
              callbacks.onTextDelta(delta);
            }
            break;
          }
          case "session.message":
          case "agent.message": {
            const text = extractOpenClawOutputText(payload);
            const delta = computeTextDelta(streamedOutput, text ?? "");
            if (delta) {
              streamedOutput += delta;
              callbacks.onTextDelta(delta);
            }
            break;
          }
          case "session.tool":
          case "tool.started":
          case "tool.start": {
            const toolName = stringValue(payload.toolName) ?? stringValue(payload.tool_name) ?? stringValue(payload.tool) ?? "tool";
            const status = stringValue(payload.status);
            const toolCallId = stringValue(payload.toolCallId) ?? stringValue(payload.tool_call_id);
            if (status && /complete|finish|done/i.test(status)) {
              const openTool = openTools.get(toolName)?.shift();
              if (openTool) callbacks.onToolEnd(openTool.id, Boolean(payload.error));
              break;
            }
            toolCounter += 1;
            const toolId = toolCallId ?? `${threadId}-${toolName}-${toolCounter}`;
            const openTool = { id: toolId, name: toolName };
            const tools = openTools.get(toolName) ?? [];
            tools.push(openTool);
            openTools.set(toolName, tools);
            callbacks.onToolStart(toolName, toolId);
            const preview = stringValue(payload.preview) ?? stringValue(payload.text);
            if (preview) callbacks.onToolUpdate(toolId, preview);
            break;
          }
          case "tool.completed":
          case "tool.finished": {
            const toolName = stringValue(payload.toolName) ?? stringValue(payload.tool_name) ?? stringValue(payload.tool) ?? "tool";
            const openTool = openTools.get(toolName)?.shift();
            if (openTool) callbacks.onToolEnd(openTool.id, Boolean(payload.error));
            break;
          }
          case "agent.completed":
          case "run.completed": {
            const finalText = extractOpenClawOutputText(payload);
            const delta = computeTextDelta(streamedOutput, finalText ?? "");
            if (delta) callbacks.onTextDelta(delta);
            const usage = objectValue(payload.usage);
            callbacks.onTurnComplete?.({
              inputTokens: numberValue(usage?.inputTokens) ?? numberValue(usage?.input_tokens) ?? 0,
              cachedInputTokens: numberValue(usage?.cachedInputTokens) ?? numberValue(usage?.cached_input_tokens) ?? 0,
              outputTokens: numberValue(usage?.outputTokens) ?? numberValue(usage?.output_tokens) ?? 0,
            });
            didEnd = true;
            callbacks.onAgentEnd();
            break;
          }
          default:
            break;
        }
      }, abortController.signal);

      this.currentRunId = result.runId;
      if (result.text && !streamedOutput.trim()) {
        callbacks.onTextDelta(result.text);
      }
      this.cachedUsage = usageFromGatewayResult(result.usage ?? result.payload.usage);
      if (!didEnd) {
        callbacks.onAgentEnd();
      }
      this.refreshFromState({ force: true });
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error("OpenClaw run was aborted");
      }
      throw error;
    } finally {
      this.currentRunId = null;
      this.currentGateway = null;
      this.abortController = null;
      this.processing = false;
      gateway.close();
    }
  }

  async abort(): Promise<void> {
    if (this.currentRunId && this.currentGateway) {
      await this.currentGateway.cancelRun(this.currentRunId).catch(() => {});
    }
    this.abortController?.abort();
    this.processing = false;
  }

  async newThread(workspace?: string, model?: string): Promise<AgentSessionInfo> {
    this.ensureIdle("start a new OpenClaw session");
    this.currentWorkspace = workspace ?? this.currentWorkspace;
    if (model) {
      this.currentModel = model;
    }
    this.currentThreadId = createOpenClawSessionId();
    this.cachedUsage = undefined;
    this.lastStateRefreshAt = Date.now();
    return this.getInfo();
  }

  async resumeThread(threadId: string): Promise<AgentSessionInfo> {
    return this.switchSession(threadId);
  }

  async switchSession(threadId: string): Promise<AgentSessionInfo> {
    this.ensureIdle("switch OpenClaw session");
    const record = this.getRecord(threadId);
    if (!record) {
      throw new Error(`Unknown OpenClaw session: ${threadId}`);
    }
    this.applyRecord(record);
    this.lastStateRefreshAt = Date.now();
    return this.getInfo();
  }

  listAllSessions(limit?: number): AgentThreadRecord[] {
    return listOpenClawSessions(limit ?? 20, this.stateOptions());
  }

  listWorkspaces(): string[] {
    const workspaces = new Set(listOpenClawWorkspaces(this.stateOptions()));
    workspaces.add(this.currentWorkspace);
    workspaces.add(this.config.workspace);
    return [...workspaces].sort((left, right) => left.localeCompare(right));
  }

  async refreshModels(options: { force?: boolean } = {}): Promise<void> {
    const now = Date.now();
    if (
      !options.force &&
      this.cachedModels.length > 0 &&
      now - this.modelsLoadedAt < OpenClawSessionService.MODEL_CACHE_TTL_MS
    ) {
      return;
    }
    const gatewayModels = await this.refreshModelsFromGateway().catch(() => []);
    const cliModels = gatewayModels.length > 0 ? [] : this.refreshModelsFromCli();
    this.cachedModels = gatewayModels.length > 0 ? gatewayModels : cliModels;
    this.modelsLoadedAt = now;
  }

  listModels(): AgentModelRecord[] {
    const models = [...this.cachedModels];
    if (this.currentModel && !models.some((model) => model.slug === this.currentModel)) {
      models.unshift({ slug: this.currentModel, displayName: this.currentModel, supportsThinking: true, supportsImages: true });
    }
    if (models.length === 0) {
      models.push({ slug: "openclaw/default", displayName: "openclaw/default", supportsThinking: true, supportsImages: true });
    }
    return models;
  }

  listLaunchProfiles(): AgentLaunchProfileRecord[] {
    return listOpenClawLaunchProfiles();
  }

  getSessionRecord(threadId: string): AgentThreadRecord | null {
    return this.getRecord(threadId);
  }

  setModel(slug: string): string {
    this.currentModel = slug;
    return slug;
  }

  setModelForCurrentSession(slug: string): AgentSettingResult {
    this.ensureIdle("change OpenClaw model");
    this.currentModel = slug;
    return { value: slug, appliedToActiveThread: Boolean(this.currentThreadId) };
  }

  setReasoningEffort(effort: string): void {
    this.currentThinking = normalizeOpenClawThinking(effort);
  }

  setReasoningEffortForCurrentSession(effort: string): AgentSettingResult {
    this.ensureIdle("change OpenClaw thinking");
    const value = normalizeOpenClawThinking(effort);
    if (!value) {
      throw new Error("OpenClaw thinking level is empty");
    }
    this.currentThinking = value;
    return { value, appliedToActiveThread: Boolean(this.currentThreadId) };
  }

  setLaunchProfile(profileId: string): CodexLaunchProfile {
    this.ensureIdle("change OpenClaw profile");
    this.currentLaunchProfile = findOpenClawLaunchProfile(profileId);
    return openClawProfileAsLaunchProfile(this.currentLaunchProfile);
  }

  setFastMode(): AgentFastModeResult {
    throw new Error("Fast mode is only supported by Codex sessions");
  }

  getSelectedLaunchProfile(): CodexLaunchProfile {
    return openClawProfileAsLaunchProfile(this.currentLaunchProfile);
  }

  syncFromAgentState(): AgentSyncResult {
    const before = this.getInfo();
    this.refreshFromState({ force: true });
    const after = this.getInfo();
    const changedFields: string[] = [];
    if (before.model !== after.model) changedFields.push("model");
    if (before.reasoningEffort !== after.reasoningEffort) changedFields.push("thinking");
    if (before.workspace !== after.workspace) changedFields.push("workspace");
    return {
      threadId: this.currentThreadId,
      changed: changedFields.length > 0,
      reattached: false,
      changedFields,
      info: after,
    };
  }

  handback(): AgentHandbackResult {
    const threadId = this.currentThreadId;
    const workspace = this.currentWorkspace;
    this.currentThreadId = null;
    return {
      threadId,
      workspace,
      command: threadId
        ? `cd ${shellQuote(workspace)} && ${shellQuote(this.cliPath ?? "openclaw")} agent --agent ${shellQuote(this.currentOpenClawAgentId)} --session-id ${shellQuote(threadId)} --message ${shellQuote("<your next message>")}`
        : undefined,
      label: "OpenClaw CLI",
    };
  }

  dispose(): void {
    this.abortController?.abort();
    this.currentGateway?.close();
    this.processing = false;
    this.currentRunId = null;
  }

  private async ensureSessionStarted(): Promise<void> {
    if (!this.currentThreadId) {
      await this.newThread(this.currentWorkspace, this.currentModel);
    }
  }

  private ensureIdle(action: string): void {
    if (this.processing) {
      throw new Error(`Cannot ${action} while a turn is in progress`);
    }
  }

  private createGatewayClient(): OpenClawGatewayClient {
    return new OpenClawGatewayClient({
      url: this.config.openClawGatewayUrl,
      token: this.config.openClawGatewayToken,
      password: this.config.openClawGatewayPassword,
      timeoutMs: 15_000,
    });
  }

  private async refreshModelsFromGateway(): Promise<AgentModelRecord[]> {
    const gateway = this.createGatewayClient();
    try {
      const response = await gateway.listModels({ agent: this.currentOpenClawAgentId });
      return parseModelsPayload(response);
    } finally {
      gateway.close();
    }
  }

  private refreshModelsFromCli(): AgentModelRecord[] {
    if (!this.cliPath) {
      return [];
    }
    const result = spawnSync(this.cliPath, ["models", "list", "--json"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      return [];
    }
    try {
      return parseModelsPayload(JSON.parse(result.stdout.trim() || "{}") as unknown);
    } catch {
      return [];
    }
  }

  private refreshFromState(options: { force?: boolean } = {}): void {
    if (!this.currentThreadId) {
      return;
    }
    const now = Date.now();
    if (!options.force && now - this.lastStateRefreshAt < OpenClawSessionService.STATE_CACHE_TTL_MS) {
      return;
    }
    this.lastStateRefreshAt = now;
    const record = this.getRecord(this.currentThreadId);
    if (record) {
      this.applyRecord(record);
    }
  }

  private applyRecord(record: OpenClawSessionRecord): void {
    this.currentThreadId = record.id;
    this.currentWorkspace = record.cwd || this.currentWorkspace;
    this.currentModel = record.model ?? this.currentModel;
    this.currentThinking = normalizeOpenClawThinking(record.reasoningEffort ?? this.currentThinking);
    this.currentOpenClawAgentId = record.openClawAgentId ?? this.currentOpenClawAgentId;
    this.cachedUsage = record.usage;
  }

  private getRecord(threadId: string): OpenClawSessionRecord | null {
    return getOpenClawSession(threadId, this.stateOptions());
  }

  private stateOptions() {
    return {
      cliPath: this.cliPath,
      openClawHome: this.config.openClawHome,
      stateDir: this.config.openClawStateDir,
      workspace: this.currentWorkspace || this.config.workspace,
      openClawAgentId: this.currentOpenClawAgentId,
    };
  }

  private async buildPrompt(input: AgentPromptInput): Promise<string> {
    if (typeof input === "string") {
      return this.withInstructions(input);
    }
    const textParts = [input.stagedFileInstructions, input.text].filter((part): part is string => Boolean(part?.trim()));
    if ((input.imagePaths?.length ?? 0) > 0) {
      textParts.push(`Attached images: ${(input.imagePaths ?? []).join(", ")}`);
    }
    return this.withInstructions(textParts.join("\n\n").trim() || "Please inspect the attached file(s).");
  }

  private withInstructions(prompt: string): string {
    const parts = [
      this.currentLaunchProfile.instructions,
      this.currentThinking ? `Use OpenClaw thinking level "${this.currentThinking}" when the configured provider supports it.` : undefined,
      prompt,
    ].filter((part): part is string => Boolean(part?.trim()));
    return parts.join("\n\n");
  }

  private async buildAttachments(input: AgentPromptInput): Promise<unknown[]> {
    if (typeof input === "string") {
      return [];
    }
    const attachments: unknown[] = [];
    for (const imagePath of input.imagePaths ?? []) {
      attachments.push({
        type: "image",
        path: imagePath,
        mimeType: mimeTypeForImage(imagePath),
        data: (await readFile(imagePath)).toString("base64"),
      });
    }
    return attachments;
  }
}

function parseModelsPayload(payload: unknown): AgentModelRecord[] {
  const object = objectValue(payload);
  const rows = arrayValue(object?.models ?? object?.data ?? payload);
  const models: AgentModelRecord[] = [];
  for (const row of rows) {
    const item = objectValue(row);
    const slug = stringValue(item?.id) ?? stringValue(item?.slug) ?? stringValue(item?.model) ?? stringValue(row);
    if (!slug) continue;
    models.push({
      slug,
      displayName: stringValue(item?.name) ?? stringValue(item?.displayName) ?? slug,
      contextWindow: numberValue(item?.contextWindow) ?? numberValue(item?.context_window) ?? undefined,
      maxInputTokens: numberValue(item?.maxInputTokens) ?? numberValue(item?.max_input_tokens) ?? undefined,
      maxOutputTokens: numberValue(item?.maxOutputTokens) ?? numberValue(item?.max_output_tokens) ?? undefined,
      supportsThinking: booleanValue(item?.supportsThinking) ?? true,
      supportsImages: booleanValue(item?.supportsImages) ?? true,
    });
  }
  return models;
}

function normalizeOpenClawThinking(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (OPENCLAW_THINKING_LEVELS.includes(value as never)) {
    return value;
  }
  throw new Error(`Unsupported OpenClaw thinking level: ${value}`);
}

function createOpenClawSessionId(): string {
  return `nordrelay-openclaw-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function usageFromGatewayResult(value: unknown): AgentSessionInfo["sessionUsage"] {
  const usage = objectValue(value);
  if (!usage) {
    return undefined;
  }
  const input = numberValue(usage.input) ?? numberValue(usage.inputTokens) ?? numberValue(usage.input_tokens) ?? 0;
  const output = numberValue(usage.output) ?? numberValue(usage.outputTokens) ?? numberValue(usage.output_tokens) ?? 0;
  const cacheRead = numberValue(usage.cacheRead) ?? numberValue(usage.cache_read_tokens) ?? 0;
  const cacheWrite = numberValue(usage.cacheWrite) ?? numberValue(usage.cache_write_tokens) ?? 0;
  const total = input + output + cacheRead + cacheWrite;
  return total > 0 ? { input, output, cacheRead, cacheWrite, total, cost: numberValue(usage.cost) ?? undefined } : undefined;
}

function computeTextDelta(previous: string, next: string): string {
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}

function mimeTypeForImage(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/jpeg";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("abort"));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
