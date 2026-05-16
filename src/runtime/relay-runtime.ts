import { randomUUID } from "node:crypto";

import { ensureOutDir, type ArtifactTurnReport } from "../artifacts/artifacts.js";
import {
  buildFileInstructions,
  outboxPath,
  stageFile,
  type StagedFile,
} from "../artifacts/attachments.js";
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
} from "../agents/shared/agent.js";
import { getExternalSnapshotForSession } from "../agents/shared/agent-activity.js";
import { listAgentAdapterDescriptors } from "../agents/shared/agent-adapter.js";
import { AgentUpdateManager, type AgentUpdateJobSnapshot, type AgentUpdateOperation } from "../agents/shared/agent-updates.js";
import { createAgentSessionService, enabledAgents } from "../agents/shared/agent-factory.js";
import { AuditLogStore, type AuditEvent, type AuditListOptions } from "../access/audit-log.js";
import { BotPreferencesStore } from "../state/bot-preferences.js";
import { ChannelCommandService } from "../channels/shared/channel-command-service.js";
import { ChannelTurnService } from "../channels/shared/channel-turn-service.js";
import { activeSessionSourceForContextKey, ChannelMirrorRegistry } from "../channels/shared/channel-mirror-registry.js";
import type { LoginResult } from "../agents/codex/codex-auth.js";
import { listThreads as listCodexThreads } from "../agents/codex/codex-state.js";
import type { ConnectorConfig } from "../core/config.js";
import type { ChannelContextKey } from "../channels/shared/context-key.js";
import { friendlyErrorText } from "../core/error-messages.js";
import { clearLogFile, getAgentUpdateLogPath, getConnectorHealth, getConnectorLogPath, getPackageVersion, getUpdateLogPath, getVersionChecks, readConnectorState, readFormattedLogTail, spawnConnectorRestart, spawnSelfUpdate } from "../support/operations.js";
import { PromptStore, toPromptEnvelope, type PromptEnvelope } from "../state/prompt-store.js";
import { UnifiedJobStore } from "../state/job-store.js";
import { buildRuntimeMetrics, type RuntimeMetricsDto } from "./metrics.js";
import { RelayArtifactService } from "./relay-artifact-service.js";
import { RelayAuthService } from "./relay-auth-service.js";
import { RelayExternalActivityMonitor } from "./relay-external-activity-monitor.js";
import { RelayQueueService, type RelayQueueAction } from "./relay-queue-service.js";
import { RuntimeSnapshotCache } from "./runtime-cache.js";
import {
  activeSessionPriority,
  activityToUnifiedJob,
  agentUpdateStatusToUnified,
  dedupeJobs,
  hostLoginCommand,
  hostLogoutCommand,
  isPromptTerminalActivity,
  normalizeMimeType,
  promptActivityToUnifiedJob,
  shouldRefreshActiveSessions,
  taskToUnifiedJob,
  uploadFileDtos,
} from "./relay-runtime-helpers.js";
import { RelayDashboardService } from "./relay-dashboard-service.js";
import { capabilitiesOf } from "../channels/shared/bot-rendering.js";
import { renderSessionInfoPlain, renderSessionUsageRows } from "../channels/shared/session-format.js";
import { SessionLockStore, type SessionLock } from "../access/session-locks.js";
import { SessionRegistry, type ContextMetadata } from "../state/session-registry.js";
import { createSupportBundle, type SupportBundleResult } from "../support/support-bundle.js";
import { transcribeAudio, type TranscriptionBackend } from "../artifacts/voice.js";
import {
  WebActivityStore,
  WebChatStore,
  type WebActivityActor,
  type WebActivityCategory,
  type WebActivityEvent,
  type WebActivitySource,
  type WebActivityStatus,
  type WebChatMessage,
} from "../web/web-state.js";
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
import { evaluateWorkspacePolicy, filterAllowedWorkspaces } from "../core/workspace-policy.js";

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
import {
  relayRuntimeSubscribe,
  relayRuntimeSnapshot,
  relayRuntimeStatus,
  relayRuntimeBootstrapStatus,
  relayRuntimeVersion,
  relayRuntimeDiagnostics,
  relayRuntimeAdapterHealth,
  relayRuntimePermissions,
  relayRuntimeMetrics,
  relayRuntimeAudit,
  relayRuntimeSupportBundle,
  relayRuntimeLogs,
  relayRuntimeClearLogs,
  relayRuntimeRestartConnector,
  relayRuntimeDispose
} from "./relay-runtime-dashboard.js";
import {
  relayRuntimeUpdateConnector,
  relayRuntimeAgentUpdateJobs,
  relayRuntimeStartAgentUpdate,
  relayRuntimeAgentUpdateLog,
  relayRuntimeDeleteAgentUpdateLog,
  relayRuntimeSendAgentUpdateInput,
  relayRuntimeCancelAgentUpdate,
  relayRuntimeTasks,
  relayRuntimeJobs,
  relayRuntimeJobLog,
  relayRuntimeJobAction,
  relayRuntimeRecordAgentUpdateLifecycle
} from "./relay-runtime-updates-jobs.js";
import {
  relayRuntimeActiveSessions,
  relayRuntimeGetSession,
  relayRuntimeListKnownContextMetadata,
  relayRuntimeDiscoverRunningConnectorSessions,
  relayRuntimeDiscoverActiveCodexSessions,
  relayRuntimeExternalActiveSession,
  relayRuntimeSessionStubForMetadata,
  relayRuntimeCapabilitiesForAgent,
  relayRuntimeActiveSessionKey,
  relayRuntimePreferredActiveSession,
  relayRuntimeRecordActivity,
  relayRuntimeAppendActivity,
  relayRuntimeEnrichActivityInput,
  relayRuntimeEnrichActivityEvent,
  relayRuntimeEnrichActivityFields,
  relayRuntimeAppendAudit,
  relayRuntimeUpdateCurrentProgress,
  relayRuntimeAddCurrentTool,
  relayRuntimeBroadcastQueue,
  relayRuntimeBroadcastStatus,
  relayRuntimeBroadcast,
  relayRuntimeScheduleActiveSessionsBroadcast,
  relayRuntimePublicInfo
} from "./relay-runtime-active-sessions.js";
import {
  relayRuntimeLocks,
  relayRuntimeLockWebSession,
  relayRuntimeUnlockWebSession,
  relayRuntimeControlOptions,
  relayRuntimeAuthStatus,
  relayRuntimeLogin,
  relayRuntimeLogout,
  relayRuntimeChatHistory,
  relayRuntimeWebMirrorPreference,
  relayRuntimeSessionDetail,
  relayRuntimeClearChatHistory,
  relayRuntimeActivity,
  relayRuntimeRetry,
  relayRuntimeSync,
  relayRuntimeListSessions,
  relayRuntimeListSessionsPage,
  relayRuntimeFilteredSessions,
  relayRuntimeListModels,
  relayRuntimeSetAgent,
  relayRuntimeNewSession,
  relayRuntimeSwitchSession,
  relayRuntimeAttachSession,
  relayRuntimeSetModel,
  relayRuntimeSetReasoningEffort,
  relayRuntimeSetFastMode,
  relayRuntimeSetLaunchProfile,
  relayRuntimeHandback,
  relayRuntimeAbort,
  relayRuntimeGetControlSession,
  relayRuntimeCliPathOptions
} from "./relay-runtime-sessions.js";
import {
  relayRuntimeSendPrompt,
  relayRuntimeSendUploadPrompt,
  relayRuntimeSendEnvelope,
  relayRuntimeQueue,
  relayRuntimeQueuePaused,
  relayRuntimeQueueAction,
  relayRuntimeArtifacts,
  relayRuntimeArtifact,
  relayRuntimeDeleteArtifact,
  relayRuntimeCreateArtifactZip,
  relayRuntimeArtifactPreview,
  relayRuntimeEnsureActiveThread,
  relayRuntimeEnsureIdle,
  relayRuntimeRunPrompt,
  relayRuntimeDrainQueue,
  relayRuntimeUpdateSession
} from "./relay-runtime-prompt-queue-artifacts.js";

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
  private readonly dashboardService: RelayDashboardService;
  private readonly turnService: ChannelTurnService;
  private readonly authService: RelayAuthService;
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
    this.authService = new RelayAuthService(config);
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
    this.dashboardService = new RelayDashboardService({
      config,
      cache: this.cache,
      snapshot: () => this.snapshot(),
      getSession: () => this.getSession(true),
      queuePaused: () => this.queueService.isPaused(),
      externalMirror: () => this.externalActivityMonitor.snapshot(),
      authStatus: (agentId) => this.authStatus(agentId),
      cliPathOptions: () => this.cliPathOptions(),
    });
    this.dashboardService.startBackgroundRefresh();
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
      checkAuth: (info) => this.authService.check(info),
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
    return relayRuntimeSubscribe(this as any, callback);
  }

  async snapshot(): Promise<RelaySnapshot> {
    return relayRuntimeSnapshot(this as any);
  }

  async status(): Promise<Record<string, unknown>> {
    return relayRuntimeStatus(this as any);
  }

  async bootstrapStatus(): Promise<Record<string, unknown>> {
    return relayRuntimeBootstrapStatus(this as any);
  }

  async version(): Promise<Record<string, unknown>> {
    return relayRuntimeVersion(this as any);
  }

  updateConnector(actor?: WebActivityActor): ReturnType<typeof spawnSelfUpdate> {
    return relayRuntimeUpdateConnector(this as any, actor);
  }

  agentUpdateJobs(): AgentUpdateJobSnapshot[] {
    return relayRuntimeAgentUpdateJobs(this as any);
  }

  startAgentUpdate(agentId: AgentId, operation: AgentUpdateOperation = "update", actor?: WebActivityActor): AgentUpdateJobSnapshot {
    return relayRuntimeStartAgentUpdate(this as any, agentId, operation, actor);
  }

  agentUpdateLog(id: string): ReturnType<AgentUpdateManager["readLog"]> {
    return relayRuntimeAgentUpdateLog(this as any, id);
  }

  deleteAgentUpdateLog(id: string, actor?: WebActivityActor): AgentUpdateJobSnapshot {
    return relayRuntimeDeleteAgentUpdateLog(this as any, id, actor);
  }

  sendAgentUpdateInput(id: string, input: string, actor?: WebActivityActor): AgentUpdateJobSnapshot {
    return relayRuntimeSendAgentUpdateInput(this as any, id, input, actor);
  }

  cancelAgentUpdate(id: string, actor?: WebActivityActor): AgentUpdateJobSnapshot {
    return relayRuntimeCancelAgentUpdate(this as any, id, actor);
  }

  async diagnostics(): Promise<WebDiagnosticsDto> {
    return relayRuntimeDiagnostics(this as any);
  }

  async adapterHealth(): Promise<WebAdapterHealthDto[]> {
    return relayRuntimeAdapterHealth(this as any);
  }

  permissions(): WebPermissionsDto {
    return relayRuntimePermissions(this as any);
  }

  tasks(): WebTasksDto {
    return relayRuntimeTasks(this as any);
  }

  async jobs(): Promise<UnifiedJobsDto> {
    return relayRuntimeJobs(this as any);
  }

  async jobLog(id: string): Promise<{ job: UnifiedJobDto | null; plain: string }> {
    return relayRuntimeJobLog(this as any, id);
  }

  async jobAction(id: string, action: "cancel" | "retry", actor?: WebActivityActor): Promise<UnifiedJobsDto> {
    return relayRuntimeJobAction(this as any, id, action, actor);
  }

  async activeSessions(): Promise<ActiveSessionsDto> {
    return relayRuntimeActiveSessions(this as any);
  }

  async metrics(): Promise<RuntimeMetricsDto> {
    return relayRuntimeMetrics(this as any);
  }

  audit(options: number | AuditListOptions = 50): AuditEvent[] {
    return relayRuntimeAudit(this as any, options);
  }

  async supportBundle(actor?: WebActivityActor): Promise<SupportBundleResult> {
    return relayRuntimeSupportBundle(this as any, actor);
  }

  locks(): SessionLock[] {
    return relayRuntimeLocks(this as any);
  }

  lockWebSession(ownerName = "Web dashboard", actor?: WebActivityActor): SessionLock {
    return relayRuntimeLockWebSession(this as any, ownerName, actor);
  }

  unlockWebSession(actor?: WebActivityActor): { removed: boolean; locks: SessionLock[] } {
    return relayRuntimeUnlockWebSession(this as any, actor);
  }

  async controlOptions(agentId?: AgentId): Promise<DashboardControlOptions> {
    return relayRuntimeControlOptions(this as any, agentId);
  }

  async authStatus(agentId?: AgentId): Promise<WebAuthDto> {
    return relayRuntimeAuthStatus(this as any, agentId);
  }

  async login(agentId?: AgentId, actor?: WebActivityActor): Promise<WebAuthDto & { result: LoginResult | null }> {
    return relayRuntimeLogin(this as any, agentId, actor);
  }

  async logout(agentId?: AgentId, actor?: WebActivityActor): Promise<WebAuthDto & { result: LoginResult | null }> {
    return relayRuntimeLogout(this as any, agentId, actor);
  }

  async chatHistory(limit = 200): Promise<WebChatMessage[]> {
    return relayRuntimeChatHistory(this as any, limit);
  }

  async webMirrorPreference(argument = "", actor?: WebActivityActor): Promise<{
    mode: string;
    minInterval: number;
    response: { plain: string; html: string };
  }> {
    return relayRuntimeWebMirrorPreference(this as any, argument, actor);
  }

  async sessionDetail(threadId: string): Promise<Record<string, unknown>> {
    return relayRuntimeSessionDetail(this as any, threadId);
  }

  async clearChatHistory(actor?: WebActivityActor): Promise<{ removed: number; messages: WebChatMessage[] }> {
    return relayRuntimeClearChatHistory(this as any, actor);
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
    return relayRuntimeActivity(this as any, options);
  }

  async retry(actor?: WebActivityActor): Promise<{ queued: boolean; queueId?: string }> {
    return relayRuntimeRetry(this as any, actor);
  }

  async sync(actor?: WebActivityActor): Promise<ReturnType<AgentSessionService["syncFromAgentState"]>> {
    return relayRuntimeSync(this as any, actor);
  }

  async listSessions(limit = 80, query = "", agentId?: AgentId): Promise<AgentThreadRecord[]> {
    return relayRuntimeListSessions(this as any, limit, query, agentId);
  }

  async listSessionsPage(page = 1, pageSize = MAX_WEB_SESSION_PAGE_SIZE, query = "", agentId?: AgentId): Promise<SessionPageDto> {
    return relayRuntimeListSessionsPage(this as any, page, pageSize, query, agentId);
  }

  private filteredSessions(session: AgentSessionService, query: string, limit: number): AgentThreadRecord[] {
    return relayRuntimeFilteredSessions(this as any, session, query, limit);
  }

  async listModels(): Promise<ReturnType<AgentSessionService["listModels"]>> {
    return relayRuntimeListModels(this as any);
  }

  async setAgent(agentId: AgentId, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    return relayRuntimeSetAgent(this as any, agentId, actor);
  }

  async newSession(options: {
    agentId?: AgentId;
    workspace?: string;
    model?: string;
    reasoningEffort?: string;
    launchProfileId?: string;
    fastMode?: boolean;
  } = {}, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    return relayRuntimeNewSession(this as any, options, actor);
  }

  async switchSession(threadId: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    return relayRuntimeSwitchSession(this as any, threadId, actor);
  }

  async attachSession(threadId: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    return relayRuntimeAttachSession(this as any, threadId, actor);
  }

  async setModel(model: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    return relayRuntimeSetModel(this as any, model, actor);
  }

  async setReasoningEffort(effort: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    return relayRuntimeSetReasoningEffort(this as any, effort, actor);
  }

  async setFastMode(enabled: boolean, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    return relayRuntimeSetFastMode(this as any, enabled, actor);
  }

  async setLaunchProfile(profileId: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    return relayRuntimeSetLaunchProfile(this as any, profileId, actor);
  }

  async handback(actor?: WebActivityActor): Promise<ReturnType<AgentSessionService["handback"]>> {
    return relayRuntimeHandback(this as any, actor);
  }

  async abort(actor?: WebActivityActor): Promise<void> {
    return relayRuntimeAbort(this as any, actor);
  }

  async sendPrompt(text: string, actor?: WebActivityActor): Promise<{ queued: boolean; queueId?: string }> {
    return relayRuntimeSendPrompt(this as any, text, actor);
  }

  async sendUploadPrompt(options: { text?: string; files: UploadPromptFile[] }, actor?: WebActivityActor): Promise<UploadPromptResult> {
    return relayRuntimeSendUploadPrompt(this as any, options, actor);
  }

  private async sendEnvelope(envelope: PromptEnvelope, actor?: WebActivityActor): Promise<{ queued: boolean; queueId?: string }> {
    return relayRuntimeSendEnvelope(this as any, envelope, actor);
  }

  queue(): QueueItemDto[] {
    return relayRuntimeQueue(this as any);
  }

  queuePaused(): boolean {
    return relayRuntimeQueuePaused(this as any);
  }

  queueAction(action: RelayQueueAction, id?: string, actor?: WebActivityActor): QueueItemDto[] {
    return relayRuntimeQueueAction(this as any, action, id, actor);
  }

  async artifacts(): Promise<ArtifactReportDto[]> {
    return relayRuntimeArtifacts(this as any);
  }

  async artifact(turnId: string): Promise<ArtifactTurnReport | null> {
    return relayRuntimeArtifact(this as any, turnId);
  }

  async deleteArtifact(turnId: string, actor?: WebActivityActor): Promise<boolean> {
    return relayRuntimeDeleteArtifact(this as any, turnId, actor);
  }

  async createArtifactZip(turnId: string, actor?: WebActivityActor): Promise<{ path: string; name: string } | null> {
    return relayRuntimeCreateArtifactZip(this as any, turnId, actor);
  }

  async artifactPreview(turnId: string, relativePath: string): Promise<ArtifactPreviewDto | null> {
    return relayRuntimeArtifactPreview(this as any, turnId, relativePath);
  }

  async logs(target: "connector" | "update" | "agent-updates" = "connector", lines = 100): Promise<ReturnType<typeof readFormattedLogTail>> {
    return relayRuntimeLogs(this as any, target, lines);
  }

  clearLogs(target: "connector" | "update" | "agent-updates" = "connector", actor?: WebActivityActor): { ok: true; filePath: string; clearedAt: string } {
    return relayRuntimeClearLogs(this as any, target, actor);
  }

  restartConnector(actor?: WebActivityActor): { ok: true; message: string } {
    return relayRuntimeRestartConnector(this as any, actor);
  }

  dispose(): void {
    return relayRuntimeDispose(this as any);
  }

  private async getSession(deferThreadStart: boolean): Promise<AgentSessionService> {
    return relayRuntimeGetSession(this as any, deferThreadStart);
  }

  private listKnownContextMetadata(): ContextMetadata[] {
    return relayRuntimeListKnownContextMetadata(this as any);
  }

  private discoverRunningConnectorSessions(): ActiveSessionDto[] {
    return relayRuntimeDiscoverRunningConnectorSessions(this as any);
  }

  private discoverActiveCodexSessions(knownContexts: ContextMetadata[], preferences: BotPreferencesStore): ActiveSessionDto[] {
    return relayRuntimeDiscoverActiveCodexSessions(this as any, knownContexts, preferences);
  }

  private externalActiveSession(meta: ContextMetadata, knownContexts: ContextMetadata[], preferences: BotPreferencesStore): ActiveSessionDto | null {
    return relayRuntimeExternalActiveSession(this as any, meta, knownContexts, preferences);
  }

  private sessionStubForMetadata(meta: ContextMetadata, agentId: AgentId, capabilities: AgentCapabilities): AgentSessionService {
    return relayRuntimeSessionStubForMetadata(this as any, meta, agentId, capabilities);
  }

  private capabilitiesForAgent(agentId: AgentId): AgentCapabilities {
    return relayRuntimeCapabilitiesForAgent(this as any, agentId);
  }

  private activeSessionKey(session: Pick<ActiveSessionDto, "agentId" | "threadId" | "id">): string {
    return relayRuntimeActiveSessionKey(this as any, session);
  }

  private preferredActiveSession(existing: ActiveSessionDto | undefined, candidate: ActiveSessionDto): ActiveSessionDto {
    return relayRuntimePreferredActiveSession(this as any, existing, candidate);
  }

  private async getControlSession(agentId?: AgentId): Promise<{ session: AgentSessionService; dispose: boolean }> {
    return relayRuntimeGetControlSession(this as any, agentId);
  }

  private cliPathOptions(): { piCliPath?: string; hermesCliPath?: string; openClawCliPath?: string; claudeCodeCliPath?: string } {
    return relayRuntimeCliPathOptions(this as any);
  }

  private async ensureActiveThread(session: AgentSessionService): Promise<void> {
    return relayRuntimeEnsureActiveThread(this as any, session);
  }

  private ensureIdle(session: AgentSessionService): void {
    return relayRuntimeEnsureIdle(this as any, session);
  }

  private async runPrompt(session: AgentSessionService, envelope: PromptEnvelope): Promise<void> {
    return relayRuntimeRunPrompt(this as any, session, envelope);
  }

  private async drainQueue(): Promise<void> {
    return relayRuntimeDrainQueue(this as any);
  }

  private updateSession(session: AgentSessionService): void {
    return relayRuntimeUpdateSession(this as any, session);
  }

  recordActivity(input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }): WebActivityEvent {
    return relayRuntimeRecordActivity(this as any, input);
  }

  private recordAgentUpdateLifecycle(job: AgentUpdateJobSnapshot): void {
    return relayRuntimeRecordAgentUpdateLifecycle(this as any, job);
  }

  private appendActivity(input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }): WebActivityEvent {
    return relayRuntimeAppendActivity(this as any, input);
  }

  private enrichActivityInput<T extends Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }>(input: T): T {
    return relayRuntimeEnrichActivityInput(this as any, input);
  }

  private enrichActivityEvent(event: WebActivityEvent, info?: AgentSessionInfo): WebActivityEvent {
    return relayRuntimeEnrichActivityEvent(this as any, event, info);
  }

  private enrichActivityFields<T extends Pick<WebActivityEvent, "threadId"> & Partial<Pick<WebActivityEvent, "workspace" | "agentId">>>(event: T, info?: AgentSessionInfo): T {
    return relayRuntimeEnrichActivityFields(this as any, event, info);
  }

  private appendAudit(input: Omit<AuditEvent, "id" | "timestamp" | "channelId">): AuditEvent {
    return relayRuntimeAppendAudit(this as any, input);
  }

  private updateCurrentProgress(patch: Partial<WebTaskDto> = {}): void {
    return relayRuntimeUpdateCurrentProgress(this as any, patch);
  }

  private addCurrentTool(toolName: string): void {
    return relayRuntimeAddCurrentTool(this as any, toolName);
  }

  private broadcastQueue(): void {
    return relayRuntimeBroadcastQueue(this as any);
  }

  private broadcastStatus(message: string, level: "info" | "warn" | "error" = "info"): void {
    return relayRuntimeBroadcastStatus(this as any, message, level);
  }

  private broadcast(event: RelayEvent): void {
    return relayRuntimeBroadcast(this as any, event);
  }

  private scheduleActiveSessionsBroadcast(): void {
    return relayRuntimeScheduleActiveSessionsBroadcast(this as any);
  }

  private publicInfo(session: AgentSessionService): AgentSessionInfo {
    return relayRuntimePublicInfo(this as any, session);
  }

}
