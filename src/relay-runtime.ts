import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  createArtifactZipBundle,
  collectRecentWorkspaceArtifacts,
  getArtifactTurnReport,
  ensureOutDir,
  listRecentArtifactReports,
  persistWorkspaceArtifactReport,
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
  agentLabel,
  agentReasoningLabel,
  agentReasoningOptions,
  type AgentExternalSnapshot,
  type AgentId,
  type AgentPromptInput,
  type AgentPromptObject,
  type AgentSessionCallbacks,
  type AgentSessionInfo,
  type AgentSessionService,
  type AgentThreadRecord,
} from "./agent.js";
import {
  getAgentDiagnostics,
  getExternalSnapshotForSession,
} from "./agent-activity.js";
import { listAgentAdapterDescriptors } from "./agent-adapter.js";
import { AgentUpdateManager, type AgentUpdateJobSnapshot, type AgentUpdateOperation } from "./agent-updates.js";
import { createAgentSessionService, enabledAgents } from "./agent-factory.js";
import { AuditLogStore, type AuditEvent } from "./audit-log.js";
import { checkAuthStatus, startLogin as startCodexLogin, startLogout as startCodexLogout, type LoginResult } from "./codex-auth.js";
import { checkClaudeCodeAuthStatus, startClaudeCodeLogin, startClaudeCodeLogout } from "./claude-code-auth.js";
import type { ConnectorConfig } from "./config.js";
import { friendlyErrorText } from "./error-messages.js";
import { checkHermesAuthStatus, startHermesLogin, startHermesLogout } from "./hermes-auth.js";
import { checkOpenClawAuthStatus } from "./openclaw-auth.js";
import { clearLogFile, getAgentUpdateLogPath, getConnectorHealth, getConnectorLogPath, getPackageVersion, getUpdateLogPath, getVersionChecks, readConnectorState, readFormattedLogTail, spawnConnectorRestart, spawnSelfUpdate } from "./operations.js";
import { checkPiAuthStatus } from "./pi-auth.js";
import { PromptStore, toPromptEnvelope, type PromptEnvelope, type QueuedPrompt } from "./prompt-store.js";
import { renderSessionInfoPlain, renderSessionUsageRows } from "./session-format.js";
import { SessionLockStore, type SessionLock } from "./session-locks.js";
import { SessionRegistry } from "./session-registry.js";
import { createSupportBundle, type SupportBundleResult } from "./support-bundle.js";
import { transcribeAudio, type TranscriptionBackend } from "./voice.js";
import {
  WebActivityStore,
  WebChatStore,
  type WebActivityEvent,
  type WebActivitySource,
  type WebActivityStatus,
  type WebChatMessage,
} from "./web-state.js";
import type {
  ArtifactPreviewDto,
  ArtifactReportDto,
  DashboardControlOptions,
  ExternalMirrorState,
  QueueItemDto,
  RelayEvent,
  RelaySnapshot,
  SessionPageDto,
  UploadPromptFile,
  UploadPromptResult,
  WebAdapterHealthDto,
  WebAuthDto,
  WebDiagnosticsDto,
  WebPermissionsDto,
  WebTaskDto,
  WebTasksDto,
} from "./relay-runtime-types.js";
import { evaluateWorkspacePolicy, filterAllowedWorkspaces } from "./workspace-policy.js";

export type {
  ArtifactPreviewDto,
  ArtifactReportDto,
  DashboardControlOptions,
  ExternalMirrorState,
  QueueItemDto,
  RelayEvent,
  RelaySnapshot,
  SessionPageDto,
  UploadPromptFile,
  UploadPromptResult,
  WebAdapterHealthDto,
  WebAuthDto,
  WebDiagnosticsDto,
  WebPermissionsDto,
  WebTaskDto,
  WebTasksDto,
} from "./relay-runtime-types.js";

const WEB_CONTEXT_KEY = "web:dashboard";
const MAX_WEB_SESSION_PAGE_SIZE = 50;
const MAX_CHAT_HISTORY = 250;
const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;

export class RelayRuntime {
  private readonly registry: SessionRegistry;
  private readonly promptStore: PromptStore;
  private readonly chatStore: WebChatStore;
  private readonly activityStore: WebActivityStore;
  private readonly auditStore: AuditLogStore;
  private readonly lockStore: SessionLockStore;
  private readonly agentUpdates: AgentUpdateManager;
  private readonly subscribers = new Set<(event: RelayEvent) => void>();
  private readonly externalMonitor?: NodeJS.Timeout;
  private draining = false;
  private externalMonitorRunning = false;
  private currentTurnId: string | null = null;
  private accumulatedText = "";
  private currentTurnStartedAt = 0;
  private currentProgress: WebTaskDto | null = null;
  private externalMirror: ExternalMirrorState | null = null;

  constructor(private readonly config: ConnectorConfig) {
    this.registry = new SessionRegistry(config, {
      fileName: "web-contexts.json",
      sqliteKey: "web-contexts",
    });
    this.promptStore = new PromptStore(config.workspace, config.stateBackend);
    this.chatStore = new WebChatStore(config.workspace, config.stateBackend, MAX_CHAT_HISTORY);
    this.activityStore = new WebActivityStore(config.workspace, config.stateBackend, config.auditMaxEvents);
    this.auditStore = new AuditLogStore(config.workspace, config.stateBackend, config.auditMaxEvents);
    this.lockStore = new SessionLockStore(config.workspace, config.stateBackend);
    this.agentUpdates = new AgentUpdateManager({
      onUpdate: (job) => this.broadcast({ type: "agent_update", job }),
    });
    if (config.codexExternalBusyCheckMs > 0) {
      this.externalMonitor = setInterval(() => {
        void this.monitorExternalActivitySafe();
      }, config.codexExternalBusyCheckMs);
      this.externalMonitor.unref?.();
    }
  }

  subscribe(callback: (event: RelayEvent) => void): () => void {
    this.subscribers.add(callback);
    void this.snapshot().then((data) => callback({ type: "snapshot", data })).catch(() => {});
    void this.chatHistory().then((messages) => callback({ type: "chat_history", messages })).catch(() => {});
    callback({ type: "activity_update", events: this.activity({ limit: 50 }) });
    return () => this.subscribers.delete(callback);
  }

  async snapshot(): Promise<RelaySnapshot> {
    const session = await this.getSession(true);
    const info = this.publicInfo(session);
    return {
      session: info,
      sessionText: renderSessionInfoPlain(info),
      queue: this.queue(),
      queuePaused: this.queuePaused(),
      processing: session.isProcessing(),
      enabledAgents: enabledAgents(this.config),
      workspaces: filterAllowedWorkspaces(session.listWorkspaces(), this.config),
    };
  }

  async status(): Promise<Record<string, unknown>> {
    return {
      health: await getConnectorHealth({ piCliPath: this.config.piCliPath, hermesCliPath: this.config.hermesCliPath, openClawCliPath: this.config.openClawCliPath, claudeCodeCliPath: this.config.claudeCodeCliPath }),
      versionChecks: await getVersionChecks({ piCliPath: this.config.piCliPath, hermesCliPath: this.config.hermesCliPath, openClawCliPath: this.config.openClawCliPath, claudeCodeCliPath: this.config.claudeCodeCliPath }),
      snapshot: await this.snapshot(),
    };
  }

  async bootstrapStatus(): Promise<Record<string, unknown>> {
    return {
      health: {
        version: await getPackageVersion(),
        state: await readConnectorState(),
      },
      snapshot: await this.snapshot(),
    };
  }

  async version(): Promise<Record<string, unknown>> {
    return {
      health: await getConnectorHealth({ piCliPath: this.config.piCliPath, hermesCliPath: this.config.hermesCliPath, openClawCliPath: this.config.openClawCliPath, claudeCodeCliPath: this.config.claudeCodeCliPath }),
      state: await readConnectorState(),
      versionChecks: await getVersionChecks({ piCliPath: this.config.piCliPath, hermesCliPath: this.config.hermesCliPath, openClawCliPath: this.config.openClawCliPath, claudeCodeCliPath: this.config.claudeCodeCliPath }),
    };
  }

  updateConnector(): ReturnType<typeof spawnSelfUpdate> {
    const update = spawnSelfUpdate();
    this.broadcastStatus(`Update started with ${update.method}. Log: ${update.logPath}`, "warn");
    this.appendActivity({
      source: "web",
      status: "info",
      type: "update_started",
      threadId: null,
      workspace: this.config.workspace,
      detail: `${update.method}: ${update.summary}`,
    });
    this.appendAudit({
      action: "command",
      status: "ok",
      contextKey: WEB_CONTEXT_KEY,
      description: "update",
      detail: update.summary,
    });
    return update;
  }

  agentUpdateJobs(): AgentUpdateJobSnapshot[] {
    return this.agentUpdates.list();
  }

  startAgentUpdate(agentId: AgentId, operation: AgentUpdateOperation = "update"): AgentUpdateJobSnapshot {
    const job = this.agentUpdates.start(agentId, {
      piCliPath: this.config.piCliPath,
      hermesCliPath: this.config.hermesCliPath,
      openClawCliPath: this.config.openClawCliPath,
      claudeCodeCliPath: this.config.claudeCodeCliPath,
    }, operation);
    this.broadcastStatus(`${job.agentLabel} ${operation} started. Log: ${job.logPath}`, "warn");
    this.appendActivity({
      source: "web",
      status: "info",
      type: operation === "install" ? "agent_install_started" : "agent_update_started",
      agentId,
      threadId: null,
      workspace: this.config.workspace,
      detail: `${job.method}: ${job.summary}`,
    });
    this.appendAudit({
      action: "command",
      status: "ok",
      contextKey: WEB_CONTEXT_KEY,
      agentId,
      description: `${operation} ${agentId}`,
      detail: job.summary,
    });
    return job;
  }

  agentUpdateLog(id: string): ReturnType<AgentUpdateManager["readLog"]> {
    return this.agentUpdates.readLog(id);
  }

  deleteAgentUpdateLog(id: string): AgentUpdateJobSnapshot {
    const job = this.agentUpdates.deleteLog(id);
    this.appendAudit({
      action: "command",
      status: "ok",
      contextKey: WEB_CONTEXT_KEY,
      agentId: job.agentId,
      description: `delete update log ${id}`,
      detail: job.logPath,
    });
    return job;
  }

  sendAgentUpdateInput(id: string, input: string): AgentUpdateJobSnapshot {
    return this.agentUpdates.sendInput(id, input);
  }

  cancelAgentUpdate(id: string): AgentUpdateJobSnapshot {
    return this.agentUpdates.cancel(id);
  }

  async diagnostics(): Promise<WebDiagnosticsDto> {
    return {
      health: await getConnectorHealth({ piCliPath: this.config.piCliPath, hermesCliPath: this.config.hermesCliPath, openClawCliPath: this.config.openClawCliPath, claudeCodeCliPath: this.config.claudeCodeCliPath }),
      versionChecks: await getVersionChecks({ piCliPath: this.config.piCliPath, hermesCliPath: this.config.hermesCliPath, openClawCliPath: this.config.openClawCliPath, claudeCodeCliPath: this.config.claudeCodeCliPath }),
      snapshot: await this.snapshot(),
      runtime: {
        stateBackend: this.config.stateBackend,
        sourceWorkspace: this.config.workspace,
        queuePaused: this.promptStore.isPaused(WEB_CONTEXT_KEY),
        externalMirror: this.externalMirror ? { ...this.externalMirror } : null,
        agentDiagnostics: getAgentDiagnostics(await this.getSession(true), this.config),
      },
    };
  }

  async adapterHealth(): Promise<WebAdapterHealthDto[]> {
    const health = await getConnectorHealth({ piCliPath: this.config.piCliPath, hermesCliPath: this.config.hermesCliPath, openClawCliPath: this.config.openClawCliPath, claudeCodeCliPath: this.config.claudeCodeCliPath });
    const versions = await getVersionChecks({ piCliPath: this.config.piCliPath, hermesCliPath: this.config.hermesCliPath, openClawCliPath: this.config.openClawCliPath, claudeCodeCliPath: this.config.claudeCodeCliPath });
    return Promise.all(listAgentAdapterDescriptors().map(async (descriptor) => {
      const enabled = enabledAgents(this.config).includes(descriptor.id);
      const auth = descriptor.capabilities.auth && enabled
        ? await this.authStatus(descriptor.id).catch((error): WebAuthDto => ({
          agentId: descriptor.id,
          agentLabel: descriptor.label,
          supported: descriptor.capabilities.auth,
          authenticated: false,
          detail: friendlyErrorText(error),
          loginSupported: descriptor.capabilities.login,
          logoutSupported: descriptor.capabilities.logout,
        }))
        : null;
      const cli = cliHealthForAgent(descriptor.id, health);
      const version = versionCheckForAgent(descriptor.id, versions);
      return {
        id: descriptor.id,
        label: descriptor.label,
        enabled,
        status: descriptor.status === "available" ? (enabled ? "enabled" : "disabled") : "planned",
        auth: {
          supported: descriptor.capabilities.auth,
          authenticated: auth ? auth.authenticated : null,
          method: auth?.method,
          detail: auth?.detail,
        },
        cli,
        version: {
          installed: version.installedLabel,
          latest: version.latestVersion,
          status: version.status,
          detail: version.detail,
        },
        capabilities: descriptor.capabilities,
        notes: descriptor.notes,
      };
    }));
  }

  permissions(): WebPermissionsDto {
    return {
      mode: "users",
      message: "Access is managed by NordRelay users, groups, Telegram identities, and Telegram chat access records.",
    };
  }

  tasks(): WebTasksDto {
    return {
      current: this.currentProgress ? { ...this.currentProgress, tools: [...this.currentProgress.tools] } : null,
      external: this.externalTask(),
      queue: this.queue(),
      queuePaused: this.queuePaused(),
      recent: this.activity({ limit: 20 }),
    };
  }

  audit(limit = 50): AuditEvent[] {
    return this.auditStore.list(limit);
  }

  async supportBundle(): Promise<SupportBundleResult> {
    const bundle = await createSupportBundle({
      config: this.config,
      diagnostics: await this.diagnostics(),
      adapterHealth: await this.adapterHealth(),
      auditEvents: this.auditStore.list(100),
      agentUpdateJobs: this.agentUpdates.list(),
      source: "web",
    });
    this.appendActivity({
      source: "web",
      status: "info",
      type: "diagnostics_bundle_exported",
      threadId: null,
      workspace: this.config.workspace,
      detail: bundle.path,
    });
    this.appendAudit({
      action: "command",
      status: "ok",
      contextKey: WEB_CONTEXT_KEY,
      description: "export diagnostics bundle",
      detail: bundle.path,
    });
    return bundle;
  }

  locks(): SessionLock[] {
    return this.lockStore.list();
  }

  lockWebSession(ownerName = "Web dashboard"): SessionLock {
    const lock = this.lockStore.set(WEB_CONTEXT_KEY, 0, ownerName, this.config.sessionLockTtlMs);
    this.appendAudit({
      action: "lock_updated",
      status: "ok",
      contextKey: WEB_CONTEXT_KEY,
      description: "lock",
      detail: `locked by ${ownerName}`,
    });
    return lock;
  }

  unlockWebSession(): { removed: boolean; locks: SessionLock[] } {
    const removed = this.lockStore.clear(WEB_CONTEXT_KEY);
    this.appendAudit({
      action: "lock_updated",
      status: "ok",
      contextKey: WEB_CONTEXT_KEY,
      description: "unlock",
      detail: removed ? "unlocked" : "no lock",
    });
    return { removed, locks: this.locks() };
  }

  async controlOptions(agentId?: AgentId): Promise<DashboardControlOptions> {
    const { session, dispose } = await this.getControlSession(agentId);
    try {
      const info = this.publicInfo(session);
      const capabilities = info.capabilities ?? CODEX_AGENT_CAPABILITIES;
      if (capabilities.modelSelection) {
        await session.refreshModels().catch((error) => {
          console.warn(
            `Failed to refresh ${agentLabel(info.agentId)} models: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      return {
        models: capabilities.modelSelection ? session.listModels() : [],
        reasoningLabel: agentReasoningLabel(info.agentId),
        reasoningOptions: agentReasoningOptions(info.agentId),
        launchProfiles: capabilities.launchProfiles ? session.listLaunchProfiles() : [],
        workspaces: filterAllowedWorkspaces(session.listWorkspaces(), this.config),
        capabilities,
      };
    } finally {
      if (dispose) {
        session.dispose();
      }
    }
  }

  async authStatus(agentId?: AgentId): Promise<WebAuthDto> {
    const { session, dispose } = await this.getControlSession(agentId);
    try {
      const info = this.publicInfo(session);
      const capabilities = info.capabilities ?? CODEX_AGENT_CAPABILITIES;
      if (!capabilities.auth) {
        return {
          agentId: info.agentId,
          agentLabel: info.agentLabel,
          supported: false,
          authenticated: null,
          detail: `${info.agentLabel} authentication is managed outside NordRelay.`,
          loginSupported: false,
          logoutSupported: false,
          hostLoginCommand: hostLoginCommand(info, this.config),
          hostLogoutCommand: hostLogoutCommand(info, this.config),
        };
      }
      const status = await this.checkAgentAuth(info);
      return {
        agentId: info.agentId,
        agentLabel: info.agentLabel,
        supported: true,
        authenticated: status.authenticated,
        method: status.method,
        detail: status.detail,
        loginSupported: capabilities.login,
        logoutSupported: capabilities.logout,
        hostLoginCommand: hostLoginCommand(info, this.config),
        hostLogoutCommand: hostLogoutCommand(info, this.config),
      };
    } finally {
      if (dispose) {
        session.dispose();
      }
    }
  }

  async login(agentId?: AgentId): Promise<WebAuthDto & { result: LoginResult | null }> {
    const { session, dispose } = await this.getControlSession(agentId);
    try {
      const info = this.publicInfo(session);
      const capabilities = info.capabilities ?? CODEX_AGENT_CAPABILITIES;
      if (!capabilities.login) {
        return {
          ...(await this.authStatus(info.agentId)),
          result: {
            success: false,
            message: `${info.agentLabel} login is not managed by NordRelay. Run ${hostLoginCommand(info, this.config)} on the host.`,
          },
        };
      }
      if (!this.config.enableTelegramLogin) {
        return {
          ...(await this.authStatus(info.agentId)),
          result: {
            success: false,
            message: `Remote login is disabled. Run ${hostLoginCommand(info, this.config)} on the host.`,
          },
        };
      }
      const result = await this.startAgentLogin(info);
      this.appendAudit({
        action: "command",
        status: result.success ? "ok" : "failed",
        contextKey: WEB_CONTEXT_KEY,
        agentId: info.agentId,
        threadId: info.threadId,
        workspace: info.workspace,
        description: "login",
        detail: result.message,
      });
      return { ...(await this.authStatus(info.agentId)), result };
    } finally {
      if (dispose) {
        session.dispose();
      }
    }
  }

  async logout(agentId?: AgentId): Promise<WebAuthDto & { result: LoginResult | null }> {
    const { session, dispose } = await this.getControlSession(agentId);
    try {
      const info = this.publicInfo(session);
      const capabilities = info.capabilities ?? CODEX_AGENT_CAPABILITIES;
      if (!capabilities.logout) {
        return {
          ...(await this.authStatus(info.agentId)),
          result: {
            success: false,
            message: `${info.agentLabel} logout is not managed by NordRelay. Run ${hostLogoutCommand(info, this.config)} on the host.`,
          },
        };
      }
      if (!this.config.enableTelegramLogin) {
        return {
          ...(await this.authStatus(info.agentId)),
          result: {
            success: false,
            message: `Remote auth management is disabled. Run ${hostLogoutCommand(info, this.config)} on the host.`,
          },
        };
      }
      const current = await this.checkAgentAuth(info);
      if (current.method === "api-key") {
        return {
          ...(await this.authStatus(info.agentId)),
          result: {
            success: false,
            message: "Cannot logout while API-key authentication is configured. Remove the API key from .env to use CLI auth.",
          },
        };
      }
      const result = await this.startAgentLogout(info);
      this.appendAudit({
        action: "command",
        status: result.success ? "ok" : "failed",
        contextKey: WEB_CONTEXT_KEY,
        agentId: info.agentId,
        threadId: info.threadId,
        workspace: info.workspace,
        description: "logout",
        detail: result.message,
      });
      return { ...(await this.authStatus(info.agentId)), result };
    } finally {
      if (dispose) {
        session.dispose();
      }
    }
  }

  async chatHistory(limit = 200): Promise<WebChatMessage[]> {
    const session = await this.getSession(true);
    return this.chatStore.list(this.publicInfo(session).threadId, limit);
  }

  async sessionDetail(threadId: string): Promise<Record<string, unknown>> {
    const session = await this.getSession(true);
    const record = session.getSessionRecord(threadId);
    const active = this.publicInfo(session);
    return {
      record,
      active,
      usageRows: active.threadId === threadId ? renderSessionUsageRows(active) : [],
      messages: this.chatStore.list(threadId, 100),
      activity: this.activity({ limit: 100 }).filter((event) => event.threadId === threadId),
    };
  }

  async clearChatHistory(): Promise<{ removed: number; messages: WebChatMessage[] }> {
    const session = await this.getSession(true);
    const removed = this.chatStore.clear(this.publicInfo(session).threadId);
    const messages = await this.chatHistory();
    this.broadcast({ type: "chat_history", messages });
    return { removed, messages };
  }

  activity(options: { limit?: number; source?: WebActivitySource | "all"; status?: WebActivityStatus | "all" } = {}): WebActivityEvent[] {
    const currentInfo = this.registry.get(WEB_CONTEXT_KEY)?.getInfo();
    return this.activityStore.list(options).map((event) => this.enrichActivityEvent(event, currentInfo));
  }

  async retry(): Promise<{ queued: boolean; queueId?: string }> {
    const cached = this.promptStore.getLastPrompt(WEB_CONTEXT_KEY);
    if (!cached) {
      throw new Error("Nothing to retry. Send a message first.");
    }
    this.appendAudit({
      action: "command",
      status: "ok",
      contextKey: WEB_CONTEXT_KEY,
      description: "retry",
      detail: cached.description,
    });
    return this.sendEnvelope(cached);
  }

  async sync(): Promise<ReturnType<AgentSessionService["syncFromAgentState"]>> {
    const session = await this.getSession(true);
    const info = this.publicInfo(session);
    if (!(info.capabilities ?? CODEX_AGENT_CAPABILITIES).externalActivity) {
      throw new Error(`${info.agentLabel} has no external state watcher to sync.`);
    }
    const result = session.syncFromAgentState({ reattach: true });
    if (result.changed) {
      this.updateSession(session);
    }
    this.appendActivity({
      source: "web",
      status: "info",
      type: "session_sync",
      threadId: result.info.threadId,
      workspace: result.info.workspace,
      agentId: result.info.agentId,
      detail: result.changedFields.length > 0 ? result.changedFields.join(", ") : "already in sync",
    });
    this.appendAudit({
      action: "command",
      status: "ok",
      contextKey: WEB_CONTEXT_KEY,
      agentId: result.info.agentId,
      threadId: result.info.threadId,
      workspace: result.info.workspace,
      description: "sync",
      detail: result.changedFields.join(", ") || "none",
    });
    return result;
  }

  async listSessions(limit = 80, query = "", agentId?: AgentId): Promise<AgentThreadRecord[]> {
    const { session, dispose } = await this.getControlSession(agentId);
    try {
      return this.filteredSessions(session, query, Math.max(1, limit * 3)).slice(0, limit);
    } finally {
      if (dispose) {
        session.dispose();
      }
    }
  }

  async listSessionsPage(page = 1, pageSize = MAX_WEB_SESSION_PAGE_SIZE, query = "", agentId?: AgentId): Promise<SessionPageDto> {
    const { session, dispose } = await this.getControlSession(agentId);
    try {
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
    } finally {
      if (dispose) {
        session.dispose();
      }
    }
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
    const session = await this.getSession(true);
    const info = this.publicInfo(session);
    await session.refreshModels({ force: true }).catch((error) => {
      console.warn(
        `Failed to refresh ${agentLabel(info.agentId)} models: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return session.listModels();
  }

  async setAgent(agentId: AgentId): Promise<AgentSessionInfo> {
    if (!enabledAgents(this.config).includes(agentId)) {
      throw new Error(`Agent is not enabled: ${agentId}`);
    }
    const session = await this.registry.switchAgent(WEB_CONTEXT_KEY, agentId);
    this.updateSession(session);
    return this.publicInfo(session);
  }

  async newSession(options: {
    agentId?: AgentId;
    workspace?: string;
    model?: string;
    reasoningEffort?: string;
    launchProfileId?: string;
    fastMode?: boolean;
  } = {}): Promise<AgentSessionInfo> {
    const session = options.agentId ? await this.registry.switchAgent(WEB_CONTEXT_KEY, options.agentId) : await this.getSession(true);
    this.ensureIdle(session);
    if (options.reasoningEffort) {
      const reasoningOptions = agentReasoningOptions(session.getInfo().agentId);
      if (!reasoningOptions.includes(options.reasoningEffort as never)) {
        throw new Error(`Invalid ${agentReasoningLabel(session.getInfo().agentId)} value: ${options.reasoningEffort}`);
      }
      session.setReasoningEffort(options.reasoningEffort);
    }
    if (options.launchProfileId && (session.getInfo().capabilities ?? CODEX_AGENT_CAPABILITIES).launchProfiles) {
      session.setLaunchProfile(options.launchProfileId);
    }
    if (typeof options.fastMode === "boolean" && (session.getInfo().capabilities ?? CODEX_AGENT_CAPABILITIES).fastMode) {
      session.setFastMode(options.fastMode);
    }
    const info = await session.newThread(options.workspace, options.model);
    this.updateSession(session);
    this.appendActivity({
      source: "web",
      status: "info",
      type: "session_new",
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      detail: "New dashboard session created.",
    });
    return this.publicInfo(session);
  }

  async switchSession(threadId: string): Promise<AgentSessionInfo> {
    const session = await this.getSession(true);
    this.ensureIdle(session);
    const info = await session.switchSession(threadId);
    this.updateSession(session);
    this.broadcast({ type: "chat_history", messages: await this.chatHistory() });
    this.appendActivity({
      source: "web",
      status: "info",
      type: "session_switch",
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      detail: "Dashboard switched session.",
    });
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
    const options = agentReasoningOptions(session.getInfo().agentId);
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
    const snapshot = getExternalSnapshotForSession(session, this.config, { maxEvents: 0 });
    if (snapshot?.activity.active && !session.isProcessing()) {
      this.broadcast({
        type: "status",
        level: "warn",
        message: `Cannot abort the external ${snapshot.agentLabel} CLI task from NordRelay. Stop it in the terminal where it is running.`,
        at: new Date().toISOString(),
      });
      return;
    }
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
    const external = getExternalSnapshotForSession(session, this.config, { maxEvents: 0 });
    if (session.isProcessing() || external?.activity.active) {
      const queued = this.promptStore.enqueue(WEB_CONTEXT_KEY, envelope);
      const info = this.publicInfo(session);
      this.appendActivity({
        source: "web",
        status: "queued",
        type: "prompt_queued",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        prompt: envelope.description,
        detail: external?.activity.active
          ? `Queued because ${external.agentLabel} CLI is still processing another task.`
          : `Queued at position ${this.promptStore.list(WEB_CONTEXT_KEY).length}.`,
      });
      this.appendAudit({
        action: "prompt_queued",
        status: "ok",
        contextKey: WEB_CONTEXT_KEY,
        agentId: info.agentId,
        threadId: info.threadId,
        workspace: info.workspace,
        promptId: queued.id,
        description: envelope.description,
      });
      if (external?.activity.active) {
        this.broadcastStatus(`Waiting for ${external.agentLabel} CLI task... ${this.promptStore.list(WEB_CONTEXT_KEY).length} queued.`, "info");
      }
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

  queuePaused(): boolean {
    return this.promptStore.isPaused(WEB_CONTEXT_KEY);
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
    this.appendActivity({
      source: "web",
      status: "info",
      type: "queue_updated",
      threadId: null,
      workspace: this.config.workspace,
      detail: id ? `${action}: ${id}` : action,
    });
    this.appendAudit({
      action: "queue_updated",
      status: "ok",
      contextKey: WEB_CONTEXT_KEY,
      description: id ? `${action}: ${id}` : action,
    });
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

  async artifactPreview(turnId: string, relativePath: string): Promise<ArtifactPreviewDto | null> {
    const report = await this.artifact(turnId);
    const artifact = report?.artifacts.find((candidate) => candidate.relativePath.split(path.sep).join("/") === relativePath);
    if (!artifact) {
      return null;
    }
    const extension = path.extname(artifact.name).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(extension)) {
      return {
        kind: "image",
        name: artifact.name,
        sizeBytes: artifact.sizeBytes,
      };
    }
    if (!isPreviewableTextFile(extension, artifact.sizeBytes)) {
      return {
        kind: "unsupported",
        name: artifact.name,
        sizeBytes: artifact.sizeBytes,
        detail: artifact.sizeBytes > MAX_TEXT_PREVIEW_BYTES ? "File is too large for inline preview." : "File type is not previewable.",
      };
    }
    const buffer = await readFile(artifact.localPath);
    const truncated = buffer.byteLength > MAX_TEXT_PREVIEW_BYTES;
    return {
      kind: "text",
      name: artifact.name,
      sizeBytes: artifact.sizeBytes,
      truncated,
      text: buffer.subarray(0, MAX_TEXT_PREVIEW_BYTES).toString("utf8"),
    };
  }

  async logs(target: "connector" | "update" | "agent-updates" = "connector", lines = 100): Promise<ReturnType<typeof readFormattedLogTail>> {
    if (target === "update") {
      return readFormattedLogTail(lines, getUpdateLogPath());
    }
    if (target === "agent-updates") {
      return readFormattedLogTail(lines, getAgentUpdateLogPath());
    }
    return readFormattedLogTail(lines);
  }

  clearLogs(target: "connector" | "update" | "agent-updates" = "connector"): { ok: true; filePath: string; clearedAt: string } {
    const result = clearLogFile(target === "update" ? getUpdateLogPath() : target === "agent-updates" ? getAgentUpdateLogPath() : getConnectorLogPath());
    this.appendActivity({
      source: "web",
      status: "info",
      type: "logs_cleared",
      threadId: null,
      workspace: this.config.workspace,
      detail: `Cleared ${target} log.`,
    });
    return { ok: true, filePath: result.filePath, clearedAt: result.clearedAt.toISOString() };
  }

  restartConnector(): { ok: true; message: string } {
    spawnConnectorRestart();
    this.broadcastStatus("Restart requested. The dashboard may disconnect briefly.", "warn");
    this.appendActivity({
      source: "web",
      status: "info",
      type: "restart_requested",
      threadId: null,
      workspace: this.config.workspace,
      detail: "Dashboard requested a connector restart.",
    });
    return { ok: true, message: "Restart requested." };
  }

  dispose(): void {
    if (this.externalMonitor) {
      clearInterval(this.externalMonitor);
    }
    this.agentUpdates.cancelAll();
    this.registry.disposeAll();
    this.subscribers.clear();
  }

  private async monitorExternalActivity(): Promise<void> {
    const session = await this.getSession(true);
    const info = this.publicInfo(session);
    if (!info.capabilities.externalActivity || !info.threadId || session.isProcessing()) {
      return;
    }

    const snapshot = getExternalSnapshotForSession(session, this.config, {
      afterLine: this.externalMirror?.threadId === info.threadId ? this.externalMirror.lastLine : Number.MAX_SAFE_INTEGER,
    }) ?? getExternalSnapshotForSession(session, this.config, {
      maxEvents: 0,
    });
    if (!snapshot) {
      return;
    }

    if (!this.externalMirror || this.externalMirror.threadId !== snapshot.threadId || this.externalMirror.rolloutPath !== snapshot.sourcePath) {
      this.externalMirror = {
        threadId: snapshot.threadId,
        rolloutPath: snapshot.sourcePath,
        lastLine: snapshot.lineCount,
        turnId: snapshot.activity.turnId,
        startedAt: snapshot.activity.startedAt?.toISOString() ?? null,
      };
      if (snapshot.activity.active) {
        this.startExternalTurn(snapshot);
      }
      return;
    }

    const mirror = this.externalMirror;
    if (snapshot.activity.active) {
      if (mirror.turnId !== snapshot.activity.turnId) {
        mirror.turnId = snapshot.activity.turnId;
        mirror.startedAt = snapshot.activity.startedAt?.toISOString() ?? null;
        mirror.latestAgentLine = undefined;
        this.startExternalTurn(snapshot);
      }
      this.broadcastExternalEvents(snapshot, snapshot.events.filter((event) => event.lineNumber > mirror.lastLine));
      mirror.lastLine = Math.max(mirror.lastLine, snapshot.lineCount);
      mirror.latestStatus = externalStatusLine(snapshot, this.queue().length);
      this.broadcastStatus(mirror.latestStatus, "info");
      return;
    }

    const terminalEvent = [...snapshot.events].reverse().find((event) => event.kind === "task" && event.status && event.status !== "started");
    if (terminalEvent && terminalEvent.lineNumber > mirror.lastLine) {
      const finalAgent = snapshot.events.filter((event) => event.kind === "agent" && event.text).at(-1);
      const finalText = finalAgent?.text ?? snapshot.latestAgentMessage;
      const finalLine = finalAgent?.lineNumber ?? snapshot.lineCount;
      if (finalText && finalLine !== mirror.latestAgentLine) {
        this.chatStore.append({
          threadId: snapshot.threadId,
          role: "agent",
          text: finalText,
          source: "cli",
          turnId: terminalEvent.turnId ?? undefined,
        });
        this.broadcast({ type: "text_delta", id: terminalEvent.turnId ?? "cli", delta: finalText });
        mirror.latestAgentLine = finalLine;
      }
      const externalStartedAt = mirror.startedAt ? new Date(mirror.startedAt) : snapshot.activity.startedAt;
      this.broadcast({
        type: "turn_complete",
        id: terminalEvent.turnId ?? "cli",
        at: terminalEvent.timestamp?.toISOString() ?? new Date().toISOString(),
      });
      this.appendActivity({
        source: "cli",
        status: terminalEvent.status === "aborted" ? "aborted" : terminalEvent.status === "failed" ? "failed" : "completed",
        type: "cli_turn_finished",
        threadId: snapshot.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        prompt: snapshot.latestUserMessage ?? undefined,
        detail: `${snapshot.agentLabel} CLI task ${terminalEvent.status ?? "finished"}.`,
        durationMs: durationFromDates(externalStartedAt, terminalEvent.timestamp),
      });
      if (externalStartedAt && terminalEvent.turnId) {
        await this.persistWorkspaceArtifactsForTurn(info.workspace, terminalEvent.turnId, externalStartedAt);
      }
      mirror.latestStatus = `${snapshot.agentLabel} CLI task ${terminalEvent.status ?? "finished"}.`;
      this.broadcastStatus(
        `${snapshot.agentLabel} CLI task ${terminalEvent.status ?? "finished"}.`,
        terminalEvent.status === "failed" ? "error" : terminalEvent.status === "aborted" ? "warn" : "info",
      );
      this.broadcast({ type: "chat_history", messages: await this.chatHistory() });
      await this.drainQueue();
    }
    mirror.lastLine = Math.max(mirror.lastLine, snapshot.lineCount);
  }

  private async monitorExternalActivitySafe(): Promise<void> {
    if (this.externalMonitorRunning) {
      return;
    }
    this.externalMonitorRunning = true;
    try {
      await this.monitorExternalActivity();
    } catch (error) {
      this.broadcastStatus(friendlyErrorText(error), "error");
    } finally {
      this.externalMonitorRunning = false;
    }
  }

  private startExternalTurn(snapshot: AgentExternalSnapshot): void {
    const prompt = snapshot.latestUserMessage ?? `${snapshot.agentLabel} CLI task`;
    this.chatStore.append({
      threadId: snapshot.threadId,
      role: "user",
      text: prompt,
      source: "cli",
      turnId: snapshot.activity.turnId ?? undefined,
      timestamp: snapshot.activity.startedAt?.toISOString(),
    });
    this.broadcast({
      type: "turn_start",
      id: snapshot.activity.turnId ?? "cli",
      prompt,
      at: snapshot.activity.startedAt?.toISOString() ?? new Date().toISOString(),
      source: "cli",
    });
    this.appendActivity({
      source: "cli",
      status: "running",
      type: "cli_turn_started",
      threadId: snapshot.threadId,
      prompt,
      detail: `${snapshot.sourceLabel}: ${snapshot.sourcePath}`,
    });
  }

  private broadcastExternalEvents(snapshot: AgentExternalSnapshot, events: AgentExternalSnapshot["events"]): void {
    for (const event of events) {
      if (event.kind === "tool" && event.status === "started") {
        this.broadcast({
          type: "tool_start",
          id: snapshot.activity.turnId ?? "cli",
          toolCallId: `cli-${event.lineNumber}`,
          toolName: event.toolName ?? "tool",
        });
        this.appendActivity({
          source: "cli",
          status: "running",
          type: "cli_tool_started",
          threadId: snapshot.threadId,
          detail: event.toolName ?? "tool",
        });
      }
      if (event.kind === "tool" && event.status === "finished") {
        this.broadcast({
          type: "tool_end",
          id: snapshot.activity.turnId ?? "cli",
          toolCallId: `cli-${event.lineNumber}`,
          isError: false,
        });
      }
    }
  }

  private async getSession(deferThreadStart: boolean): Promise<AgentSessionService> {
    return this.registry.getOrCreate(WEB_CONTEXT_KEY, { deferThreadStart });
  }

  private async getControlSession(agentId?: AgentId): Promise<{ session: AgentSessionService; dispose: boolean }> {
    const active = await this.getSession(true);
    const activeInfo = this.publicInfo(active);
    if (!agentId || agentId === activeInfo.agentId) {
      return { session: active, dispose: false };
    }
    if (!enabledAgents(this.config).includes(agentId)) {
      throw new Error(`Agent is not enabled: ${agentId}`);
    }
    const session = await createAgentSessionService(this.config, agentId, {
      deferThreadStart: true,
      workspace: activeInfo.workspace,
    });
    return { session, dispose: true };
  }

  private async ensureActiveThread(session: AgentSessionService): Promise<void> {
    if (!session.hasActiveThread()) {
      await session.newThread();
      this.updateSession(session);
    }
  }

  private async checkAgentAuth(info: AgentSessionInfo): Promise<{ authenticated: boolean; detail: string; method?: string }> {
    if (info.agentId === "pi") {
      return checkPiAuthStatus(info.model);
    }
    if (info.agentId === "hermes") {
      return checkHermesAuthStatus({
        baseUrl: this.config.hermesApiBaseUrl,
        apiKey: this.config.hermesApiKey,
      });
    }
    if (info.agentId === "openclaw") {
      return checkOpenClawAuthStatus({
        gatewayUrl: this.config.openClawGatewayUrl,
        token: this.config.openClawGatewayToken,
        password: this.config.openClawGatewayPassword,
      });
    }
    if (info.agentId === "claude-code") {
      return checkClaudeCodeAuthStatus(this.config.claudeCodeCliPath);
    }
    return checkAuthStatus(this.config.codexApiKey);
  }

  private async startAgentLogin(info: AgentSessionInfo): Promise<LoginResult> {
    if (info.agentId === "hermes") {
      return startHermesLogin(this.config.hermesCliPath);
    }
    if (info.agentId === "claude-code") {
      return startClaudeCodeLogin(this.config.claudeCodeCliPath);
    }
    if (info.agentId === "codex") {
      return startCodexLogin();
    }
    return {
      success: false,
      message: `${info.agentLabel} login is not managed by NordRelay. Run the agent login flow on the host.`,
    };
  }

  private async startAgentLogout(info: AgentSessionInfo): Promise<LoginResult> {
    if (info.agentId === "hermes") {
      return startHermesLogout(this.config.hermesCliPath);
    }
    if (info.agentId === "claude-code") {
      return startClaudeCodeLogout(this.config.claudeCodeCliPath);
    }
    if (info.agentId === "codex") {
      return startCodexLogout();
    }
    return {
      success: false,
      message: `${info.agentLabel} logout is not managed by NordRelay. Run the agent logout flow on the host.`,
    };
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
      const auth = await this.checkAgentAuth(info);
      if (!auth.authenticated) {
        throw new Error(`${agentLabel(info.agentId)} is not authenticated: ${auth.detail}`);
      }
    }
    const workspacePolicy = evaluateWorkspacePolicy(session.getInfo().workspace, this.config);
    if (!workspacePolicy.allowed) {
      throw new Error(workspacePolicy.warning ?? "Current workspace is blocked by policy.");
    }

    const turnId = randomUUID().slice(0, 12);
    this.currentTurnId = turnId;
    this.currentTurnStartedAt = Date.now();
    this.accumulatedText = "";
    this.currentProgress = {
      id: turnId,
      source: "web",
      status: "running",
      prompt: envelope.description,
      agentId: info.agentId,
      agentLabel: info.agentLabel,
      threadId: info.threadId,
      workspace: info.workspace,
      startedAt: new Date(this.currentTurnStartedAt).toISOString(),
      updatedAt: new Date(this.currentTurnStartedAt).toISOString(),
      durationMs: 0,
      outputChars: 0,
      tools: [],
    };
    this.promptStore.setLastPrompt(WEB_CONTEXT_KEY, envelope);
    const startedDate = new Date();
    const startedAt = startedDate.toISOString();
    this.chatStore.append({
      threadId: info.threadId ?? "pending",
      role: "user",
      text: envelope.description,
      source: "web",
      turnId,
      timestamp: startedAt,
    });
    this.appendActivity({
      source: "web",
      status: "running",
      type: "prompt_started",
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      prompt: envelope.description,
    });
    this.appendAudit({
      action: "prompt_started",
      status: "ok",
      contextKey: WEB_CONTEXT_KEY,
      agentId: info.agentId,
      threadId: info.threadId,
      workspace: info.workspace,
      description: envelope.description,
    });
    this.broadcast({ type: "turn_start", id: turnId, prompt: envelope.description, at: startedAt, source: "web" });

    const callbacks: AgentSessionCallbacks = {
      onTextDelta: (delta) => {
        this.accumulatedText += delta;
        this.updateCurrentProgress({ outputChars: this.accumulatedText.length });
        this.broadcast({ type: "text_delta", id: turnId, delta });
      },
      onToolStart: (toolName, toolCallId) => {
        this.addCurrentTool(toolName);
        this.broadcast({ type: "tool_start", id: turnId, toolCallId, toolName });
      },
      onToolUpdate: (toolCallId, partialResult) => {
        this.updateCurrentProgress();
        this.broadcast({ type: "tool_update", id: turnId, toolCallId, partialResult });
      },
      onToolEnd: (toolCallId, isError) => {
        this.updateCurrentProgress({ currentTool: undefined });
        this.broadcast({ type: "tool_end", id: turnId, toolCallId, isError });
      },
      onTodoUpdate: (items) => {
        this.updateCurrentProgress({ detail: `Plan: ${items.filter((item) => item.completed).length}/${items.length} done` });
        this.broadcast({ type: "todo_update", id: turnId, items });
      },
      onTurnComplete: () => {},
      onAgentEnd: () => this.broadcast({ type: "turn_complete", id: turnId, at: new Date().toISOString() }),
    };

    try {
      await session.prompt(envelope.input as AgentPromptInput, callbacks);
      this.updateSession(session);
      await this.persistWorkspaceArtifactsForTurn(session.getInfo().workspace, turnId, startedDate);
      if (this.accumulatedText.trim()) {
        this.chatStore.append({
          threadId: info.threadId ?? "pending",
          role: "agent",
          text: this.accumulatedText,
          source: "web",
          turnId,
        });
      }
      this.appendActivity({
        source: "web",
        status: "completed",
        type: "prompt_completed",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        prompt: envelope.description,
        durationMs: Date.now() - this.currentTurnStartedAt,
      });
      this.appendAudit({
        action: "prompt_completed",
        status: "ok",
        contextKey: WEB_CONTEXT_KEY,
        agentId: info.agentId,
        threadId: info.threadId,
        workspace: info.workspace,
        description: envelope.description,
      });
      this.updateCurrentProgress({ status: "completed" });
      this.broadcast({ type: "turn_complete", id: turnId, at: new Date().toISOString() });
      this.broadcast({ type: "chat_history", messages: await this.chatHistory() });
    } catch (error) {
      const errorText = friendlyErrorText(error);
      this.chatStore.append({
        threadId: info.threadId ?? "pending",
        role: "system",
        text: `Error: ${errorText}`,
        source: "web",
        turnId,
      });
      this.appendActivity({
        source: "web",
        status: "failed",
        type: "prompt_failed",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        prompt: envelope.description,
        detail: errorText,
        durationMs: Date.now() - this.currentTurnStartedAt,
      });
      this.appendAudit({
        action: "prompt_failed",
        status: "failed",
        contextKey: WEB_CONTEXT_KEY,
        agentId: info.agentId,
        threadId: info.threadId,
        workspace: info.workspace,
        description: envelope.description,
        detail: errorText,
      });
      this.updateCurrentProgress({ status: "failed", detail: errorText });
      this.broadcast({ type: "turn_error", id: turnId, error: errorText, at: new Date().toISOString() });
      this.broadcast({ type: "chat_history", messages: await this.chatHistory() });
      throw error;
    } finally {
      this.currentTurnId = null;
      if (this.currentProgress) {
        this.currentProgress.durationMs = Date.now() - this.currentTurnStartedAt;
        this.currentProgress.updatedAt = new Date().toISOString();
      }
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
        const external = getExternalSnapshotForSession(session, this.config, { maxEvents: 0 });
        if (external?.activity.active) {
          this.broadcastStatus(`Waiting for ${external.agentLabel} CLI task... ${this.queue().length} queued.`, "info");
          return;
        }
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

  private appendActivity(input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }): WebActivityEvent {
    const event = this.activityStore.append(this.enrichActivityInput(input));
    this.broadcast({ type: "activity_update", events: this.activity({ limit: 50 }) });
    return event;
  }

  private enrichActivityInput<T extends Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }>(input: T): T {
    return this.enrichActivityFields(input) as T;
  }

  private enrichActivityEvent(event: WebActivityEvent, info?: AgentSessionInfo): WebActivityEvent {
    return this.enrichActivityFields(event, info) as WebActivityEvent;
  }

  private enrichActivityFields<T extends Pick<WebActivityEvent, "threadId"> & Partial<Pick<WebActivityEvent, "workspace" | "agentId">>>(event: T, info?: AgentSessionInfo): T {
    if (!info) {
      return !event.threadId && !event.workspace ? { ...event, workspace: this.config.workspace } : event;
    }
    if (event.threadId && info.threadId && event.threadId === info.threadId) {
      return { ...event, workspace: event.workspace ?? info.workspace, agentId: event.agentId ?? info.agentId };
    }
    if (!event.threadId && !event.workspace) {
      return { ...event, workspace: this.config.workspace };
    }
    return event;
  }

  private appendAudit(input: Omit<AuditEvent, "id" | "timestamp" | "channelId">): AuditEvent {
    return this.auditStore.append({ ...input, channelId: "web" });
  }

  private updateCurrentProgress(patch: Partial<WebTaskDto> = {}): void {
    if (!this.currentProgress) {
      return;
    }
    if ("currentTool" in patch) {
      this.currentProgress.currentTool = patch.currentTool;
      const { currentTool: _currentTool, ...rest } = patch;
      Object.assign(this.currentProgress, rest);
    } else {
      Object.assign(this.currentProgress, patch);
    }
    this.currentProgress.durationMs = Date.now() - this.currentTurnStartedAt;
    this.currentProgress.updatedAt = new Date().toISOString();
  }

  private addCurrentTool(toolName: string): void {
    if (!this.currentProgress) {
      return;
    }
    const existing = this.currentProgress.tools.find((tool) => tool.name === toolName);
    if (existing) {
      existing.count += 1;
    } else {
      this.currentProgress.tools.push({ name: toolName, count: 1 });
    }
    this.updateCurrentProgress({ currentTool: toolName, lastTool: toolName });
  }

  private externalTask(): WebTaskDto | null {
    if (!this.externalMirror) {
      return null;
    }
    const startedAt = this.externalMirror.startedAt ?? new Date().toISOString();
    const startedMs = new Date(startedAt).getTime();
    return {
      id: this.externalMirror.turnId ?? "cli",
      source: "cli",
      status: this.externalMirror.latestStatus?.includes("failed")
        ? "failed"
        : this.externalMirror.latestStatus?.includes("aborted")
          ? "aborted"
          : this.externalMirror.latestStatus?.includes("finished") || this.externalMirror.latestStatus?.includes("completed")
            ? "completed"
            : "running",
      threadId: this.externalMirror.threadId,
      startedAt,
      updatedAt: new Date().toISOString(),
      durationMs: Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0,
      outputChars: 0,
      tools: [],
      detail: this.externalMirror.latestStatus ?? this.externalMirror.rolloutPath,
    };
  }

  private broadcastQueue(): void {
    this.broadcast({ type: "queue_update", queue: this.queue(), paused: this.queuePaused() });
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

  private async persistWorkspaceArtifactsForTurn(workspace: string, turnId: string, startedAt: Date): Promise<void> {
    const report = await collectRecentWorkspaceArtifacts(workspace, {
      since: startedAt,
      until: new Date(),
      maxFileSize: this.config.maxFileSize,
      limit: 20,
      ignoreDirs: this.config.artifactIgnoreDirs,
      ignoreGlobs: this.config.artifactIgnoreGlobs,
    });
    if (report.artifacts.length === 0 && report.skippedCount === 0 && !report.omittedCount) {
      return;
    }
    await persistWorkspaceArtifactReport(workspace, turnId, report);
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

function externalStatusLine(snapshot: AgentExternalSnapshot, queueLength: number): string {
  const elapsed = snapshot.activity.startedAt
    ? formatDuration((Date.now() - snapshot.activity.startedAt.getTime()) / 1000)
    : "-";
  const tool = snapshot.latestToolName ?? "-";
  return `${snapshot.agentLabel} CLI running · ${elapsed} · tool ${tool} · ${queueLength} queued`;
}

function cliHealthForAgent(agentId: AgentId, health: Awaited<ReturnType<typeof getConnectorHealth>>): WebAdapterHealthDto["cli"] {
  if (agentId === "pi") {
    return { path: health.piCliPath, label: health.piCli, version: health.piCliVersion };
  }
  if (agentId === "hermes") {
    return { path: health.hermesCliPath, label: health.hermesCli, version: health.hermesCliVersion };
  }
  if (agentId === "openclaw") {
    return { path: health.openClawCliPath, label: health.openClawCli, version: health.openClawCliVersion };
  }
  if (agentId === "claude-code") {
    return { path: health.claudeCodeCliPath, label: health.claudeCodeCli, version: health.claudeCodeCliVersion };
  }
  return { path: health.codexCliPath, label: health.codexCli, version: health.codexCliVersion };
}

function versionCheckForAgent(agentId: AgentId, versions: Awaited<ReturnType<typeof getVersionChecks>>) {
  if (agentId === "pi") return versions.pi;
  if (agentId === "hermes") return versions.hermes;
  if (agentId === "openclaw") return versions.openclaw;
  if (agentId === "claude-code") return versions.claudeCode;
  return versions.codex;
}

function hostLoginCommand(info: AgentSessionInfo, config: ConnectorConfig): string {
  if (info.agentId === "hermes") {
    return `${config.hermesCliPath ?? "hermes"} login --no-browser`;
  }
  if (info.agentId === "claude-code") {
    return `${config.claudeCodeCliPath ?? "claude"} auth login`;
  }
  if (info.agentId === "pi") {
    return `${config.piCliPath ?? "pi"} auth login`;
  }
  if (info.agentId === "openclaw") {
    return `${config.openClawCliPath ?? "openclaw"} login`;
  }
  return "codex login --device-auth";
}

function hostLogoutCommand(info: AgentSessionInfo, config: ConnectorConfig): string {
  if (info.agentId === "hermes") {
    return `${config.hermesCliPath ?? "hermes"} logout`;
  }
  if (info.agentId === "claude-code") {
    return `${config.claudeCodeCliPath ?? "claude"} auth logout`;
  }
  if (info.agentId === "pi") {
    return `${config.piCliPath ?? "pi"} auth logout`;
  }
  if (info.agentId === "openclaw") {
    return `${config.openClawCliPath ?? "openclaw"} logout`;
  }
  return "codex logout";
}

function durationFromDates(start: Date | null, end: Date | null): number | undefined {
  if (!start || !end) {
    return undefined;
  }
  return Math.max(0, end.getTime() - start.getTime());
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "-";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
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

function isPreviewableTextFile(extension: string, sizeBytes: number): boolean {
  if (sizeBytes > MAX_TEXT_PREVIEW_BYTES * 4) {
    return false;
  }
  return [
    "",
    ".c",
    ".conf",
    ".cpp",
    ".css",
    ".csv",
    ".env",
    ".go",
    ".html",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".log",
    ".md",
    ".py",
    ".rb",
    ".rs",
    ".sh",
    ".sql",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
  ].includes(extension);
}
