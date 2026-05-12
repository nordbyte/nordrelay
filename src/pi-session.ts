import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  PI_AGENT_CAPABILITIES,
  PI_THINKING_LEVELS,
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
import { findPiLaunchProfile, listPiLaunchProfiles, piProfileAsLaunchProfile, type PiLaunchProfile } from "./pi-launch.js";
import { resolvePiCli } from "./pi-cli.js";
import { PiRpcClient, type PiRpcEvent } from "./pi-rpc.js";
import {
  getPiSession,
  listPiSessions,
  listPiWorkspaces,
  readPiSessionRecord,
  resolvePiSessionDir,
} from "./pi-state.js";

type JsonObject = Record<string, unknown>;

type PiStateData = {
  model?: unknown;
  thinkingLevel?: unknown;
  sessionFile?: unknown;
  sessionId?: unknown;
  sessionName?: unknown;
  isStreaming?: unknown;
};

type PiStatsData = {
  sessionFile?: unknown;
  sessionId?: unknown;
  tokens?: unknown;
  cost?: unknown;
  contextUsage?: unknown;
};

type PiImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export class PiSessionService implements AgentSessionService {
  private readonly sessionDir: string;
  private readonly cliPath: string;
  private currentLaunchProfile: PiLaunchProfile;
  private rpc: PiRpcClient | null = null;
  private currentWorkspace: string;
  private currentThreadId: string | null = null;
  private currentSessionPath: string | undefined;
  private currentModel: string | undefined;
  private currentThinking: string | undefined;
  private currentSessionName: string | undefined;
  private processing = false;
  private cachedStats: {
    sessionUsage?: AgentSessionInfo["sessionUsage"];
    contextUsage?: AgentSessionInfo["contextUsage"];
  } = {};

  private constructor(private readonly config: ConnectorConfig) {
    const cli = resolvePiCli(process.env, config.piCliPath);
    if (!cli.path) {
      throw new Error("Pi CLI not found. Install Pi from https://pi.dev/ or set PI_CLI_PATH.");
    }
    this.cliPath = cli.path;
    this.sessionDir = resolvePiSessionDir({ sessionDir: config.piSessionDir });
    this.currentWorkspace = config.workspace;
    this.currentModel = config.piDefaultModel;
    this.currentThinking = config.piDefaultThinking;
    this.currentLaunchProfile = findPiLaunchProfile(config.piDefaultLaunchProfileId);
  }

  static async create(config: ConnectorConfig, options?: AgentCreateOptions): Promise<PiSessionService> {
    const service = new PiSessionService(config);
    service.currentWorkspace = options?.workspace ?? config.workspace;
    service.currentModel = options?.model ?? config.piDefaultModel;
    service.currentThinking = options?.reasoningEffort ?? config.piDefaultThinking;
    service.currentLaunchProfile = findPiLaunchProfile(options?.launchProfileId ?? config.piDefaultLaunchProfileId);

    if (options?.sessionPath) {
      await service.switchSession(options.sessionPath);
      return service;
    }
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
    return {
      agentId: "pi",
      agentLabel: "Pi",
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
      unsafeLaunch: false,
      sessionPath: this.currentSessionPath,
      sessionUsage: this.cachedStats.sessionUsage,
      contextUsage: this.cachedStats.contextUsage,
      capabilities: PI_AGENT_CAPABILITIES,
    };
  }

  isProcessing(): boolean {
    return this.processing;
  }

  getActiveThreadId(): string | null {
    return this.currentThreadId;
  }

  hasActiveThread(): boolean {
    return Boolean(this.currentThreadId || this.currentSessionPath);
  }

  getCurrentWorkspace(): string {
    return this.currentWorkspace;
  }

  async prompt(input: AgentPromptInput, callbacks: AgentSessionCallbacks): Promise<void> {
    if (this.processing) {
      throw new Error("A Pi turn is already in progress");
    }

    await this.ensureSessionStarted();
    const rpc = this.getRpc();
    const promptPayload = await this.buildPromptPayload(input);
    const lastToolOutput = new Map<string, string>();
    let didEnd = false;

    this.processing = true;
    const off = rpc.onEvent((event) => {
      try {
        switch (event.type) {
          case "message_update":
            handleMessageUpdate(event, callbacks);
            break;
          case "tool_execution_start": {
            const toolCallId = stringValue(event.toolCallId) ?? "tool";
            const toolName = stringValue(event.toolName) ?? "tool";
            lastToolOutput.set(toolCallId, "");
            callbacks.onToolStart(toolName, toolCallId);
            break;
          }
          case "tool_execution_update": {
            const toolCallId = stringValue(event.toolCallId) ?? "tool";
            const text = extractContentText(objectValue(event.partialResult));
            const previous = lastToolOutput.get(toolCallId) ?? "";
            const delta = computeTextDelta(previous, text);
            lastToolOutput.set(toolCallId, text);
            if (delta) {
              callbacks.onToolUpdate(toolCallId, delta);
            }
            break;
          }
          case "tool_execution_end": {
            const toolCallId = stringValue(event.toolCallId) ?? "tool";
            const resultText = extractContentText(objectValue(event.result));
            const previous = lastToolOutput.get(toolCallId) ?? "";
            const delta = computeTextDelta(previous, resultText);
            if (delta) {
              callbacks.onToolUpdate(toolCallId, delta);
            }
            callbacks.onToolEnd(toolCallId, Boolean(event.isError));
            break;
          }
          case "turn_end":
            this.refreshFromTurnEnd(event, callbacks);
            break;
          case "agent_end":
            didEnd = true;
            callbacks.onAgentEnd();
            break;
          case "extension_error": {
            const toolCallId = stringValue(event.id) ?? "extension-error";
            callbacks.onToolStart("extension_error", toolCallId);
            callbacks.onToolUpdate(toolCallId, stringValue(event.error) ?? "Extension error");
            callbacks.onToolEnd(toolCallId, true);
            break;
          }
          default:
            break;
        }
      } catch (error) {
        console.error("Failed to handle Pi RPC event:", error);
      }
    });

    try {
      await rpc.send({ type: "prompt", ...promptPayload }, 30_000);
      await this.waitForAgentEnd(() => didEnd);
      await this.refreshState().catch(() => {});
      await this.refreshStats().catch(() => {});
    } finally {
      off();
      this.processing = false;
    }
  }

  async abort(): Promise<void> {
    if (!this.rpc) {
      this.processing = false;
      return;
    }
    await this.rpc.send({ type: "abort" }, 10_000).catch(() => {});
    this.processing = false;
  }

  async newThread(workspace?: string, model?: string): Promise<AgentSessionInfo> {
    this.ensureIdle("start a new Pi session");
    this.currentWorkspace = workspace ?? this.currentWorkspace;
    if (model) {
      this.currentModel = model;
    }
    this.currentThreadId = null;
    this.currentSessionPath = undefined;
    this.cachedStats = {};
    this.restartRpc();
    await this.refreshState();
    return this.getInfo();
  }

  async resumeThread(threadId: string): Promise<AgentSessionInfo> {
    return this.switchSession(threadId);
  }

  async switchSession(threadId: string): Promise<AgentSessionInfo> {
    this.ensureIdle("switch Pi session");
    const record = getPiSession(threadId, { sessionDir: this.sessionDir });
    if (!record) {
      throw new Error(`Unknown Pi session: ${threadId}`);
    }

    this.currentWorkspace = record.cwd;
    this.currentThreadId = record.id;
    this.currentSessionPath = record.sessionPath;
    this.currentModel = record.model ?? this.currentModel;
    this.currentThinking = record.reasoningEffort ?? this.currentThinking;
    this.cachedStats = {};

    if (this.rpc) {
      const result = await this.rpc.send<{ cancelled?: boolean }>(
        { type: "switch_session", sessionPath: record.sessionPath },
        30_000,
      );
      if (objectValue(result.data)?.cancelled === true) {
        throw new Error("Pi session switch was cancelled by an extension");
      }
    } else {
      this.restartRpc();
    }

    await this.refreshState();
    await this.refreshStats().catch(() => {});
    return this.getInfo();
  }

  listAllSessions(limit?: number): AgentThreadRecord[] {
    return listPiSessions(limit ?? 20, { sessionDir: this.sessionDir });
  }

  listWorkspaces(): string[] {
    const workspaces = new Set(listPiWorkspaces({ sessionDir: this.sessionDir }));
    workspaces.add(this.currentWorkspace);
    workspaces.add(this.config.workspace);
    return [...workspaces].sort((left, right) => left.localeCompare(right));
  }

  listModels(): AgentModelRecord[] {
    const result = spawnSync(this.cliPath, ["--list-models"], {
      cwd: this.currentWorkspace,
      env: process.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status !== 0 || !result.stdout) {
      return this.currentModel ? [{ slug: this.currentModel, displayName: this.currentModel }] : [];
    }

    const records: AgentModelRecord[] = [];
    for (const line of result.stdout
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)) {
      const parts = line.split(/\s+/);
      const provider = parts[0];
      const model = parts[1];
      if (!provider || !model) {
        continue;
      }
      const slug = `${provider}/${model}`;
      const contextWindow = parseCompactTokenCount(parts[2]);
      const maxOutputTokens = parseCompactTokenCount(parts[3]);
      const supportsThinking = parseYesNo(parts[4]);
      const supportsImages = parseYesNo(parts[5]);
      records.push({
        slug,
        displayName: slug,
        ...(contextWindow !== undefined ? { maxInputTokens: contextWindow, contextWindow } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(supportsThinking !== undefined ? { supportsThinking } : {}),
        ...(supportsImages !== undefined ? { supportsImages } : {}),
      });
    }

    if (this.currentModel && !records.some((record) => record.slug === this.currentModel)) {
      records.unshift({ slug: this.currentModel, displayName: this.currentModel });
    }
    return records;
  }

  listLaunchProfiles(): AgentLaunchProfileRecord[] {
    return listPiLaunchProfiles();
  }

  getSessionRecord(threadId: string): AgentThreadRecord | null {
    return getPiSession(threadId, { sessionDir: this.sessionDir });
  }

  setModel(slug: string): string {
    this.currentModel = slug;
    this.restartRpcIfIdle();
    return slug;
  }

  async setModelForCurrentSession(slug: string): Promise<AgentSettingResult> {
    this.ensureIdle("change Pi model");
    this.currentModel = slug;
    let appliedToActiveThread = false;
    if (this.rpc && this.currentThreadId) {
      const { provider, modelId } = splitPiModelSlug(slug);
      await this.rpc.send({ type: "set_model", provider, modelId }, 30_000);
      await this.refreshState().catch(() => {});
      appliedToActiveThread = true;
    } else {
      this.restartRpcIfIdle();
    }
    return { value: slug, appliedToActiveThread };
  }

  setReasoningEffort(effort: string): void {
    this.currentThinking = normalizePiThinking(effort);
    this.restartRpcIfIdle();
  }

  async setReasoningEffortForCurrentSession(effort: string): Promise<AgentSettingResult> {
    this.ensureIdle("change Pi thinking level");
    const level = normalizePiThinking(effort);
    this.currentThinking = level;
    let appliedToActiveThread = false;
    if (this.rpc && this.currentThreadId) {
      await this.rpc.send({ type: "set_thinking_level", level }, 30_000);
      await this.refreshState().catch(() => {});
      appliedToActiveThread = true;
    } else {
      this.restartRpcIfIdle();
    }
    return { value: level, appliedToActiveThread };
  }

  setLaunchProfile(profileId: string): CodexLaunchProfile {
    this.ensureIdle("change Pi profile");
    this.currentLaunchProfile = findPiLaunchProfile(profileId);
    this.restartRpcIfIdle();
    return piProfileAsLaunchProfile(this.currentLaunchProfile);
  }

  setFastMode(): AgentFastModeResult {
    throw new Error("Fast mode is only supported by Codex sessions");
  }

  getSelectedLaunchProfile(): CodexLaunchProfile {
    return piProfileAsLaunchProfile(this.currentLaunchProfile);
  }

  syncFromCodexState(): AgentSyncResult {
    return {
      threadId: this.currentThreadId,
      changed: false,
      reattached: false,
      changedFields: [],
      info: this.getInfo(),
    };
  }

  handback(): AgentHandbackResult {
    const threadId = this.currentThreadId;
    const workspace = this.currentWorkspace;
    const sessionPath = this.currentSessionPath;
    this.rpc?.stop();
    this.rpc = null;
    this.currentThreadId = null;
    this.currentSessionPath = undefined;
    return {
      threadId,
      workspace,
      command: sessionPath
        ? `cd ${shellQuote(workspace)} && pi --session ${shellQuote(sessionPath)}`
        : undefined,
      label: "Pi CLI",
    };
  }

  dispose(): void {
    this.rpc?.stop();
    this.rpc = null;
    this.processing = false;
  }

  private async ensureSessionStarted(): Promise<void> {
    if (this.currentThreadId || this.currentSessionPath) {
      this.getRpc().ensureStarted();
      await this.refreshState().catch(() => {});
      return;
    }
    await this.newThread(this.currentWorkspace, this.currentModel);
  }

  private restartRpc(): void {
    this.rpc?.stop();
    this.rpc = new PiRpcClient({
      commandPath: this.cliPath,
      cwd: this.currentWorkspace,
      sessionDir: this.sessionDir,
      sessionPath: this.currentSessionPath,
      model: this.currentModel,
      thinking: this.currentThinking,
      ...this.currentLaunchProfile.cli,
      env: { PI_CODING_AGENT_SESSION_DIR: this.sessionDir },
    });
  }

  private restartRpcIfIdle(): void {
    if (this.processing) {
      return;
    }
    this.restartRpc();
  }

  private getRpc(): PiRpcClient {
    if (!this.rpc) {
      this.restartRpc();
    }
    return this.rpc!;
  }

  private ensureIdle(action: string): void {
    if (this.processing) {
      throw new Error(`Cannot ${action} while a turn is in progress`);
    }
  }

  private async refreshState(): Promise<void> {
    const response = await this.getRpc().send<PiStateData>({ type: "get_state" }, 30_000);
    const data = objectValue(response.data);
    if (!data) {
      return;
    }

    const model = objectValue(data.model);
    const provider = stringValue(model?.provider);
    const modelId = stringValue(model?.id);
    this.currentModel = provider && modelId ? `${provider}/${modelId}` : modelId ?? this.currentModel;
    this.currentThinking = stringValue(data.thinkingLevel) ?? this.currentThinking;
    this.currentSessionPath = stringValue(data.sessionFile) ?? this.currentSessionPath;
    this.currentThreadId = stringValue(data.sessionId) ?? this.currentThreadId;
    this.currentSessionName = stringValue(data.sessionName) ?? this.currentSessionName;

    if (this.currentSessionPath) {
      const record = readPiSessionRecord(this.currentSessionPath, path.basename(path.dirname(this.currentSessionPath)));
      if (record?.cwd) {
        this.currentWorkspace = record.cwd;
      }
    }
  }

  private async refreshStats(): Promise<void> {
    const response = await this.getRpc().send<PiStatsData>({ type: "get_session_stats" }, 30_000);
    const data = objectValue(response.data);
    if (!data) {
      return;
    }

    const tokens = objectValue(data.tokens);
    const contextUsage = objectValue(data.contextUsage);
    this.cachedStats = {
      sessionUsage: tokens
        ? {
            input: numberValue(tokens.input) ?? 0,
            output: numberValue(tokens.output) ?? 0,
            cacheRead: numberValue(tokens.cacheRead) ?? 0,
            cacheWrite: numberValue(tokens.cacheWrite) ?? 0,
            total: numberValue(tokens.total) ?? 0,
            cost: numberValue(data.cost) ?? undefined,
          }
        : undefined,
      contextUsage: contextUsage
        ? {
            tokens: numberValue(contextUsage.tokens),
            contextWindow: numberValue(contextUsage.contextWindow),
            percent: numberValue(contextUsage.percent),
          }
        : undefined,
    };
  }

  private async buildPromptPayload(input: AgentPromptInput): Promise<{ message: string; images?: PiImageContent[] }> {
    if (typeof input === "string") {
      return { message: input };
    }

    const textParts = [input.stagedFileInstructions, input.text].filter((part): part is string => Boolean(part?.trim()));
    const images = await Promise.all((input.imagePaths ?? []).map(async (imagePath) => ({
      type: "image" as const,
      data: (await readFile(imagePath)).toString("base64"),
      mimeType: mimeTypeForImage(imagePath),
    })));
    if (images.length > 0) {
      const imageSupport = this.currentModelSupportsImages();
      if (imageSupport === false) {
        throw new Error(`Current Pi model does not support image input: ${this.currentModel}`);
      }
    }
    return {
      message: textParts.join("\n\n") || "Please inspect the attached file(s).",
      ...(images.length > 0 ? { images } : {}),
    };
  }

  private currentModelSupportsImages(): boolean | null {
    const model = this.currentModel;
    if (!model) {
      return null;
    }
    const record = this.listModels().find((candidate) => candidate.slug === model || candidate.slug.endsWith(`/${model}`));
    return record?.supportsImages ?? null;
  }

  private refreshFromTurnEnd(event: PiRpcEvent, callbacks: AgentSessionCallbacks): void {
    const message = objectValue(event.message);
    const usage = objectValue(message?.usage);
    if (!usage) {
      return;
    }
    callbacks.onTurnComplete?.({
      inputTokens: numberValue(usage.input) ?? 0,
      cachedInputTokens: numberValue(usage.cacheRead) ?? 0,
      outputTokens: numberValue(usage.output) ?? 0,
    });
  }

  private async waitForAgentEnd(done: () => boolean): Promise<void> {
    if (done()) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (done()) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (!this.processing) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (Date.now() - startedAt > 24 * 60 * 60 * 1000) {
          clearInterval(timer);
          reject(new Error("Timed out waiting for Pi agent to finish"));
        }
      }, 250);
      timer.unref?.();
    });
  }
}

function handleMessageUpdate(event: PiRpcEvent, callbacks: AgentSessionCallbacks): void {
  const update = objectValue(event.assistantMessageEvent);
  const updateType = stringValue(update?.type);
  if (updateType === "text_delta") {
    const delta = stringValue(update?.delta);
    if (delta) {
      callbacks.onTextDelta(delta);
    }
  } else if (updateType === "toolcall_end") {
    const toolCall = objectValue(update?.toolCall);
    const id = stringValue(toolCall?.id);
    const name = stringValue(toolCall?.name);
    if (id && name) {
      callbacks.onToolStart(name, id);
    }
  } else if (updateType === "error") {
    const toolId = "pi-message-error";
    callbacks.onToolStart("message_error", toolId);
    callbacks.onToolUpdate(toolId, stringValue(update?.reason) ?? "Message error");
    callbacks.onToolEnd(toolId, true);
  }
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null ? value as JsonObject : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractContentText(container: JsonObject | null): string {
  const content = container?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((entry) => {
      const block = objectValue(entry);
      return stringValue(block?.text) ?? "";
    })
    .join("");
}

function computeTextDelta(previousText: string, nextText: string): string {
  return nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
}

function splitPiModelSlug(slug: string): { provider: string; modelId: string } {
  const separatorIndex = slug.indexOf("/");
  if (separatorIndex === -1) {
    return { provider: "openai-codex", modelId: slug };
  }
  return {
    provider: slug.slice(0, separatorIndex),
    modelId: slug.slice(separatorIndex + 1),
  };
}

function normalizePiThinking(value: string): string {
  if (PI_THINKING_LEVELS.includes(value as never)) {
    return value;
  }
  throw new Error(`Unsupported Pi thinking level: ${value}`);
}

function parseCompactTokenCount(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = value.match(/^(\d+(?:\.\d+)?)([KMB])?$/i);
  if (!match) {
    return undefined;
  }
  const number = Number(match[1]);
  const unit = match[2]?.toUpperCase();
  const multiplier = unit === "M" ? 1_000_000 : unit === "K" ? 1_000 : unit === "B" ? 1_000_000_000 : 1;
  return Math.round(number * multiplier);
}

function parseYesNo(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (["yes", "true", "1"].includes(normalized)) {
    return true;
  }
  if (["no", "false", "0"].includes(normalized)) {
    return false;
  }
  return undefined;
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
