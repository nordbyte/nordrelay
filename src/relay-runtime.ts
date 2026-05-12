import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  createArtifactZipBundle,
  getArtifactTurnReport,
  ensureOutDir,
  listRecentArtifactReports,
  removeArtifactTurn,
  totalArtifactSize,
  type ArtifactTurnReport,
} from "./artifacts.js";
import {
  buildFileInstructions,
  outboxPath,
  stageFile,
  type StagedFile,
} from "./attachments.js";
import {
  CODEX_AGENT_CAPABILITIES,
  CODEX_REASONING_EFFORTS,
  PI_THINKING_LEVELS,
  agentLabel,
  agentReasoningLabel,
  type AgentId,
  type AgentPromptInput,
  type AgentPromptObject,
  type AgentSessionCallbacks,
  type AgentSessionInfo,
  type AgentSessionService,
  type AgentThreadRecord,
} from "./agent.js";
import { enabledAgents } from "./agent-factory.js";
import { checkAuthStatus } from "./codex-auth.js";
import type { ConnectorConfig } from "./config.js";
import { friendlyErrorText } from "./error-messages.js";
import { getConnectorHealth, getVersionChecks, readFormattedLogTail } from "./operations.js";
import { PromptStore, toPromptEnvelope, type PromptEnvelope, type QueuedPrompt } from "./prompt-store.js";
import { renderSessionInfoPlain } from "./session-format.js";
import { SessionRegistry } from "./session-registry.js";
import { transcribeAudio, type TranscriptionBackend } from "./voice.js";
import { evaluateWorkspacePolicy, filterAllowedWorkspaces } from "./workspace-policy.js";

export type RelayEvent =
  | { type: "snapshot"; data: RelaySnapshot }
  | { type: "turn_start"; id: string; prompt: string; at: string }
  | { type: "text_delta"; id: string; delta: string }
  | { type: "tool_start"; id: string; toolCallId: string; toolName: string }
  | { type: "tool_update"; id: string; toolCallId: string; partialResult: string }
  | { type: "tool_end"; id: string; toolCallId: string; isError: boolean }
  | { type: "todo_update"; id: string; items: Array<{ text: string; completed: boolean }> }
  | { type: "turn_complete"; id: string; at: string }
  | { type: "turn_error"; id: string; error: string; at: string }
  | { type: "queue_update"; queue: QueueItemDto[] }
  | { type: "session_update"; session: AgentSessionInfo }
  | { type: "status"; message: string; level: "info" | "warn" | "error"; at: string };

export interface RelaySnapshot {
  session: AgentSessionInfo;
  sessionText: string;
  queue: QueueItemDto[];
  processing: boolean;
  enabledAgents: AgentId[];
  workspaces: string[];
}

export interface QueueItemDto {
  id: string;
  description: string;
  createdAt: string;
  attempts: number;
  notBefore?: string;
  lastError?: string;
}

export interface ArtifactReportDto {
  turnId: string;
  updatedAt: string;
  source?: string;
  fileCount: number;
  totalSizeBytes: number;
  skippedCount: number;
  omittedCount?: number;
  artifacts: Array<{
    name: string;
    relativePath: string;
    sizeBytes: number;
  }>;
}

export interface SessionPageDto {
  sessions: AgentThreadRecord[];
  pagination: {
    page: number;
    pageSize: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
}

export interface UploadPromptFile {
  name: string;
  mimeType?: string;
  data: Buffer;
}

export interface UploadPromptResult {
  queued: boolean;
  queueId?: string;
  transcript?: string;
  transcribeOnly?: boolean;
  files: Array<{
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}

const WEB_CONTEXT_KEY = "0";
const MAX_WEB_SESSION_PAGE_SIZE = 50;

export class RelayRuntime {
  private readonly registry: SessionRegistry;
  private readonly promptStore: PromptStore;
  private readonly subscribers = new Set<(event: RelayEvent) => void>();
  private draining = false;
  private currentTurnId: string | null = null;
  private accumulatedText = "";

  constructor(private readonly config: ConnectorConfig) {
    this.registry = new SessionRegistry(config);
    this.promptStore = new PromptStore(config.workspace, config.stateBackend);
  }

  subscribe(callback: (event: RelayEvent) => void): () => void {
    this.subscribers.add(callback);
    void this.snapshot().then((data) => callback({ type: "snapshot", data })).catch(() => {});
    return () => this.subscribers.delete(callback);
  }

  async snapshot(): Promise<RelaySnapshot> {
    const session = await this.getSession(true);
    const info = this.publicInfo(session);
    return {
      session: info,
      sessionText: renderSessionInfoPlain(info),
      queue: this.queue(),
      processing: session.isProcessing(),
      enabledAgents: enabledAgents(this.config),
      workspaces: filterAllowedWorkspaces(session.listWorkspaces(), this.config),
    };
  }

  async status(): Promise<Record<string, unknown>> {
    return {
      health: await getConnectorHealth(),
      versionChecks: await getVersionChecks({ piCliPath: this.config.piCliPath }),
      snapshot: await this.snapshot(),
    };
  }

  async listSessions(limit = 80, query = ""): Promise<AgentThreadRecord[]> {
    return this.filteredSessions(await this.getSession(true), query, Math.max(1, limit * 3)).slice(0, limit);
  }

  async listSessionsPage(page = 1, pageSize = MAX_WEB_SESSION_PAGE_SIZE, query = ""): Promise<SessionPageDto> {
    const session = await this.getSession(true);
    const effectivePage = Math.max(1, Math.floor(page));
    const effectivePageSize = Math.min(MAX_WEB_SESSION_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
    const offset = (effectivePage - 1) * effectivePageSize;
    const requested = Math.min(5_000, Math.max(100, (offset + effectivePageSize + 1) * 3));
    const records = this.filteredSessions(session, query, requested);
    return {
      sessions: records.slice(offset, offset + effectivePageSize),
      pagination: {
        page: effectivePage,
        pageSize: effectivePageSize,
        hasPrevious: effectivePage > 1,
        hasNext: records.length > offset + effectivePageSize,
      },
    };
  }

  private filteredSessions(session: AgentSessionService, query: string, limit: number): AgentThreadRecord[] {
    const normalized = query.trim().toLowerCase();
    return session.listAllSessions(limit)
      .filter((record) => evaluateWorkspacePolicy(record.cwd, this.config).allowed)
      .filter((record) => {
        if (!normalized) {
          return true;
        }
        return [
          record.id,
          record.title,
          record.cwd,
          record.model,
          record.reasoningEffort,
          record.firstUserMessage,
        ].some((value) => value?.toLowerCase().includes(normalized));
      });
  }

  async listModels(): Promise<ReturnType<AgentSessionService["listModels"]>> {
    return (await this.getSession(true)).listModels();
  }

  async setAgent(agentId: AgentId): Promise<AgentSessionInfo> {
    if (!enabledAgents(this.config).includes(agentId)) {
      throw new Error(`Agent is not enabled: ${agentId}`);
    }
    const session = await this.registry.switchAgent(WEB_CONTEXT_KEY, agentId);
    this.updateSession(session);
    return this.publicInfo(session);
  }

  async newSession(options: { workspace?: string; model?: string } = {}): Promise<AgentSessionInfo> {
    const session = await this.getSession(true);
    this.ensureIdle(session);
    const info = await session.newThread(options.workspace, options.model);
    this.updateSession(session);
    return this.publicInfo(session);
  }

  async switchSession(threadId: string): Promise<AgentSessionInfo> {
    const session = await this.getSession(true);
    this.ensureIdle(session);
    const info = await session.switchSession(threadId);
    this.updateSession(session);
    return this.publicInfo(session);
  }

  async attachSession(threadId: string): Promise<AgentSessionInfo> {
    return this.switchSession(threadId);
  }

  async setModel(model: string): Promise<AgentSessionInfo> {
    const session = await this.getSession(true);
    this.ensureIdle(session);
    await session.setModelForCurrentSession(model);
    this.updateSession(session);
    return this.publicInfo(session);
  }

  async setReasoningEffort(effort: string): Promise<AgentSessionInfo> {
    const session = await this.getSession(true);
    this.ensureIdle(session);
    const options = session.getInfo().agentId === "pi" ? PI_THINKING_LEVELS : CODEX_REASONING_EFFORTS;
    if (!options.includes(effort as never)) {
      throw new Error(`Invalid ${agentReasoningLabel(session.getInfo().agentId)} value: ${effort}`);
    }
    await session.setReasoningEffortForCurrentSession(effort);
    this.updateSession(session);
    return this.publicInfo(session);
  }

  async setFastMode(enabled: boolean): Promise<AgentSessionInfo> {
    const session = await this.getSession(true);
    this.ensureIdle(session);
    if (!(session.getInfo().capabilities ?? CODEX_AGENT_CAPABILITIES).fastMode) {
      throw new Error(`Fast mode is not supported for ${agentLabel(session.getInfo().agentId)}.`);
    }
    session.setFastMode(enabled);
    this.updateSession(session);
    return this.publicInfo(session);
  }

  async setLaunchProfile(profileId: string): Promise<AgentSessionInfo> {
    const session = await this.getSession(true);
    this.ensureIdle(session);
    session.setLaunchProfile(profileId);
    this.updateSession(session);
    return this.publicInfo(session);
  }

  async handback(): Promise<ReturnType<AgentSessionService["handback"]>> {
    const session = await this.getSession(true);
    this.ensureIdle(session);
    const result = session.handback();
    this.updateSession(session);
    return result;
  }

  async abort(): Promise<void> {
    const session = await this.getSession(true);
    await session.abort();
    this.broadcast({ type: "status", level: "warn", message: "Current operation aborted.", at: new Date().toISOString() });
  }

  async sendPrompt(text: string): Promise<{ queued: boolean; queueId?: string }> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Prompt is empty.");
    }
    return this.sendEnvelope(toPromptEnvelope(trimmed));
  }

  async sendUploadPrompt(options: { text?: string; files: UploadPromptFile[] }): Promise<UploadPromptResult> {
    const text = options.text?.trim() ?? "";
    const files = options.files.filter((file) => file.data.byteLength > 0);
    if (!text && files.length === 0) {
      throw new Error("Prompt is empty.");
    }

    const session = await this.getSession(false);
    const workspace = session.getInfo().workspace;
    const turnId = randomUUID().slice(0, 12);
    const outDir = outboxPath(workspace, turnId);
    await ensureOutDir(outDir);

    const stagedFiles: StagedFile[] = [];
    const imagePaths: string[] = [];
    const transcriptParts: string[] = [];

    for (const [index, file] of files.entries()) {
      const mimeType = normalizeMimeType(file.mimeType, file.name);
      const staged = await stageFile(file.data, file.name || `upload-${index + 1}`, mimeType, {
        workspace,
        turnId,
        maxFileSize: this.config.maxFileSize,
      });
      stagedFiles.push(staged);

      if (mimeType.startsWith("image/")) {
        imagePaths.push(staged.localPath);
      }

      if (mimeType.startsWith("audio/")) {
        const result = await transcribeAudio(staged.localPath, {
          preferredBackend: this.config.voicePreferredBackend === "auto"
            ? undefined
            : this.config.voicePreferredBackend as TranscriptionBackend,
          language: this.config.voiceDefaultLanguage,
        });
        const transcript = result.text.trim();
        if (transcript) {
          transcriptParts.push(`Audio transcript (${staged.safeName}, via ${result.backend}):\n${transcript}`);
        }
      }
    }

    const audioOnly = stagedFiles.length > 0 && stagedFiles.every((file) => file.mimeType.startsWith("audio/"));
    if (this.config.voiceTranscribeOnly && audioOnly && !text) {
      return {
        queued: false,
        transcript: transcriptParts.join("\n\n"),
        transcribeOnly: true,
        files: uploadFileDtos(stagedFiles),
      };
    }

    const promptInput: AgentPromptObject = {};
    const textParts = [text, ...transcriptParts].filter(Boolean);
    if (textParts.length > 0) {
      promptInput.text = textParts.join("\n\n");
    }
    if (imagePaths.length > 0) {
      promptInput.imagePaths = imagePaths;
    }
    if (stagedFiles.length > 0) {
      promptInput.stagedFileInstructions = buildFileInstructions(stagedFiles, outDir);
    }

    const result = await this.sendEnvelope(toPromptEnvelope(promptInput, outDir));
    return {
      ...result,
      transcript: transcriptParts.join("\n\n") || undefined,
      files: uploadFileDtos(stagedFiles),
    };
  }

  private async sendEnvelope(envelope: PromptEnvelope): Promise<{ queued: boolean; queueId?: string }> {
    const session = await this.getSession(false);
    if (session.isProcessing()) {
      const queued = this.promptStore.enqueue(WEB_CONTEXT_KEY, envelope);
      this.broadcastQueue();
      return { queued: true, queueId: queued.id };
    }

    void this.runPrompt(session, envelope).catch((error) => {
      this.broadcast({ type: "turn_error", id: this.currentTurnId ?? "turn", error: friendlyErrorText(error), at: new Date().toISOString() });
    });
    return { queued: false };
  }

  queue(): QueueItemDto[] {
    return this.promptStore.list(WEB_CONTEXT_KEY).map(queueItemDto);
  }

  queueAction(action: "pause" | "resume" | "clear" | "cancel" | "top" | "up" | "down" | "run", id?: string): QueueItemDto[] {
    if (action === "pause") this.promptStore.pause(WEB_CONTEXT_KEY);
    if (action === "resume") this.promptStore.resume(WEB_CONTEXT_KEY);
    if (action === "clear") this.promptStore.clear(WEB_CONTEXT_KEY);
    if (id && action === "cancel") this.promptStore.remove(WEB_CONTEXT_KEY, id);
    if (id && action === "top") this.promptStore.moveToTop(WEB_CONTEXT_KEY, id);
    if (id && action === "up") this.promptStore.moveUp(WEB_CONTEXT_KEY, id);
    if (id && action === "down") this.promptStore.moveDown(WEB_CONTEXT_KEY, id);
    if (id && action === "run") {
      const item = this.promptStore.remove(WEB_CONTEXT_KEY, id);
      if (item) this.promptStore.enqueueFront(WEB_CONTEXT_KEY, item);
      void this.drainQueue().catch((error) => this.broadcastStatus(friendlyErrorText(error), "error"));
    }
    this.broadcastQueue();
    return this.queue();
  }

  async artifacts(): Promise<ArtifactReportDto[]> {
    const session = await this.getSession(true);
    return (await listRecentArtifactReports(session.getInfo().workspace, 20, this.config.maxFileSize)).map(artifactDto);
  }

  async artifact(turnId: string): Promise<ArtifactTurnReport | null> {
    const session = await this.getSession(true);
    return getArtifactTurnReport(session.getInfo().workspace, turnId, this.config.maxFileSize);
  }

  async deleteArtifact(turnId: string): Promise<boolean> {
    const session = await this.getSession(true);
    return removeArtifactTurn(session.getInfo().workspace, turnId);
  }

  async createArtifactZip(turnId: string): Promise<{ path: string; name: string } | null> {
    const report = await this.artifact(turnId);
    if (!report) {
      return null;
    }
    const bundle = await createArtifactZipBundle(report.artifacts, report.outDir, {
      maxFileSize: this.config.maxFileSize,
      bundleName: `nordrelay-artifacts-${turnId}.zip`,
    });
    return bundle ? { path: bundle.localPath, name: bundle.name } : null;
  }

  async logs(target: "connector" | "update" = "connector", lines = 100): Promise<ReturnType<typeof readFormattedLogTail>> {
    if (target === "update") {
      const { getUpdateLogPath } = await import("./operations.js");
      return readFormattedLogTail(lines, getUpdateLogPath());
    }
    return readFormattedLogTail(lines);
  }

  dispose(): void {
    this.registry.disposeAll();
    this.subscribers.clear();
  }

  private async getSession(deferThreadStart: boolean): Promise<AgentSessionService> {
    return this.registry.getOrCreate(WEB_CONTEXT_KEY, { deferThreadStart });
  }

  private async ensureActiveThread(session: AgentSessionService): Promise<void> {
    if (!session.hasActiveThread()) {
      await session.newThread();
      this.updateSession(session);
    }
  }

  private ensureIdle(session: AgentSessionService): void {
    if (session.isProcessing()) {
      throw new Error("The active session is still processing a turn.");
    }
  }

  private async runPrompt(session: AgentSessionService, envelope: PromptEnvelope): Promise<void> {
    await this.ensureActiveThread(session);
    const info = session.getInfo();
    if ((info.capabilities ?? CODEX_AGENT_CAPABILITIES).auth) {
      const auth = await checkAuthStatus(this.config.codexApiKey);
      if (!auth.authenticated) {
        throw new Error(`Codex is not authenticated: ${auth.detail}`);
      }
    }
    const workspacePolicy = evaluateWorkspacePolicy(session.getInfo().workspace, this.config);
    if (!workspacePolicy.allowed) {
      throw new Error(workspacePolicy.warning ?? "Current workspace is blocked by policy.");
    }

    const turnId = randomUUID().slice(0, 12);
    this.currentTurnId = turnId;
    this.accumulatedText = "";
    this.promptStore.setLastPrompt(WEB_CONTEXT_KEY, envelope);
    this.broadcast({ type: "turn_start", id: turnId, prompt: envelope.description, at: new Date().toISOString() });

    const callbacks: AgentSessionCallbacks = {
      onTextDelta: (delta) => {
        this.accumulatedText += delta;
        this.broadcast({ type: "text_delta", id: turnId, delta });
      },
      onToolStart: (toolName, toolCallId) => this.broadcast({ type: "tool_start", id: turnId, toolCallId, toolName }),
      onToolUpdate: (toolCallId, partialResult) => this.broadcast({ type: "tool_update", id: turnId, toolCallId, partialResult }),
      onToolEnd: (toolCallId, isError) => this.broadcast({ type: "tool_end", id: turnId, toolCallId, isError }),
      onTodoUpdate: (items) => this.broadcast({ type: "todo_update", id: turnId, items }),
      onTurnComplete: () => {},
      onAgentEnd: () => this.broadcast({ type: "turn_complete", id: turnId, at: new Date().toISOString() }),
    };

    try {
      await session.prompt(envelope.input as AgentPromptInput, callbacks);
      this.updateSession(session);
      this.broadcast({ type: "turn_complete", id: turnId, at: new Date().toISOString() });
    } catch (error) {
      this.broadcast({ type: "turn_error", id: turnId, error: friendlyErrorText(error), at: new Date().toISOString() });
      throw error;
    } finally {
      this.currentTurnId = null;
      await this.drainQueue();
    }
  }

  private async drainQueue(): Promise<void> {
    if (this.draining || this.promptStore.isPaused(WEB_CONTEXT_KEY)) {
      return;
    }
    this.draining = true;
    try {
      const session = await this.getSession(false);
      while (!session.isProcessing()) {
        const next = this.promptStore.dequeue(WEB_CONTEXT_KEY);
        this.broadcastQueue();
        if (!next) {
          return;
        }
        await this.runPrompt(session, next);
      }
    } finally {
      this.draining = false;
    }
  }

  private updateSession(session: AgentSessionService): void {
    this.registry.updateMetadata(WEB_CONTEXT_KEY, session);
    this.broadcast({ type: "session_update", session: this.publicInfo(session) });
  }

  private broadcastQueue(): void {
    this.broadcast({ type: "queue_update", queue: this.queue() });
  }

  private broadcastStatus(message: string, level: "info" | "warn" | "error" = "info"): void {
    this.broadcast({ type: "status", message, level, at: new Date().toISOString() });
  }

  private broadcast(event: RelayEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  private publicInfo(session: AgentSessionService): AgentSessionInfo {
    const info = session.getInfo();
    const agentId = info.agentId ?? "codex";
    return {
      ...info,
      agentId,
      agentLabel: info.agentLabel ?? agentLabel(agentId),
      capabilities: info.capabilities ?? CODEX_AGENT_CAPABILITIES,
    };
  }
}

function queueItemDto(item: QueuedPrompt): QueueItemDto {
  return {
    id: item.id,
    description: item.description,
    createdAt: new Date(item.createdAt).toISOString(),
    attempts: item.attempts ?? 0,
    notBefore: item.notBefore ? new Date(item.notBefore).toISOString() : undefined,
    lastError: item.lastError,
  };
}

function artifactDto(report: ArtifactTurnReport): ArtifactReportDto {
  return {
    turnId: report.turnId,
    updatedAt: report.updatedAt.toISOString(),
    source: report.source,
    fileCount: report.artifacts.length,
    totalSizeBytes: totalArtifactSize(report.artifacts),
    skippedCount: report.skippedCount,
    omittedCount: report.omittedCount,
    artifacts: report.artifacts.map((artifact) => ({
      name: artifact.name,
      relativePath: artifact.relativePath.split(path.sep).join("/"),
      sizeBytes: artifact.sizeBytes,
    })),
  };
}

function normalizeMimeType(value: string | undefined, name: string): string {
  const configured = value?.trim();
  if (configured) {
    return configured;
  }
  const extension = path.extname(name).toLowerCase();
  if ([".jpg", ".jpeg"].includes(extension)) return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".ogg" || extension === ".oga") return "audio/ogg";
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".webm") return "audio/webm";
  return "application/octet-stream";
}

function uploadFileDtos(files: StagedFile[]): UploadPromptResult["files"] {
  return files.map((file) => ({
    name: file.safeName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  }));
}
