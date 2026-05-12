import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  HERMES_AGENT_CAPABILITIES,
  HERMES_REASONING_EFFORTS,
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
import { HermesApiClient } from "./hermes-api.js";
import { resolveHermesCli } from "./hermes-cli.js";
import {
  findHermesLaunchProfile,
  hermesProfileAsLaunchProfile,
  listHermesLaunchProfiles,
  type HermesLaunchProfile,
} from "./hermes-launch.js";
import {
  getHermesSession,
  listHermesSessions,
  listHermesWorkspaces,
  resolveHermesStateDbPath,
  type HermesSessionRecord,
} from "./hermes-state.js";

type OpenTool = {
  id: string;
  name: string;
};

export class HermesSessionService implements AgentSessionService {
  private readonly api: HermesApiClient;
  private readonly stateDbPath: string;
  private readonly cliPath?: string;
  private currentWorkspace: string;
  private currentThreadId: string | null = null;
  private currentModel: string | undefined;
  private currentReasoning: string | undefined;
  private currentLaunchProfile: HermesLaunchProfile;
  private cachedModels: AgentModelRecord[] = [];
  private cachedUsage: AgentSessionInfo["sessionUsage"];
  private processing = false;
  private abortController: AbortController | null = null;
  private currentRunId: string | null = null;

  private constructor(private readonly config: ConnectorConfig) {
    this.api = new HermesApiClient({
      baseUrl: config.hermesApiBaseUrl,
      apiKey: config.hermesApiKey,
    });
    this.stateDbPath = resolveHermesStateDbPath({
      hermesHome: config.hermesHome,
      stateDbPath: config.hermesStateDbPath,
    });
    this.cliPath = resolveHermesCli(process.env, config.hermesCliPath).path;
    this.currentWorkspace = config.workspace;
    this.currentModel = config.hermesDefaultModel;
    this.currentReasoning = config.hermesDefaultReasoning;
    this.currentLaunchProfile = findHermesLaunchProfile(config.hermesDefaultLaunchProfileId);
  }

  static async create(config: ConnectorConfig, options?: AgentCreateOptions): Promise<HermesSessionService> {
    const service = new HermesSessionService(config);
    service.currentWorkspace = options?.workspace ?? config.workspace;
    service.currentModel = options?.model ?? config.hermesDefaultModel;
    service.currentReasoning = normalizeHermesReasoning(options?.reasoningEffort ?? config.hermesDefaultReasoning);
    service.currentLaunchProfile = findHermesLaunchProfile(options?.launchProfileId ?? config.hermesDefaultLaunchProfileId);
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
      agentId: "hermes",
      agentLabel: "Hermes",
      threadId: this.currentThreadId,
      workspace: this.currentWorkspace,
      model: this.currentModel,
      reasoningEffort: this.currentReasoning,
      launchProfileId: this.currentLaunchProfile.id,
      launchProfileLabel: this.currentLaunchProfile.label,
      launchProfileBehavior: this.currentLaunchProfile.behavior,
      sandboxMode: "host",
      approvalPolicy: "never",
      fastMode: false,
      unsafeLaunch: this.currentLaunchProfile.unsafe,
      sessionPath: this.stateDbPath,
      sessionUsage: this.cachedUsage,
      capabilities: HERMES_AGENT_CAPABILITIES,
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
      throw new Error("A Hermes turn is already in progress");
    }
    await this.ensureSessionStarted();

    const threadId = this.currentThreadId!;
    const promptInput = await this.buildHermesInput(input);
    const instructions = this.buildInstructions();
    const abortController = new AbortController();
    const openTools = new Map<string, OpenTool[]>();
    let finalOutput = "";
    let streamedOutput = "";
    let finalError: string | null = null;
    let didEnd = false;
    let toolCounter = 0;

    this.processing = true;
    this.abortController = abortController;

    try {
      const run = await this.api.startRun({
        input: promptInput,
        session_id: threadId,
        model: this.currentModel,
        reasoning_effort: this.currentReasoning,
        ...(instructions ? { instructions } : {}),
      }, this.sessionKey(threadId));
      this.currentRunId = run.run_id;

      await this.api.streamRunEvents(run.run_id, (event) => {
        const eventName = stringValue(event.event);
        switch (eventName) {
          case "message.delta": {
            const delta = stringValue(event.delta);
            if (delta) {
              streamedOutput += delta;
              callbacks.onTextDelta(delta);
            }
            break;
          }
          case "tool.started": {
            const toolName = stringValue(event.tool) ?? "tool";
            toolCounter += 1;
            const toolId = `${run.run_id}-${toolName}-${toolCounter}`;
            const openTool = { id: toolId, name: toolName };
            const tools = openTools.get(toolName) ?? [];
            tools.push(openTool);
            openTools.set(toolName, tools);
            callbacks.onToolStart(toolName, toolId);
            const preview = stringValue(event.preview);
            if (preview) {
              callbacks.onToolUpdate(toolId, preview);
            }
            break;
          }
          case "tool.completed": {
            const toolName = stringValue(event.tool) ?? "tool";
            const openTool = openTools.get(toolName)?.shift();
            if (openTool) {
              callbacks.onToolEnd(openTool.id, Boolean(event.error));
            }
            break;
          }
          case "reasoning.available": {
            const toolId = `${run.run_id}-reasoning`;
            callbacks.onToolStart("reasoning", toolId);
            callbacks.onToolUpdate(toolId, stringValue(event.text) ?? "Reasoning available");
            callbacks.onToolEnd(toolId, false);
            break;
          }
          case "approval.request": {
            const toolId = `${run.run_id}-approval`;
            callbacks.onToolStart("approval", toolId);
            callbacks.onToolUpdate(toolId, "Hermes requested command approval.");
            void this.api.approveRun(run.run_id, this.currentLaunchProfile.approvalChoice)
              .then(() => callbacks.onToolUpdate(toolId, `Approval response: ${this.currentLaunchProfile.approvalChoice}`))
              .catch((error) => callbacks.onToolUpdate(toolId, `Approval response failed: ${error instanceof Error ? error.message : String(error)}`))
              .finally(() => callbacks.onToolEnd(toolId, this.currentLaunchProfile.approvalChoice === "deny"));
            break;
          }
          case "run.completed": {
            finalOutput = stringValue(event.output) ?? finalOutput;
            const usage = objectValue(event.usage);
            callbacks.onTurnComplete?.({
              inputTokens: numberValue(usage?.input_tokens) ?? 0,
              cachedInputTokens: 0,
              outputTokens: numberValue(usage?.output_tokens) ?? 0,
            });
            if (finalOutput && !streamedOutput) {
              streamedOutput = finalOutput;
              callbacks.onTextDelta(finalOutput);
            }
            if (!didEnd) {
              didEnd = true;
              callbacks.onAgentEnd();
            }
            break;
          }
          case "run.failed":
            finalError = stringValue(event.error) ?? "Hermes run failed";
            break;
          case "run.cancelled":
            finalError = "Hermes run was cancelled";
            break;
          default:
            break;
        }
      }, abortController.signal);

      if (finalError) {
        throw new Error(finalError);
      }
      if (!didEnd) {
        callbacks.onAgentEnd();
      }
      this.refreshFromState();
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error("Hermes run was aborted");
      }
      throw error;
    } finally {
      this.currentRunId = null;
      this.abortController = null;
      this.processing = false;
    }
  }

  async abort(): Promise<void> {
    const runId = this.currentRunId;
    if (runId) {
      await this.api.stopRun(runId).catch(() => {});
    }
    this.abortController?.abort();
    this.processing = false;
  }

  async newThread(workspace?: string, model?: string): Promise<AgentSessionInfo> {
    this.ensureIdle("start a new Hermes session");
    this.currentWorkspace = workspace ?? this.currentWorkspace;
    if (model) {
      this.currentModel = model;
    }
    this.currentThreadId = createHermesSessionId();
    this.cachedUsage = undefined;
    return this.getInfo();
  }

  async resumeThread(threadId: string): Promise<AgentSessionInfo> {
    return this.switchSession(threadId);
  }

  async switchSession(threadId: string): Promise<AgentSessionInfo> {
    this.ensureIdle("switch Hermes session");
    const record = this.getRecord(threadId);
    if (!record) {
      throw new Error(`Unknown Hermes session: ${threadId}`);
    }
    this.applyRecord(record);
    return this.getInfo();
  }

  listAllSessions(limit?: number): AgentThreadRecord[] {
    return listHermesSessions(limit ?? 20, this.stateOptions());
  }

  listWorkspaces(): string[] {
    const workspaces = new Set(listHermesWorkspaces(this.stateOptions()));
    workspaces.add(this.currentWorkspace);
    workspaces.add(this.config.workspace);
    return [...workspaces].sort((left, right) => left.localeCompare(right));
  }

  listModels(): AgentModelRecord[] {
    const models = [...this.cachedModels];
    if (this.currentModel && !models.some((model) => model.slug === this.currentModel)) {
      models.unshift({ slug: this.currentModel, displayName: this.currentModel, supportsThinking: true, supportsImages: true });
    }
    if (models.length === 0) {
      models.push({ slug: "hermes-agent", displayName: "hermes-agent", supportsThinking: true, supportsImages: true });
    }
    return models;
  }

  listLaunchProfiles(): AgentLaunchProfileRecord[] {
    return listHermesLaunchProfiles();
  }

  getSessionRecord(threadId: string): AgentThreadRecord | null {
    return this.getRecord(threadId);
  }

  setModel(slug: string): string {
    this.currentModel = slug;
    return slug;
  }

  setModelForCurrentSession(slug: string): AgentSettingResult {
    this.ensureIdle("change Hermes model");
    this.currentModel = slug;
    return { value: slug, appliedToActiveThread: false };
  }

  setReasoningEffort(effort: string): void {
    this.currentReasoning = normalizeHermesReasoning(effort);
  }

  setReasoningEffortForCurrentSession(effort: string): AgentSettingResult {
    this.ensureIdle("change Hermes reasoning");
    const value = normalizeHermesReasoning(effort);
    if (!value) {
      throw new Error("Hermes reasoning effort is empty");
    }
    this.currentReasoning = value;
    return { value, appliedToActiveThread: false };
  }

  setLaunchProfile(profileId: string): CodexLaunchProfile {
    this.ensureIdle("change Hermes profile");
    this.currentLaunchProfile = findHermesLaunchProfile(profileId);
    return hermesProfileAsLaunchProfile(this.currentLaunchProfile);
  }

  setFastMode(): AgentFastModeResult {
    throw new Error("Fast mode is only supported by Codex sessions");
  }

  getSelectedLaunchProfile(): CodexLaunchProfile {
    return hermesProfileAsLaunchProfile(this.currentLaunchProfile);
  }

  syncFromCodexState(): AgentSyncResult {
    const before = this.getInfo();
    this.refreshFromState();
    const after = this.getInfo();
    const changedFields: string[] = [];
    if (before.model !== after.model) changedFields.push("model");
    if (before.reasoningEffort !== after.reasoningEffort) changedFields.push("reasoningEffort");
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
        ? `cd ${shellQuote(workspace)} && ${shellQuote(this.cliPath ?? "hermes")} --resume ${shellQuote(threadId)}`
        : undefined,
      label: "Hermes CLI",
    };
  }

  dispose(): void {
    this.abortController?.abort();
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

  private async refreshModels(): Promise<void> {
    const models = await this.api.models();
    this.cachedModels = models.map((model) => ({
      slug: model.id,
      displayName: model.id,
      supportsThinking: true,
      supportsImages: true,
    }));
  }

  private refreshFromState(): void {
    if (!this.currentThreadId) {
      return;
    }
    const record = this.getRecord(this.currentThreadId);
    if (record) {
      this.applyRecord(record);
    }
  }

  private applyRecord(record: HermesSessionRecord): void {
    this.currentThreadId = record.id;
    this.currentWorkspace = record.cwd || this.currentWorkspace;
    this.currentModel = record.model ?? this.currentModel;
    this.currentReasoning = normalizeHermesReasoning(record.reasoningEffort ?? this.currentReasoning);
    this.cachedUsage = record.usage;
  }

  private getRecord(threadId: string): HermesSessionRecord | null {
    return getHermesSession(threadId, this.stateOptions());
  }

  private stateOptions() {
    return {
      hermesHome: this.config.hermesHome,
      stateDbPath: this.config.hermesStateDbPath,
      workspace: this.currentWorkspace || this.config.workspace,
    };
  }

  private async buildHermesInput(input: AgentPromptInput): Promise<unknown> {
    if (typeof input === "string") {
      return input;
    }

    const textParts = [input.stagedFileInstructions, input.text].filter((part): part is string => Boolean(part?.trim()));
    const content: Array<Record<string, unknown>> = [];
    const text = textParts.join("\n\n").trim();
    if (text) {
      content.push({ type: "text", text });
    }
    for (const imagePath of input.imagePaths ?? []) {
      const data = (await readFile(imagePath)).toString("base64");
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${mimeTypeForImage(imagePath)};base64,${data}`,
        },
      });
    }
    if (content.length === 0) {
      return "Please inspect the attached file(s).";
    }
    if (content.length === 1 && content[0]?.type === "text") {
      return String(content[0].text ?? "");
    }
    return [{ role: "user", content }];
  }

  private buildInstructions(): string | undefined {
    const parts = [
      this.currentLaunchProfile.instructions,
      this.currentReasoning ? `Use Hermes reasoning effort "${this.currentReasoning}" when the configured provider supports it.` : undefined,
    ].filter((part): part is string => Boolean(part?.trim()));
    return parts.join("\n\n") || undefined;
  }

  private sessionKey(threadId: string): string {
    return `nordrelay:hermes:${threadId}`;
  }
}

function normalizeHermesReasoning(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value === "off" ? "none" : value;
  if (HERMES_REASONING_EFFORTS.includes(normalized as never)) {
    return normalized;
  }
  throw new Error(`Unsupported Hermes reasoning effort: ${value}`);
}

function createHermesSessionId(): string {
  const date = new Date();
  const stamp = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    "_",
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0"),
  ].join("");
  return `${stamp}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
}

function mimeTypeForImage(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
