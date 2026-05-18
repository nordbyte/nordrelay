import { AgentUpdateManager } from "../../agents/shared/agent-updates.js";
import { AuditLogStore } from "../../access/audit-log.js";
import { SessionLockStore } from "../../access/session-locks.js";
import { UserStore } from "../../access/user-management.js";
import type { ConnectorConfig } from "../../core/config.js";
import { RemoteRelayClient } from "../../peers/peer-client.js";
import { RelayArtifactService } from "../../runtime/relay-artifact-service.js";
import { RelayAuthService } from "../../runtime/relay-auth-service.js";
import { BotPreferencesStore } from "../../state/bot-preferences.js";
import { PromptStore } from "../../state/prompt-store.js";
import { WebActivityStore } from "../../web/web-state.js";
import type { TurnProgress } from "./bot-rendering.js";
import { createChannelBusyStore, createChannelQueueStatusController } from "./channel-bridge-controller.js";
import type { ChannelBusyState, ChannelExternalMirrorState } from "./channel-bridge-state.js";
import { ChannelCommandService } from "./channel-command-service.js";
import type { ChannelContext } from "./channel-adapter.js";

export interface ChannelQueueStatusAdapter<Key extends string, MessageId extends string | number> {
  send(contextKey: Key, context: ChannelContext, text: string): Promise<MessageId>;
  edit(contextKey: Key, context: ChannelContext, messageId: MessageId, text: string): Promise<void>;
}

export interface ChannelBridgeEnvironmentOptions<
  Key extends string,
  BusyState extends ChannelBusyState,
  MessageId extends string | number,
> {
  busyDefaults?: () => BusyState;
  queueStatus?: ChannelQueueStatusAdapter<Key, MessageId>;
  agentUpdates?: ConstructorParameters<typeof AgentUpdateManager>[0];
}

export interface ChannelBridgeEnvironment<
  Key extends string,
  BusyState extends ChannelBusyState,
  MessageId extends string | number,
  ExternalMirrorState extends ChannelExternalMirrorState<MessageId>,
> {
  promptStore: PromptStore;
  preferencesStore: BotPreferencesStore;
  activityStore: WebActivityStore;
  auditLog: AuditLogStore;
  lockStore: SessionLockStore;
  userStore: UserStore;
  artifactService: RelayArtifactService;
  authService: RelayAuthService;
  agentUpdates: AgentUpdateManager;
  commandService: ChannelCommandService;
  busyStates: ReturnType<typeof createChannelBusyStore<Key, BusyState>>;
  turnProgress: Map<Key, TurnProgress>;
  draining: Set<Key>;
  externalMirrors: Map<Key, ExternalMirrorState>;
  queueStatusMessages?: ReturnType<typeof createChannelQueueStatusController<Key, MessageId>>;
  remoteClient: RemoteRelayClient;
}

export function createChannelBridgeEnvironment<
  Key extends string,
  BusyState extends ChannelBusyState = ChannelBusyState,
  MessageId extends string | number = string,
  ExternalMirrorState extends ChannelExternalMirrorState<MessageId> = ChannelExternalMirrorState<MessageId>,
>(
  config: ConnectorConfig,
  options: ChannelBridgeEnvironmentOptions<Key, BusyState, MessageId> = {},
): ChannelBridgeEnvironment<Key, BusyState, MessageId, ExternalMirrorState> {
  return {
    promptStore: new PromptStore(config.workspace, config.stateBackend),
    preferencesStore: new BotPreferencesStore(config.workspace, config.stateBackend),
    activityStore: new WebActivityStore(config.workspace, config.stateBackend, config.auditMaxEvents),
    auditLog: new AuditLogStore(config.workspace, config.stateBackend, config.auditMaxEvents),
    lockStore: new SessionLockStore(config.workspace, config.stateBackend),
    userStore: new UserStore(),
    artifactService: new RelayArtifactService(config),
    authService: new RelayAuthService(config),
    agentUpdates: new AgentUpdateManager(options.agentUpdates),
    commandService: new ChannelCommandService(config),
    busyStates: createChannelBusyStore<Key, BusyState>(options.busyDefaults),
    turnProgress: new Map<Key, TurnProgress>(),
    draining: new Set<Key>(),
    externalMirrors: new Map<Key, ExternalMirrorState>(),
    queueStatusMessages: options.queueStatus
      ? createChannelQueueStatusController<Key, MessageId>(options.queueStatus)
      : undefined,
    remoteClient: new RemoteRelayClient(),
  };
}
