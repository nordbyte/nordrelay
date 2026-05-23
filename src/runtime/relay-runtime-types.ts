import type {
  AgentCapabilities,
  AgentApprovalRequest,
  AgentDiagnostics,
  AgentId,
  AgentModelRecord,
  AgentReasoningEffort,
  AgentSessionInfo,
  AgentThreadRecord,
} from "../agents/shared/agent.js";
import type { AgentUpdateJobSnapshot } from "../agents/shared/agent-updates.js";
import type { ConnectorHealth, VersionChecks } from "../support/operations.js";
import type { VoiceDiagnostics } from "../artifacts/voice.js";
import type { AuditEvent } from "../access/audit-log.js";
import type { CursorPageMeta } from "../core/pagination.js";
import type { SlackDiagnostics } from "../channels/slack/slack-diagnostics.js";
import type { MatrixDiagnostics } from "../channels/matrix/matrix-diagnostics.js";
import type {
  WebActivityActor,
  WebActivityEvent,
  WebActivityCategory,
  WebActivitySource,
  WebActivityStatus,
  WebChatMessage,
} from "../web/web-state.js";
import type { PromptTemplate, Workflow, WorkflowRun } from "../state/workflow-store.js";
import type { QueuePlan, QueuePlanStatus } from "../state/queue-plan-store.js";

export type RelayEvent =
  | { type: "snapshot"; data: RelaySnapshot }
  | { type: "chat_history"; messages: WebChatMessage[] }
  | { type: "activity_update"; events: WebActivityEvent[] }
  | { type: "active_sessions_update"; active: ActiveSessionsDto }
  | { type: "turn_start"; id: string; prompt: string; text?: string; meta?: string[]; at: string; source?: WebActivitySource; correlationId?: string }
  | { type: "text_delta"; id: string; delta: string; correlationId?: string }
  | { type: "tool_start"; id: string; toolCallId: string; toolName: string; correlationId?: string }
  | { type: "tool_update"; id: string; toolCallId: string; partialResult: string; correlationId?: string }
  | { type: "tool_end"; id: string; toolCallId: string; isError: boolean; correlationId?: string }
  | { type: "todo_update"; id: string; items: Array<{ text: string; completed: boolean }>; correlationId?: string }
  | { type: "turn_complete"; id: string; at: string; correlationId?: string }
  | { type: "turn_error"; id: string; error: string; at: string; correlationId?: string }
  | { type: "queue_update"; queue: QueueItemDto[]; paused: boolean }
  | { type: "session_update"; session: AgentSessionInfo }
  | { type: "agent_update"; job: AgentUpdateJobSnapshot }
  | { type: "status"; message: string; level: "info" | "warn" | "error"; at: string };

export interface RelaySnapshot {
  session: AgentSessionInfo;
  sessionText: string;
  queue: QueueItemDto[];
  queuePaused: boolean;
  processing: boolean;
  enabledAgents: AgentId[];
  workspaces: string[];
}

export type ActiveSessionSource = "web" | "telegram" | "discord" | "slack" | "matrix" | "cli";

export interface ActiveSessionMirrorDto {
  source: Exclude<ActiveSessionSource, "cli">;
  contextKey: string;
  mode: "status" | "final" | "full";
  queueLength: number;
  queuePaused: boolean;
}

export interface ActiveSessionDto {
  id: string;
  contextKey: string;
  sourceContextKey?: string;
  source: ActiveSessionSource;
  status: "running" | "external";
  agentId?: AgentId;
  agentLabel?: string;
  threadId: string | null;
  sessionName?: string;
  workspace?: string;
  prompt?: string;
  currentTool?: string;
  lastTool?: string;
  startedAt: string;
  updatedAt: string;
  durationMs: number;
  queueLength: number;
  queuePaused: boolean;
  mirrorChannels?: ActiveSessionMirrorDto[];
  approvalRequired?: AgentApprovalRequest;
  detail?: string;
}

export interface ActiveSessionsDto {
  sessions: ActiveSessionDto[];
  updatedAt: string;
}

export interface QueueItemDto {
  id: string;
  description: string;
  createdAt: string;
  attempts: number;
  correlationId?: string;
  notBefore?: string;
  lastError?: string;
}

export interface QueuePlanDto extends QueuePlan {
  effectiveStatus: QueuePlanStatus;
  queuePosition?: number;
  traceEvents: number;
}

export interface QueuePlannerSnapshotDto {
  plans: QueuePlanDto[];
  columns: Record<QueuePlanStatus, QueuePlanDto[]>;
  queue: QueueItemDto[];
  paused: boolean;
  inProgress: WebTaskDto[];
  updatedAt: string;
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
    safeStatus?: "ok" | "warn" | "blocked";
    safeWarnings?: string[];
  }>;
  provenance?: {
    agentId?: AgentId;
    threadId?: string | null;
    workspace?: string;
    source?: string;
    contextKey?: string;
    correlationId?: string;
    prompt?: string;
    turnStartedAt?: string;
    actor?: WebActivityActor;
  };
}

export interface ArtifactUsageDto {
  workspace: string;
  managedBytes: number;
  referencedBytes: number;
  totalBytes: number;
  maxTotalBytes: number;
  usagePercent: number | null;
  warnPercent: number;
  status: "ok" | "warn" | "over";
  turnDirs: number;
  inboxDirs: number;
  indexedTurns: number;
  indexedFiles: number;
  skippedFiles: number;
  oldestUpdatedAt?: string;
  newestUpdatedAt?: string;
  largestTurn?: {
    turnId: string;
    sizeBytes: number;
    updatedAt: string;
  };
}

export interface ArtifactCleanupDto {
  workspace: string;
  dryRun: boolean;
  usageBefore: ArtifactUsageDto;
  usageAfter: ArtifactUsageDto;
  candidates: Array<{
    kind: "turn" | "inbox";
    id: string;
    path: string;
    sizeBytes: number;
    updatedAt: string;
    reasons: string[];
  }>;
  removedTurnDirs: number;
  removedInboxDirs: number;
  removedBytes: number;
}

export interface CursorPageDto<T> {
  items: T[];
  pagination: CursorPageMeta;
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

export interface UploadPromptOptions {
  text?: string;
  files: UploadPromptFile[];
  correlationId?: string;
  transcribeOnly?: boolean;
}

export interface UploadPromptResult {
  queued: boolean;
  queueId?: string;
  correlationId?: string;
  transcript?: string;
  transcribeOnly?: boolean;
  files: Array<{
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}

export interface DashboardControlOptions {
  models: AgentModelRecord[];
  reasoningLabel: string;
  reasoningOptions: AgentReasoningEffort[];
  launchProfiles: Array<{
    id: string;
    label: string;
    behavior: string;
    unsafe: boolean;
  }>;
  workspaces: string[];
  capabilities: AgentCapabilities;
}

export interface ArtifactPreviewDto {
  kind: "text" | "image" | "unsupported";
  name: string;
  sizeBytes: number;
  language?: string;
  lineCount?: number;
  text?: string;
  truncated?: boolean;
  detail?: string;
  safeStatus?: "ok" | "warn" | "blocked";
  safeWarnings?: string[];
}

export interface ArtifactDiffDto {
  kind: "diff" | "unavailable";
  name: string;
  relativePath: string;
  text?: string;
  truncated?: boolean;
  detail?: string;
  safeStatus?: "ok" | "warn" | "blocked";
  safeWarnings?: string[];
}

export interface WebDiagnosticsDto {
  health: ConnectorHealth;
  versionChecks: VersionChecks;
  snapshot: RelaySnapshot;
  runtime: {
    stateBackend: string;
    sourceWorkspace: string;
    queuePaused: boolean;
    externalMirror: ExternalMirrorState | null;
    agentDiagnostics: AgentDiagnostics;
    slackDiagnostics?: SlackDiagnostics;
    matrixDiagnostics?: MatrixDiagnostics;
    voiceDiagnostics: VoiceDiagnostics;
  };
}

export interface WebTaskDto {
  id: string;
  source: WebActivitySource;
  status: WebActivityStatus;
  correlationId?: string;
  prompt?: string;
  agentId?: AgentId;
  agentLabel?: string;
  threadId: string | null;
  workspace?: string;
  startedAt: string;
  updatedAt: string;
  durationMs: number;
  currentTool?: string;
  lastTool?: string;
  outputChars: number;
  tools: Array<{ name: string; count: number }>;
  detail?: string;
}

export interface WebTasksDto {
  current: WebTaskDto | null;
  external: WebTaskDto | null;
  queue: QueueItemDto[];
  queuePaused: boolean;
  recent: WebActivityEvent[];
}

export type UnifiedJobKind =
  | "web-turn"
  | "external-turn"
  | "queued-prompt"
  | "workflow-run"
  | "agent-update"
  | "connector-update"
  | "support-bundle";

export type UnifiedJobStatus = "queued" | "running" | "completed" | "failed" | "aborted" | "info";

export interface UnifiedJobDto {
  id: string;
  kind: UnifiedJobKind;
  title: string;
  status: UnifiedJobStatus;
  source: WebActivitySource;
  agentId?: AgentId;
  agentLabel?: string;
  threadId: string | null;
  workspace?: string;
  owner?: WebActivityActor;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs?: number;
  summary?: string;
  logPath?: string;
  logTail?: string;
  queueId?: string;
  updateJobId?: string;
  correlationId?: string;
  canCancel: boolean;
  canRetry: boolean;
  canReadLog: boolean;
}

export interface UnifiedJobsDto {
  jobs: UnifiedJobDto[];
  pagination?: CursorPageMeta;
  updatedAt: string;
}

export interface WorkflowPreviewDto {
  workflowId?: string;
  templateId?: string;
  name: string;
  prompts: Array<{
    stepId: string;
    name: string;
    prompt: string;
  }>;
}

export interface WorkflowDryRunDto extends WorkflowPreviewDto {
  valid: boolean;
  variables: Array<{
    name: string;
    label?: string;
    required: boolean;
    provided: boolean;
    defaultValue?: string;
  }>;
  missingVariables: string[];
  warnings: string[];
}

export interface WorkflowRunResultDto {
  run: WorkflowRun;
}

export interface WorkflowListDto {
  templates: PromptTemplate[];
  workflows: Workflow[];
  runs: WorkflowRun[];
}

export interface TraceTimelineItemDto {
  id: string;
  at: string;
  source: "activity" | "audit" | "chat" | "queue" | "job";
  status?: string;
  type: string;
  title: string;
  detail?: string;
  threadId?: string | null;
  workspace?: string;
  agentId?: AgentId;
}

export interface TraceDetailDto {
  correlationId: string;
  summary: {
    startedAt: string | null;
    updatedAt: string | null;
    status: string;
    sources: string[];
    threadId?: string | null;
    workspace?: string;
    agentId?: AgentId;
  };
  activity: WebActivityEvent[];
  audit: AuditEvent[];
  chat: WebChatMessage[];
  queue: QueueItemDto[];
  jobs: UnifiedJobDto[];
  timeline: TraceTimelineItemDto[];
}

export type { WebActivityActor, WebActivityCategory };

export interface WebAdapterHealthDto {
  id: AgentId;
  label: string;
  enabled: boolean;
  status: "enabled" | "disabled" | "planned";
  auth: {
    supported: boolean;
    authenticated: boolean | null;
    method?: string;
    detail?: string;
  };
  cli: {
    path: string | null;
    label: string;
    version: string;
  };
  version: {
    installed: string;
    latest: string | null;
    status: string;
    detail?: string;
  };
  capabilities: AgentCapabilities;
  notes?: string;
}

export interface WebAuthDto {
  agentId: AgentId;
  agentLabel: string;
  supported: boolean;
  authenticated: boolean | null;
  method?: string;
  detail: string;
  loginSupported: boolean;
  logoutSupported: boolean;
  hostLoginCommand?: string;
  hostLogoutCommand?: string;
}

export interface WebPermissionsDto {
  mode: "users";
  message: string;
}

export interface ExternalMirrorState {
  threadId: string;
  rolloutPath: string;
  lastLine: number;
  turnId: string | null;
  startedAt: string | Date | null;
  latestAgentLine?: number;
  latestStatus?: string;
  latestStatusAt?: number;
  latestMirroredEventLine?: number;
  approvalRequestIds?: string[];
  statusMessageId?: number;
  lastTypingAt?: number;
  workingNoticeTurnKey?: string;
  artifactsDeliveredForTurnId?: string;
  activityStartedTurnKey?: string;
  activityFinishedTurnKey?: string;
  activityToolStartLines?: number[];
  activityToolEndLines?: number[];
}
