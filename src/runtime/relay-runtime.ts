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
  type AgentSessionInfoOptions,
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
import { clearLogFile, getAgentUpdateLogPath, getConnectorHealth, getConnectorLogPath, getPackageVersion, getUpdateLogPath, getVersionChecks, readConnectorState, readFormattedLogTail, spawnConnectorRestart, spawnSelfUpdate, type FormattedLogTail } from "../support/operations.js";
import { PromptStore, toPromptEnvelope, type PromptEnvelope } from "../state/prompt-store.js";
import { UnifiedJobStore } from "../state/job-store.js";
import { WorkflowStore } from "../state/workflow-store.js";
import { QueuePlanStore, type QueuePlanStatus } from "../state/queue-plan-store.js";
import { RelayWorkflowService } from "./relay-workflow-service.js";
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
import { startAdaptiveExternalMonitor, type AdaptiveExternalMonitorHandle } from "./relay-external-monitor-scheduler.js";
import { capabilitiesOf } from "../channels/shared/bot-rendering.js";
import { renderSessionInfoPlain, renderSessionUsageRows } from "../channels/shared/session-format.js";
import { SessionLockStore, type SessionLock } from "../access/session-locks.js";
import { SessionRegistry, type ContextMetadata } from "../state/session-registry.js";
import { createSessionWorktreeStore, SessionWorktreeService } from "../worktrees/worktree-service.js";
import type { SessionWorktreeRecord, WorktreeDashboardSnapshot, WorktreeIntegrationRun } from "../worktrees/worktree-types.js";
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
  ArtifactCleanupDto,
  ArtifactDiffDto,
  ArtifactPreviewDto,
  ArtifactReportDto,
  ArtifactUsageDto,
  CursorPageDto,
  DashboardControlOptions,
  QueueItemDto,
  RelayEvent,
  RelaySnapshot,
  SessionPageDto,
  TraceDetailDto,
  UnifiedJobDto,
  UnifiedJobsDto,
  UploadPromptFile,
  UploadPromptResult,
  WebAdapterHealthDto,
  WebAuthDto,
  WebDiagnosticsDto,
  WebPermissionsDto,
  WorkflowPreviewDto,
  WorkflowRunResultDto,
  QueuePlanDto,
  QueuePlannerSnapshotDto,
  WebTaskDto,
  WebTasksDto,
} from "./relay-runtime-types.js";
export type { RuntimeMetricsDto } from "./metrics.js";
import { evaluateWorkspacePolicy, filterAllowedWorkspaces } from "../core/workspace-policy.js";

export type {
  ActiveSessionDto,
  ActiveSessionsDto,
  ArtifactCleanupDto,
  ArtifactDiffDto,
  ArtifactPreviewDto,
  ArtifactReportDto,
  ArtifactUsageDto,
  CursorPageDto,
  DashboardControlOptions,
  ExternalMirrorState,
  QueueItemDto,
  RelayEvent,
  RelaySnapshot,
  SessionPageDto,
  TraceDetailDto,
  UnifiedJobDto,
  UnifiedJobsDto,
  UploadPromptFile,
  UploadPromptResult,
  WebAdapterHealthDto,
  WebAuthDto,
  WebDiagnosticsDto,
  WebPermissionsDto,
  WorkflowPreviewDto,
  WorkflowRunResultDto,
  QueuePlanDto,
  QueuePlannerSnapshotDto,
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
  relayRuntimeAuditPage,
  relayRuntimeSupportBundle,
  relayRuntimeLogs,
  relayRuntimeClearLogs,
  relayRuntimeRestartConnector,
  relayRuntimeDispose
} from "./relay-runtime-dashboard.js";
import { relayRuntimeTrace } from "./relay-runtime-trace.js";
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
  relayRuntimeActivityPage,
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
import { relayRuntimeCommitSessionWorktree, relayRuntimeForkCurrentSessionToWorktree, relayRuntimeIntegrateSessionWorktrees, relayRuntimeRemoveSessionWorktree, relayRuntimeSessionWorktrees } from "./relay-runtime-worktrees.js";
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
  relayRuntimeArtifactDiff,
  relayRuntimeArtifactUsage,
  relayRuntimeArtifactCleanupPreview,
  relayRuntimeArtifactCleanupRun,
  relayRuntimeEnsureActiveThread,
  relayRuntimeEnsureIdle,
  relayRuntimeRunPrompt,
  relayRuntimeDrainQueue,
  relayRuntimeUpdateSession
} from "./relay-runtime-prompt-queue-artifacts.js";
import {
  relayRuntimeApproveQueuePlan,
  relayRuntimeCreateQueuePlan,
  relayRuntimeDeleteQueuePlan,
  relayRuntimeEnqueueQueuePlan,
  relayRuntimeMoveQueuePlan,
  relayRuntimeQueuePlannerSnapshot,
  relayRuntimeUpdateQueuePlan,
  type QueuePlanInput
} from "./relay-runtime-queue-planner.js";

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
  readonly contextKey: ChannelContextKey;
  readonly registry: SessionRegistry;
  readonly promptStore: PromptStore;
  readonly chatStore: WebChatStore;
  readonly activityStore: WebActivityStore;
  readonly auditStore: AuditLogStore;
  readonly preferencesStore: BotPreferencesStore;
  readonly lockStore: SessionLockStore;
  readonly agentUpdates: AgentUpdateManager;
  readonly queueService: RelayQueueService;
  readonly jobStore: UnifiedJobStore;
  readonly workflowStore: WorkflowStore;
  readonly queuePlanStore: QueuePlanStore;
  readonly workflowService: RelayWorkflowService;
  readonly artifactService: RelayArtifactService;
  readonly worktreeService: SessionWorktreeService;
  readonly mirrorRegistry: ChannelMirrorRegistry;
  readonly externalActivityMonitor: RelayExternalActivityMonitor;
  readonly cache = new RuntimeSnapshotCache();
  readonly dashboardService: RelayDashboardService;
  readonly turnService: ChannelTurnService;
  readonly authService: RelayAuthService;
  readonly subscribers = new Set<(event: RelayEvent) => void>();
  readonly agentUpdateActors = new Map<string, WebActivityActor>();
  readonly agentUpdateStates = new Map<string, { status: AgentUpdateJobSnapshot["status"]; needsInput: boolean }>();
  externalMonitor?: AdaptiveExternalMonitorHandle;
  activeSessionsBroadcastTimer: NodeJS.Timeout | null = null;
  activeSessionsLastBroadcastAt = 0;
  draining = false;
  currentTurnId: string | null = null;
  accumulatedText = "";
  currentTurnStartedAt = 0;
  currentProgress: WebTaskDto | null = null;

  constructor(readonly config: ConnectorConfig, options: RelayRuntimeOptions = {}) {
    this.contextKey = options.contextKey ?? WEB_CONTEXT_KEY;
    this.worktreeService = new SessionWorktreeService(config, createSessionWorktreeStore(config));
    this.registry = new SessionRegistry(config, {
      fileName: options.registryFileName ?? "web-contexts.json",
      sqliteKey: options.registrySqliteKey ?? "web-contexts",
      worktreeService: this.worktreeService,
    });
    this.promptStore = new PromptStore(config.workspace, config.stateBackend);
    this.chatStore = new WebChatStore(config.workspace, config.stateBackend, MAX_CHAT_HISTORY);
    this.activityStore = new WebActivityStore(config.workspace, config.stateBackend, config.auditMaxEvents);
    this.auditStore = new AuditLogStore(config.workspace, config.stateBackend, config.auditMaxEvents);
    this.preferencesStore = new BotPreferencesStore(config.workspace, config.stateBackend);
    this.lockStore = new SessionLockStore(config.workspace, config.stateBackend);
    this.queueService = new RelayQueueService(this.promptStore, this.contextKey);
    this.jobStore = new UnifiedJobStore(config.workspace, config.stateBackend, config.unifiedJobMaxItems);
    this.workflowStore = new WorkflowStore(config.workspace, config.stateBackend);
    this.queuePlanStore = new QueuePlanStore(config.workspace, config.stateBackend);
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
      scheduleActiveSessionsBroadcast: () => this.scheduleActiveSessionsBroadcast(),
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
      this.externalMonitor = startAdaptiveExternalMonitor({
        baseMs: config.codexExternalBusyCheckMs,
        run: () => this.externalActivityMonitor.monitorSafe(),
      });
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
    this.workflowService = new RelayWorkflowService({
      store: this.workflowStore,
      getSession: (deferThreadStart) => this.getSession(deferThreadStart),
      newSession: (input, actor) => this.newSession(input, actor),
      setAgent: (agentId, actor) => this.setAgent(agentId, actor),
      attachSession: (threadId, actor) => this.attachSession(threadId, actor),
      runPrompt: (session, envelope) => this.runPrompt(session, envelope),
      isSessionBusy: (session) => session.isProcessing() || Boolean(getExternalSnapshotForSession(session, this.config, { maxEvents: 0 })?.activity.active),
      abort: (actor) => this.abort(actor),
      appendActivity: (input) => this.appendActivity(input),
      appendAudit: (input) => this.appendAudit(input),
      upsertJob: (job) => { this.jobStore.upsert(job); },
      broadcastStatus: (message, level) => this.broadcastStatus(message, level),
    });
  }

  subscribe(callback: (event: RelayEvent) => void): () => void {
    return relayRuntimeSubscribe(this, callback);
  }

  async snapshot(): Promise<RelaySnapshot> {
    return relayRuntimeSnapshot(this);
  }

  async status(): Promise<Record<string, unknown>> {
    return relayRuntimeStatus(this);
  }

  async bootstrapStatus(): Promise<Record<string, unknown>> {
    return relayRuntimeBootstrapStatus(this);
  }

  async version(): Promise<Record<string, unknown>> {
    return relayRuntimeVersion(this);
  }

  updateConnector(actor?: WebActivityActor): ReturnType<typeof spawnSelfUpdate> {
    return relayRuntimeUpdateConnector(this, actor);
  }

  agentUpdateJobs(): AgentUpdateJobSnapshot[] {
    return relayRuntimeAgentUpdateJobs(this);
  }

  startAgentUpdate(agentId: AgentId, operation: AgentUpdateOperation = "update", actor?: WebActivityActor): AgentUpdateJobSnapshot {
    return relayRuntimeStartAgentUpdate(this, agentId, operation, actor);
  }

  agentUpdateLog(id: string): ReturnType<AgentUpdateManager["readLog"]> {
    return relayRuntimeAgentUpdateLog(this, id);
  }

  deleteAgentUpdateLog(id: string, actor?: WebActivityActor): AgentUpdateJobSnapshot {
    return relayRuntimeDeleteAgentUpdateLog(this, id, actor);
  }

  sendAgentUpdateInput(id: string, input: string, actor?: WebActivityActor): AgentUpdateJobSnapshot {
    return relayRuntimeSendAgentUpdateInput(this, id, input, actor);
  }

  cancelAgentUpdate(id: string, actor?: WebActivityActor): AgentUpdateJobSnapshot {
    return relayRuntimeCancelAgentUpdate(this, id, actor);
  }

  async diagnostics(): Promise<WebDiagnosticsDto> {
    return relayRuntimeDiagnostics(this);
  }

  async adapterHealth(): Promise<WebAdapterHealthDto[]> {
    return relayRuntimeAdapterHealth(this);
  }

  permissions(): WebPermissionsDto {
    return relayRuntimePermissions(this);
  }

  tasks(): WebTasksDto {
    return relayRuntimeTasks(this);
  }

  async jobs(options: { limit?: number; cursor?: string } = {}): Promise<UnifiedJobsDto> {
    return relayRuntimeJobs(this, options);
  }

  async jobLog(id: string): Promise<{ job: UnifiedJobDto | null; plain: string }> {
    return relayRuntimeJobLog(this, id);
  }

  async jobAction(id: string, action: "cancel" | "retry", actor?: WebActivityActor): Promise<UnifiedJobsDto> {
    return relayRuntimeJobAction(this, id, action, actor);
  }

  async activeSessions(): Promise<ActiveSessionsDto> {
    return relayRuntimeActiveSessions(this);
  }

  async metrics(): Promise<RuntimeMetricsDto> {
    return relayRuntimeMetrics(this);
  }

  audit(options: number | AuditListOptions = 50): AuditEvent[] {
    return relayRuntimeAudit(this, options);
  }

  auditPage(options: AuditListOptions = {}): CursorPageDto<AuditEvent> {
    return relayRuntimeAuditPage(this, options);
  }

  async trace(correlationId: string): Promise<TraceDetailDto> {
    return relayRuntimeTrace(this, correlationId);
  }

  async supportBundle(actor?: WebActivityActor): Promise<SupportBundleResult> {
    return relayRuntimeSupportBundle(this, actor);
  }

  locks(): SessionLock[] {
    return relayRuntimeLocks(this);
  }

  lockWebSession(ownerName = "Web dashboard", actor?: WebActivityActor): SessionLock {
    return relayRuntimeLockWebSession(this, ownerName, actor);
  }

  unlockWebSession(actor?: WebActivityActor): { removed: boolean; locks: SessionLock[] } {
    return relayRuntimeUnlockWebSession(this, actor);
  }

  async controlOptions(agentId?: AgentId): Promise<DashboardControlOptions> {
    return relayRuntimeControlOptions(this, agentId);
  }

  async authStatus(agentId?: AgentId): Promise<WebAuthDto> {
    return relayRuntimeAuthStatus(this, agentId);
  }

  async login(agentId?: AgentId, actor?: WebActivityActor): Promise<WebAuthDto & { result: LoginResult | null }> {
    return relayRuntimeLogin(this, agentId, actor);
  }

  async logout(agentId?: AgentId, actor?: WebActivityActor): Promise<WebAuthDto & { result: LoginResult | null }> {
    return relayRuntimeLogout(this, agentId, actor);
  }

  async chatHistory(limit = 200): Promise<WebChatMessage[]> {
    return relayRuntimeChatHistory(this, limit);
  }

  async webMirrorPreference(argument = "", actor?: WebActivityActor): Promise<{
    mode: string;
    minInterval: number;
    response: { plain: string; html: string };
  }> {
    return relayRuntimeWebMirrorPreference(this, argument, actor);
  }

  async sessionDetail(threadId: string): Promise<Record<string, unknown>> {
    return relayRuntimeSessionDetail(this, threadId);
  }

  async clearChatHistory(actor?: WebActivityActor): Promise<{ removed: number; messages: WebChatMessage[] }> {
    return relayRuntimeClearChatHistory(this, actor);
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
    return relayRuntimeActivity(this, options);
  }

  activityPage(options: {
    limit?: number;
    cursor?: string;
    source?: WebActivitySource | "all";
    status?: WebActivityStatus | "all";
    category?: WebActivityCategory | "all";
    actor?: string;
    agentId?: AgentId | "all" | string;
    threadId?: string;
    workspace?: string;
    type?: string;
    since?: string | number;
  } = {}): CursorPageDto<WebActivityEvent> {
    return relayRuntimeActivityPage(this, options);
  }

  async retry(actor?: WebActivityActor): Promise<{ queued: boolean; queueId?: string; correlationId?: string }> {
    return relayRuntimeRetry(this, actor);
  }

  async sync(actor?: WebActivityActor): Promise<ReturnType<AgentSessionService["syncFromAgentState"]>> {
    return relayRuntimeSync(this, actor);
  }

  async listSessions(limit = 80, query = "", agentId?: AgentId): Promise<AgentThreadRecord[]> {
    return relayRuntimeListSessions(this, limit, query, agentId);
  }

  async listSessionsPage(page = 1, pageSize = MAX_WEB_SESSION_PAGE_SIZE, query = "", agentId?: AgentId): Promise<SessionPageDto> {
    return relayRuntimeListSessionsPage(this, page, pageSize, query, agentId);
  }

  filteredSessions(session: AgentSessionService, query: string, limit: number): AgentThreadRecord[] {
    return relayRuntimeFilteredSessions(this, session, query, limit);
  }

  async listModels(): Promise<ReturnType<AgentSessionService["listModels"]>> {
    return relayRuntimeListModels(this);
  }

  async setAgent(agentId: AgentId, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    return relayRuntimeSetAgent(this, agentId, actor);
  }

  async newSession(options: { agentId?: AgentId; workspace?: string; workspaceMode?: "shared" | "worktree" | "attached"; model?: string; reasoningEffort?: string; launchProfileId?: string; fastMode?: boolean } = {}, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    return relayRuntimeNewSession(this, options, actor);
  }

  async switchSession(threadId: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    return relayRuntimeSwitchSession(this, threadId, actor);
  }

  async attachSession(threadId: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    return relayRuntimeAttachSession(this, threadId, actor);
  }

  async sessionWorktrees(): Promise<WorktreeDashboardSnapshot> { return relayRuntimeSessionWorktrees(this); }
  async commitSessionWorktree(id: string, message?: string, actor?: WebActivityActor): Promise<{ record: SessionWorktreeRecord; clean: boolean; status: string[] }> { return relayRuntimeCommitSessionWorktree(this, id, message, actor); }
  async integrateSessionWorktrees(ids: string[], actor?: WebActivityActor): Promise<WorktreeIntegrationRun> { return relayRuntimeIntegrateSessionWorktrees(this, ids, actor); }
  async forkCurrentSessionToWorktree(options: { includeUncommitted?: boolean } = {}, actor?: WebActivityActor): Promise<{ session: AgentSessionInfo; record: SessionWorktreeRecord; copiedUntrackedFiles: string[]; skippedUntrackedFiles: string[]; patchApplied: boolean }> { return relayRuntimeForkCurrentSessionToWorktree(this, options, actor); }
  async removeSessionWorktree(id: string, force = false, actor?: WebActivityActor): Promise<SessionWorktreeRecord> { return relayRuntimeRemoveSessionWorktree(this, id, force, actor); }

  async setModel(model: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    return relayRuntimeSetModel(this, model, actor);
  }

  async setReasoningEffort(effort: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    return relayRuntimeSetReasoningEffort(this, effort, actor);
  }

  async setFastMode(enabled: boolean, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    return relayRuntimeSetFastMode(this, enabled, actor);
  }

  async setLaunchProfile(profileId: string, actor?: WebActivityActor, options: { applyToCurrent?: boolean } = {}): Promise<AgentSessionInfo> {
    return relayRuntimeSetLaunchProfile(this, profileId, actor, options);
  }

  async handback(actor?: WebActivityActor): Promise<ReturnType<AgentSessionService["handback"]>> {
    return relayRuntimeHandback(this, actor);
  }

  async abort(actor?: WebActivityActor): Promise<void> {
    return relayRuntimeAbort(this, actor);
  }

  async sendPrompt(text: string, actor?: WebActivityActor, correlationId?: string): Promise<{ queued: boolean; queueId?: string; correlationId?: string }> {
    return relayRuntimeSendPrompt(this, text, actor, correlationId);
  }

  async sendUploadPrompt(options: { text?: string; files: UploadPromptFile[]; correlationId?: string }, actor?: WebActivityActor): Promise<UploadPromptResult> {
    return relayRuntimeSendUploadPrompt(this, options, actor);
  }

  async sendEnvelope(envelope: PromptEnvelope, actor?: WebActivityActor): Promise<{ queued: boolean; queueId?: string; correlationId?: string }> {
    return relayRuntimeSendEnvelope(this, envelope, actor);
  }

  queue(): QueueItemDto[] {
    return relayRuntimeQueue(this);
  }

  queuePaused(): boolean {
    return relayRuntimeQueuePaused(this);
  }

  queueAction(action: RelayQueueAction, id?: string, actor?: WebActivityActor): QueueItemDto[] {
    return relayRuntimeQueueAction(this, action, id, actor);
  }

  queuePlanner(): QueuePlannerSnapshotDto { return relayRuntimeQueuePlannerSnapshot(this); }
  async createQueuePlan(input: QueuePlanInput, actor?: WebActivityActor): Promise<QueuePlanDto> { return relayRuntimeCreateQueuePlan(this, input, actor); }
  updateQueuePlan(id: string, input: Partial<QueuePlanInput>, actor?: WebActivityActor): QueuePlanDto { return relayRuntimeUpdateQueuePlan(this, id, input, actor); }
  async moveQueuePlan(id: string, status: QueuePlanStatus, actor?: WebActivityActor): Promise<QueuePlanDto> { return relayRuntimeMoveQueuePlan(this, id, status, actor); }
  approveQueuePlan(id: string, actor?: WebActivityActor): QueuePlanDto { return relayRuntimeApproveQueuePlan(this, id, actor); }
  async enqueueQueuePlan(id: string, actor?: WebActivityActor): Promise<QueuePlanDto> { return relayRuntimeEnqueueQueuePlan(this, id, actor); }
  deleteQueuePlan(id: string, actor?: WebActivityActor): { removed: boolean; snapshot: QueuePlannerSnapshotDto } { return relayRuntimeDeleteQueuePlan(this, id, actor); }

  async artifacts(limit = 20): Promise<ArtifactReportDto[]> { return relayRuntimeArtifacts(this, limit); }
  async artifact(turnId: string): Promise<ArtifactTurnReport | null> { return relayRuntimeArtifact(this, turnId); }
  async deleteArtifact(turnId: string, actor?: WebActivityActor): Promise<boolean> { return relayRuntimeDeleteArtifact(this, turnId, actor); }
  async createArtifactZip(turnId: string, actor?: WebActivityActor): Promise<{ path: string; name: string } | null> { return relayRuntimeCreateArtifactZip(this, turnId, actor); }
  async artifactPreview(turnId: string, relativePath: string): Promise<ArtifactPreviewDto | null> { return relayRuntimeArtifactPreview(this, turnId, relativePath); }
  async artifactDiff(turnId: string, relativePath: string): Promise<ArtifactDiffDto | null> { return relayRuntimeArtifactDiff(this, turnId, relativePath); }
  async artifactUsage(): Promise<ArtifactUsageDto> { return relayRuntimeArtifactUsage(this); }
  async artifactCleanupPreview(): Promise<ArtifactCleanupDto> { return relayRuntimeArtifactCleanupPreview(this); }
  async artifactCleanupRun(actor?: WebActivityActor): Promise<ArtifactCleanupDto> { return relayRuntimeArtifactCleanupRun(this, actor); }

  async logs(target: "connector" | "update" | "agent-updates" = "connector", lines = 100): Promise<FormattedLogTail> {
    return relayRuntimeLogs(this, target, lines);
  }

  clearLogs(target: "connector" | "update" | "agent-updates" = "connector", actor?: WebActivityActor): { ok: true; filePath: string; clearedAt: string } {
    return relayRuntimeClearLogs(this, target, actor);
  }

  restartConnector(actor?: WebActivityActor): { ok: true; message: string } {
    return relayRuntimeRestartConnector(this, actor);
  }

  dispose(): void {
    return relayRuntimeDispose(this);
  }

  async getSession(deferThreadStart: boolean): Promise<AgentSessionService> {
    return relayRuntimeGetSession(this, deferThreadStart);
  }

  listKnownContextMetadata(): ContextMetadata[] {
    return relayRuntimeListKnownContextMetadata(this);
  }

  discoverRunningConnectorSessions(): ActiveSessionDto[] {
    return relayRuntimeDiscoverRunningConnectorSessions(this);
  }

  discoverActiveCodexSessions(knownContexts: ContextMetadata[], preferences: BotPreferencesStore): ActiveSessionDto[] {
    return relayRuntimeDiscoverActiveCodexSessions(this, knownContexts, preferences);
  }

  externalActiveSession(meta: ContextMetadata, knownContexts: ContextMetadata[], preferences: BotPreferencesStore): ActiveSessionDto | null {
    return relayRuntimeExternalActiveSession(this, meta, knownContexts, preferences);
  }

  sessionStubForMetadata(meta: ContextMetadata, agentId: AgentId, capabilities: AgentCapabilities): AgentSessionService {
    return relayRuntimeSessionStubForMetadata(this, meta, agentId, capabilities);
  }

  capabilitiesForAgent(agentId: AgentId): AgentCapabilities {
    return relayRuntimeCapabilitiesForAgent(this, agentId);
  }

  activeSessionKey(session: Pick<ActiveSessionDto, "agentId" | "threadId" | "id">): string {
    return relayRuntimeActiveSessionKey(this, session);
  }

  preferredActiveSession(existing: ActiveSessionDto | undefined, candidate: ActiveSessionDto): ActiveSessionDto {
    return relayRuntimePreferredActiveSession(this, existing, candidate);
  }

  async getControlSession(agentId?: AgentId): Promise<{ session: AgentSessionService; dispose: boolean }> {
    return relayRuntimeGetControlSession(this, agentId);
  }

  cliPathOptions(): { piCliPath?: string; hermesCliPath?: string; openClawCliPath?: string; claudeCodeCliPath?: string } {
    return relayRuntimeCliPathOptions(this);
  }

  async ensureActiveThread(session: AgentSessionService): Promise<void> {
    return relayRuntimeEnsureActiveThread(this, session);
  }

  ensureIdle(session: AgentSessionService): void {
    return relayRuntimeEnsureIdle(this, session);
  }

  async runPrompt(session: AgentSessionService, envelope: PromptEnvelope): Promise<void> {
    return relayRuntimeRunPrompt(this, session, envelope);
  }

  async drainQueue(): Promise<void> {
    return relayRuntimeDrainQueue(this);
  }

  updateSession(session: AgentSessionService): void {
    return relayRuntimeUpdateSession(this, session);
  }

  recordActivity(input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }): WebActivityEvent {
    return relayRuntimeRecordActivity(this, input);
  }

  recordAgentUpdateLifecycle(job: AgentUpdateJobSnapshot): void {
    return relayRuntimeRecordAgentUpdateLifecycle(this, job);
  }

  appendActivity(input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }): WebActivityEvent {
    return relayRuntimeAppendActivity(this, input);
  }

  enrichActivityInput<T extends Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }>(input: T): T {
    return relayRuntimeEnrichActivityInput(this, input);
  }

  enrichActivityEvent(event: WebActivityEvent, info?: AgentSessionInfo): WebActivityEvent {
    return relayRuntimeEnrichActivityEvent(this, event, info);
  }

  enrichActivityFields<T extends Pick<WebActivityEvent, "threadId"> & Partial<Pick<WebActivityEvent, "workspace" | "agentId">>>(event: T, info?: AgentSessionInfo): T {
    return relayRuntimeEnrichActivityFields(this, event, info);
  }

  appendAudit(input: Omit<AuditEvent, "id" | "timestamp" | "channelId">): AuditEvent {
    return relayRuntimeAppendAudit(this, input);
  }

  updateCurrentProgress(patch: Partial<WebTaskDto> = {}): void {
    return relayRuntimeUpdateCurrentProgress(this, patch);
  }

  addCurrentTool(toolName: string): void {
    return relayRuntimeAddCurrentTool(this, toolName);
  }

  broadcastQueue(): void {
    return relayRuntimeBroadcastQueue(this);
  }

  broadcastStatus(message: string, level: "info" | "warn" | "error" = "info"): void {
    return relayRuntimeBroadcastStatus(this, message, level);
  }

  broadcast(event: RelayEvent): void {
    return relayRuntimeBroadcast(this, event);
  }

  scheduleActiveSessionsBroadcast(): void {
    return relayRuntimeScheduleActiveSessionsBroadcast(this);
  }

  publicInfo(session: AgentSessionService, options?: AgentSessionInfoOptions): AgentSessionInfo { return relayRuntimePublicInfo(this, session, options); }
}
