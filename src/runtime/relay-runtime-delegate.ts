import type { AuditEvent, AuditListOptions } from "../access/audit-log.js";
import type { SessionLock } from "../access/session-locks.js";
import type { ArtifactTurnReport } from "../artifacts/artifacts.js";
import type { LoginResult } from "../agents/codex/codex-auth.js";
import type {
  AgentCapabilities,
  AgentId,
  AgentSessionInfoOptions,
  AgentSessionInfo,
  AgentSessionService,
  AgentThreadRecord,
} from "../agents/shared/agent.js";
import type { AgentUpdateJobSnapshot, AgentUpdateOperation } from "../agents/shared/agent-updates.js";
import type { ChannelMirrorRegistry } from "../channels/shared/channel-mirror-registry.js";
import type { ChannelTurnService } from "../channels/shared/channel-turn-service.js";
import type { ChannelContextKey } from "../channels/shared/context-key.js";
import type { ConnectorConfig } from "../core/config.js";
import type { BotPreferencesStore } from "../state/bot-preferences.js";
import type { UnifiedJobStore } from "../state/job-store.js";
import type { PromptEnvelope, PromptStore } from "../state/prompt-store.js";
import type { SessionNameStore } from "../state/session-names.js";
import type { RelayWorkflowService } from "./relay-workflow-service.js";
import type { WorkflowStore } from "../state/workflow-store.js";
import type { QueuePlanStatus, QueuePlanStore } from "../state/queue-plan-store.js";
import type { MetricsHistoryStore } from "../state/metrics-history-store.js";
import type { QueuePlanInput } from "./relay-runtime-queue-planner.js";
import type { ContextMetadata, SessionRegistry } from "../state/session-registry.js";
import type { FormattedLogReadOptions, FormattedLogTail, SelfUpdateResult } from "../support/operations.js";
import type { SupportBundleResult } from "../support/support-bundle.js";
import type {
  WebActivityActor,
  WebActivityCategory,
  WebActivityEvent,
  WebActivitySource,
  WebActivityStatus,
  WebActivityStore,
  WebChatMessage,
  WebChatStore,
} from "../web/web-state.js";
import type { RelayArtifactService } from "./relay-artifact-service.js";
import type { RelayAuthService } from "./relay-auth-service.js";
import type { RelayDashboardService } from "./relay-dashboard-service.js";
import type { AdaptiveExternalMonitorHandle } from "./relay-external-monitor-scheduler.js";
import type { RelayExternalActivityMonitor } from "./relay-external-activity-monitor.js";
import type { RelayQueueAction, RelayQueueService } from "./relay-queue-service.js";
import type { RuntimeMetricHistorySample, RuntimeMetricsDto } from "./metrics.js";
import type { RuntimeSnapshotCache } from "./runtime-cache.js";
import type { SessionWorktreeService } from "../worktrees/worktree-service.js";
import type {
  SessionWorktreeDiffSnapshot,
  SessionWorktreeRecord,
  SessionWorktreeUpdateResult,
  WorktreeCleanupResult,
  WorktreeDashboardSnapshot,
  WorktreeFinalizeIntegrationOptions,
  WorktreeFinalizeIntegrationResult,
  WorktreeIntegrationOptions, WorktreeIntegrationPatchExport, WorktreeIntegrationRun,
  WorktreeIntegrationPreview,
} from "../worktrees/worktree-types.js";
import type {
  ActiveSessionDto, ActiveSessionsDto,
  ArtifactPreviewDto,
  ArtifactReportDto,
  ArtifactUsageDto,
  ArtifactCleanupDto,
  ArtifactDiffDto,
  CursorPageDto,
  DashboardControlOptions,
  QueueItemDto,
  QueuePlanDto,
  QueuePlannerSnapshotDto,
  RelayEvent,
  RelaySnapshot,
  SessionPageDto,
  UnifiedJobDto,
  UnifiedJobsDto,
  UploadPromptOptions,
  UploadPromptResult,
  WebAdapterHealthDto,
  WebAuthDto,
  WebDiagnosticsDto,
  WebPermissionsDto,
  WebTaskDto,
  WebTasksDto,
  TraceDetailDto,
} from "./relay-runtime-types.js";
import type { AgentUpdateManager } from "../agents/shared/agent-updates.js";
import type { AuditLogStore } from "../access/audit-log.js";
import type { SessionLockStore } from "../access/session-locks.js";

export interface RelayRuntimeActivityOptions {
  limit?: number;
  category?: WebActivityCategory | "all";
  sinceMs?: number;
  since?: string | number;
  source?: WebActivitySource | "all";
  status?: WebActivityStatus | "all";
  actor?: string;
  agentId?: AgentId | "all" | string;
  threadId?: string;
  workspace?: string;
  type?: string;
}

export interface RelayRuntimeDelegate {
  readonly config: ConnectorConfig;
  readonly contextKey: ChannelContextKey;
  readonly registry: SessionRegistry;
  readonly promptStore: PromptStore;
  readonly chatStore: WebChatStore;
  readonly activityStore: WebActivityStore;
  readonly auditStore: AuditLogStore;
  readonly preferencesStore: BotPreferencesStore; readonly sessionNameStore: SessionNameStore;
  readonly lockStore: SessionLockStore;
  readonly agentUpdates: AgentUpdateManager;
  readonly queueService: RelayQueueService;
  readonly jobStore: UnifiedJobStore;
  readonly workflowStore: WorkflowStore; readonly queuePlanStore: QueuePlanStore; readonly metricsHistoryStore: MetricsHistoryStore; readonly workflowService: RelayWorkflowService;
  readonly artifactService: RelayArtifactService;
  readonly worktreeService: SessionWorktreeService;
  readonly mirrorRegistry: ChannelMirrorRegistry;
  readonly externalActivityMonitor: RelayExternalActivityMonitor;
  readonly cache: RuntimeSnapshotCache;
  readonly dashboardService: RelayDashboardService;
  readonly turnService: ChannelTurnService;
  readonly authService: RelayAuthService;
  readonly subscribers: Set<(event: RelayEvent) => void>;
  readonly agentUpdateActors: Map<string, WebActivityActor>;
  readonly agentUpdateStates: Map<string, { status: AgentUpdateJobSnapshot["status"]; needsInput: boolean }>;
  externalMonitor?: AdaptiveExternalMonitorHandle; activeSessionsBroadcastTimer: NodeJS.Timeout | null; metricsHistoryTimer: NodeJS.Timeout | null; activeSessionsLastBroadcastAt: number;
  draining: boolean;
  currentTurnId: string | null;
  accumulatedText: string;
  currentTurnStartedAt: number;
  currentProgress: WebTaskDto | null;

  subscribe(callback: (event: RelayEvent) => void): () => void;
  snapshot(): Promise<RelaySnapshot>;
  status(): Promise<Record<string, unknown>>;
  bootstrapStatus(): Promise<Record<string, unknown>>;
  version(options?: { forceRefresh?: boolean }): Promise<Record<string, unknown>>;
  updateConnector(actor?: WebActivityActor): SelfUpdateResult;
  agentUpdateJobs(): AgentUpdateJobSnapshot[];
  startAgentUpdate(agentId: AgentId, operation?: AgentUpdateOperation, actor?: WebActivityActor): AgentUpdateJobSnapshot;
  agentUpdateLog(id: string): ReturnType<AgentUpdateManager["readLog"]>;
  deleteAgentUpdateLog(id: string, actor?: WebActivityActor): AgentUpdateJobSnapshot;
  sendAgentUpdateInput(id: string, input: string, actor?: WebActivityActor): AgentUpdateJobSnapshot;
  cancelAgentUpdate(id: string, actor?: WebActivityActor): AgentUpdateJobSnapshot;
  diagnostics(): Promise<WebDiagnosticsDto>;
  adapterHealth(): Promise<WebAdapterHealthDto[]>;
  permissions(): WebPermissionsDto;
  tasks(): WebTasksDto;
  jobs(options?: { limit?: number; cursor?: string }): Promise<UnifiedJobsDto>;
  jobLog(id: string): Promise<{ job: UnifiedJobDto | null; plain: string }>;
  jobAction(id: string, action: "cancel" | "retry", actor?: WebActivityActor): Promise<UnifiedJobsDto>;
  activeSessions(): Promise<ActiveSessionsDto>;
  metrics(): Promise<RuntimeMetricsDto>; metricsHistory(limit?: number): RuntimeMetricHistorySample[];
  audit(options?: number | AuditListOptions): AuditEvent[];
  auditPage(options?: AuditListOptions): CursorPageDto<AuditEvent>;
  trace(correlationId: string): Promise<TraceDetailDto>;
  supportBundle(actor?: WebActivityActor): Promise<SupportBundleResult>;
  locks(): SessionLock[];
  lockWebSession(ownerName?: string, actor?: WebActivityActor): SessionLock;
  unlockWebSession(actor?: WebActivityActor): { removed: boolean; locks: SessionLock[] };
  controlOptions(agentId?: AgentId): Promise<DashboardControlOptions>;
  authStatus(agentId?: AgentId): Promise<WebAuthDto>;
  login(agentId?: AgentId, actor?: WebActivityActor): Promise<WebAuthDto & { result: LoginResult | null }>;
  logout(agentId?: AgentId, actor?: WebActivityActor): Promise<WebAuthDto & { result: LoginResult | null }>;
  chatHistory(limit?: number): Promise<WebChatMessage[]>;
  webMirrorPreference(argument?: string, actor?: WebActivityActor): Promise<{
    mode: string;
    minInterval: number;
    response: { plain: string; html: string };
  }>;
  sessionDetail(threadId: string, agentId?: AgentId): Promise<Record<string, unknown>>; setSessionName(threadId: string, name: string, agentId?: AgentId, actor?: WebActivityActor): Promise<Record<string, unknown>>;
  clearChatHistory(actor?: WebActivityActor): Promise<{ removed: number; messages: WebChatMessage[] }>;
  activity(options?: RelayRuntimeActivityOptions): WebActivityEvent[];
  activityPage(options?: RelayRuntimeActivityOptions & { cursor?: string }): CursorPageDto<WebActivityEvent>;
  retry(actor?: WebActivityActor): Promise<{ queued: boolean; queueId?: string; correlationId?: string }>;
  sync(actor?: WebActivityActor): Promise<ReturnType<AgentSessionService["syncFromAgentState"]>>;
  listSessions(limit?: number, query?: string, agentId?: AgentId): Promise<AgentThreadRecord[]>;
  listSessionsPage(page?: number, pageSize?: number, query?: string, agentId?: AgentId): Promise<SessionPageDto>;
  filteredSessions(session: AgentSessionService, query: string, limit: number): AgentThreadRecord[];
  listModels(): Promise<ReturnType<AgentSessionService["listModels"]>>;
  setAgent(agentId: AgentId, actor?: WebActivityActor): Promise<AgentSessionInfo>;
  newSession(options?: { agentId?: AgentId; workspace?: string; workspaceMode?: "shared" | "worktree" | "attached"; model?: string; reasoningEffort?: string; launchProfileId?: string; fastMode?: boolean }, actor?: WebActivityActor): Promise<AgentSessionInfo>;
  switchSession(threadId: string, actor?: WebActivityActor): Promise<AgentSessionInfo>;
  attachSession(threadId: string, actor?: WebActivityActor): Promise<AgentSessionInfo>;
  sessionWorktrees(): Promise<WorktreeDashboardSnapshot>; sessionWorktreeDiff(id: string): Promise<SessionWorktreeDiffSnapshot>;
  previewSessionWorktreeIntegration(ids: string[]): Promise<WorktreeIntegrationPreview>; updateSessionWorktreeFromBase(id: string, actor?: WebActivityActor): Promise<SessionWorktreeUpdateResult>; exportSessionWorktreeIntegrationPatch(ids: string[]): Promise<WorktreeIntegrationPatchExport>;
  cleanupSessionWorktrees(actor?: WebActivityActor): Promise<WorktreeCleanupResult>; commitSessionWorktree(id: string, message?: string, actor?: WebActivityActor): Promise<{ record: SessionWorktreeRecord; clean: boolean; status: string[] }>;
  integrateSessionWorktrees(ids: string[], options?: WorktreeIntegrationOptions, actor?: WebActivityActor): Promise<WorktreeIntegrationRun>;
  finalizeSessionWorktreeIntegration(id: string, options?: WorktreeFinalizeIntegrationOptions, actor?: WebActivityActor): Promise<WorktreeFinalizeIntegrationResult>;
  forkCurrentSessionToWorktree(options?: { includeUncommitted?: boolean }, actor?: WebActivityActor): Promise<{ session: AgentSessionInfo; record: SessionWorktreeRecord; copiedUntrackedFiles: string[]; skippedUntrackedFiles: string[]; patchApplied: boolean }>;
  removeSessionWorktree(id: string, force?: boolean, actor?: WebActivityActor): Promise<SessionWorktreeRecord>;
  setModel(model: string, actor?: WebActivityActor): Promise<AgentSessionInfo>;
  setReasoningEffort(effort: string, actor?: WebActivityActor): Promise<AgentSessionInfo>;
  setFastMode(enabled: boolean, actor?: WebActivityActor): Promise<AgentSessionInfo>;
  setLaunchProfile(profileId: string, actor?: WebActivityActor, options?: { applyToCurrent?: boolean }): Promise<AgentSessionInfo>;
  handback(actor?: WebActivityActor): Promise<ReturnType<AgentSessionService["handback"]>>;
  abort(actor?: WebActivityActor): Promise<void>;
  sendPrompt(text: string, actor?: WebActivityActor, correlationId?: string): Promise<{ queued: boolean; queueId?: string; correlationId?: string }>;
  sendUploadPrompt(options: UploadPromptOptions, actor?: WebActivityActor): Promise<UploadPromptResult>;
  sendEnvelope(envelope: PromptEnvelope, actor?: WebActivityActor): Promise<{ queued: boolean; queueId?: string; correlationId?: string }>;
  queue(): QueueItemDto[];
  queuePaused(): boolean;
  queueAction(action: RelayQueueAction, id?: string, actor?: WebActivityActor): QueueItemDto[];
  queuePlanner(): QueuePlannerSnapshotDto;
  createQueuePlan(input: QueuePlanInput, actor?: WebActivityActor): Promise<QueuePlanDto>;
  updateQueuePlan(id: string, input: Partial<QueuePlanInput>, actor?: WebActivityActor): QueuePlanDto;
  moveQueuePlan(id: string, status: QueuePlanStatus, actor?: WebActivityActor): Promise<QueuePlanDto>;
  approveQueuePlan(id: string, actor?: WebActivityActor): QueuePlanDto;
  enqueueQueuePlan(id: string, actor?: WebActivityActor): Promise<QueuePlanDto>;
  deleteQueuePlan(id: string, actor?: WebActivityActor): { removed: boolean; snapshot: QueuePlannerSnapshotDto };
  artifacts(limit?: number): Promise<ArtifactReportDto[]>;
  artifact(turnId: string): Promise<ArtifactTurnReport | null>;
  deleteArtifact(turnId: string, actor?: WebActivityActor): Promise<boolean>;
  createArtifactZip(turnId: string, actor?: WebActivityActor): Promise<{ path: string; name: string } | null>;
  artifactPreview(turnId: string, relativePath: string): Promise<ArtifactPreviewDto | null>;
  artifactDiff(turnId: string, relativePath: string): Promise<ArtifactDiffDto | null>;
  artifactUsage(): Promise<ArtifactUsageDto>;
  artifactCleanupPreview(): Promise<ArtifactCleanupDto>;
  artifactCleanupRun(actor?: WebActivityActor): Promise<ArtifactCleanupDto>;
  logs(target?: "connector" | "update" | "agent-updates", options?: number | FormattedLogReadOptions): Promise<FormattedLogTail>;
  clearLogs(target?: "connector" | "update" | "agent-updates", actor?: WebActivityActor): { ok: true; filePath: string; clearedAt: string };
  restartConnector(actor?: WebActivityActor): { ok: true; message: string };
  dispose(): void;

  getSession(deferThreadStart: boolean): Promise<AgentSessionService>;
  listKnownContextMetadata(): ContextMetadata[];
  discoverRunningConnectorSessions(): ActiveSessionDto[];
  discoverActiveCodexSessions(knownContexts: ContextMetadata[], preferences: BotPreferencesStore): ActiveSessionDto[];
  externalActiveSession(meta: ContextMetadata, knownContexts: ContextMetadata[], preferences: BotPreferencesStore): ActiveSessionDto | null;
  sessionStubForMetadata(meta: ContextMetadata, agentId: AgentId, capabilities: AgentCapabilities): AgentSessionService;
  capabilitiesForAgent(agentId: AgentId): AgentCapabilities;
  activeSessionKey(session: Pick<ActiveSessionDto, "agentId" | "threadId" | "id">): string;
  preferredActiveSession(existing: ActiveSessionDto | undefined, candidate: ActiveSessionDto): ActiveSessionDto;
  getControlSession(agentId?: AgentId): Promise<{ session: AgentSessionService; dispose: boolean }>;
  cliPathOptions(): { piCliPath?: string; hermesCliPath?: string; openClawCliPath?: string; claudeCodeCliPath?: string };
  ensureActiveThread(session: AgentSessionService): Promise<void>;
  ensureIdle(session: AgentSessionService): void;
  runPrompt(session: AgentSessionService, envelope: PromptEnvelope): Promise<void>;
  drainQueue(): Promise<void>;
  updateSession(session: AgentSessionService): void;
  recordActivity(input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }): WebActivityEvent;
  recordAgentUpdateLifecycle(job: AgentUpdateJobSnapshot): void;
  appendActivity(input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }): WebActivityEvent;
  enrichActivityInput<T extends Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }>(input: T): T;
  enrichActivityEvent(event: WebActivityEvent, info?: AgentSessionInfo): WebActivityEvent;
  enrichActivityFields<T extends Pick<WebActivityEvent, "threadId"> & Partial<Pick<WebActivityEvent, "workspace" | "agentId">>>(event: T, info?: AgentSessionInfo): T;
  appendAudit(input: Omit<AuditEvent, "id" | "timestamp" | "channelId">): AuditEvent;
  updateCurrentProgress(patch?: Partial<WebTaskDto>): void;
  addCurrentTool(toolName: string): void;
  broadcastQueue(): void;
  broadcastStatus(message: string, level?: "info" | "warn" | "error"): void;
  broadcast(event: RelayEvent): void;
  scheduleActiveSessionsBroadcast(): void;
  publicInfo(session: AgentSessionService, options?: AgentSessionInfoOptions): AgentSessionInfo;
}
