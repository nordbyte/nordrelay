import type { Permission } from "../access/access-control.js";
import type { AgentId, AgentSessionInfo } from "../agents/shared/agent.js";
import type { AgentAdapterDescriptor } from "../agents/shared/agent-adapter.js";
import type { AdapterConformanceMatrix } from "../agents/shared/adapter-conformance.js";
import type { AgentUpdateJobSnapshot } from "../agents/shared/agent-updates.js";
import type { AuditEvent } from "../access/audit-log.js";
import type { ChannelDescriptor } from "../channels/shared/channel-adapter.js";
import type { ClearLogResult, ConnectorHealth, ConnectorRuntimeState, FormattedLogTail, SelfUpdateResult, VersionChecks } from "../support/operations.js";
import type { PeerDiscoveryJobSnapshot, PeerDiscoveryResult, PeerIdentityBackup, PeerSnapshot, PublicPeerRecord } from "../peers/peer-types.js";
import type { WebApiDynamicPathFromContract, WebApiStaticPathFromContract } from "./web-api-contract.js";
import type {
  ActiveSessionsDto,
  ArtifactPreviewDto,
  ArtifactReportDto,
  CursorPageDto,
  DashboardControlOptions,
  QueueItemDto,
  RelaySnapshot,
  SessionPageDto,
  TraceDetailDto,
  UnifiedJobsDto,
  UploadPromptResult,
  WebAdapterHealthDto,
  WebAuthDto,
  WebDiagnosticsDto,
  WebTasksDto,
} from "../runtime/relay-runtime.js";
import type { SessionLock } from "../access/session-locks.js";
import type { SettingsSnapshot, SettingsUpdateResult } from "../core/settings-service.js";
import type {
  DiscordChannelAccessRecord,
  DiscordIdentityRecord,
  GroupRecord,
  SlackChannelAccessRecord,
  SlackIdentityRecord,
  TelegramChatAccessRecord,
  TelegramIdentityRecord,
  UserRecord,
  WebSessionRecord,
} from "../access/user-management.js";
import type { WebActivityEvent, WebChatMessage } from "./web-state.js";

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
  csrfToken?: string;
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
    webSessions: PublicWebSession[];
  }>;
  groups: GroupRecord[];
  telegramChats: TelegramChatAccessRecord[];
  discordChannels: DiscordChannelAccessRecord[];
  slackChannels: SlackChannelAccessRecord[];
  adminConfigured: boolean;
  permissions: Permission[];
}

export interface WebSessionDetailResponse {
  record?: Record<string, unknown>;
  active?: AgentSessionInfo;
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
  P extends "/api/prompt/upload" ? { text?: string; correlationId?: string; files: Array<{ name: string; mimeType?: string; dataBase64: string }> } :
  P extends "/api/agent" ? { agentId: AgentId } :
  P extends "/api/agent-update" ? { agentId: AgentId; operation?: "update" | "install" } :
  P extends "/api/sessions/new" ? { agentId?: AgentId; workspace?: string; model?: string; reasoningEffort?: string; launchProfileId?: string; fastMode?: boolean } :
  P extends "/api/sessions/switch" | "/api/sessions/attach" ? { threadId: string } :
  P extends "/api/session/model" ? { model: string } :
  P extends "/api/session/reasoning" ? { reasoning: string } :
  P extends "/api/session/fast" ? { enabled: boolean } :
  P extends "/api/session/launch" ? { profileId: string } :
  P extends "/api/queue" ? { action: string; id?: string } :
  P extends "/api/artifacts/bulk" ? { action: "delete"; turnIds: string[] } :
  P extends "/api/peers/discovery-jobs" ? { targets?: string[]; timeoutMs?: number; concurrency?: number; maxHosts?: number } :
  P extends "/api/peers/identity/restore" ? { backup: PeerIdentityBackup } :
  P extends `/api/peers/${string}/rotate` ? { expiresMinutes?: number } :
  P extends "/api/logs/clear" ? { target?: "connector" | "update" | "agent-updates" } :
  P extends "/api/settings" ? { settings: Record<string, string | null | undefined> } :
  P extends "/api/users" ? { email: string; displayName?: string; password: string; groupIds?: string[]; active?: boolean; telegramUserId?: number; discordUserId?: string } :
  P extends `/api/users/${string}/password` ? { password: string } :
  P extends `/api/users/${string}/telegram` ? { createCode?: boolean; telegramUserId?: number; username?: string } :
  P extends `/api/users/${string}/discord` ? { createCode?: boolean; discordUserId?: string; username?: string; globalName?: string } :
  P extends `/api/users/${string}/slack` ? { createCode?: boolean; slackUserId?: string; teamId?: string; username?: string; realName?: string } :
  P extends `/api/users/${string}` ? { email?: string; displayName?: string; active?: boolean; groupIds?: string[] } :
  P extends "/api/groups" ? { name: string; description?: string; permissions?: string[]; agentIds?: string[]; workspaceRoots?: string[]; telegramChatIds?: number[]; discordChannelIds?: string[]; slackChannelIds?: string[] } :
  P extends `/api/groups/${string}` ? { name?: string; description?: string; permissions?: string[]; agentIds?: string[]; workspaceRoots?: string[]; telegramChatIds?: number[]; discordChannelIds?: string[]; slackChannelIds?: string[] } :
  P extends "/api/telegram-chats" ? { chatId: number; title?: string; type?: string; enabled?: boolean; allowedGroupIds?: string[] } :
  P extends `/api/telegram-chats/${string}` ? { title?: string; enabled?: boolean; allowedGroupIds?: string[] } :
  P extends "/api/discord-channels" ? { guildId?: string; channelId: string; title?: string; type?: string; enabled?: boolean; allowedGroupIds?: string[] } :
  P extends `/api/discord-channels/${string}` ? { title?: string; enabled?: boolean; allowedGroupIds?: string[] } :
  P extends "/api/slack-channels" ? { teamId?: string; channelId: string; title?: string; type?: string; enabled?: boolean; allowedGroupIds?: string[] } :
  P extends `/api/slack-channels/${string}` ? { title?: string; enabled?: boolean; allowedGroupIds?: string[] } :
  P extends "/api/locks" ? { ownerName?: string } :
  P extends "/api/auth/login" | "/api/auth/logout" ? { agentId?: AgentId } :
  P extends `/api/agent-update/${string}/input` ? { input: string } :
  Record<string, unknown>;

export type WebApiClientResponse<P extends WebApiPath> =
  P extends "/api/auth/me" ? WebCurrentUserDto :
  P extends "/api/dashboard/logout" ? { ok: boolean } :
  P extends "/api/bootstrap" ? WebBootstrapResponse :
  P extends "/api/health" ? WebStatusResponse :
  P extends "/api/snapshot" ? RelaySnapshot :
  P extends "/api/tasks" | "/api/progress" ? WebTasksDto :
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
  P extends `/api/peers/discovery-jobs/${string}/log` ? { id: string; plain: string } :
  P extends `/api/peers/discovery-jobs/${string}/cancel` | `/api/peers/discovery-jobs/${string}` ? { job: PeerDiscoveryJobSnapshot | null } :
  P extends `/api/peers/${string}/repin` ? { peer: PublicPeerRecord; probe: unknown } :
  P extends `/api/peers/${string}/rotate` ? { peer: PublicPeerRecord; invitation: unknown; code: string; command: string; readiness?: unknown; warnings?: string[] } :
  P extends "/api/peers/probe" ? unknown :
  P extends "/api/peers/global-sessions" ? unknown :
  P extends "/api/permissions" | "/api/users" ? WebUserManagementResponse :
  P extends "/api/groups" ? { groups: GroupRecord[] } :
  P extends "/api/telegram-chats" ? { chats: TelegramChatAccessRecord[] } :
  P extends "/api/discord-channels" ? { channels: DiscordChannelAccessRecord[] } :
  P extends "/api/slack-channels" ? { channels: SlackChannelAccessRecord[] } :
  P extends "/api/audit" ? { events: AuditEvent[]; pagination?: CursorPageDto<AuditEvent>["pagination"] } :
  P extends "/api/locks" ? { locks: SessionLock[]; lock?: SessionLock } :
  P extends "/api/auth/status" | "/api/auth/login" | "/api/auth/logout" ? WebAuthDto :
  P extends "/api/settings" ? SettingsSnapshot | SettingsUpdateResult :
  P extends "/api/control-options" ? DashboardControlOptions :
  P extends "/api/sessions" ? SessionPageDto :
  P extends "/api/sessions/new" | "/api/sessions/switch" | "/api/sessions/attach" | "/api/agent" | "/api/session/model" | "/api/session/reasoning" | "/api/session/fast" | "/api/session/launch" ? { session: AgentSessionInfo } :
  P extends "/api/sessions/detail" ? WebSessionDetailResponse :
  P extends "/api/models" ? { models: unknown[] } :
  P extends "/api/prompt" | "/api/prompt/upload" | "/api/retry" ? UploadPromptResult :
  P extends "/api/abort" | "/api/stop" | "/api/runtime/restart" ? { ok: boolean } :
  P extends "/api/handback" ? { command?: string } :
  P extends "/api/sync" ? { changed?: boolean; changedFields?: string[] } :
  P extends "/api/queue" ? { queue: QueueItemDto[]; paused: boolean } :
  P extends "/api/chat/history" ? { messages: WebChatMessage[]; removed?: number } :
  P extends "/api/chat/mirror" ? { mode: string; minInterval: number; response: { plain: string; html: string } } :
  P extends "/api/activity" ? { events: WebActivityEvent[]; pagination?: CursorPageDto<WebActivityEvent>["pagination"] } :
  P extends "/api/artifacts" ? { reports: ArtifactReportDto[]; pagination?: CursorPageDto<ArtifactReportDto>["pagination"]; removed?: boolean } :
  P extends "/api/artifacts/bulk" ? { removed: string[] } :
  P extends "/api/artifacts/preview" ? ArtifactPreviewDto :
  P extends "/api/logs" ? FormattedLogTail :
  P extends "/api/logs/clear" ? ClearLogResult :
  P extends "/api/diagnostics" ? WebDiagnosticsDto :
  P extends "/api/diagnostics/bundle" ? never :
  P extends `/api/users/${string}/sessions` ? { sessions?: PublicWebSession[]; revoked?: number } :
  P extends `/api/users/${string}/password` ? { ok: boolean } :
  P extends `/api/users/${string}/telegram` ? { linkCode?: unknown; identity?: TelegramIdentityRecord } :
  P extends `/api/users/${string}/telegram/${string}` ? { removed: boolean } :
  P extends `/api/users/${string}/discord` ? { linkCode?: unknown; identity?: DiscordIdentityRecord } :
  P extends `/api/users/${string}/discord/${string}` ? { removed: boolean } :
  P extends `/api/users/${string}/slack` ? { linkCode?: unknown; identity?: SlackIdentityRecord } :
  P extends `/api/users/${string}/slack/${string}` ? { removed: boolean } :
  P extends `/api/users/${string}` ? { user: PublicUser; groups: GroupRecord[] } :
  P extends `/api/groups/${string}` ? { group: GroupRecord } :
  P extends `/api/telegram-chats/${string}` ? { chat: TelegramChatAccessRecord } :
  P extends `/api/discord-channels/${string}` ? { channel: DiscordChannelAccessRecord } :
  P extends `/api/slack-channels/${string}` ? { channel: SlackChannelAccessRecord } :
  Record<string, unknown>;
