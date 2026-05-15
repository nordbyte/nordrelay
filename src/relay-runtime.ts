import { randomUUID } from "node:crypto";

import { ensureOutDir, type ArtifactTurnReport } from "./artifacts.js";
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
  isAgentId,
  type AgentCapabilities,
  type AgentId,
  type AgentPromptObject,
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
import { AuditLogStore, type AuditEvent, type AuditListOptions } from "./audit-log.js";
import { BotPreferencesStore } from "./bot-preferences.js";
import { ChannelCommandService } from "./channel-command-service.js";
import { ChannelTurnService } from "./channel-turn-service.js";
import { activeSessionSourceForContextKey, ChannelMirrorRegistry } from "./channel-mirror-registry.js";
import { checkAuthStatus, startLogin as startCodexLogin, startLogout as startCodexLogout, type LoginResult } from "./codex-auth.js";
import { checkClaudeCodeAuthStatus, startClaudeCodeLogin, startClaudeCodeLogout } from "./claude-code-auth.js";
import { listThreads as listCodexThreads } from "./codex-state.js";
import type { ConnectorConfig } from "./config.js";
import type { ChannelContextKey } from "./context-key.js";
import { friendlyErrorText } from "./error-messages.js";
import { checkHermesAuthStatus, startHermesLogin, startHermesLogout } from "./hermes-auth.js";
import { checkOpenClawAuthStatus } from "./openclaw-auth.js";
import { clearLogFile, getAgentUpdateLogPath, getConnectorHealth, getConnectorLogPath, getPackageVersion, getUpdateLogPath, getVersionChecks, readConnectorState, readFormattedLogTail, spawnConnectorRestart, spawnSelfUpdate } from "./operations.js";
import { checkPiAuthStatus } from "./pi-auth.js";
import { PromptStore, toPromptEnvelope, type PromptEnvelope } from "./prompt-store.js";
import { UnifiedJobStore } from "./job-store.js";
import { buildRuntimeMetrics, type RuntimeMetricsDto } from "./metrics.js";
import { RelayArtifactService } from "./relay-artifact-service.js";
import { RelayExternalActivityMonitor } from "./relay-external-activity-monitor.js";
import { RelayQueueService, type RelayQueueAction } from "./relay-queue-service.js";
import { RuntimeSnapshotCache } from "./runtime-cache.js";
import {
  activeSessionPriority,
  activityToUnifiedJob,
  agentUpdateStatusToUnified,
  cliHealthForAgent,
  dedupeJobs,
  hostLoginCommand,
  hostLogoutCommand,
  isPromptTerminalActivity,
  normalizeMimeType,
  promptActivityToUnifiedJob,
  shouldRefreshActiveSessions,
  taskToUnifiedJob,
  uploadFileDtos,
  versionCheckForAgent,
} from "./relay-runtime-helpers.js";
import { capabilitiesOf } from "./bot-rendering.js";
import { renderSessionInfoPlain, renderSessionUsageRows } from "./session-format.js";
import { SessionLockStore, type SessionLock } from "./session-locks.js";
import { SessionRegistry, type ContextMetadata } from "./session-registry.js";
import { collectSlackDiagnostics } from "./slack-diagnostics.js";
import { getSlackRateLimitMetrics } from "./slack-rate-limit.js";
import { createSupportBundle, type SupportBundleResult } from "./support-bundle.js";
import { transcribeAudio, type TranscriptionBackend } from "./voice.js";
import {
  WebActivityStore,
  WebChatStore,
  type WebActivityActor,
  type WebActivityCategory,
  type WebActivityEvent,
  type WebActivitySource,
  type WebActivityStatus,
  type WebChatMessage,
} from "./web-state.js";
import type {
  ActiveSessionDto,
  ActiveSessionsDto,
  ArtifactPreviewDto,
  ArtifactReportDto,
  DashboardControlOptions,
  QueueItemDto,
  RelayEvent,
  RelaySnapshot,
  SessionPageDto,
  UnifiedJobDto,
  UnifiedJobsDto,
  UploadPromptFile,
  UploadPromptResult,
  WebAdapterHealthDto,
  WebAuthDto,
  WebDiagnosticsDto,
  WebPermissionsDto,
  WebTaskDto,
  WebTasksDto,
} from "./relay-runtime-types.js";
export type { RuntimeMetricsDto } from "./metrics.js";
import { evaluateWorkspacePolicy, filterAllowedWorkspaces } from "./workspace-policy.js";

export type {
  ActiveSessionDto,
  ActiveSessionsDto,
  ArtifactPreviewDto,
  ArtifactReportDto,
  DashboardControlOptions,
  ExternalMirrorState,
  QueueItemDto,
  RelayEvent,
  RelaySnapshot,
  SessionPageDto,
  UnifiedJobDto,
  UnifiedJobsDto,
  UploadPromptFile,
  UploadPromptResult,
  WebAdapterHealthDto,
  WebAuthDto,
  WebDiagnosticsDto,
  WebPermissionsDto,
  WebTaskDto,
  WebTasksDto,
} from "./relay-runtime-types.js";

export const WEB_CONTEXT_KEY = "web:dashboard";
const ACTIVE_CODEX_DISCOVERY_LIMIT = 200;
const ACTIVE_ACTIVITY_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_WEB_SESSION_PAGE_SIZE = 50;
const MAX_CHAT_HISTORY = 250;

export interface RelayRuntimeOptions {
  contextKey?: ChannelContextKey;
  registryFileName?: string;
  registrySqliteKey?: string;
}

export class RelayRuntime {
  private readonly contextKey: ChannelContextKey;
  private readonly registry: SessionRegistry;
  private readonly promptStore: PromptStore;
  private readonly chatStore: WebChatStore;
  private readonly activityStore: WebActivityStore;
  private readonly auditStore: AuditLogStore;
  private readonly preferencesStore: BotPreferencesStore;
  private readonly lockStore: SessionLockStore;
  private readonly agentUpdates: AgentUpdateManager;
  private readonly queueService: RelayQueueService;
  private readonly jobStore: UnifiedJobStore;
  private readonly artifactService: RelayArtifactService;
  private readonly mirrorRegistry: ChannelMirrorRegistry;
  private readonly externalActivityMonitor: RelayExternalActivityMonitor;
  private readonly cache = new RuntimeSnapshotCache();
  private readonly turnService: ChannelTurnService;
  private readonly subscribers = new Set<(event: RelayEvent) => void>();
  private readonly agentUpdateActors = new Map<string, WebActivityActor>();
  private readonly agentUpdateStates = new Map<string, { status: AgentUpdateJobSnapshot["status"]; needsInput: boolean }>();
  private readonly externalMonitor?: NodeJS.Timeout;
  private activeSessionsBroadcastTimer: NodeJS.Timeout | null = null;
  private activeSessionsLastBroadcastAt = 0;
  private draining = false;
  private currentTurnId: string | null = null;
  private accumulatedText = "";
  private currentTurnStartedAt = 0;
  private currentProgress: WebTaskDto | null = null;

  constructor(private readonly config: ConnectorConfig, options: RelayRuntimeOptions = {}) {
    this.contextKey = options.contextKey ?? WEB_CONTEXT_KEY;
    this.registry = new SessionRegistry(config, {
      fileName: options.registryFileName ?? "web-contexts.json",
      sqliteKey: options.registrySqliteKey ?? "web-contexts",
    });
    this.promptStore = new PromptStore(config.workspace, config.stateBackend);
    this.chatStore = new WebChatStore(config.workspace, config.stateBackend, MAX_CHAT_HISTORY);
    this.activityStore = new WebActivityStore(config.workspace, config.stateBackend, config.auditMaxEvents);
    this.auditStore = new AuditLogStore(config.workspace, config.stateBackend, config.auditMaxEvents);
    this.preferencesStore = new BotPreferencesStore(config.workspace, config.stateBackend);
    this.lockStore = new SessionLockStore(config.workspace, config.stateBackend);
    this.queueService = new RelayQueueService(this.promptStore, this.contextKey);
    this.jobStore = new UnifiedJobStore(config.workspace, config.stateBackend, config.unifiedJobMaxItems);
    this.artifactService = new RelayArtifactService(config);
    this.mirrorRegistry = new ChannelMirrorRegistry(config, this.promptStore);
    this.agentUpdates = new AgentUpdateManager({
      onUpdate: (job) => {
        this.broadcast({ type: "agent_update", job });
        this.recordAgentUpdateLifecycle(job);
      },
    });
    this.externalActivityMonitor = new RelayExternalActivityMonitor({
      config,
      getSession: () => this.getSession(true),
      publicInfo: (session) => this.publicInfo(session),
      queueLength: () => this.queueService.length(),
      mirrorMode: () => this.preferencesStore.get(this.contextKey).mirrorMode ?? this.config.webMirrorMode,
      mirrorMinUpdateMs: () => this.config.webMirrorMinUpdateMs,
      chatStore: this.chatStore,
      chatHistory: () => this.chatHistory(),
      persistWorkspaceArtifactsForTurn: (workspace, turnId, startedAt) =>
        this.artifactService.persistWorkspaceArtifactsForTurn(workspace, turnId, startedAt),
      drainQueue: () => this.drainQueue(),
      appendActivity: (input) => this.appendActivity(input),
      broadcast: (event) => this.broadcast(event),
      broadcastStatus: (message, level) => this.broadcastStatus(message, level),
    });
    if (config.codexExternalBusyCheckMs > 0) {
      this.externalMonitor = setInterval(() => {
        void this.externalActivityMonitor.monitorSafe();
      }, config.codexExternalBusyCheckMs);
      this.externalMonitor.unref?.();
    }
    this.turnService = new ChannelTurnService({
      source: "web",
      contextKey: this.contextKey,
      chatStore: this.chatStore,
      artifactService: this.artifactService,
      checkAuth: (info) => this.checkAgentAuth(info),
      ensureActiveThread: (session) => this.ensureActiveThread(session),
      updateSession: (session) => this.updateSession(session),
      appendActivity: (input) => this.appendActivity(input),
      appendAudit: (input) => this.appendAudit(input),
      broadcast: (event) => this.broadcast(event),
      chatHistory: () => this.chatHistory(),
      setLastPrompt: (envelope) => this.queueService.setLastPrompt(envelope),
      getCurrentProgress: () => this.currentProgress,
      setCurrentProgress: (progress) => {
        this.currentProgress = progress;
      },
      setCurrentTurn: (id, startedAt, accumulatedText) => {
        this.currentTurnId = id;
        if (startedAt !== undefined) this.currentTurnStartedAt = startedAt;
        if (accumulatedText !== undefined) this.accumulatedText = accumulatedText;
      },
      getCurrentTurnStartedAt: () => this.currentTurnStartedAt,
      getAccumulatedText: () => this.accumulatedText,
      setAccumulatedText: (text) => {
        this.accumulatedText = text;
      },
    });
  }

  subscribe(callback: (event: RelayEvent) => void): () => void {
    this.subscribers.add(callback);
    void this.snapshot().then((data) => callback({ type: "snapshot", data })).catch(() => {});
    void this.chatHistory().then((messages) => callback({ type: "chat_history", messages })).catch(() => {});
    void this.activeSessions().then((active) => callback({ type: "active_sessions_update", active })).catch(() => {});
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
    const cliOptions = this.cliPathOptions();
    const [health, versionChecks, snapshot] = await Promise.all([
      getConnectorHealth(cliOptions),
      getVersionChecks(cliOptions),
      this.snapshot(),
    ]);
    return {
      health,
      versionChecks,
      snapshot,
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
    return this.cached("version", async () => {
      const cliOptions = this.cliPathOptions();
      const [health, state, versionChecks] = await Promise.all([
        getConnectorHealth(cliOptions),
        readConnectorState(),
        getVersionChecks(cliOptions),
      ]);
      return {
        health,
        state,
        versionChecks,
      };
    });
  }

  updateConnector(actor?: WebActivityActor): ReturnType<typeof spawnSelfUpdate> {
    this.cache.invalidate("version");
    const update = spawnSelfUpdate();
    this.broadcastStatus(`Update started with ${update.method}. Log: ${update.logPath}`, "warn");
    this.appendActivity({
      source: "web",
      status: "info",
      type: "update_started",
      threadId: null,
      workspace: this.config.workspace,
      actor,
      detail: `${update.method}: ${update.summary}`,
    });
    this.appendAudit({
      action: "command",
      status: "ok",
      contextKey: this.contextKey,
      actor,
      description: "update",
      detail: update.summary,
    });
    return update;
  }

  agentUpdateJobs(): AgentUpdateJobSnapshot[] {
    return this.agentUpdates.list();
  }

  startAgentUpdate(agentId: AgentId, operation: AgentUpdateOperation = "update", actor?: WebActivityActor): AgentUpdateJobSnapshot {
    this.cache.invalidate("adapterHealth");
    this.cache.invalidate("version");
    const job = this.agentUpdates.start(agentId, {
      piCliPath: this.config.piCliPath,
      hermesCliPath: this.config.hermesCliPath,
      openClawCliPath: this.config.openClawCliPath,
      claudeCodeCliPath: this.config.claudeCodeCliPath,
    }, operation);
    if (actor) {
      this.agentUpdateActors.set(job.id, actor);
    }
    this.agentUpdateStates.set(job.id, { status: job.status, needsInput: job.needsInput });
    this.broadcastStatus(`${job.agentLabel} ${operation} started. Log: ${job.logPath}`, "warn");
    this.appendActivity({
      source: "web",
      status: "info",
      type: operation === "install" ? "agent_install_started" : "agent_update_started",
      agentId,
      threadId: null,
      workspace: this.config.workspace,
      actor,
      detail: `${job.method}: ${job.summary}`,
    });
    this.appendAudit({
      action: "command",
      status: "ok",
      contextKey: this.contextKey,
      agentId,
      actor,
      description: `${operation} ${agentId}`,
      detail: job.summary,
    });
    return job;
  }

  agentUpdateLog(id: string): ReturnType<AgentUpdateManager["readLog"]> {
    return this.agentUpdates.readLog(id);
  }

  deleteAgentUpdateLog(id: string, actor?: WebActivityActor): AgentUpdateJobSnapshot {
    const job = this.agentUpdates.deleteLog(id);
    this.appendActivity({
      source: "web",
      status: "info",
      type: "agent_update_log_deleted",
      agentId: job.agentId,
      threadId: null,
      workspace: this.config.workspace,
      actor,
      detail: job.logPath,
    });
    this.appendAudit({
      action: "command",
      status: "ok",
      contextKey: this.contextKey,
      agentId: job.agentId,
      actor,
      description: `delete update log ${id}`,
      detail: job.logPath,
    });
    return job;
  }

  sendAgentUpdateInput(id: string, input: string, actor?: WebActivityActor): AgentUpdateJobSnapshot {
    const job = this.agentUpdates.sendInput(id, input);
    this.appendActivity({
      source: "web",
      status: "info",
      type: "agent_update_input_sent",
      agentId: job.agentId,
      threadId: null,
      workspace: this.config.workspace,
      actor: actor ?? this.agentUpdateActors.get(id),
      detail: `Input sent to ${job.agentLabel} ${job.operation}.`,
    });
    return job;
  }

  cancelAgentUpdate(id: string, actor?: WebActivityActor): AgentUpdateJobSnapshot {
    const job = this.agentUpdates.cancel(id);
    this.appendActivity({
      source: "web",
      status: "aborted",
      type: "agent_update_cancel_requested",
      agentId: job.agentId,
      threadId: null,
      workspace: this.config.workspace,
      actor: actor ?? this.agentUpdateActors.get(id),
      detail: `${job.agentLabel} ${job.operation} cancellation requested.`,
    });
    return job;
  }

  async diagnostics(): Promise<WebDiagnosticsDto> {
    return this.cached("diagnostics", async () => {
      const cliOptions = this.cliPathOptions();
      const [health, versionChecks, snapshot, session] = await Promise.all([
        getConnectorHealth(cliOptions),
        getVersionChecks(cliOptions),
        this.snapshot(),
        this.getSession(true),
      ]);
      return {
        health,
        versionChecks,
        snapshot,
        runtime: {
          stateBackend: this.config.stateBackend,
          sourceWorkspace: this.config.workspace,
          queuePaused: this.queueService.isPaused(),
          externalMirror: this.externalActivityMonitor.snapshot(),
          agentDiagnostics: getAgentDiagnostics(session, this.config),
          slackDiagnostics: await collectSlackDiagnostics({
            config: this.config,
            timeoutMs: 2_500,
            rateLimit: getSlackRateLimitMetrics(),
          }),
        },
      };
    });
  }

  async adapterHealth(): Promise<WebAdapterHealthDto[]> {
    return this.cached("adapterHealth", async () => {
      const cliOptions = this.cliPathOptions();
      const [health, versions] = await Promise.all([
        getConnectorHealth(cliOptions),
        getVersionChecks(cliOptions),
      ]);
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
    });
  }

  permissions(): WebPermissionsDto {
    return {
      mode: "users",
      message: "Access is managed by NordRelay users, groups, Telegram identities, Telegram chat access records, Discord identities, and Discord channel access records.",
    };
  }

  tasks(): WebTasksDto {
    return {
      current: this.currentProgress ? { ...this.currentProgress, tools: [...this.currentProgress.tools] } : null,
      external: this.externalActivityMonitor.task(),
      queue: this.queue(),
      queuePaused: this.queuePaused(),
      recent: this.activity({ limit: 20 }),
    };
  }

  async jobs(): Promise<UnifiedJobsDto> {
    const jobs: UnifiedJobDto[] = [];
    const current = this.currentProgress;
    if (current) {
      jobs.push(taskToUnifiedJob("web:current", "web-turn", "Current WebUI turn", current, {
        canCancel: current.status === "running",
        canRetry: false,
        canReadLog: false,
      }));
    }

    const external = this.externalActivityMonitor.task();
    if (external) {
      jobs.push(taskToUnifiedJob(`external:${external.agentId ?? "agent"}:${external.threadId ?? "pending"}`, "external-turn", "External CLI turn", external, {
        canCancel: false,
        canRetry: false,
        canReadLog: false,
      }));
    }

    for (const item of this.queueService.rawList()) {
      const createdAt = new Date(item.createdAt).toISOString();
      jobs.push({
        id: `queue:${item.id}`,
        kind: "queued-prompt",
        title: `Queued prompt ${item.id}`,
        status: "queued",
        source: "web",
        threadId: null,
        workspace: this.config.workspace,
        owner: item.activityActor,
        startedAt: createdAt,
        updatedAt: createdAt,
        summary: item.description,
        queueId: item.id,
        logTail: item.lastError,
        canCancel: true,
        canRetry: true,
        canReadLog: true,
      });
    }

    for (const job of this.agentUpdates.list()) {
      jobs.push({
        id: `agent-update:${job.id}`,
        kind: "agent-update",
        title: `${job.agentLabel} ${job.operation}`,
        status: agentUpdateStatusToUnified(job.status),
        source: "web",
        agentId: job.agentId,
        agentLabel: job.agentLabel,
        threadId: null,
        workspace: this.config.workspace,
        owner: this.agentUpdateActors.get(job.id),
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt,
        summary: job.error || job.summary,
        logPath: job.logPath,
        logTail: job.outputTail,
        updateJobId: job.id,
        canCancel: job.status === "running",
        canRetry: job.status !== "running",
        canReadLog: true,
      });
    }

    for (const event of this.activity({ limit: 100 })) {
      if (event.type === "diagnostics_bundle_exported") {
        jobs.push(activityToUnifiedJob(event, "support-bundle", "Diagnostics support bundle", {
          canCancel: false,
          canRetry: true,
          canReadLog: Boolean(event.detail),
        }));
      } else if (event.type === "update_started") {
        jobs.push(activityToUnifiedJob(event, "connector-update", "NordRelay update", {
          canCancel: false,
          canRetry: true,
          canReadLog: Boolean(event.detail),
        }));
      } else if (event.category === "prompt" && event.type.startsWith("prompt_")) {
        jobs.push(promptActivityToUnifiedJob(event));
      }
    }

    const liveJobs = dedupeJobs(jobs);
    const storedJobs = this.jobStore.upsertMany(liveJobs);
    return {
      jobs: dedupeJobs([...liveJobs, ...storedJobs]).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
      updatedAt: new Date().toISOString(),
    };
  }

  async jobLog(id: string): Promise<{ job: UnifiedJobDto | null; plain: string }> {
    if (id.startsWith("agent-update:")) {
      const updateId = id.slice("agent-update:".length);
      const log = this.agentUpdates.readLog(updateId);
      return { job: (await this.jobs()).jobs.find((job) => job.id === id) ?? null, plain: log.plain };
    }
    if (id.startsWith("queue:")) {
      const queueId = id.slice("queue:".length);
      const item = this.queueService.rawList().find((candidate) => candidate.id === queueId);
      return {
        job: (await this.jobs()).jobs.find((job) => job.id === id) ?? null,
        plain: item ? [
          `Queued prompt: ${item.id}`,
          `Created: ${new Date(item.createdAt).toISOString()}`,
          `Attempts: ${item.attempts ?? 0}`,
          `Description: ${item.description}`,
          item.lastError ? `Last error: ${item.lastError}` : "",
        ].filter(Boolean).join("\n") : "Queued prompt not found.",
      };
    }
    const job = (await this.jobs()).jobs.find((candidate) => candidate.id === id) ?? null;
    return { job, plain: job?.logTail || job?.logPath || job?.summary || this.jobStore.get(id)?.summary || "No log available for this job." };
  }

  async jobAction(id: string, action: "cancel" | "retry", actor?: WebActivityActor): Promise<UnifiedJobsDto> {
    if (id === "web:current" && action === "cancel") {
      await this.abort(actor);
      return this.jobs();
    }
    if (id.startsWith("queue:")) {
      const queueId = id.slice("queue:".length);
      this.queueService.apply(action === "cancel" ? "cancel" : "run", queueId);
      this.jobStore.patch(id, {
        status: action === "cancel" ? "aborted" : "queued",
        summary: action === "cancel" ? `Cancelled queued prompt ${queueId}.` : `Queued prompt ${queueId} moved to the front.`,
        canCancel: action !== "cancel",
        canRetry: action === "cancel",
        finishedAt: action === "cancel" ? new Date().toISOString() : undefined,
      });
      this.broadcast({ type: "queue_update", queue: this.queue(), paused: this.queuePaused() });
      this.appendActivity({
        source: "web",
        status: action === "cancel" ? "aborted" : "queued",
        type: action === "cancel" ? "job_cancelled" : "job_retried",
        threadId: null,
        workspace: this.config.workspace,
        actor,
        detail: `queue:${queueId}`,
      });
      if (action === "retry") {
        void this.drainQueue();
      }
      return this.jobs();
    }
    if (id.startsWith("agent-update:")) {
      const updateId = id.slice("agent-update:".length);
      const current = this.agentUpdates.get(updateId);
      if (!current) {
        throw new Error("Unknown agent update job.");
      }
      if (action === "cancel") {
        this.cancelAgentUpdate(updateId, actor);
      } else {
        this.startAgentUpdate(current.agentId, current.operation, actor);
      }
      return this.jobs();
    }
    if (id.startsWith("support-bundle:") && action === "retry") {
      await this.supportBundle(actor);
      return this.jobs();
    }
    if (id.startsWith("connector-update:") && action === "retry") {
      this.updateConnector(actor);
      return this.jobs();
    }
    throw new Error(`Unsupported job action: ${action} ${id}`);
  }

  async activeSessions(): Promise<ActiveSessionsDto> {
    const sessions = new Map<string, ActiveSessionDto>();
    const knownContexts = this.listKnownContextMetadata();
    const preferences = new BotPreferencesStore(this.config.workspace, this.config.stateBackend);
    const addActiveSession = (session: ActiveSessionDto): void => {
      const key = this.activeSessionKey(session);
      const existing = sessions.get(key);
      sessions.set(key, this.preferredActiveSession(existing, session));
    };

    if (this.currentProgress?.status === "running") {
      addActiveSession({
        ...this.currentProgress,
        contextKey: this.contextKey,
        sourceContextKey: this.contextKey,
        source: "web",
        status: "running",
        queueLength: this.queueService.length(),
        queuePaused: this.queueService.isPaused(),
      });
    }

    for (const active of this.discoverRunningConnectorSessions()) {
      addActiveSession(active);
    }

    for (const active of this.discoverActiveCodexSessions(knownContexts, preferences)) {
      addActiveSession(active);
    }

    for (const meta of knownContexts) {
      if (meta.contextKey === this.contextKey && this.currentProgress?.status === "running") {
        continue;
      }
      const active = this.externalActiveSession(meta, knownContexts, preferences);
      if (active) {
        addActiveSession(active);
      }
    }

    return {
      sessions: [...sessions.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
      updatedAt: new Date().toISOString(),
    };
  }

  async metrics(): Promise<RuntimeMetricsDto> {
    const [active, jobs] = await Promise.all([
      this.activeSessions(),
      this.jobs(),
    ]);
    return buildRuntimeMetrics({
      queueLength: this.queueService.length(),
      queuePaused: this.queueService.isPaused(),
      activeTurnCount: active.sessions.length,
      jobs: jobs.jobs,
      activity: this.activity({ limit: 500 }),
    });
  }

  audit(options: number | AuditListOptions = 50): AuditEvent[] {
    return this.auditStore.list(options);
  }

  async supportBundle(actor?: WebActivityActor): Promise<SupportBundleResult> {
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
      actor,
      detail: bundle.path,
    });
    this.appendAudit({
      action: "command",
      status: "ok",
      contextKey: this.contextKey,
      actor,
      description: "export diagnostics bundle",
      detail: bundle.path,
    });
    return bundle;
  }

  locks(): SessionLock[] {
    return this.lockStore.list();
  }

  lockWebSession(ownerName = "Web dashboard", actor?: WebActivityActor): SessionLock {
    const label = ownerName || actor?.label || "Web dashboard";
    const lock = this.lockStore.set(this.contextKey, {
      userId: actor?.id ?? "web",
      label,
      channel: "web",
    }, this.config.sessionLockTtlMs);
    this.appendActivity({
      source: "web",
      status: "info",
      type: "lock_created",
      threadId: null,
      workspace: this.config.workspace,
      actor,
      detail: `locked by ${label}`,
    });
    this.appendAudit({
      action: "lock_updated",
      status: "ok",
      contextKey: this.contextKey,
      actor,
      description: "lock",
      detail: `locked by ${label}`,
    });
    return lock;
  }

  unlockWebSession(actor?: WebActivityActor): { removed: boolean; locks: SessionLock[] } {
    const removed = this.lockStore.clear(this.contextKey);
    this.appendActivity({
      source: "web",
      status: "info",
      type: "lock_removed",
      threadId: null,
      workspace: this.config.workspace,
      actor,
      detail: removed ? "unlocked" : "no lock",
    });
    this.appendAudit({
      action: "lock_updated",
      status: "ok",
      contextKey: this.contextKey,
      actor,
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

  async login(agentId?: AgentId, actor?: WebActivityActor): Promise<WebAuthDto & { result: LoginResult | null }> {
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
      this.appendActivity({
        source: "web",
        status: result.success ? "info" : "failed",
        type: result.success ? "login_started" : "login_failed",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        actor,
        detail: result.message,
      });
      this.appendAudit({
        action: "command",
        status: result.success ? "ok" : "failed",
        contextKey: this.contextKey,
        agentId: info.agentId,
        threadId: info.threadId,
        workspace: info.workspace,
        actor,
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

  async logout(agentId?: AgentId, actor?: WebActivityActor): Promise<WebAuthDto & { result: LoginResult | null }> {
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
      this.appendActivity({
        source: "web",
        status: result.success ? "info" : "failed",
        type: result.success ? "logout_completed" : "logout_failed",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        actor,
        detail: result.message,
      });
      this.appendAudit({
        action: "command",
        status: result.success ? "ok" : "failed",
        contextKey: this.contextKey,
        agentId: info.agentId,
        threadId: info.threadId,
        workspace: info.workspace,
        actor,
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

  async webMirrorPreference(argument = "", actor?: WebActivityActor): Promise<{
    mode: string;
    minInterval: number;
    response: { plain: string; html: string };
  }> {
    const session = await this.getSession(true);
    this.registry.updateMetadata(this.contextKey, session);
    const info = this.publicInfo(session);
    const response = new ChannelCommandService(this.config).renderMirrorPreference({
      source: "web",
      contextKey: this.contextKey,
      argument,
      preferencesStore: this.preferencesStore,
      cliMirrorSupported: capabilitiesOf(info).cliMirror,
      agentLabel: info.agentLabel,
    });
    const mode = this.preferencesStore.get(this.contextKey).mirrorMode ?? this.config.webMirrorMode;
    const changed = argument.trim() && response.plain.startsWith("CLI mirroring:");
    if (changed) {
      this.appendActivity({
        source: "web",
        status: "info",
        type: "mirror_mode_changed",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        actor,
        detail: mode,
      });
      this.appendAudit({
        action: "command",
        status: "ok",
        contextKey: this.contextKey,
        agentId: info.agentId,
        threadId: info.threadId,
        workspace: info.workspace,
        actor,
        description: `mirror ${mode}`,
      });
      this.externalActivityMonitor.reset();
      void this.externalActivityMonitor.monitorSafe();
    }
    return {
      mode,
      minInterval: this.config.webMirrorMinUpdateMs,
      response,
    };
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

  async clearChatHistory(actor?: WebActivityActor): Promise<{ removed: number; messages: WebChatMessage[] }> {
    const session = await this.getSession(true);
    const info = this.publicInfo(session);
    const removed = this.chatStore.clear(info.threadId);
    const messages = await this.chatHistory();
    this.broadcast({ type: "chat_history", messages });
    this.appendActivity({
      source: "web",
      status: "info",
      type: "chat_history_cleared",
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      actor,
      detail: `${removed} messages removed.`,
    });
    return { removed, messages };
  }

  activity(options: {
    limit?: number;
    source?: WebActivitySource | "all";
    status?: WebActivityStatus | "all";
    category?: WebActivityCategory | "all";
    actor?: string;
    agentId?: AgentId | "all" | string;
    threadId?: string;
    workspace?: string;
    type?: string;
    since?: string | number;
  } = {}): WebActivityEvent[] {
    const currentInfo = this.registry.get(this.contextKey)?.getInfo();
    return this.activityStore.list(options).map((event) => this.enrichActivityEvent(event, currentInfo));
  }

  async retry(actor?: WebActivityActor): Promise<{ queued: boolean; queueId?: string }> {
    const cached = this.queueService.getLastPrompt();
    if (!cached) {
      throw new Error("Nothing to retry. Send a message first.");
    }
    this.appendAudit({
      action: "command",
      status: "ok",
      contextKey: this.contextKey,
      actor,
      description: "retry",
      detail: cached.description,
    });
    return this.sendEnvelope({ ...cached, activityActor: cached.activityActor ?? actor }, actor);
  }

  async sync(actor?: WebActivityActor): Promise<ReturnType<AgentSessionService["syncFromAgentState"]>> {
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
      actor,
      detail: result.changedFields.length > 0 ? result.changedFields.join(", ") : "already in sync",
    });
    this.appendAudit({
      action: "command",
      status: "ok",
      contextKey: this.contextKey,
      agentId: result.info.agentId,
      threadId: result.info.threadId,
      workspace: result.info.workspace,
      actor,
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

  async setAgent(agentId: AgentId, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    if (!enabledAgents(this.config).includes(agentId)) {
      throw new Error(`Agent is not enabled: ${agentId}`);
    }
    const session = await this.registry.switchAgent(this.contextKey, agentId);
    this.updateSession(session);
    const info = this.publicInfo(session);
    this.appendActivity({
      source: "web",
      status: "info",
      type: "agent_switch",
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      actor,
      detail: `Dashboard switched agent to ${info.agentLabel}.`,
    });
    return this.publicInfo(session);
  }

  async newSession(options: {
    agentId?: AgentId;
    workspace?: string;
    model?: string;
    reasoningEffort?: string;
    launchProfileId?: string;
    fastMode?: boolean;
  } = {}, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    const session = options.agentId ? await this.registry.switchAgent(this.contextKey, options.agentId) : await this.getSession(true);
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
      actor,
      detail: "New dashboard session created.",
    });
    return this.publicInfo(session);
  }

  async switchSession(threadId: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
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
      actor,
      detail: "Dashboard switched session.",
    });
    return this.publicInfo(session);
  }

  async attachSession(threadId: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    return this.switchSession(threadId, actor);
  }

  async setModel(model: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    const session = await this.getSession(true);
    this.ensureIdle(session);
    await session.setModelForCurrentSession(model);
    this.updateSession(session);
    const info = this.publicInfo(session);
    this.appendActivity({ source: "web", status: "info", type: "model_changed", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId, actor, detail: model });
    return info;
  }

  async setReasoningEffort(effort: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    const session = await this.getSession(true);
    this.ensureIdle(session);
    const options = agentReasoningOptions(session.getInfo().agentId);
    if (!options.includes(effort as never)) {
      throw new Error(`Invalid ${agentReasoningLabel(session.getInfo().agentId)} value: ${effort}`);
    }
    await session.setReasoningEffortForCurrentSession(effort);
    this.updateSession(session);
    const info = this.publicInfo(session);
    this.appendActivity({ source: "web", status: "info", type: "reasoning_changed", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId, actor, detail: effort });
    return info;
  }

  async setFastMode(enabled: boolean, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    const session = await this.getSession(true);
    this.ensureIdle(session);
    if (!(session.getInfo().capabilities ?? CODEX_AGENT_CAPABILITIES).fastMode) {
      throw new Error(`Fast mode is not supported for ${agentLabel(session.getInfo().agentId)}.`);
    }
    session.setFastMode(enabled);
    this.updateSession(session);
    const info = this.publicInfo(session);
    this.appendActivity({ source: "web", status: "info", type: "fast_mode_changed", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId, actor, detail: enabled ? "on" : "off" });
    return info;
  }

  async setLaunchProfile(profileId: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    const session = await this.getSession(true);
    this.ensureIdle(session);
    session.setLaunchProfile(profileId);
    this.updateSession(session);
    const info = this.publicInfo(session);
    this.appendActivity({ source: "web", status: "info", type: "launch_profile_changed", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId, actor, detail: info.launchProfileLabel ?? profileId });
    return info;
  }

  async handback(actor?: WebActivityActor): Promise<ReturnType<AgentSessionService["handback"]>> {
    const session = await this.getSession(true);
    this.ensureIdle(session);
    const result = session.handback();
    this.updateSession(session);
    const info = this.publicInfo(session);
    this.appendActivity({ source: "web", status: "info", type: "handback", threadId: result.threadId, workspace: result.workspace, agentId: info.agentId, actor, detail: result.command ?? "Thread handed back." });
    return result;
  }

  async abort(actor?: WebActivityActor): Promise<void> {
    const session = await this.getSession(true);
    const snapshot = getExternalSnapshotForSession(session, this.config, { maxEvents: 0 });
    if (snapshot?.activity.active && !session.isProcessing()) {
      this.broadcast({
        type: "status",
        level: "warn",
        message: `Cannot abort the external ${snapshot.agentLabel} CLI task from NordRelay. Stop it in the terminal where it is running.`,
        at: new Date().toISOString(),
      });
      const info = this.publicInfo(session);
      this.appendActivity({ source: "web", status: "aborted", type: "prompt_abort_rejected", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId, actor, detail: `External ${snapshot.agentLabel} CLI task is active.` });
      return;
    }
    await session.abort();
    const info = this.publicInfo(session);
    this.appendActivity({ source: "web", status: "aborted", type: "prompt_aborted", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId, actor, detail: "Current operation aborted." });
    this.broadcast({ type: "status", level: "warn", message: "Current operation aborted.", at: new Date().toISOString() });
  }

  async sendPrompt(text: string, actor?: WebActivityActor): Promise<{ queued: boolean; queueId?: string }> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Prompt is empty.");
    }
    return this.sendEnvelope({ ...toPromptEnvelope(trimmed), activityActor: actor }, actor);
  }

  async sendUploadPrompt(options: { text?: string; files: UploadPromptFile[] }, actor?: WebActivityActor): Promise<UploadPromptResult> {
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
          this.appendActivity({
            source: "web",
            status: "completed",
            type: "voice_transcribed",
            threadId: session.getInfo().threadId,
            workspace,
            agentId: session.getInfo().agentId,
            actor,
            detail: `${staged.safeName} via ${result.backend}`,
            durationMs: result.durationMs,
          });
        }
      }
    }

    if (stagedFiles.length > 0) {
      this.appendActivity({
        source: "web",
        status: "info",
        type: "attachment_staged",
        threadId: session.getInfo().threadId,
        workspace,
        agentId: session.getInfo().agentId,
        actor,
        detail: `${stagedFiles.length} file(s): ${stagedFiles.map((file) => file.safeName).join(", ")}`,
      });
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

    const result = await this.sendEnvelope({ ...toPromptEnvelope(promptInput, outDir), activityActor: actor }, actor);
    return {
      ...result,
      transcript: transcriptParts.join("\n\n") || undefined,
      files: uploadFileDtos(stagedFiles),
    };
  }

  private async sendEnvelope(envelope: PromptEnvelope, actor?: WebActivityActor): Promise<{ queued: boolean; queueId?: string }> {
    const activityActor = envelope.activityActor ?? actor;
    const session = await this.getSession(false);
    const external = getExternalSnapshotForSession(session, this.config, { maxEvents: 0 });
    if (session.isProcessing() || external?.activity.active) {
      const queued = this.queueService.enqueue(envelope);
      const info = this.publicInfo(session);
      this.appendActivity({
        source: "web",
        status: "queued",
        type: "prompt_queued",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        actor: activityActor,
        prompt: envelope.description,
        detail: external?.activity.active
          ? `Queued because ${external.agentLabel} CLI is still processing another task.`
          : `Queued at position ${this.queueService.length()}.`,
      });
      this.appendAudit({
        action: "prompt_queued",
        status: "ok",
        contextKey: this.contextKey,
        agentId: info.agentId,
        threadId: info.threadId,
        workspace: info.workspace,
        promptId: queued.id,
        actor: activityActor,
        description: envelope.description,
      });
      if (external?.activity.active) {
        this.broadcastStatus(`Waiting for ${external.agentLabel} CLI task... ${this.queueService.length()} queued.`, "info");
      }
      this.broadcastQueue();
      return { queued: true, queueId: queued.id };
    }

    void this.runPrompt(session, { ...envelope, activityActor }).catch((error) => {
      this.broadcast({ type: "turn_error", id: this.currentTurnId ?? "turn", error: friendlyErrorText(error), at: new Date().toISOString() });
    });
    return { queued: false };
  }

  queue(): QueueItemDto[] {
    return this.queueService.list();
  }

  queuePaused(): boolean {
    return this.queueService.isPaused();
  }

  queueAction(action: RelayQueueAction, id?: string, actor?: WebActivityActor): QueueItemDto[] {
    const before = this.queueService.rawList();
    const affected = id ? before.find((item) => item.id === id) : undefined;
    this.queueService.apply(action, id);
    if (id && action === "run") {
      void this.drainQueue().catch((error) => this.broadcastStatus(friendlyErrorText(error), "error"));
    }
    this.appendActivity({
      source: "web",
      status: "info",
      type: `queue_${action}`,
      threadId: null,
      workspace: this.config.workspace,
      actor,
      prompt: affected?.description,
      detail: id ? `${action}: ${id}` : `${action}: ${before.length} queued`,
    });
    this.appendAudit({
      action: "queue_updated",
      status: "ok",
      contextKey: this.contextKey,
      actor,
      description: id ? `${action}: ${id}` : action,
    });
    this.broadcastQueue();
    return this.queue();
  }

  async artifacts(): Promise<ArtifactReportDto[]> {
    const session = await this.getSession(true);
    return this.artifactService.list(session.getInfo().workspace, 20);
  }

  async artifact(turnId: string): Promise<ArtifactTurnReport | null> {
    const session = await this.getSession(true);
    return this.artifactService.get(session.getInfo().workspace, turnId);
  }

  async deleteArtifact(turnId: string, actor?: WebActivityActor): Promise<boolean> {
    const session = await this.getSession(true);
    const info = this.publicInfo(session);
    const removed = await this.artifactService.delete(info.workspace, turnId);
    this.appendActivity({
      source: "web",
      status: removed ? "info" : "failed",
      type: "artifact_deleted",
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      actor,
      detail: turnId,
    });
    return removed;
  }

  async createArtifactZip(turnId: string, actor?: WebActivityActor): Promise<{ path: string; name: string } | null> {
    const session = await this.getSession(true);
    const info = this.publicInfo(session);
    const zip = await this.artifactService.createZip(info.workspace, turnId);
    if (zip) {
      this.appendActivity({
        source: "web",
        status: "info",
        type: "artifact_zip_created",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        actor,
        detail: zip.name,
      });
    }
    return zip;
  }

  async artifactPreview(turnId: string, relativePath: string): Promise<ArtifactPreviewDto | null> {
    const session = await this.getSession(true);
    return this.artifactService.preview(session.getInfo().workspace, turnId, relativePath);
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

  clearLogs(target: "connector" | "update" | "agent-updates" = "connector", actor?: WebActivityActor): { ok: true; filePath: string; clearedAt: string } {
    const result = clearLogFile(target === "update" ? getUpdateLogPath() : target === "agent-updates" ? getAgentUpdateLogPath() : getConnectorLogPath());
    this.appendActivity({
      source: "web",
      status: "info",
      type: "logs_cleared",
      threadId: null,
      workspace: this.config.workspace,
      actor,
      detail: `Cleared ${target} log.`,
    });
    this.appendAudit({
      action: "command",
      status: "ok",
      contextKey: this.contextKey,
      actor,
      description: `clear ${target} log`,
      detail: result.filePath,
    });
    return { ok: true, filePath: result.filePath, clearedAt: result.clearedAt.toISOString() };
  }

  restartConnector(actor?: WebActivityActor): { ok: true; message: string } {
    spawnConnectorRestart();
    this.broadcastStatus("Restart requested. The dashboard may disconnect briefly.", "warn");
    this.appendActivity({
      source: "web",
      status: "info",
      type: "restart_requested",
      threadId: null,
      workspace: this.config.workspace,
      actor,
      detail: "Dashboard requested a connector restart.",
    });
    this.appendAudit({
      action: "command",
      status: "ok",
      contextKey: this.contextKey,
      actor,
      description: "restart connector",
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

  private async getSession(deferThreadStart: boolean): Promise<AgentSessionService> {
    return this.registry.getOrCreate(this.contextKey, { deferThreadStart });
  }

  private async cached<T>(key: string, producer: () => Promise<T>): Promise<T> {
    return (await this.cache.get(key, this.config.dashboardCacheTtlMs, producer)).value;
  }

  private listKnownContextMetadata(): ContextMetadata[] {
    const contexts = new Map<string, ContextMetadata>();
    const add = (meta: ContextMetadata | undefined): void => {
      if (meta?.contextKey) {
        contexts.set(meta.contextKey, meta);
      }
    };

    for (const meta of this.registry.listContexts()) {
      add(meta);
    }

    const sharedRegistry = new SessionRegistry(this.config);
    try {
      for (const meta of sharedRegistry.listContexts()) {
        add(meta);
      }
    } finally {
      sharedRegistry.disposeAll();
    }

    const current = this.registry.get(this.contextKey)?.getInfo();
    if (current) {
      add({
        contextKey: this.contextKey,
        agentId: current.agentId,
        threadId: current.threadId,
        workspace: current.workspace,
        model: current.model,
        reasoningEffort: current.reasoningEffort,
        launchProfileId: current.nextLaunchProfileId ?? current.launchProfileId,
        sessionPath: current.sessionPath,
        updatedAt: Date.now(),
      });
    }

    return [...contexts.values()];
  }

  private discoverRunningConnectorSessions(): ActiveSessionDto[] {
    const active: ActiveSessionDto[] = [];
    const terminal = new Set<string>();
    const now = Date.now();
    for (const event of this.activityStore.list({ limit: 500 })) {
      if (!event.threadId || !event.agentId || !event.contextKey) {
        continue;
      }
      const key = `${event.source}:${event.contextKey}:${event.agentId}:${event.threadId}`;
      if (isPromptTerminalActivity(event)) {
        terminal.add(key);
        continue;
      }
      if (event.type !== "prompt_started" || event.status !== "running" || event.source === "cli") {
        continue;
      }
      if (terminal.has(key)) {
        continue;
      }
      const startedMs = Date.parse(event.timestamp);
      if (!Number.isFinite(startedMs) || now - startedMs > ACTIVE_ACTIVITY_TTL_MS) {
        continue;
      }
      active.push({
        id: `${event.contextKey}:${event.id}`,
        contextKey: event.contextKey,
        sourceContextKey: event.contextKey,
        source: event.source,
        status: "running",
        agentId: event.agentId,
        agentLabel: event.agentId ? agentLabel(event.agentId) : undefined,
        threadId: event.threadId,
        workspace: event.workspace,
        prompt: event.prompt,
        startedAt: event.timestamp,
        updatedAt: event.timestamp,
        durationMs: Math.max(0, now - startedMs),
        queueLength: this.promptStore.list(event.contextKey).length,
        queuePaused: this.promptStore.isPaused(event.contextKey),
        detail: event.actor?.label ? `Started by ${event.actor.label}` : undefined,
      });
    }
    return active;
  }

  private discoverActiveCodexSessions(
    knownContexts: ContextMetadata[],
    preferences: BotPreferencesStore,
  ): ActiveSessionDto[] {
    if (!this.config.codexEnabled || !enabledAgents(this.config).includes("codex")) {
      return [];
    }

    const capabilities = this.capabilitiesForAgent("codex");
    if (!capabilities.externalActivity) {
      return [];
    }

    const active: ActiveSessionDto[] = [];
    const nowMs = Date.now();
    const staleAfterMs = this.config.codexExternalBusyStaleMs;
    for (const thread of listCodexThreads(ACTIVE_CODEX_DISCOVERY_LIMIT)) {
      if (staleAfterMs > 0 && nowMs - thread.updatedAt.getTime() > staleAfterMs) {
        continue;
      }
      const meta: ContextMetadata = {
        contextKey: `cli:codex:${thread.id}`,
        agentId: "codex",
        threadId: thread.id,
        workspace: thread.cwd,
        model: thread.model ?? undefined,
        reasoningEffort: thread.reasoningEffort ?? undefined,
        updatedAt: thread.updatedAt.getTime(),
      };
      const session = this.externalActiveSession(meta, knownContexts, preferences);
      if (session) {
        active.push(session);
      }
    }
    return active;
  }

  private externalActiveSession(
    meta: ContextMetadata,
    knownContexts: ContextMetadata[],
    preferences: BotPreferencesStore,
  ): ActiveSessionDto | null {
    if (!meta.threadId) {
      return null;
    }
    const agentId = isAgentId(meta.agentId) ? meta.agentId : this.config.defaultAgent;
    if (!enabledAgents(this.config).includes(agentId)) {
      return null;
    }
    const capabilities = this.capabilitiesForAgent(agentId);
    if (!capabilities.externalActivity) {
      return null;
    }
    if (
      agentId === "codex" &&
      meta.updatedAt &&
      this.config.codexExternalBusyStaleMs > 0 &&
      Date.now() - meta.updatedAt > this.config.codexExternalBusyStaleMs
    ) {
      return null;
    }

    const snapshot = getExternalSnapshotForSession(this.sessionStubForMetadata(meta, agentId, capabilities), this.config, {
      maxEvents: 8,
    });
    if (!snapshot?.activity.active) {
      return null;
    }

    const startedAt = snapshot.activity.startedAt?.toISOString() ?? new Date().toISOString();
    const updatedAt = snapshot.activity.updatedAt?.toISOString() ?? new Date().toISOString();
    const startedMs = Date.parse(startedAt);
    const sourceContextKey = `cli:${snapshot.agentId}:${snapshot.threadId}`;
    const mirrorChannels = this.mirrorRegistry.activeMirrorsForThread(snapshot.agentId, snapshot.threadId, knownContexts, preferences);
    const queueLength = this.mirrorRegistry.queueLengthForExternalSource(sourceContextKey, mirrorChannels);
    const mirrorDetail = mirrorChannels.length > 0
      ? `Mirroring: ${mirrorChannels.map((mirror) => `${mirror.source} ${mirror.mode}`).join(", ")}`
      : "Mirroring: none";
    return {
      id: `${sourceContextKey}:${snapshot.activity.turnId ?? snapshot.threadId}`,
      contextKey: sourceContextKey,
      sourceContextKey,
      source: "cli",
      status: "external",
      agentId: snapshot.agentId,
      agentLabel: snapshot.agentLabel,
      threadId: snapshot.threadId,
      workspace: meta.workspace,
      prompt: snapshot.latestUserMessage ?? undefined,
      currentTool: snapshot.latestToolName ?? undefined,
      lastTool: snapshot.latestToolName ?? undefined,
      startedAt,
      updatedAt,
      durationMs: Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0,
      queueLength,
      queuePaused: this.mirrorRegistry.queuePausedForExternalSource(sourceContextKey, mirrorChannels),
      mirrorChannels,
      detail: `${mirrorDetail} | ${snapshot.sourceLabel}: ${snapshot.sourcePath}`,
    };
  }

  private sessionStubForMetadata(
    meta: ContextMetadata,
    agentId: AgentId,
    capabilities: AgentCapabilities,
  ): AgentSessionService {
    const info: AgentSessionInfo = {
      agentId,
      agentLabel: agentLabel(agentId),
      threadId: meta.threadId,
      workspace: meta.workspace,
      model: meta.model,
      reasoningEffort: meta.reasoningEffort,
      launchProfileId: meta.launchProfileId ?? this.config.defaultLaunchProfileId,
      launchProfileLabel: meta.launchProfileId ?? this.config.defaultLaunchProfileId,
      launchProfileBehavior: "-",
      sandboxMode: "-",
      approvalPolicy: "-",
      fastMode: false,
      unsafeLaunch: false,
      sessionPath: meta.sessionPath,
      capabilities,
    };
    return {
      getInfo: () => info,
      getActiveThreadId: () => meta.threadId,
    } as AgentSessionService;
  }

  private capabilitiesForAgent(agentId: AgentId): AgentCapabilities {
    return listAgentAdapterDescriptors().find((descriptor) => descriptor.id === agentId)?.capabilities ?? CODEX_AGENT_CAPABILITIES;
  }

  private activeSessionKey(session: Pick<ActiveSessionDto, "agentId" | "threadId" | "id">): string {
    return session.threadId ? `${session.agentId ?? "unknown"}:${session.threadId}` : session.id;
  }

  private preferredActiveSession(existing: ActiveSessionDto | undefined, candidate: ActiveSessionDto): ActiveSessionDto {
    if (!existing) {
      return candidate;
    }
    const existingPriority = activeSessionPriority(existing);
    const candidatePriority = activeSessionPriority(candidate);
    if (candidatePriority !== existingPriority) {
      return candidatePriority > existingPriority ? candidate : existing;
    }
    return Date.parse(candidate.updatedAt) >= Date.parse(existing.updatedAt) ? candidate : existing;
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

  private cliPathOptions(): { piCliPath?: string; hermesCliPath?: string; openClawCliPath?: string; claudeCodeCliPath?: string } {
    return {
      piCliPath: this.config.piCliPath,
      hermesCliPath: this.config.hermesCliPath,
      openClawCliPath: this.config.openClawCliPath,
      claudeCodeCliPath: this.config.claudeCodeCliPath,
    };
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
    const workspacePolicy = evaluateWorkspacePolicy(session.getInfo().workspace, this.config);
    if (!workspacePolicy.allowed) {
      throw new Error(workspacePolicy.warning ?? "Current workspace is blocked by policy.");
    }
    try {
      await this.turnService.run(session, envelope);
    } finally {
      await this.drainQueue();
    }
  }

  private async drainQueue(): Promise<void> {
    if (this.draining || this.queueService.isPaused()) {
      return;
    }
    this.draining = true;
    try {
      const session = await this.getSession(false);
      while (!session.isProcessing()) {
        const external = getExternalSnapshotForSession(session, this.config, { maxEvents: 0 });
        if (external?.activity.active) {
          this.broadcastStatus(`Waiting for ${external.agentLabel} CLI task... ${this.queueService.length()} queued.`, "info");
          return;
        }
        const next = this.queueService.dequeue();
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
    this.registry.updateMetadata(this.contextKey, session);
    this.broadcast({ type: "session_update", session: this.publicInfo(session) });
  }

  recordActivity(input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }): WebActivityEvent {
    return this.appendActivity(input);
  }

  private recordAgentUpdateLifecycle(job: AgentUpdateJobSnapshot): void {
    const previous = this.agentUpdateStates.get(job.id);
    const actor = this.agentUpdateActors.get(job.id);
    if (job.needsInput && !previous?.needsInput) {
      this.appendActivity({
        source: "web",
        status: "info",
        type: "agent_update_input_required",
        agentId: job.agentId,
        threadId: null,
        workspace: this.config.workspace,
        actor,
        detail: `${job.agentLabel} ${job.operation} may require input.`,
      });
    }
    if (job.status !== "running" && previous?.status === "running") {
      this.appendActivity({
        source: "web",
        status: job.status === "completed" ? "completed" : job.status === "cancelled" ? "aborted" : "failed",
        type: job.operation === "install" ? `agent_install_${job.status}` : `agent_update_${job.status}`,
        agentId: job.agentId,
        threadId: null,
        workspace: this.config.workspace,
        actor,
        detail: job.error ?? `${job.agentLabel} ${job.operation} ${job.status}.`,
        durationMs: Math.max(0, Date.parse(job.finishedAt ?? job.updatedAt) - Date.parse(job.startedAt)),
      });
      this.agentUpdateActors.delete(job.id);
    }
    this.agentUpdateStates.set(job.id, { status: job.status, needsInput: job.needsInput });
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
    if (shouldRefreshActiveSessions(event)) {
      this.scheduleActiveSessionsBroadcast();
    }
  }

  private scheduleActiveSessionsBroadcast(): void {
    if (this.activeSessionsBroadcastTimer) {
      return;
    }
    const delayMs = Math.max(0, 1_000 - (Date.now() - this.activeSessionsLastBroadcastAt));
    this.activeSessionsBroadcastTimer = setTimeout(() => {
      this.activeSessionsBroadcastTimer = null;
      this.activeSessionsLastBroadcastAt = Date.now();
      void this.activeSessions()
        .then((active) => this.broadcast({ type: "active_sessions_update", active }))
        .catch(() => {});
    }, delayMs);
    this.activeSessionsBroadcastTimer.unref?.();
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
