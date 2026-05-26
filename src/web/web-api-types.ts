import type { Permission } from "../access/access-control.js";
import type { AgentId, AgentSessionInfo } from "../agents/shared/agent.js";
import type { AgentAdapterDescriptor } from "../agents/shared/agent-adapter.js";
import type { AdapterConformanceMatrix } from "../agents/shared/adapter-conformance.js";
import type { AgentUpdateJobSnapshot } from "../agents/shared/agent-updates.js";
import type { AuditEvent } from "../access/audit-log.js";
import type { ChannelDescriptor } from "../channels/shared/channel-adapter.js";
import type { ClearLogResult, ConnectorHealth, ConnectorRuntimeState, FormattedLogTail, SelfUpdateResult, VersionChecks } from "../support/operations.js";
import type { DoctorFixResponse, DoctorReport } from "../support/doctor.js";
import type { PeerDiscoveryJobSnapshot, PeerDiscoveryResult, PeerIdentityBackup, PeerRelayQueueSnapshot, PeerSnapshot, PeerSyncCandidatesResponse, PeerSyncResponse, PublicPeerRecord } from "../peers/peer-types.js";
import type { PeerOutboundRelaySnapshot } from "../peers/peer-outbound-relay.js";
import type { PeerDebugReport, PeerEffectiveAccessReport, PeerRepairAction, PeerRepairResult } from "../peers/peer-diagnostics.js";
import type { RuntimeMetricHistorySample, RuntimeMetricsDto } from "../runtime/metrics.js";
import type { ObservabilitySnapshot } from "../observability/observability-registry.js";
import type { WebChatAttachmentFileDto } from "../runtime/relay-runtime-types.js";
import type { WebApiDynamicPathFromContract, WebApiStaticPathFromContract } from "./web-api-contract.js";
import type {
  ActiveSessionsDto,
  ArtifactCleanupDto,
  ArtifactDiffDto,
  ArtifactPreviewDto,
  ArtifactReportDto,
  ArtifactUsageDto,
  CursorPageDto,
  DashboardControlOptions,
  QueueItemDto,
  QueuePlanDto,
  QueuePlannerSnapshotDto,
  RelaySnapshot,
  SessionPageDto,
  TraceDetailDto,
  UnifiedJobsDto,
  UploadPromptResult,
  WebAdapterHealthDto,
  WebAuthDto,
  WebDiagnosticsDto,
  WorkflowDryRunDto,
  WorkflowPreviewDto,
  WorkflowRunResultDto,
  WebTasksDto,
} from "../runtime/relay-runtime.js";
import type { PromptTemplate, Workflow, WorkflowExportBundle, WorkflowRun, WorkflowRunReport, WorkflowStep, WorkflowTrigger, WorkflowTriggerCreateResult, WorkflowVersionDiff, WorkflowVersionRecord } from "../state/workflow-store.js";
import type { QueuePlanStatus } from "../state/queue-plan-store.js";
import type { SessionLock } from "../access/session-locks.js";
import type { SettingsSnapshot, SettingsUpdateResult } from "../core/settings-service.js";
import type {
  SessionWorktreeDiffSnapshot,
  SessionWorkspaceMode,
  SessionWorktreeRecord,
  SessionWorktreeUpdateResult,
  WorktreeCleanupResult,
  WorktreeComparisonSnapshot,
  WorktreeConflictResolution,
  WorktreeFinalizeIntegrationOptions,
  WorktreeFinalizeIntegrationResult,
  WorktreeDashboardSnapshot,
  WorktreeIntegrationPatchExport,
  WorktreeIntegrationRun,
  WorktreeIntegrationPreview,
} from "../worktrees/worktree-types.js";
import type {
  DiscordChannelAccessRecord,
  DiscordIdentityRecord,
  GroupRecord,
  MatrixIdentityRecord,
  MatrixRoomAccessRecord,
  SlackChannelAccessRecord,
  SlackIdentityRecord,
  TelegramChatAccessRecord,
  TelegramIdentityRecord,
  UserRecord,
  WebSessionRecord,
  PublicApiTokenRecord,
  PublicWebAuthnCredentialRecord,
} from "../access/user-management.js";
import type { WebActivityEvent, WebChatMessage } from "./web-state.js";
import type { VoiceDiagnostics } from "../artifacts/voice.js";
import type { PluginCatalog } from "../plugins/plugin-service.js";
import type { PluginMarketplaceResponse } from "../plugins/plugin-marketplace.js";
import type { PluginInstallRequest, PluginInvokeResult, PluginScaffoldRequest, PluginUpdateCheckResult, PluginValidationResult, PublicPluginRecord } from "../plugins/plugin-types.js";

export type WebApiMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type WebApiQueryValue = string | number | boolean | null | undefined;
export type WebApiQuery = Record<string, WebApiQueryValue | WebApiQueryValue[]>;

export type WebApiStaticPath = WebApiStaticPathFromContract;
export type WebApiDynamicPath = WebApiDynamicPathFromContract;

export type WebApiPath = WebApiStaticPath | WebApiDynamicPath;

export type PublicUser = Omit<UserRecord, "passwordHash" | "passwordSalt">;
export type PublicWebSession = Omit<WebSessionRecord, "tokenHash">;

export interface WebCurrentUserDto {
  user: PublicUser;
  groups: GroupRecord[];
  permissions: Permission[];
  apiToken?: PublicApiTokenRecord;
  csrfToken?: string;
}

export interface WebProfileResponse {
  user: PublicUser;
  groups: GroupRecord[];
  permissions: Permission[];
  telegramIdentities: TelegramIdentityRecord[];
  discordIdentities: DiscordIdentityRecord[];
  slackIdentities: SlackIdentityRecord[];
  matrixIdentities: MatrixIdentityRecord[];
  webSessions: PublicWebSession[];
  mfa: {
    totpEnabled: boolean;
    recoveryCodesRemaining: number;
    webAuthnCredentials: PublicWebAuthnCredentialRecord[];
  };
  apiTokens: PublicApiTokenRecord[];
  currentSessionId?: string;
}

export interface WebBootstrapResponse {
  auth: WebCurrentUserDto;
  channels: ChannelDescriptor[];
  agentAdapters: AgentAdapterDescriptor[];
  adapterConformance: AdapterConformanceMatrix;
  enabledAgents: AgentId[];
  controls: DashboardControlOptions;
  status: WebBootstrapStatus;
}

export interface WebBootstrapStatus {
  health?: {
    version?: string;
    state?: ConnectorRuntimeState;
  };
  snapshot: RelaySnapshot;
}

export interface WebStatusResponse {
  health: ConnectorHealth;
  versionChecks: VersionChecks;
  snapshot: RelaySnapshot;
}

export interface WebVersionResponse {
  health: ConnectorHealth;
  state: ConnectorRuntimeState;
  versionChecks: VersionChecks;
}

export interface WebUserManagementResponse {
  users: Array<PublicUser & {
    groups: GroupRecord[];
    telegramIdentities: TelegramIdentityRecord[];
    discordIdentities: DiscordIdentityRecord[];
    slackIdentities: SlackIdentityRecord[];
    matrixIdentities: MatrixIdentityRecord[];
    webSessions: PublicWebSession[];
    mfa: WebProfileResponse["mfa"];
    apiTokens: PublicApiTokenRecord[];
  }>;
  groups: GroupRecord[];
  telegramChats: TelegramChatAccessRecord[];
  discordChannels: DiscordChannelAccessRecord[];
  slackChannels: SlackChannelAccessRecord[];
  matrixRooms: MatrixRoomAccessRecord[];
  adminConfigured: boolean;
  permissions: Permission[];
}

export interface WebSessionDetailResponse {
  record?: Record<string, unknown>;
  active?: AgentSessionInfo;
  sessionName?: string;
  messages?: WebChatMessage[];
  activity?: WebActivityEvent[];
  usageRows?: Array<[string, string] | string>;
}

export interface WebAgentUpdateLogResponse {
  job: AgentUpdateJobSnapshot;
  plain: string;
}

export interface WebApiClientOptions<P extends WebApiPath = WebApiPath> {
  method?: WebApiMethod;
  query?: WebApiQuery;
  headers?: Record<string, string>;
  body?: WebApiRequestBody<P> | string | null;
}

export type WebApiRequestBody<P extends WebApiPath> =
  P extends "/api/prompt" ? { text: string; correlationId?: string } :
  P extends "/api/prompt/upload" ? { text?: string; correlationId?: string; transcribeOnly?: boolean; files: Array<{ name: string; mimeType?: string; dataBase64: string }> } :
  P extends "/api/profile" ? { displayName?: string; theme?: "light" | "dark" | "system"; preferences?: { theme?: "light" | "dark" | "system" } } :
  P extends "/api/profile/password" ? { currentPassword: string; newPassword?: string; password?: string } :
  P extends "/api/profile/logout-other-sessions" ? Record<string, never> :
  P extends "/api/profile/mfa/totp/setup" ? Record<string, never> :
  P extends "/api/profile/mfa/totp/enable" ? { secret: string; code: string } :
  P extends "/api/profile/mfa/totp/disable" | "/api/profile/mfa/recovery-codes" ? Record<string, never> :
  P extends "/api/profile/webauthn/register/options" ? Record<string, never> :
  P extends "/api/profile/webauthn/register/verify" ? { challengeId: string; response: unknown; name?: string } :
  P extends `/api/profile/webauthn/${string}` ? Record<string, never> :
  P extends "/api/profile/api-tokens" ? { name: string; permissions: string[]; agentIds?: string[]; workspaceRoots?: string[]; peerIds?: string[]; expiresAt?: string } :
  P extends `/api/profile/api-tokens/${string}` | `/api/profile/sessions/${string}` ? Record<string, never> :
  P extends "/api/agent" ? { agentId: AgentId } :
  P extends "/api/agent-update" ? { agentId: AgentId; operation?: "update" | "install" } :
  P extends "/api/sessions/new" ? { agentId?: AgentId; workspace?: string; workspaceMode?: SessionWorkspaceMode; model?: string; reasoningEffort?: string; launchProfileId?: string; fastMode?: boolean } :
  P extends "/api/sessions/worktrees/fork" ? { includeUncommitted?: boolean } :
  P extends "/api/sessions/worktrees/compare" ? { ids: string[] } :
  P extends "/api/sessions/worktrees/integrate" ? { ids: string[]; resolutions?: WorktreeConflictResolution[] } :
  P extends "/api/sessions/worktrees/integrate/preview" ? { ids: string[] } :
  P extends "/api/sessions/worktrees/integrate/patch" ? { ids: string[] } :
  P extends "/api/sessions/worktrees/cleanup" ? Record<string, never> :
  P extends `/api/sessions/worktrees/integrations/${string}/finalize` ? WorktreeFinalizeIntegrationOptions :
  P extends `/api/sessions/worktrees/${string}/commit` ? { message?: string } :
  P extends `/api/sessions/worktrees/${string}/update` ? Record<string, never> :
  P extends `/api/sessions/worktrees/${string}` ? { force?: boolean } :
  P extends "/api/sessions/switch" | "/api/sessions/attach" ? { threadId: string } :
  P extends "/api/sessions/name" ? { threadId: string; agentId?: AgentId; name: string } :
  P extends "/api/session/model" ? { model: string } :
  P extends "/api/session/reasoning" ? { reasoning: string } :
  P extends "/api/session/fast" ? { enabled: boolean } :
  P extends "/api/session/launch" ? { profileId: string; apply?: boolean; confirmUnsafe?: boolean } :
  P extends "/api/queue" ? { action: string; id?: string } :
  P extends "/api/queue/plans" ? { title?: string; prompt: string; status?: QueuePlanStatus; labels?: string[]; priority?: number; agentId?: AgentId; workspace?: string; threadId?: string } :
  P extends `/api/queue/plans/${string}/move` ? { status: QueuePlanStatus } :
  P extends `/api/queue/plans/${string}` ? { title?: string; prompt?: string; status?: QueuePlanStatus; labels?: string[]; priority?: number; agentId?: AgentId; workspace?: string; threadId?: string } :
  P extends "/api/artifacts/bulk" ? { action: "delete"; turnIds: string[] } :
  P extends "/api/artifacts/cleanup/preview" | "/api/artifacts/cleanup/run" ? Record<string, never> :
  P extends "/api/peers/discovery-jobs" ? { targets?: string[]; timeoutMs?: number; concurrency?: number; maxHosts?: number } :
  P extends "/api/peers/relay" ? { action: "cancel"; peerId: string; id: string } | { action: "retry"; peerId?: string; id?: string } | { action: "drain-expired" } :
  P extends "/api/peers/sync" ? { sourcePeerId: string; candidateNodeIds: string[]; expiresMinutes?: number } :
  P extends "/api/peers/identity/restore" ? { backup: PeerIdentityBackup } :
  P extends `/api/peers/${string}/rotate` ? { expiresMinutes?: number } :
  P extends `/api/peers/${string}/sync-invite` ? { expiresMinutes?: number } :
  P extends `/api/peers/${string}/repair` ? { action: PeerRepairAction } :
  P extends "/api/logs/clear" ? { target?: "connector" | "update" | "agent-updates" } :
  P extends "/api/doctor/fix" ? { fixIds?: string[] } :
  P extends "/api/settings" ? { settings: Record<string, string | null | undefined> } :
  P extends "/api/plugins" ? PluginInstallRequest :
  P extends "/api/plugins/marketplace" ? Record<string, never> :
  P extends "/api/plugins/validate" ? { source: string } :
  P extends "/api/plugins/scaffold" ? PluginScaffoldRequest :
  P extends `/api/plugins/${string}/enable` | `/api/plugins/${string}/disable` | `/api/plugins/${string}/manifest` ? Record<string, never> :
  P extends `/api/plugins/${string}/update` | `/api/plugins/${string}/update-check` | `/api/plugins/${string}/diagnostics` ? Record<string, never> :
  P extends `/api/plugins/${string}/rollback` ? { version?: string } :
  P extends `/api/plugins/${string}/settings` ? { settings: Record<string, unknown> } :
  P extends `/api/plugins/${string}/invoke` ? { actionId: string; input?: Record<string, unknown> } :
  P extends `/api/plugins/${string}/command` ? { command: string; input?: Record<string, unknown> } :
  P extends `/api/plugins/${string}/panel` ? { panelId: string; input?: Record<string, unknown> } :
  P extends `/api/plugins/${string}/artifact-handler` ? { handlerId: string; input?: Record<string, unknown> } :
  P extends `/api/plugins/${string}/collector` ? { collectorId: string; input?: Record<string, unknown> } :
  P extends `/api/plugins/${string}` ? Record<string, never> :
  P extends "/api/templates" ? { name: string; prompt: string; description?: string; tags?: string[]; variables?: PromptTemplate["variables"]; scope?: "private" | "shared"; defaultAgentId?: AgentId; defaultWorkspace?: string; defaultModel?: string; defaultReasoning?: string; defaultLaunchProfile?: string } :
  P extends "/api/templates/import" ? { bundle: unknown } :
  P extends `/api/templates/${string}/versions/${string}/rollback` | `/api/workflows/${string}/versions/${string}/rollback` ? Record<string, never> :
  P extends `/api/templates/${string}/versions/${string}/run` | `/api/templates/${string}/versions/${string}/preview` ? { variables?: Record<string, string> } :
  P extends `/api/templates/${string}/run` | `/api/templates/${string}/preview` ? { variables?: Record<string, string> } :
  P extends `/api/templates/${string}` ? { name: string; prompt: string; description?: string; tags?: string[]; variables?: PromptTemplate["variables"]; scope?: "private" | "shared"; defaultAgentId?: AgentId; defaultWorkspace?: string; defaultModel?: string; defaultReasoning?: string; defaultLaunchProfile?: string } :
  P extends "/api/workflows" ? { name: string; description?: string; tags?: string[]; steps: WorkflowStep[]; schedule?: Workflow["schedule"]; scope?: "private" | "shared" } :
  P extends "/api/workflows/import" ? { bundle: unknown } :
  P extends `/api/workflows/${string}/versions/${string}/run` | `/api/workflows/${string}/versions/${string}/preview` ? { variables?: Record<string, string> } :
  P extends `/api/workflows/${string}/dry-run` ? { variables?: Record<string, string>; version?: number | string } :
  P extends `/api/workflows/${string}/triggers` ? { kind?: "api" | "webhook"; name?: string; enabled?: boolean } :
  P extends `/api/workflow-triggers/${string}/run` ? { variables?: Record<string, string> } :
  P extends `/api/workflows/${string}/run` | `/api/workflows/${string}/preview` ? { variables?: Record<string, string> } :
  P extends `/api/workflows/${string}` ? { name: string; description?: string; tags?: string[]; steps: WorkflowStep[]; schedule?: Workflow["schedule"]; scope?: "private" | "shared" } :
  P extends `/api/workflow-runs/${string}/rerun-failed` ? Record<string, never> :
  P extends "/api/users" ? { email: string; displayName?: string; password: string; groupIds?: string[]; active?: boolean; telegramUserId?: number; discordUserId?: string; slackUserId?: string; slackTeamId?: string; matrixUserId?: string; matrixHomeserver?: string; preferences?: { artifactDelivery?: string } } :
  P extends `/api/users/${string}/password` ? { password: string } :
  P extends `/api/users/${string}/telegram` ? { createCode?: boolean; telegramUserId?: number; username?: string } :
  P extends `/api/users/${string}/discord` ? { createCode?: boolean; discordUserId?: string; username?: string; globalName?: string } :
  P extends `/api/users/${string}/slack` ? { createCode?: boolean; slackUserId?: string; teamId?: string; username?: string; realName?: string } :
  P extends `/api/users/${string}/matrix` ? { createCode?: boolean; matrixUserId?: string; homeserver?: string; displayName?: string } :
  P extends `/api/users/${string}` ? { email?: string; displayName?: string; active?: boolean; groupIds?: string[]; preferences?: { artifactDelivery?: string } } :
  P extends "/api/groups" ? { name: string; description?: string; permissions?: string[]; agentIds?: string[]; workspaceRoots?: string[]; telegramChatIds?: number[]; discordChannelIds?: string[]; slackChannelIds?: string[]; matrixRoomIds?: string[]; peerIds?: string[] } :
  P extends `/api/groups/${string}` ? { name?: string; description?: string; permissions?: string[]; agentIds?: string[]; workspaceRoots?: string[]; telegramChatIds?: number[]; discordChannelIds?: string[]; slackChannelIds?: string[]; matrixRoomIds?: string[]; peerIds?: string[] } :
  P extends "/api/telegram-chats" ? { chatId: number; title?: string; type?: string; enabled?: boolean; allowedGroupIds?: string[]; artifactDelivery?: string } :
  P extends `/api/telegram-chats/${string}` ? { title?: string; enabled?: boolean; allowedGroupIds?: string[]; artifactDelivery?: string } :
  P extends "/api/discord-channels" ? { guildId?: string; channelId: string; title?: string; type?: string; enabled?: boolean; allowedGroupIds?: string[]; artifactDelivery?: string } :
  P extends `/api/discord-channels/${string}` ? { title?: string; enabled?: boolean; allowedGroupIds?: string[]; artifactDelivery?: string } :
  P extends "/api/slack-channels" ? { teamId?: string; channelId: string; title?: string; type?: string; enabled?: boolean; allowedGroupIds?: string[]; artifactDelivery?: string } :
  P extends `/api/slack-channels/${string}` ? { title?: string; enabled?: boolean; allowedGroupIds?: string[]; artifactDelivery?: string } :
  P extends "/api/matrix-rooms" ? { homeserver?: string; roomId: string; title?: string; canonicalAlias?: string; type?: string; enabled?: boolean; allowedGroupIds?: string[]; artifactDelivery?: string } :
  P extends `/api/matrix-rooms/${string}` ? { title?: string; enabled?: boolean; allowedGroupIds?: string[]; artifactDelivery?: string } :
  P extends "/api/locks" ? { ownerName?: string } :
  P extends "/api/auth/login" | "/api/auth/logout" ? { agentId?: AgentId } :
  P extends `/api/agent-update/${string}/input` ? { input: string } :
  Record<string, unknown>;

export type WebApiClientResponse<P extends WebApiPath> =
  P extends "/api/auth/me" ? WebCurrentUserDto :
  P extends "/api/dashboard/logout" ? { ok: boolean } :
  P extends "/api/profile" ? WebProfileResponse :
  P extends "/api/profile/password" ? { ok: boolean; profile?: WebProfileResponse } :
  P extends "/api/profile/logout-other-sessions" ? { revoked: number; profile?: WebProfileResponse } :
  P extends "/api/profile/mfa/totp/setup" ? { secret: string; otpauthUrl: string } :
  P extends "/api/profile/mfa/totp/enable" | "/api/profile/mfa/recovery-codes" ? { recoveryCodes: string[]; status: WebProfileResponse["mfa"] } :
  P extends "/api/profile/mfa/totp/disable" ? { status: WebProfileResponse["mfa"] } :
  P extends "/api/profile/webauthn/register/options" ? { challengeId: string; options: unknown } :
  P extends "/api/profile/webauthn/register/verify" ? { credential: unknown; status: WebProfileResponse["mfa"] } :
  P extends `/api/profile/webauthn/${string}` ? { removed: boolean; status: WebProfileResponse["mfa"] } :
  P extends "/api/profile/api-tokens" ? { tokens: PublicApiTokenRecord[] } | { token: string; record: PublicApiTokenRecord } :
  P extends `/api/profile/api-tokens/${string}` | `/api/profile/sessions/${string}` ? { removed: boolean } :
  P extends "/api/bootstrap" ? WebBootstrapResponse :
  P extends "/api/health" ? WebStatusResponse :
  P extends "/api/snapshot" ? RelaySnapshot :
  P extends "/api/tasks" | "/api/progress" ? WebTasksDto :
  P extends "/api/metrics" ? RuntimeMetricsDto :
  P extends "/api/metrics/history" ? { samples: RuntimeMetricHistorySample[] } :
  P extends "/api/metrics/observability" ? ObservabilitySnapshot :
  P extends "/api/jobs" ? UnifiedJobsDto :
  P extends "/api/trace" ? TraceDetailDto :
  P extends "/api/active-sessions" ? ActiveSessionsDto :
  P extends "/api/version" ? WebVersionResponse :
  P extends "/api/update" ? SelfUpdateResult :
  P extends "/api/agent-updates" ? { jobs: AgentUpdateJobSnapshot[] } :
  P extends "/api/agent-update" ? { job: AgentUpdateJobSnapshot } :
  P extends `/api/agent-update/${string}/log` ? WebAgentUpdateLogResponse :
  P extends `/api/agent-update/${string}/input` | `/api/agent-update/${string}/cancel` ? { job: AgentUpdateJobSnapshot } :
  P extends "/api/adapters/health" ? { adapters: WebAdapterHealthDto[] } :
  P extends "/api/adapters/conformance" ? AdapterConformanceMatrix :
  P extends "/api/peers" ? PeerSnapshot :
  P extends "/api/peers/identity/backup" ? { backup: PeerIdentityBackup } :
  P extends "/api/peers/identity/restore" ? { identity: PeerIdentityBackup["identity"] } :
  P extends "/api/peers/discover" ? PeerDiscoveryResult :
  P extends "/api/peers/discovery-jobs" ? { jobs: PeerDiscoveryJobSnapshot[] } | { job: PeerDiscoveryJobSnapshot } :
  P extends "/api/peers/relay" ? { enabled: boolean; allowedPeerIds: string[]; queue: PeerRelayQueueSnapshot; outbound: PeerOutboundRelaySnapshot; updatedAt: string; result?: unknown } :
  P extends `/api/peers/discovery-jobs/${string}/log` ? { id: string; plain: string } :
  P extends `/api/peers/discovery-jobs/${string}/cancel` | `/api/peers/discovery-jobs/${string}` ? { job: PeerDiscoveryJobSnapshot | null } :
  P extends `/api/peers/${string}/repin` ? { peer: PublicPeerRecord; probe: unknown } :
  P extends `/api/peers/${string}/rotate` ? { peer: PublicPeerRecord; invitation: unknown; code: string; command: string; readiness?: unknown; warnings?: string[] } :
  P extends `/api/peers/${string}/sync-candidates` ? PeerSyncCandidatesResponse :
  P extends `/api/peers/${string}/sync-invite` ? { peer: PublicPeerRecord; remotePeer?: PublicPeerRecord; invitation: unknown; code: string; command?: string; readiness?: unknown; warnings?: string[] } :
  P extends `/api/peers/${string}/debug` | `/api/peers/${string}/debug/probe` ? PeerDebugReport :
  P extends `/api/peers/${string}/effective-access` ? PeerEffectiveAccessReport :
  P extends `/api/peers/${string}/health-history` ? { peer: PublicPeerRecord; history: PublicPeerRecord["healthHistory"] } :
  P extends `/api/peers/${string}/repair` ? PeerRepairResult & { report: PeerDebugReport } :
  P extends "/api/peers/probe" ? unknown :
  P extends "/api/peers/sync" ? PeerSyncResponse :
  P extends "/api/peers/global-sessions" ? unknown :
  P extends "/api/permissions" | "/api/users" ? WebUserManagementResponse :
  P extends "/api/groups" ? { groups: GroupRecord[] } :
  P extends "/api/telegram-chats" ? { chats: TelegramChatAccessRecord[] } :
  P extends "/api/discord-channels" ? { channels: DiscordChannelAccessRecord[] } :
  P extends "/api/slack-channels" ? { channels: SlackChannelAccessRecord[] } :
  P extends "/api/matrix-rooms" ? { rooms: MatrixRoomAccessRecord[] } :
  P extends "/api/audit" ? { events: AuditEvent[]; pagination?: CursorPageDto<AuditEvent>["pagination"] } :
  P extends "/api/locks" ? { locks: SessionLock[]; lock?: SessionLock } :
  P extends "/api/auth/status" | "/api/auth/login" | "/api/auth/logout" ? WebAuthDto :
  P extends "/api/settings" ? SettingsSnapshot | SettingsUpdateResult :
  P extends "/api/plugins" ? { enabled: boolean; plugins: PublicPluginRecord[]; catalog: PluginCatalog } | PublicPluginRecord :
  P extends "/api/plugins/catalog" ? PluginCatalog :
  P extends "/api/plugins/marketplace" ? PluginMarketplaceResponse :
  P extends "/api/plugins/validate" ? PluginValidationResult :
  P extends "/api/plugins/scaffold" ? { path: string } :
  P extends `/api/plugins/${string}/enable` | `/api/plugins/${string}/disable` | `/api/plugins/${string}/settings` | `/api/plugins/${string}/manifest` ? PublicPluginRecord :
  P extends `/api/plugins/${string}/update` | `/api/plugins/${string}/rollback` ? PublicPluginRecord :
  P extends `/api/plugins/${string}/update-check` ? PluginUpdateCheckResult :
  P extends `/api/plugins/${string}/log` ? { id: string; log: string } :
  P extends `/api/plugins/${string}/invoke` ? PluginInvokeResult :
  P extends `/api/plugins/${string}/command` | `/api/plugins/${string}/panel` | `/api/plugins/${string}/artifact-handler` | `/api/plugins/${string}/diagnostics` | `/api/plugins/${string}/collector` ? PluginInvokeResult :
  P extends `/api/plugins/${string}` ? PublicPluginRecord | { ok: true } :
  P extends "/api/templates" ? { templates: PromptTemplate[] } | { template: PromptTemplate } :
  P extends "/api/templates/import" ? { template: PromptTemplate } :
  P extends `/api/templates/${string}/versions` ? { versions: WorkflowVersionRecord[] } :
  P extends `/api/templates/${string}/diff` ? WorkflowVersionDiff :
  P extends `/api/templates/${string}/export` | `/api/templates/${string}/versions/${string}/export` ? WorkflowExportBundle :
  P extends `/api/templates/${string}/versions/${string}/rollback` ? { template: PromptTemplate } :
  P extends `/api/templates/${string}/versions/${string}/run` ? WorkflowRunResultDto :
  P extends `/api/templates/${string}/versions/${string}/preview` ? WorkflowPreviewDto :
  P extends `/api/templates/${string}/run` ? WorkflowRunResultDto :
  P extends `/api/templates/${string}/preview` ? WorkflowPreviewDto :
  P extends `/api/templates/${string}` ? { template?: PromptTemplate; removed?: boolean } :
  P extends "/api/workflows" ? { workflows: Workflow[]; runs?: WorkflowRun[] } | { workflow: Workflow } :
  P extends "/api/workflows/import" ? { workflow: Workflow } :
  P extends `/api/workflows/${string}/versions` ? { versions: WorkflowVersionRecord[] } :
  P extends `/api/workflows/${string}/diff` ? WorkflowVersionDiff :
  P extends `/api/workflows/${string}/export` | `/api/workflows/${string}/versions/${string}/export` ? WorkflowExportBundle :
  P extends `/api/workflows/${string}/versions/${string}/rollback` ? { workflow: Workflow } :
  P extends `/api/workflows/${string}/versions/${string}/run` ? WorkflowRunResultDto :
  P extends `/api/workflows/${string}/versions/${string}/preview` ? WorkflowPreviewDto :
  P extends `/api/workflows/${string}/dry-run` ? WorkflowDryRunDto :
  P extends `/api/workflows/${string}/triggers` ? { triggers: WorkflowTrigger[] } | WorkflowTriggerCreateResult :
  P extends `/api/workflows/${string}/triggers/${string}` ? { workflow: Workflow; removed: boolean } :
  P extends `/api/workflows/${string}/run` ? WorkflowRunResultDto :
  P extends `/api/workflows/${string}/preview` ? WorkflowPreviewDto :
  P extends `/api/workflow-triggers/${string}/run` ? WorkflowRunResultDto :
  P extends `/api/workflows/${string}` ? { workflow?: Workflow; removed?: boolean } :
  P extends `/api/workflow-runs/${string}/report` ? WorkflowRunReport :
  P extends `/api/workflow-runs/${string}/cancel` | `/api/workflow-runs/${string}/rerun-failed` | `/api/workflow-runs/${string}` ? { run: WorkflowRun | null } :
  P extends "/api/control-options" ? DashboardControlOptions :
  P extends "/api/sessions" ? SessionPageDto :
  P extends "/api/sessions/new" | "/api/sessions/switch" | "/api/sessions/attach" | "/api/agent" | "/api/session/model" | "/api/session/reasoning" | "/api/session/fast" | "/api/session/launch" ? { session: AgentSessionInfo } :
  P extends "/api/sessions/worktrees" ? WorktreeDashboardSnapshot :
  P extends "/api/sessions/worktrees/fork" ? { session: AgentSessionInfo; record: SessionWorktreeRecord; copiedUntrackedFiles: string[]; skippedUntrackedFiles: string[]; patchApplied: boolean } :
  P extends "/api/sessions/worktrees/compare" ? WorktreeComparisonSnapshot :
  P extends "/api/sessions/worktrees/integrate" ? { run: WorktreeIntegrationRun } :
  P extends "/api/sessions/worktrees/integrate/preview" ? WorktreeIntegrationPreview :
  P extends "/api/sessions/worktrees/integrate/patch" ? WorktreeIntegrationPatchExport :
  P extends "/api/sessions/worktrees/cleanup" ? WorktreeCleanupResult :
  P extends `/api/sessions/worktrees/integrations/${string}/finalize` ? WorktreeFinalizeIntegrationResult :
  P extends `/api/sessions/worktrees/${string}/diff` ? SessionWorktreeDiffSnapshot :
  P extends `/api/sessions/worktrees/${string}/update` ? SessionWorktreeUpdateResult :
  P extends `/api/sessions/worktrees/${string}/commit` ? { record: SessionWorktreeRecord; clean: boolean; status: string[] } :
  P extends `/api/sessions/worktrees/${string}` ? { record: SessionWorktreeRecord } :
  P extends "/api/sessions/detail" | "/api/sessions/name" ? WebSessionDetailResponse :
  P extends "/api/models" ? { models: unknown[] } :
  P extends "/api/prompt" | "/api/prompt/upload" | "/api/retry" ? UploadPromptResult :
  P extends "/api/abort" | "/api/stop" | "/api/runtime/restart" ? { ok: boolean } :
  P extends `/api/approvals/${string}/respond` ? { ok: boolean; status: string; message: string } :
  P extends "/api/handback" ? { command?: string } :
  P extends "/api/sync" ? { changed?: boolean; changedFields?: string[] } :
  P extends "/api/queue" ? { queue: QueueItemDto[]; paused: boolean } :
  P extends "/api/queue/plans" ? QueuePlannerSnapshotDto | { plan: QueuePlanDto; snapshot: QueuePlannerSnapshotDto } :
  P extends `/api/queue/plans/${string}/approve` | `/api/queue/plans/${string}/enqueue` | `/api/queue/plans/${string}/move` ? { plan: QueuePlanDto; snapshot: QueuePlannerSnapshotDto } :
  P extends `/api/queue/plans/${string}` ? { plan?: QueuePlanDto; removed?: boolean; snapshot?: QueuePlannerSnapshotDto } :
  P extends "/api/chat/history" ? { messages: WebChatMessage[]; pagination?: CursorPageDto<WebChatMessage>["pagination"]; removed?: number } :
  P extends "/api/chat/attachment" ? WebChatAttachmentFileDto :
  P extends "/api/chat/mirror" ? { mode: string; minInterval: number; response: { plain: string; html: string } } :
  P extends "/api/activity" ? { events: WebActivityEvent[]; pagination?: CursorPageDto<WebActivityEvent>["pagination"] } :
  P extends "/api/artifacts" ? { reports: ArtifactReportDto[]; pagination?: CursorPageDto<ArtifactReportDto>["pagination"]; removed?: boolean } :
  P extends "/api/artifacts/usage" ? ArtifactUsageDto :
  P extends "/api/artifacts/cleanup/preview" | "/api/artifacts/cleanup/run" ? ArtifactCleanupDto :
  P extends "/api/artifacts/bulk" ? { removed: string[] } :
  P extends "/api/artifacts/preview" ? ArtifactPreviewDto :
  P extends "/api/artifacts/diff" ? ArtifactDiffDto :
  P extends "/api/logs" ? FormattedLogTail :
  P extends "/api/logs/clear" ? ClearLogResult :
  P extends "/api/diagnostics" ? WebDiagnosticsDto :
  P extends "/api/diagnostics/voice/refresh" ? VoiceDiagnostics :
  P extends "/api/diagnostics/bundle" ? never :
  P extends "/api/doctor" ? DoctorReport :
  P extends "/api/doctor/fix" ? DoctorFixResponse :
  P extends `/api/users/${string}/sessions` ? { sessions?: PublicWebSession[]; revoked?: number } :
  P extends `/api/users/${string}/password` ? { ok: boolean } :
  P extends `/api/users/${string}/telegram` ? { linkCode?: unknown; identity?: TelegramIdentityRecord } :
  P extends `/api/users/${string}/telegram/${string}` ? { removed: boolean } :
  P extends `/api/users/${string}/discord` ? { linkCode?: unknown; identity?: DiscordIdentityRecord } :
  P extends `/api/users/${string}/discord/${string}` ? { removed: boolean } :
  P extends `/api/users/${string}/slack` ? { linkCode?: unknown; identity?: SlackIdentityRecord } :
  P extends `/api/users/${string}/slack/${string}` ? { removed: boolean } :
  P extends `/api/users/${string}/matrix` ? { linkCode?: unknown; identity?: MatrixIdentityRecord } :
  P extends `/api/users/${string}/matrix/${string}` ? { removed: boolean } :
  P extends `/api/users/${string}` ? { user: PublicUser; groups: GroupRecord[] } :
  P extends `/api/groups/${string}` ? { group: GroupRecord } :
  P extends `/api/telegram-chats/${string}` ? { chat: TelegramChatAccessRecord } :
  P extends `/api/discord-channels/${string}` ? { channel: DiscordChannelAccessRecord } :
  P extends `/api/slack-channels/${string}` ? { channel: SlackChannelAccessRecord } :
  P extends `/api/matrix-rooms/${string}` ? { room: MatrixRoomAccessRecord } :
  Record<string, unknown>;
