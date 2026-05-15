import type {
  AgentCapabilities,
  AgentDiagnostics,
  AgentId,
  AgentModelRecord,
  AgentReasoningEffort,
  AgentSessionInfo,
  AgentThreadRecord,
} from "./agent.js";
import type { AgentUpdateJobSnapshot } from "./agent-updates.js";
import type { ConnectorHealth, VersionChecks } from "./operations.js";
import type { SlackDiagnostics } from "./slack-diagnostics.js";
import type {
  WebActivityActor,
  WebActivityEvent,
  WebActivityCategory,
  WebActivitySource,
  WebActivityStatus,
  WebChatMessage,
} from "./web-state.js";

export type RelayEvent =
  | { type: "snapshot"; data: RelaySnapshot }
  | { type: "chat_history"; messages: WebChatMessage[] }
  | { type: "activity_update"; events: WebActivityEvent[] }
  | { type: "active_sessions_update"; active: ActiveSessionsDto }
  | { type: "turn_start"; id: string; prompt: string; at: string; source?: WebActivitySource }
  | { type: "text_delta"; id: string; delta: string }
  | { type: "tool_start"; id: string; toolCallId: string; toolName: string }
  | { type: "tool_update"; id: string; toolCallId: string; partialResult: string }
  | { type: "tool_end"; id: string; toolCallId: string; isError: boolean }
  | { type: "todo_update"; id: string; items: Array<{ text: string; completed: boolean }> }
  | { type: "turn_complete"; id: string; at: string }
  | { type: "turn_error"; id: string; error: string; at: string }
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

export type ActiveSessionSource = "web" | "telegram" | "discord" | "slack" | "cli";

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
  text?: string;
  truncated?: boolean;
  detail?: string;
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
  };
}

export interface WebTaskDto {
  id: string;
  source: WebActivitySource;
  status: WebActivityStatus;
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
  canCancel: boolean;
  canRetry: boolean;
  canReadLog: boolean;
}

export interface UnifiedJobsDto {
  jobs: UnifiedJobDto[];
  updatedAt: string;
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
  statusMessageId?: number;
  lastTypingAt?: number;
  workingNoticeTurnKey?: string;
  artifactsDeliveredForTurnId?: string;
  activityStartedTurnKey?: string;
  activityFinishedTurnKey?: string;
  activityToolStartLines?: number[];
  activityToolEndLines?: number[];
}
