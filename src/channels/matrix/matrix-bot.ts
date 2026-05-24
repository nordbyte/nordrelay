import { randomUUID } from "node:crypto";

import { ADMIN_GROUP_ID, type Permission } from "../../access/access-control.js";
import { agentLabel, agentReasoningLabel, agentReasoningOptions, type AgentId, type AgentPromptInput, type AgentSessionInfo, type AgentSessionService, type AgentThreadRecord } from "../../agents/shared/agent.js";
import { getAgentActivityLog, getExternalSnapshotForSession } from "../../agents/shared/agent-activity.js";
import { respondToExternalApproval } from "../../agents/shared/agent-approval.js";
import { hostAgentLoginCommand, hostAgentLogoutCommand } from "../../agents/shared/agent-auth-commands.js";
import { listAgentAdapterDescriptors } from "../../agents/shared/agent-adapter.js";
import type { AgentUpdateOperation } from "../../agents/shared/agent-updates.js";
import { enabledAgents } from "../../agents/shared/agent-factory.js";
import { ensureOutDir } from "../../artifacts/artifacts.js";
import { buildFileInstructions, outboxPath, stageFile, type StagedFile } from "../../artifacts/attachments.js";
import { capabilitiesOf, filterActivityEvents, filterSessions, orderPinnedSessions, parseActivityOptions, trimLine } from "../shared/bot-rendering.js";
import { parseAgentUpdateId, renderAgentUpdateJobAction, renderAgentUpdateJobsAction, renderAgentUpdateLogAction, renderAgentUpdatePickerAction, renderQueueListAction } from "../shared/channel-actions.js";
import type { ChannelContext } from "../shared/channel-adapter.js";
import {
  createChannelActivityRecorder,
  createChannelAuditRecorder,
  createChannelPermissionChecker,
} from "../shared/channel-bridge-controller.js";
import { createChannelBridgeEnvironment } from "../shared/channel-bridge-environment.js";
import { createSharedChannelCommandDispatcher } from "../shared/channel-command-core.js";
import { matrixHelpCommandList } from "../shared/channel-command-catalog.js";
import { runChannelLocalPrompt } from "../shared/channel-local-prompt-runner.js";
import { queueChannelPromptIfBusy } from "../shared/channel-prompt-queue.js";
import { createChannelPeerMirrorController } from "../shared/channel-peer-mirror.js";
import { runChannelPeerPrompt } from "../shared/channel-peer-prompt.js";
import {
  listTargetPeerSessions,
  parseRemoteSessionChoice,
  remoteSessionChoiceValue,
  renderTargetPeerMirrorPreference,
  renderTargetPeerSession,
  selectedTargetPeerId,
  switchTargetPeerSession,
} from "../shared/channel-peer-sessions.js";
import { inferChannelMimeType } from "../shared/channel-attachments.js";
import { deliverChannelAction } from "../shared/channel-runtime.js";
import { deliverChannelCliArtifacts } from "../shared/channel-cli-artifacts.js";
import { createChannelExternalMirrorController } from "../shared/channel-external-mirror-controller.js";
import { monitorChannelExternalContexts } from "../shared/channel-external-monitor.js";
import { createChannelExternalMonitorLoop } from "../shared/channel-external-monitor-loop.js";
import { configureChannelRuntime, createTextQueueStatusAdapter } from "../shared/channel-runtime-bootstrap.js";
import { getLastAgentMessageText, parseLastAgentMessageOptions } from "../shared/last-agent-message.js";
import { channelTemplatePrompt, channelWorkflowPrompts, parseChannelWorkflowArgument, renderChannelTemplateList, renderChannelWorkflowList } from "../shared/channel-workflow-commands.js";
import type { LoginResult } from "../../agents/codex/codex-auth.js";
import type { ConnectorConfig } from "../../core/config.js";
import { isMatrixContextKey, parseMatrixContextKey, type ChannelContextKey } from "../shared/context-key.js";
import { friendlyErrorText } from "../../core/error-messages.js";
import { spawnConnectorRestart, spawnSelfUpdate } from "../../support/operations.js";
import { toPromptEnvelope, webChatAttachmentsForStagedFiles, type PromptEnvelope } from "../../state/prompt-store.js";
import { resolveArtifactDeliveryPolicy, type ArtifactDeliveryMode } from "../../artifacts/artifact-delivery.js";
import { redactText } from "../../core/redaction.js";
import { renderSessionInfoPlain } from "../shared/session-format.js";
import { canWriteWithLock } from "../../access/session-locks.js";
import { SessionRegistry } from "../../state/session-registry.js";
import { createMatrixArtifactCommandHandler, sendRecentMatrixArtifacts } from "./matrix-artifacts.js";
import { MatrixBotChannelRuntime, splitMatrixMessage, trimMatrixMessage } from "./matrix-channel-runtime.js";
import { MatrixClient } from "./matrix-client.js";
import { MATRIX_SESSION_PAGE_SIZE, renderMatrixSessionPageAction, type MatrixSessionListRecord, type MatrixSessionPageSource, type MatrixSessionPageState } from "./matrix-sessions.js";
import { createMatrixSyncLoop } from "./matrix-sync-loop.js";
import type { MatrixAttachment, MatrixBridge, MatrixBusyReason, MatrixBusyState, MatrixExternalMirrorState, MatrixMessageEvent, MatrixPickState, MatrixRequest } from "./matrix-types.js";
import {
  canSendSystemMessagesToMatrixContext,
  isMatrixHomeserverAllowed,
  isMatrixRoomAllowedByEnv,
  matrixAttachmentsFromEvent,
  matrixEventText,
  matrixHomeserverFromUserId,
  matrixRequestFromMessage,
  stripMatrixMention,
} from "./matrix-request-context.js";
import { isUnauthenticatedMatrixCommandAllowed, parseMatrixMessageCommand, permissionForMatrixAction, requiredPermissionForMatrixCommand } from "./matrix-command-surface.js";
import { collectMatrixDiagnostics } from "./matrix-diagnostics.js";
import { getMatrixRateLimitMetrics } from "./matrix-rate-limit.js";
import { transcribeAudio, type TranscriptionBackend } from "../../artifacts/voice.js";
import type { AuthenticatedUser } from "../../access/user-management.js";
import type { WebActivityActor } from "../../web/web-state.js";
import { evaluateWorkspacePolicy, filterAllowedWorkspaces, renderWorkspacePolicyLine } from "../../core/workspace-policy.js";

export { isUnauthenticatedMatrixCommandAllowed, permissionForMatrixAction, requiredPermissionForMatrixCommand } from "./matrix-command-surface.js";
export { canSendSystemMessagesToMatrixContext } from "./matrix-request-context.js";

const EDIT_DEBOUNCE_MS = 1500;
const TYPING_INTERVAL_MS = 4500;
const MAX_CHOICES = 25;
const MAX_ATTACHMENT_DOWNLOAD = 25 * 1024 * 1024;

type BusyState = MatrixBusyState;
type BusyReason = MatrixBusyReason;
type PickState = MatrixPickState;

export function createMatrixBridge(config: ConnectorConfig, registry: SessionRegistry): MatrixBridge | null {
  if (!config.matrixEnabled) {
    return null;
  }
  if (!config.matrixAccessToken) {
    console.warn("Matrix adapter disabled: MATRIX_ENABLED=true requires MATRIX_ACCESS_TOKEN.");
    return null;
  }
  if (!config.matrixHomeserverUrl || !config.matrixUserId) {
    console.warn("Matrix adapter disabled: MATRIX_ENABLED=true requires MATRIX_HOMESERVER_URL and MATRIX_USER_ID.");
    return null;
  }

  configureChannelRuntime(config);

  const client = new MatrixClient({
    homeserverUrl: config.matrixHomeserverUrl,
    accessToken: config.matrixAccessToken,
    userId: config.matrixUserId,
    deviceId: config.matrixDeviceId,
    syncTimeoutMs: config.matrixSyncTimeoutMs,
    pollTimeoutMs: config.matrixPollTimeoutMs,
  });
  const runtime = new MatrixBotChannelRuntime(client);
  const env = createChannelBridgeEnvironment<ChannelContextKey, BusyState, string, MatrixExternalMirrorState>(config, {
    queueStatus: createTextQueueStatusAdapter(runtime),
  });
  const {
    promptStore,
    preferencesStore,
    activityStore,
    auditLog,
    lockStore,
    userStore,
    artifactService,
    authService,
    agentUpdates,
    commandService,
    busyStates,
    turnProgress,
    draining,
    externalMirrors,
    remoteClient,
  } = env;

  const artifactPolicyForRequest = (request: MatrixRequest) => resolveArtifactDeliveryPolicy({ config, channelId: "matrix", authUser: request.authUser, channelAccess: request.isDirectMessage ? null : userStore.snapshot().matrixRooms.find((room) => room.roomId === request.roomId && (!room.homeserver || !request.homeserver || room.homeserver === request.homeserver)) ?? null });
  const artifactPolicyForContext = (context: ChannelContext) => resolveArtifactDeliveryPolicy({ config, channelId: "matrix", channelAccess: userStore.snapshot().matrixRooms.find((room) => room.roomId === context.chatId) ?? null });
  const picks = new Map<string, PickState>();
  const sessionPages = new Map<string, MatrixSessionPageState>();
  const queueStatusMessages = env.queueStatusMessages!;

  const matrixContextForKey = (contextKey: ChannelContextKey): ChannelContext | null => {
    const parsed = parseMatrixContextKey(contextKey);
    return parsed ? { channelId: "matrix", chatId: parsed.roomId, ...(parsed.threadId ? { topicId: parsed.threadId } : {}) } : null;
  };

  const getBusyState = (contextKey: ChannelContextKey): BusyState => busyStates.get(contextKey);

  const actorFor = (request: MatrixRequest): WebActivityActor => ({
    channel: "matrix",
    id: request.authUser?.user.id ?? `matrix:${request.userId}`,
    label: request.authUser?.user.displayName || request.authUser?.user.email || request.username || request.userId,
    username: request.authUser?.user.email ?? request.username,
    channelUserId: request.userId,
  });

  const appendActivity = createChannelActivityRecorder<MatrixRequest>({
    source: "matrix",
    workspace: config.workspace,
    activityStore,
    actorFor,
  });

  const audit = createChannelAuditRecorder<MatrixRequest>({
    channelId: "matrix",
    auditLog,
    actorFor,
    actorIdFor: (request) => request.userId,
  });

  const peerMirrorController = createChannelPeerMirrorController({
    label: "Matrix",
    runtime,
    preferencesStore,
    remoteClient,
    contextForKey: matrixContextForKey,
    defaultMirrorMode: () => config.matrixMirrorMode,
    mirrorMinUpdateMs: EDIT_DEBOUNCE_MS,
  });

  const hasPermission = createChannelPermissionChecker<MatrixRequest>(userStore);

  const reply = async (
    request: MatrixRequest,
    content: string,
    options: { buttons?: Array<Array<{ label: string; action: string }>>; ephemeral?: boolean } = {},
  ): Promise<void> => {
    if (options.ephemeral && request.respond) {
      await request.respond({
        text: trimMatrixMessage(content),
        response_type: "ephemeral",
        replace_original: false,
      }).catch(() => runtime.sendMessage(request.context, { text: trimMatrixMessage(content), fallbackText: trimMatrixMessage(content), buttons: options.buttons }));
      return;
    }
    for (const [index, chunk] of splitMatrixMessage(content).entries()) {
      await runtime.sendMessage(request.context, {
        text: chunk,
        fallbackText: chunk,
        buttons: index === splitMatrixMessage(content).length - 1 ? options.buttons : undefined,
      });
    }
  };

  const authenticate = async (request: MatrixRequest, permission: Permission | null, commandName?: string): Promise<boolean> => {
    if (commandName && isUnauthenticatedMatrixCommandAllowed(commandName)) {
      return true;
    }
    if (!userStore.hasAdminUser()) {
      await reply(request, "NordRelay has no admin user yet. Run `nordrelay user create-admin` on the host.", { ephemeral: true });
      return false;
    }
    const authUser = userStore.resolveMatrixUser({ matrixUserId: request.userId, homeserver: request.userHomeserver ?? matrixHomeserverFromUserId(request.userId) });
    if (!authUser) {
      audit(request, {
        action: "permission_denied",
        status: "denied",
        description: "Matrix account is not linked",
      });
      if (request.isDirectMessage || request.respond) {
        await reply(request, "Unauthorized. Link this Matrix account to a NordRelay user first.", { ephemeral: true });
      }
      return false;
    }
    request.authUser = authUser;

    if (!isMatrixHomeserverAllowed(config, request.homeserver) || !isMatrixRoomAllowedByEnv(config, request.roomId)) {
      audit(request, {
        action: "permission_denied",
        status: "denied",
        description: "Matrix homeserver or room is outside configured allow-list",
      });
      await reply(request, "This Matrix homeserver or room is not allowed for NordRelay.", { ephemeral: true });
      return false;
    }

    const channelAllowed = userStore.isMatrixRoomAllowed({
      homeserver: request.homeserver,
      roomId: request.roomId,
      isDirectMessage: request.isDirectMessage,
    }, authUser);
    if (!channelAllowed && commandName !== "register_channel") {
      audit(request, {
        action: "permission_denied",
        status: "denied",
        description: "Matrix room is not enabled or outside user scope",
      });
      if (request.isDirectMessage || request.respond) {
        await reply(request, "This Matrix room is not enabled for NordRelay. An admin can use `/register_channel` in the room.", { ephemeral: true });
      }
      return false;
    }

    if (!permission) {
      audit(request, {
        action: "permission_denied",
        status: "denied",
        description: commandName ? `Unsupported command /${commandName}` : "Unsupported action",
      });
      await reply(request, "Unsupported command or action.", { ephemeral: true });
      return false;
    }
    if (!hasPermission(request, permission)) {
      audit(request, {
        action: "permission_denied",
        status: "denied",
        description: `${permission} required`,
      });
      await reply(request, `Access denied: ${permission} permission required.`, { ephemeral: true });
      return false;
    }
    return true;
  };

  const getSession = async (request: MatrixRequest, options?: { deferThreadStart?: boolean }): Promise<AgentSessionService> => registry.getOrCreate(request.contextKey, options);
  const updateSession = (request: MatrixRequest, session: AgentSessionService): void => { registry.updateMetadata(request.contextKey, session); };

  const artifactDeps = {
    config,
    runtime,
    artifactService,
    getSession,
    reply,
    appendActivity,
    getArtifactDeliveryMode: (request: MatrixRequest) => request.authUser?.user.preferences?.artifactDelivery,
    setArtifactDeliveryMode: async (request: MatrixRequest, mode: ArtifactDeliveryMode | null) => { if (!request.authUser) throw new Error("Authenticated Matrix user required."); const updated = userStore.updateUser(request.authUser.user.id, { preferences: { artifactDelivery: mode } }); request.authUser = updated; return updated.user.preferences?.artifactDelivery ?? config.matrixArtifactDeliveryMode; },
  };
  const commandArtifacts = createMatrixArtifactCommandHandler<MatrixRequest>(artifactDeps);

  const getBusyReason = (contextKey: ChannelContextKey): BusyReason => {
    const state = busyStates.peek(contextKey);
    const session = registry.get(contextKey);
    if (state?.processing || state?.switching || session?.isProcessing()) {
      return { busy: true, kind: "connector", state: state ?? getBusyState(contextKey) };
    }
    const snapshot = session ? getExternalSnapshotForSession(session, config, { maxEvents: 0 }) : null;
    if (snapshot?.activity.active) {
      return { busy: true, kind: "external", agentLabel: snapshot.agentLabel };
    }
    return { busy: false, kind: "idle" };
  };

  const updateQueueStatusMessage = async (contextKey: ChannelContextKey, context: ChannelContext, text: string): Promise<void> => {
    await queueStatusMessages.update(contextKey, context, text);
  };

  const ensureActiveThread = async (request: MatrixRequest, session: AgentSessionService): Promise<void> => {
    if (!session.hasActiveThread()) {
      await registry.startNewThread(request.contextKey, session);
      updateSession(request, session);
    }
  };

  const checkAgentAuthStatus = (info: AgentSessionInfo) => authService.check(info);

  const checkLoginAuthStatus = (info: AgentSessionInfo) => authService.check(info);

  const startAgentLogin = (info: AgentSessionInfo): Promise<LoginResult> => authService.startLogin(info);

  const startAgentLogout = (info: AgentSessionInfo): Promise<LoginResult> => authService.startLogout(info);

  const hostLoginCommand = (info: AgentSessionInfo): string => hostAgentLoginCommand(config, info);
  const hostLogoutCommand = (info: AgentSessionInfo): string => hostAgentLogoutCommand(config, info);

  const denyIfLocked = async (request: MatrixRequest): Promise<boolean> => {
    const lock = lockStore.get(request.contextKey);
    const isAdmin = request.authUser?.groups.some((group) => group.id === ADMIN_GROUP_ID) ?? false;
    if (canWriteWithLock(lock, request.authUser?.user.id, isAdmin)) {
      return false;
    }
    await reply(request, `Session is locked by ${lock?.ownerLabel || lock?.ownerUserId || "another user"}.`);
    return true;
  };

  const handleRemotePrompt = async (request: MatrixRequest, envelope: PromptEnvelope): Promise<boolean> => {
    const targetPeerId = preferencesStore.get(request.contextKey).targetPeerId ?? undefined;
    return runChannelPeerPrompt<string>({
      targetPeerId,
      contextKey: request.contextKey,
      prompt: envelope,
      remoteClient,
      canUsePeer: (peerId) => userStore.canUsePeer(request.authUser, peerId),
      editMinIntervalMs: EDIT_DEBOUNCE_MS,
      typingIntervalMs: TYPING_INTERVAL_MS,
      sendTyping: () => runtime.sendTyping(request.context),
      sendResponse: async (text) => {
        const rendered = trimMatrixMessage(text);
        const sent = await runtime.sendMessage(request.context, { text: rendered, fallbackText: rendered });
        return sent.messageId;
      },
      editResponse: async (messageId, text) => {
        const rendered = trimMatrixMessage(text);
        await runtime.editMessage(request.context, messageId, { text: rendered, fallbackText: rendered });
      },
      sendTurnStart: (remotePrompt) => reply(request, `Remote peer working on:\n${remotePrompt}`),
      sendToolStart: (toolName) => reply(request, `Remote tool: ${toolName}`),
      sendQueued: async (queueId) => {
        await reply(request, `Remote prompt queued${queueId ? `: ${queueId}` : ""}.`, queueId ? {
          buttons: [[{ label: "Cancel queued message", action: `matrix_peer_queue_cancel:${targetPeerId}:${queueId}` }]],
        } : undefined);
      },
      sendCompleted: () => reply(request, "Remote turn completed."),
      sendFailure: (message) => reply(request, `Remote peer failed: ${message}`),
    });
  };

  const handlePrompt = async (request: MatrixRequest, input: AgentPromptInput, artifactOutDir?: string, options: { fromQueue?: boolean; attachments?: ReturnType<typeof webChatAttachmentsForStagedFiles> } = {}): Promise<void> => {
    const session = await getSession(request);
    const envelope = toPromptEnvelope(input, artifactOutDir);
    envelope.activityActor = actorFor(request);
    if (options.attachments) envelope.attachments = options.attachments;

    if (!options.fromQueue && await handleRemotePrompt(request, envelope)) {
      return;
    }
    if (!options.fromQueue && await denyIfLocked(request)) {
      return;
    }

    if (await queueChannelPromptIfBusy({
      request,
      envelope,
      fromQueue: options.fromQueue,
      promptStore,
      busy: getBusyReason(request.contextKey),
      actionPrefix: "matrix",
      reply,
      appendActivity,
      audit,
    })) {
      return;
    }

    await runChannelLocalPrompt({
      source: "matrix",
      label: "Matrix",
      config,
      runtime,
      request,
      session,
      envelope,
      busyState: getBusyState(request.contextKey),
      promptStore,
      turnProgress,
      artifactService,
      abortActionPrefix: "matrix",
      editDebounceMs: EDIT_DEBOUNCE_MS,
      typingIntervalMs: TYPING_INTERVAL_MS,
      trimMessage: trimMatrixMessage,
      splitMessage: splitMatrixMessage,
      actor: actorFor(request),
      appendActivity,
      audit,
      checkAgentAuthStatus,
      ensureActiveThread,
      updateSession,
      sendRecentArtifacts: async (startedAt, turnId) => {
        const artifactPolicy = artifactPolicyForRequest(request);
        if (artifactPolicy.sendSummary || artifactPolicy.autoSendFiles || artifactPolicy.autoSendZip) {
          await sendRecentMatrixArtifacts(artifactDeps, request, session, startedAt, turnId, artifactPolicy);
        }
      },
      drainQueue: () => drainQueue(request),
    });
  };

  const drainQueue = async (request: MatrixRequest): Promise<void> => {
    if (draining.has(request.contextKey)) return;
    draining.add(request.contextKey);
    try {
      while (true) {
        const session = await getSession(request, { deferThreadStart: true });
        if (session.isProcessing() || getBusyReason(request.contextKey).busy || promptStore.isPaused(request.contextKey)) return;
        const next = promptStore.dequeue(request.contextKey);
        if (!next) return;
        await reply(request, `Processing queued prompt ${next.id}: ${next.description}`);
        await handlePrompt(request, next.input, next.artifactOutDir, { fromQueue: true, attachments: next.attachments });
      }
    } finally {
      draining.delete(request.contextKey);
    }
  };

  const deliverCliGeneratedArtifacts = async (
    contextKey: ChannelContextKey,
    context: ChannelContext,
    session: AgentSessionService,
    startedAt: Date | null | undefined,
    turnId: string | null,
  ): Promise<void> => {
    await deliverChannelCliArtifacts({
      config,
      contextKey,
      session,
      startedAt,
      turnId,
      state: externalMirrors.get(contextKey),
      autoSend: config.matrixAutoSendArtifacts,
      deliveryPolicy: artifactPolicyForContext(context),
      sendSummaryWhenAutoSendDisabled: false,
      logPrefix: "Matrix",
      sendSummary: (summary) => runtime.sendMessage(context, { text: summary, fallbackText: summary }).then(() => {}),
      sendArtifact: (artifact) => runtime.sendFile(context, { localPath: artifact.localPath, name: artifact.name }).then(() => {}).catch((error) => {
        console.error(`Failed to send Matrix CLI artifact ${artifact.name}:`, error);
      }),
      appendActivity: (input) => {
        activityStore.append(input);
      },
    });
  };

  const externalMirrorController = createChannelExternalMirrorController<string>({
    config,
    states: externalMirrors,
    typingIntervalMs: TYPING_INTERVAL_MS,
    minUpdateMs: () => config.matrixMirrorMinUpdateMs,
    mirrorMode: (contextKey) => preferencesStore.get(contextKey).mirrorMode ?? config.matrixMirrorMode,
    queueLength: (contextKey) => promptStore.list(contextKey).length,
    activityActor: (snapshot) => ({ channel: "cli", label: `${snapshot.agentLabel} CLI` }),
    appendActivity: (input) => {
      activityStore.append(input);
    },
    sendTyping: (_contextKey, context) => runtime.sendTyping(context).catch(() => {}),
    sendWorkingNotice: async (_contextKey, context, state, snapshot, prompt) => {
      const turnKey = snapshot.activity.turnId ?? snapshot.activity.startedAt?.toISOString() ?? "unknown";
      if (state.workingNoticeTurnKey === turnKey) {
        return;
      }
      const text = prompt ? `*Working on* ${prompt}` : `*Working on* external ${snapshot.agentLabel} task...`;
      await runtime.sendMessage(context, {
        text,
        fallbackText: prompt ? `Working on ${prompt}` : `Working on external ${snapshot.agentLabel} task...`,
      });
      state.workingNoticeTurnKey = turnKey;
    },
    sendStatus: async (_contextKey, context, _state, rendered) => {
      const sent = await runtime.sendMessage(context, { text: rendered.plain, fallbackText: rendered.plain });
      return sent.messageId;
    },
    editStatus: (_contextKey, context, _state, messageId, rendered) =>
      runtime.editMessage(context, messageId, { text: rendered.plain, fallbackText: rendered.plain }),
    sendEvent: (_contextKey, context, _state, rendered) =>
      runtime.sendMessage(context, { text: rendered.plain, fallbackText: rendered.plain }).then(() => {}),
    sendApprovalRequest: async (_contextKey, context, _state, _snapshot, approval, rendered) => {
      const buttons = [
        [
          { label: "Proceed", action: `matrix_external_approval:yes:${approval.id}` },
          ...(approval.prefixRule.length > 0 ? [{ label: "Proceed and remember", action: `matrix_external_approval:persist:${approval.id}` }] : []),
        ],
        [{ label: "Deny", action: `matrix_external_approval:no:${approval.id}` }],
      ];
      await runtime.sendMessage(context, {
        text: rendered.plain,
        fallbackText: rendered.plain,
        buttons,
      });
    },
    sendDone: (_contextKey, context, state, text) => {
      if (state.statusMessageId) {
        return runtime.editMessage(context, state.statusMessageId, { text, fallbackText: text });
      }
      return runtime.sendMessage(context, { text, fallbackText: text }).then(() => {});
    },
    sendFinalAnswer: async (_contextKey, context, _state, snapshot, text) => {
      await runtime.sendMessage(context, {
        text: `*${snapshot.agentLabel} CLI final answer:*`,
        fallbackText: `${snapshot.agentLabel} CLI final answer:`,
      });
      for (const chunk of splitMatrixMessage(text)) {
        await runtime.sendMessage(context, { text: chunk, fallbackText: chunk });
      }
    },
    deliverArtifacts: (contextKey, context, session, state, turnId) =>
      deliverCliGeneratedArtifacts(contextKey, context, session, state.startedAt, turnId),
    fullEventFilter: () => true,
    fullEventLimit: 6,
    requirePreviousForTerminal: false,
  });

  const mirrorExternalSnapshot = externalMirrorController.mirror;

  const commandDispatcher = createSharedChannelCommandDispatcher<MatrixRequest>({
    transport: "matrix",
    bindings: [
      { names: ["start", "help"], handler: (request) => commandHelp(request) },
      { names: ["channels"], handler: (request) => deliverChannelAction(runtime, request.context, commandService.renderChannels()).then(() => {}) },
      { names: ["peers"], handler: (request) => deliverChannelAction(runtime, request.context, commandService.renderPeers((peerId) => userStore.canUsePeer(request.authUser, peerId))).then(() => {}) },
      { names: ["nodes"], handler: (request) => deliverChannelAction(runtime, request.context, commandService.renderNodeTargets({ source: "matrix", contextKey: request.contextKey, argument: "", preferencesStore, canUsePeer: (peerId) => userStore.canUsePeer(request.authUser, peerId) })).then(() => {}) },
      { names: ["target"], handler: async (request, argument) => {
        await deliverChannelAction(runtime, request.context, commandService.renderTargetPreference({ source: "matrix", contextKey: request.contextKey, argument, preferencesStore, canUsePeer: (peerId) => userStore.canUsePeer(request.authUser, peerId) }));
        peerMirrorController.sync(request.contextKey, request.context);
      } },
      { names: ["agents"], handler: (request) => deliverChannelAction(runtime, request.context, commandService.renderAgents()).then(() => {}) },
      { names: ["agent"], handler: (request, argument) => commandAgent(request, argument) },
      { names: ["auth"], handler: (request) => commandAuth(request) },
      { names: ["login"], handler: (request) => commandLogin(request) },
      { names: ["logout"], handler: (request) => commandLogout(request) },
      { names: ["session"], handler: (request) => commandSession(request) },
      { names: ["sessions"], handler: (request, argument) => commandSessions(request, argument) },
      { names: ["new"], handler: (request, argument) => commandNew(request, argument) },
      { names: ["switch", "attach"], handler: (request, argument) => commandSwitch(request, argument) },
      { names: ["model"], handler: (request, argument) => commandModel(request, argument) },
      { names: ["reasoning", "effort"], handler: (request, argument) => commandReasoning(request, argument) },
      { names: ["fast"], handler: (request, argument) => commandFast(request, argument) },
      { names: ["launch", "launch_profiles", "launch-profiles"], handler: (request, argument) => commandLaunch(request, argument) },
      { names: ["queue"], handler: (request, argument) => commandQueue(request, argument) },
      { names: ["clearqueue"], handler: (request) => { promptStore.clear(request.contextKey); return reply(request, "Queue cleared."); } },
      { names: ["cancel"], handler: (request, argument) => commandQueue(request, `cancel ${argument}`) },
      { names: ["abort", "stop"], handler: (request) => commandAbort(request) },
      { names: ["retry"], handler: (request) => commandRetry(request) },
      { names: ["last"], handler: (request, argument) => commandLast(request, argument) },
      { names: ["templates"], handler: (request) => reply(request, renderChannelTemplateList(config)) },
      { names: ["workflows"], handler: (request) => reply(request, renderChannelWorkflowList(config)) },
      { names: ["template"], handler: (request, argument) => commandTemplate(request, argument) },
      { names: ["workflow"], handler: (request, argument) => commandWorkflow(request, argument) },
      { names: ["sync"], handler: (request) => commandSync(request) },
      { names: ["tasks", "progress"], handler: (request) => commandProgress(request) },
      { names: ["activity"], handler: (request, argument) => commandActivity(request, argument) },
      { names: ["audit"], handler: (request, argument) => commandAudit(request, argument) },
      { names: ["artifacts"], handler: (request, argument) => commandArtifacts(request, argument) },
      { names: ["logs"], handler: async (request, argument) => deliverChannelAction(runtime, request.context, await commandService.renderLogs(argument)).then(() => {}) },
      { names: ["version", "health", "status"], handler: async (request) => deliverChannelAction(runtime, request.context, await commandService.renderVersion()).then(() => {}) },
      { names: ["diagnostics", "support"], handler: (request) => commandDiagnostics(request) },
      { names: ["restart"], handler: (request) => commandRestart(request) },
      { names: ["update"], handler: (request, argument) => commandUpdate(request, argument) },
      { names: ["lock"], handler: (request) => commandLock(request) },
      { names: ["unlock"], handler: (request) => { lockStore.clear(request.contextKey); return reply(request, "Session unlocked."); } },
      { names: ["locks"], handler: (request) => reply(request, lockStore.list().map((lock) => `${lock.contextKey}: ${lock.ownerLabel || lock.ownerUserId}`).join("\n") || "No active locks.") },
      { names: ["mirror"], handler: (request, argument) => commandMirror(request, argument) },
      { names: ["notify"], handler: (request, argument) => commandNotify(request, argument) },
      { names: ["voice"], handler: (request, argument) => commandVoice(request, argument) },
      { names: ["workspaces"], handler: (request) => commandWorkspaces(request) },
      { names: ["pin"], handler: (request, argument) => commandPin(request, argument) },
      { names: ["unpin"], handler: (request, argument) => commandUnpin(request, argument) },
      { names: ["pinned"], handler: (request) => commandPinned(request) },
      { names: ["handback"], handler: (request) => commandHandback(request) },
      { names: ["register_channel", "register_chat"], handler: (request) => commandRegisterChannel(request) },
      { names: ["link"], handler: (request, argument) => commandLink(request, argument) },
      { names: ["whoami"], handler: (request) => reply(request, request.authUser ? `${request.authUser.user.displayName} <${request.authUser.user.email}>\nGroups: ${request.authUser.groups.map((group) => group.name).join(", ")}` : "Not linked.") },
      { names: ["prompt"], handler: (request, argument) => handlePrompt(request, argument) },
    ],
  });

  const handleCommand = async (request: MatrixRequest, command: string, argument: string): Promise<void> => {
    const normalized = command.toLowerCase();
    const permission = requiredPermissionForMatrixCommand(normalized, argument);
    if (!await authenticate(request, permission, normalized)) return;
    audit(request, { action: "command", status: "ok", description: `/${normalized} ${argument}`.trim() });

    const result = await commandDispatcher.dispatch(request, normalized, argument);
    if (!result.matched) {
      await reply(request, `Unknown command: /${normalized}`);
    }
  };

  const commandHelp = async (request: MatrixRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    await reply(request, [
      "NordRelay Matrix adapter is ready.",
      "",
      "Send a message, mention the app, or use the configured Slash command.",
      "",
      `Core commands: ${matrixHelpCommandList()}.`,
      "",
      renderSessionInfoPlain(session.getInfo()),
    ].join("\n"));
  };

  const commandAgent = async (request: MatrixRequest, argument: string): Promise<void> => {
    const choices = enabledAgents(config);
    const requested = argument.trim() as AgentId;
    if (requested && choices.includes(requested)) {
      const state = getBusyState(request.contextKey);
      if (getBusyReason(request.contextKey).busy) {
        await reply(request, "Cannot switch agent while this context is busy.");
        return;
      }
      state.switching = true;
      try {
        const session = await registry.switchAgent(request.contextKey, requested);
        updateSession(request, session);
        appendActivity(request, { status: "info", type: "agent_switch", agentId: requested, detail: `Switched to ${agentLabel(requested)}.` });
        await reply(request, `Switched agent to ${agentLabel(requested)}.\n\n${renderSessionInfoPlain(session.getInfo())}`);
      } finally {
        state.switching = false;
      }
      return;
    }
    const pickId = createPick("agent", choices);
    await reply(request, "Select agent:", { buttons: choices.map((id, index) => [{ label: agentLabel(id), action: `matrix_pick:${pickId}:${index}` }]) });
  };

  const commandAuth = async (request: MatrixRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const info = session.getInfo();
    if (!capabilitiesOf(info).auth) {
      await deliverChannelAction(runtime, request.context, commandService.renderHostAuthInstruction(info.agentLabel, hostLoginCommand(info), "login"));
      return;
    }
    const status = await checkAgentAuthStatus(info);
    await deliverChannelAction(runtime, request.context, commandService.renderAuthStatus({ label: info.agentLabel, authenticated: status.authenticated, method: status.method, detail: status.detail }));
  };

  const commandLogin = async (request: MatrixRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const info = session.getInfo();
    if (!capabilitiesOf(info).login) {
      await deliverChannelAction(runtime, request.context, commandService.renderHostAuthInstruction(info.agentLabel, hostLoginCommand(info), "login"));
      return;
    }
    const auth = await checkLoginAuthStatus(info);
    if (info.agentId !== "hermes" && auth.authenticated) {
      await reply(request, `${info.agentLabel} is already authenticated via ${auth.method ?? "unknown"}.`);
      return;
    }
    if (!config.enableTelegramLogin) {
      await reply(request, `Remote login is disabled. Run this on the host: ${hostLoginCommand(info)}`);
      return;
    }
    const result = await startAgentLogin(info);
    appendActivity(request, { status: result.success ? "info" : "failed", type: result.success ? "login_started" : "login_failed", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId, detail: redactText(result.message) });
    await deliverChannelAction(runtime, request.context, commandService.renderAuthActionResult("login", { ...result, message: redactText(result.message) }));
  };

  const commandLogout = async (request: MatrixRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const info = session.getInfo();
    if (!capabilitiesOf(info).logout) {
      await deliverChannelAction(runtime, request.context, commandService.renderHostAuthInstruction(info.agentLabel, hostLogoutCommand(info), "logout"));
      return;
    }
    const auth = await checkLoginAuthStatus(info);
    if (auth.method === "api-key") {
      await reply(request, `Cannot logout ${info.agentLabel} while API-key authentication is active. Remove the API key from .env to use CLI auth.`);
      return;
    }
    if (!config.enableTelegramLogin) {
      await reply(request, `Remote auth management is disabled. Run this on the host: ${hostLogoutCommand(info)}`);
      return;
    }
    if (info.agentId !== "hermes" && !auth.authenticated) {
      await reply(request, `${info.agentLabel} is not currently authenticated.`);
      return;
    }
    const result = await startAgentLogout(info);
    appendActivity(request, { status: result.success ? "info" : "failed", type: result.success ? "logout_completed" : "logout_failed", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId, detail: redactText(result.message) });
    await deliverChannelAction(runtime, request.context, commandService.renderAuthActionResult("logout", { ...result, message: redactText(result.message) }));
  };

  const commandSession = async (request: MatrixRequest): Promise<void> => {
    const remoteRendered = await renderTargetPeerSession({
      contextKey: request.contextKey,
      preferencesStore,
      remoteClient,
      actor: actorFor(request),
      canUsePeer: (peerId) => userStore.canUsePeer(request.authUser, peerId),
    }).catch(async (error) => {
      await reply(request, `Remote session failed: ${friendlyErrorText(error)}`);
      return null;
    });
    if (remoteRendered) {
      await deliverChannelAction(runtime, request.context, remoteRendered);
      return;
    }
    const session = await getSession(request, { deferThreadStart: true });
    await reply(request, `Matrix session:\n${renderSessionInfoPlain(session.getInfo({ includeUsage: true }))}`);
  };

  const commandSessions = async (request: MatrixRequest, query: string): Promise<void> => {
    const remote = await listTargetPeerSessions({
      contextKey: request.contextKey,
      preferencesStore,
      remoteClient,
      actor: actorFor(request),
      canUsePeer: (peerId) => userStore.canUsePeer(request.authUser, peerId),
      query,
      limit: 50,
    }).catch(async (error) => {
      await reply(request, `Remote sessions failed: ${friendlyErrorText(error)}`);
      return null;
    });
    if (remote) {
      const records = remote.sessions;
      if (records.length === 0) {
        await reply(request, query.trim() ? `No remote threads found matching "${query.trim()}".` : "No remote threads found.");
        return;
      }
      const title = `Sessions on ${remote.peerLabel} · Agent: ${remote.agentLabel ?? remote.agentId ?? "-"}`;
      const pickId = createSessionPage(
        "sessions",
        request.contextKey,
        query,
        records,
        undefined,
        records.map((record) => remoteSessionChoiceValue(remote.peerId, record.id)),
        title,
      );
      const rendered = renderMatrixSessionPageAction(title, records, pickId, {
        activeThreadId: remote.activeThreadId,
        pinnedThreadIds: [],
      });
      await reply(request, rendered.text, { buttons: rendered.buttons });
      return;
    }
    const session = await getSession(request, { deferThreadStart: true });
    const requestedThread = query.trim() ? session.getSessionRecord(query.trim()) : null;
    if (requestedThread) {
      await commandSwitch(request, query);
      return;
    }
    const records = listMatrixSessionRecords(request, session, query);
    if (records.length === 0) {
      await reply(request, query.trim() ? `No threads found matching "${query.trim()}".` : "No recent threads found.");
      return;
    }
    const title = `${query.trim() ? "Matching threads" : "Recent threads"} on Local node · Agent: ${session.getInfo().agentLabel}`;
    const pickId = createSessionPage("sessions", request.contextKey, query, records, session, undefined, title);
    const rendered = renderMatrixSessionPageAction(title, records, pickId, {
      activeThreadId: session.getInfo().threadId,
      pinnedThreadIds: registry.listPinnedThreadIds(request.contextKey),
    });
    await reply(request, rendered.text, {
      buttons: rendered.buttons,
    });
  };

  const commandNew = async (request: MatrixRequest, workspace: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    if (getBusyReason(request.contextKey).busy) {
      await reply(request, "Cannot create a new thread while this context is busy.");
      return;
    }
    const workspaceValue = workspace.trim() || undefined;
    if (workspaceValue && !filterAllowedWorkspaces(session.listWorkspaces(), config).includes(workspaceValue)) {
      await reply(request, "Workspace is not allowed.");
      return;
    }
    const info = await registry.startNewThread(request.contextKey, session, { workspace: workspaceValue });
    appendActivity(request, { status: "info", type: "session_new", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId, detail: info.workspace });
    await reply(request, `New thread created.\n\n${renderSessionInfoPlain(info)}`);
  };

  const commandSwitch = async (request: MatrixRequest, threadId: string): Promise<void> => {
    if (!threadId.trim()) {
      await reply(request, "Usage: `/switch <thread-id>`");
      return;
    }
    const remoteChoice = parseRemoteSessionChoice(threadId.trim());
    if (remoteChoice) {
      if (!userStore.canUsePeer(request.authUser, remoteChoice.peerId)) {
        await reply(request, "Access denied for peer target.");
        return;
      }
      preferencesStore.update(request.contextKey, { targetPeerId: remoteChoice.peerId });
    }
    if (remoteChoice || selectedTargetPeerId(preferencesStore, request.contextKey)) {
      const switched = await switchTargetPeerSession({
        contextKey: request.contextKey,
        preferencesStore,
        remoteClient,
        actor: actorFor(request),
        canUsePeer: (peerId) => userStore.canUsePeer(request.authUser, peerId),
        threadId: remoteChoice?.threadId ?? threadId.trim(),
      }).catch(async (error) => {
        await reply(request, `Remote switch failed: ${friendlyErrorText(error)}`);
        return null;
      });
      if (switched) {
        peerMirrorController.sync(request.contextKey, request.context);
        await reply(request, `Switched remote session on ${switched.peerLabel}.\n\n${renderSessionInfoPlain(switched.info)}`);
      }
      return;
    }
    if (getBusyReason(request.contextKey).busy) {
      await reply(request, "Cannot switch sessions while a prompt is running.");
      return;
    }
    const session = await getSession(request, { deferThreadStart: true });
    const requestedThread = session.getSessionRecord(threadId.trim());
    const workspacePolicy = evaluateWorkspacePolicy(requestedThread?.cwd ?? session.getCurrentWorkspace(), config);
    if (!workspacePolicy.allowed) {
      await reply(request, `Failed: ${workspacePolicy.warning ?? "Thread workspace blocked by policy."}`);
      return;
    }
    const info = await session.switchSession(threadId.trim());
    updateSession(request, session);
    appendActivity(request, { status: "info", type: "session_switch", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId });
    const policyLine = renderWorkspacePolicyLine(info.workspace, config);
    await reply(request, ["Switched session.", policyLine, "", renderSessionInfoPlain(info)].filter((line): line is string => Boolean(line)).join("\n"));
  };

  const commandModel = async (request: MatrixRequest, argument: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const info = session.getInfo();
    if (!capabilitiesOf(info).modelSelection) {
      await reply(request, `Model selection is not supported for ${info.agentLabel}.`);
      return;
    }
    if (argument.trim()) {
      await session.setModelForCurrentSession(argument.trim());
      updateSession(request, session);
      await reply(request, `Model set to ${argument.trim()}.\n\n${renderSessionInfoPlain(session.getInfo())}`);
      return;
    }
    await session.refreshModels({ force: true }).catch(() => {});
    const models = session.listModels().map((model) => model.slug).slice(0, MAX_CHOICES);
    const pickId = createPick("model", models);
    await reply(request, "Select model:", { buttons: models.map((model, index) => [{ label: trimLine(model, 75), action: `matrix_pick:${pickId}:${index}` }]) });
  };

  const commandReasoning = async (request: MatrixRequest, argument: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const options = agentReasoningOptions(session.getInfo().agentId);
    if (!options.length) {
      await reply(request, `${agentReasoningLabel(session.getInfo().agentId)} is not supported for ${session.getInfo().agentLabel}.`);
      return;
    }
    const requested = argument.trim();
    if (requested) {
      if (!options.includes(requested as never)) {
        await reply(request, `Invalid ${agentReasoningLabel(session.getInfo().agentId)}. Options: ${options.join(", ")}`);
        return;
      }
      await session.setReasoningEffortForCurrentSession(requested);
      updateSession(request, session);
      await reply(request, `${agentReasoningLabel(session.getInfo().agentId)} set to ${requested}.`);
      return;
    }
    const pickId = createPick("reasoning", options);
    await reply(request, `Select ${agentReasoningLabel(session.getInfo().agentId)}:`, { buttons: options.map((value, index) => [{ label: value, action: `matrix_pick:${pickId}:${index}` }]) });
  };

  const commandFast = async (request: MatrixRequest, argument: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    if (!capabilitiesOf(session.getInfo()).fastMode) {
      await reply(request, `Fast mode is not supported for ${session.getInfo().agentLabel}.`);
      return;
    }
    const normalized = argument.trim().toLowerCase();
    const enabled = normalized ? ["on", "true", "yes", "1"].includes(normalized) : !session.getInfo().fastMode;
    session.setFastMode(enabled);
    updateSession(request, session);
    await reply(request, `Fast mode ${enabled ? "on" : "off"}.`);
  };

  const commandLaunch = async (request: MatrixRequest, argument: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    if (!capabilitiesOf(session.getInfo()).launchProfiles) {
      await reply(request, `Launch profiles are not supported for ${session.getInfo().agentLabel}.`);
      return;
    }
    const parts = argument.trim().split(/\s+/).filter(Boolean);
    const requested = parts[0] ?? "";
    const confirmed = parts.slice(1).some((part) => part.toLowerCase() === "confirm");
    const applyToCurrent = parts.slice(1).some((part) => ["apply", "current", "now"].includes(part.toLowerCase()));
    if (requested) {
      const profile = session.listLaunchProfiles().find((candidate) => candidate.id === requested);
      if (!profile) {
        await reply(request, `Unknown launch profile: ${requested}`);
        return;
      }
      if (profile.unsafe && !confirmed) {
        await reply(request, [`Confirm launch profile: ${profile.label}`, `Behavior: ${profile.behavior}`, "", "WARNING: This profile uses danger-full-access.", `Run \`/launch ${profile.id} confirm${applyToCurrent ? " apply" : ""}\` to ${applyToCurrent ? "apply it to the current idle thread" : "enable it for new or reattached threads"} in this Matrix context.`].join("\n"));
        return;
      }
      if (applyToCurrent) {
        const external = getExternalSnapshotForSession(session, config, { maxEvents: 0 });
        if (external?.activity.active && !session.isProcessing()) {
          await reply(request, `Cannot apply launch profile while the external ${external.agentLabel} CLI task is still running.`);
          return;
        }
      }
      const result = applyToCurrent && session.setLaunchProfileForCurrentSession
        ? await session.setLaunchProfileForCurrentSession(profile.id)
        : { value: session.setLaunchProfile(profile.id).id, appliedToActiveThread: false };
      updateSession(request, session);
      const suffix = applyToCurrent
        ? result.appliedToActiveThread
          ? "Applied to the current idle thread."
          : "No active idle thread was attached; applies to the next thread."
        : "Applies to new or reattached threads.";
      await reply(request, `Launch profile set to ${profile.label}.\nBehavior: ${profile.behavior}\n\n${suffix}`);
      return;
    }
    const profiles = session.listLaunchProfiles();
    const pickId = createPick("launch", profiles.map((profile) => profile.id));
    await reply(request, "Select launch profile:\nUse `/launch <profile-id> apply` to apply a profile to the current idle thread.", { buttons: profiles.map((profile, index) => [{ label: trimLine(profile.label || profile.id, 75), action: `matrix_pick:${pickId}:${index}` }]) });
  };

  const commandQueue = async (request: MatrixRequest, argument: string): Promise<void> => {
    const [action, id] = argument.trim().split(/\s+/, 2);
    if (!action) {
      const queue = promptStore.list(request.contextKey);
      if (queue.length === 0) {
        await reply(request, promptStore.isPaused(request.contextKey) ? "Queue is paused and empty." : "Queue is empty.");
        return;
      }
      await deliverChannelAction(runtime, request.context, { ...renderQueueListAction(queue, promptStore.isPaused(request.contextKey)), buttons: queue.slice(0, 5).map((item) => [
        { label: `Run ${item.id}`, action: `matrix_queue_run:${request.contextKey}:${item.id}` },
        { label: "Top", action: `matrix_queue_top:${request.contextKey}:${item.id}` },
        { label: "Up", action: `matrix_queue_up:${request.contextKey}:${item.id}` },
        { label: "Down", action: `matrix_queue_down:${request.contextKey}:${item.id}` },
        { label: `Cancel ${item.id}`, action: `matrix_queue_cancel:${request.contextKey}:${item.id}` },
      ]) });
      return;
    }
    if (action === "pause") promptStore.pause(request.contextKey);
    else if (action === "resume") {
      promptStore.resume(request.contextKey);
      await drainQueue(request);
    } else if (action === "clear") promptStore.clear(request.contextKey);
    else if (action === "cancel" && id) promptStore.remove(request.contextKey, id);
    else if (action === "top" && id) promptStore.moveToTop(request.contextKey, id);
    else if (action === "up" && id) promptStore.moveUp(request.contextKey, id);
    else if (action === "down" && id) promptStore.moveDown(request.contextKey, id);
    else if (action === "run" && id) {
      const item = promptStore.remove(request.contextKey, id);
      if (item) {
        await handlePrompt(request, item.input, item.artifactOutDir, { attachments: item.attachments });
        return;
      }
    } else {
      await reply(request, "Usage: `/queue [pause|resume|clear|run <id>|cancel <id>|top <id>|up <id>|down <id>]`");
      return;
    }
    await reply(request, "Queue updated.");
  };

  const commandAbort = async (request: MatrixRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const external = getExternalSnapshotForSession(session, config, { maxEvents: 0 });
    if (external?.activity.active && !session.isProcessing()) {
      await reply(request, `Cannot abort the external ${external.agentLabel} CLI task from NordRelay. Stop it in the terminal where it is running.`);
      return;
    }
    await session.abort();
    appendActivity(request, { status: "aborted", type: "prompt_aborted", threadId: session.getInfo().threadId, workspace: session.getInfo().workspace, agentId: session.getInfo().agentId });
    await reply(request, "Aborted current operation.");
  };

  const commandRetry = async (request: MatrixRequest): Promise<void> => {
    const cached = promptStore.getLastPrompt(request.contextKey);
    if (!cached) {
      await reply(request, "Nothing to retry. Send a message first.");
      return;
    }
    await handlePrompt(request, cached.input, cached.artifactOutDir, { attachments: cached.attachments });
  };

  const commandLast = async (request: MatrixRequest, argument: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const result = getLastAgentMessageText(session, config, parseLastAgentMessageOptions(argument));
    await reply(request, result.text);
  };

  const commandTemplate = async (request: MatrixRequest, argument: string): Promise<void> => {
    if (!argument.trim()) {
      await reply(request, "Usage: `/template <template-id> {\"variable\":\"value\"}`");
      return;
    }
    const { id, variables } = parseChannelWorkflowArgument(argument);
    await handlePrompt(request, channelTemplatePrompt(config, id, variables).prompt);
  };

  const commandWorkflow = async (request: MatrixRequest, argument: string): Promise<void> => {
    if (!argument.trim()) {
      await reply(request, "Usage: `/workflow <workflow-id> {\"variable\":\"value\"}`");
      return;
    }
    const { id, variables } = parseChannelWorkflowArgument(argument);
    const prompts = channelWorkflowPrompts(config, id, variables);
    const [first, ...rest] = prompts;
    if (!first) {
      await reply(request, "Workflow has no runnable steps.");
      return;
    }
    for (const item of rest) {
      promptStore.enqueue(request.contextKey, toPromptEnvelope(item.prompt));
    }
    await reply(request, `Workflow queued with ${prompts.length} step(s).`);
    await handlePrompt(request, first.prompt);
  };

  const commandSync = async (request: MatrixRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    if (!capabilitiesOf(session.getInfo()).externalActivity) {
      await reply(request, `${session.getInfo().agentLabel} has no external state watcher.`);
      return;
    }
    const result = session.syncFromAgentState({ reattach: true });
    if (result.changed) updateSession(request, session);
    await reply(request, `Sync complete: ${result.changedFields.join(", ") || "already current"}.`);
  };

  const commandProgress = async (request: MatrixRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const external = getExternalSnapshotForSession(session, config, { maxEvents: 0 });
    const state = getBusyState(request.contextKey);
    await deliverChannelAction(runtime, request.context, commandService.renderProgress(turnProgress.get(request.contextKey), promptStore.list(request.contextKey).length, {
      processing: state.processing || session.isProcessing(),
      switching: state.switching,
      transcribing: false,
      approving: false,
      external: Boolean(external?.activity.active),
    }, session.getInfo()));
  };

  const commandActivity = async (request: MatrixRequest, argument: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const info = session.getInfo();
    if (!capabilitiesOf(info).activityLog) {
      await reply(request, `${info.agentLabel} activity timelines are not available yet.`);
      return;
    }
    const threadId = session.getActiveThreadId();
    if (!threadId) {
      await reply(request, "No active thread yet.");
      return;
    }
    const options = parseActivityOptions(argument);
    const events = filterActivityEvents(getAgentActivityLog(session, config, options.exportFile ? 200 : options.limit), options);
    await deliverChannelAction(runtime, request.context, commandService.renderActivity(threadId, events, options));
  };

  const commandAudit = async (request: MatrixRequest, argument: string): Promise<void> => {
    const limit = Math.max(1, Math.min(100, Number.parseInt(argument, 10) || 20));
    await deliverChannelAction(runtime, request.context, commandService.renderAudit(auditLog.list(limit)));
  };

  const commandDiagnostics = async (request: MatrixRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const external = getExternalSnapshotForSession(session, config, { maxEvents: 3 });
    const rateLimit = getMatrixRateLimitMetrics();
    const matrixDiagnostics = await collectMatrixDiagnostics({
      config,
      userStore,
      timeoutMs: 2_500,
      rateLimit,
    });
    await reply(request, [
      "Diagnostics:",
      `Context: ${request.contextKey}`,
      `Channel: ${request.homeserver || "team"} / ${request.roomId}`,
      `Agent: ${session.getInfo().agentLabel}`,
      `Thread: ${session.getInfo().threadId || "-"}`,
      `Workspace: ${session.getInfo().workspace}`,
      `Queue: ${promptStore.list(request.contextKey).length}${promptStore.isPaused(request.contextKey) ? " paused" : ""}`,
      `External: ${external?.activity.active ? "active" : "idle"}`,
      `Matrix rate limit: queued ${rateLimit.queued}, running ${rateLimit.running}, retries ${rateLimit.retries}`,
      "",
      "Matrix readiness:",
      ...matrixDiagnostics.checks.map((check) => `${check.status.toUpperCase()} ${check.label}: ${check.detail}`),
      ...matrixDiagnostics.roomChecks.map((room) => `${room.status.toUpperCase()} room ${room.roomId}: ${room.detail}`),
    ].join("\n"));
  };

  const commandUpdate = async (request: MatrixRequest, argument: string): Promise<void> => {
    const tokens = argument.trim().split(/\s+/).filter(Boolean);
    const [target, second] = tokens;
    if (!target) {
      const update = spawnSelfUpdate();
      await reply(request, `NordRelay update started with ${update.method}. Log: ${update.logPath}`);
      return;
    }
    if (target === "agents" || target === "agent") {
      await deliverChannelAction(runtime, request.context, renderAgentUpdatePickerAction(listAgentAdapterDescriptors()));
      return;
    }
    if (target === "jobs") {
      await deliverChannelAction(runtime, request.context, renderAgentUpdateJobsAction(agentUpdates.list()));
      return;
    }
    if (target === "log" && second) {
      await deliverChannelAction(runtime, request.context, renderAgentUpdateLogAction(agentUpdates.readLog(second)));
      return;
    }
    if (target === "cancel" && second) {
      await deliverChannelAction(runtime, request.context, renderAgentUpdateJobAction(agentUpdates.cancel(second)));
      return;
    }
    if (target === "input" && second) {
      const input = tokens.slice(2).join(" ");
      if (!input.trim()) {
        await reply(request, "Usage: `/update input <job-id> <text>`");
        return;
      }
      await deliverChannelAction(runtime, request.context, renderAgentUpdateJobAction(agentUpdates.sendInput(second, input)));
      return;
    }
    const operation: AgentUpdateOperation = target === "install" ? "install" : "update";
    const agentId = parseAgentUpdateId(operation === "install" ? second : target);
    if (!agentId) {
      await reply(request, "Unknown agent.");
      return;
    }
    const job = agentUpdates.start(agentId, {
      piCliPath: config.piCliPath,
      hermesCliPath: config.hermesCliPath,
      openClawCliPath: config.openClawCliPath,
      claudeCodeCliPath: config.claudeCodeCliPath,
    }, operation);
    await deliverChannelAction(runtime, request.context, renderAgentUpdateJobAction(job));
  };

  const commandLock = async (request: MatrixRequest): Promise<void> => {
    const owner = actorFor(request);
    lockStore.set(request.contextKey, { userId: request.authUser?.user.id ?? request.userId, label: owner.label, channel: "matrix", channelUserId: request.userId }, config.sessionLockTtlMs);
    await reply(request, `Session locked to ${owner.label}.`);
  };

  const commandRestart = async (request: MatrixRequest): Promise<void> => {
    spawnConnectorRestart();
    appendActivity(request, {
      status: "info",
      type: "connector_restart_requested",
      workspace: config.workspace,
      detail: "Matrix restart command",
    });
    await reply(request, "Restarting connector. Matrix may disconnect briefly.");
  };

  const commandWorkspaces = async (request: MatrixRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    await deliverChannelAction(runtime, request.context, commandService.renderWorkspaces(session.getInfo(), filterAllowedWorkspaces(session.listWorkspaces(), config)));
  };

  const commandPin = async (request: MatrixRequest, argument: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const threadId = argument.trim() || session.getActiveThreadId();
    if (!threadId) {
      await reply(request, "No active thread to pin.");
      return;
    }
    const pinned = registry.pinThread(request.contextKey, threadId);
    await reply(request, `Pinned thread ${threadId}.\nPinned threads: ${pinned.length}`);
  };

  const commandUnpin = async (request: MatrixRequest, argument: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const threadId = argument.trim() || session.getActiveThreadId();
    if (!threadId) {
      await reply(request, "No active thread to unpin.");
      return;
    }
    const pinned = registry.unpinThread(request.contextKey, threadId);
    await reply(request, `Unpinned thread ${threadId}.\nPinned threads: ${pinned.length}`);
  };

  const commandPinned = async (request: MatrixRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const records = listPinnedSessionRecords(request, session);
    if (records.length === 0) {
      await reply(request, "No pinned threads.");
      return;
    }
    const pickId = createSessionPage("pinned", request.contextKey, "", records, session);
    const rendered = renderMatrixSessionPageAction("Pinned threads", records, pickId, {
      activeThreadId: session.getInfo().threadId,
      pinnedThreadIds: registry.listPinnedThreadIds(request.contextKey),
    });
    await reply(request, rendered.text, {
      buttons: rendered.buttons,
    });
  };

  const commandHandback = async (request: MatrixRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    if (getBusyReason(request.contextKey).busy) {
      await reply(request, "Cannot hand back while a prompt is running. Use `/stop` first.");
      return;
    }
    if (!session.hasActiveThread()) {
      await reply(request, "No active thread to hand back.");
      return;
    }
    const result = session.handback();
    updateSession(request, session);
    appendActivity(request, { status: "info", type: "handback", threadId: result.threadId, workspace: result.workspace, agentId: session.getInfo().agentId, detail: result.command ?? result.threadId ?? "handback" });
    await deliverChannelAction(runtime, request.context, commandService.renderHandback(result));
  };

  const commandMirror = async (request: MatrixRequest, argument: string): Promise<void> => {
    const remoteResponse = await renderTargetPeerMirrorPreference({
      source: "matrix",
      contextKey: request.contextKey,
      argument,
      preferencesStore,
      remoteClient,
      actor: actorFor(request),
      canUsePeer: (peerId) => userStore.canUsePeer(request.authUser, peerId),
    }).catch(async (error) => {
      await reply(request, `Remote mirror failed: ${friendlyErrorText(error)}`);
      return null;
    });
    if (remoteResponse) {
      await deliverChannelAction(runtime, request.context, remoteResponse.response);
      peerMirrorController.sync(request.contextKey, request.context);
      return;
    }
    const session = await getSession(request, { deferThreadStart: true });
    const info = session.getInfo();
    await deliverChannelAction(runtime, request.context, commandService.renderMirrorPreference({ source: "matrix", contextKey: request.contextKey, argument, preferencesStore, cliMirrorSupported: capabilitiesOf(info).cliMirror, agentLabel: info.agentLabel }));
  };

  const commandNotify = async (request: MatrixRequest, argument: string): Promise<void> => {
    await deliverChannelAction(runtime, request.context, commandService.renderNotifyPreference({ source: "matrix", contextKey: request.contextKey, argument, preferencesStore }));
  };

  const commandVoice = async (request: MatrixRequest, argument: string): Promise<void> => {
    await deliverChannelAction(runtime, request.context, await commandService.renderVoicePreference({ source: "matrix", contextKey: request.contextKey, argument, preferencesStore }));
  };

  const commandRegisterChannel = async (request: MatrixRequest): Promise<void> => {
    const room = userStore.registerMatrixRoom({ roomId: request.roomId, title: request.roomName, type: request.isDirectMessage ? "dm" : "room", enabled: true });
    audit(request, { action: "matrix_room_updated", status: "ok", description: room.roomId });
    await reply(request, `Matrix room registered: ${room.title || room.roomId}`);
  };

  const commandLink = async (request: MatrixRequest, code: string): Promise<void> => {
    if (!userStore.hasAdminUser()) {
      await reply(request, "NordRelay has no admin user yet. Run `nordrelay user create-admin` on the host.", { ephemeral: true });
      return;
    }
    try {
      const linked = userStore.consumeMatrixLinkCode(code, { matrixUserId: request.userId, homeserver: request.userHomeserver ?? matrixHomeserverFromUserId(request.userId), displayName: request.username });
      request.authUser = linked;
      audit(request, { action: "matrix_linked", status: "ok", description: request.userId });
      await reply(request, `Linked Matrix account to ${linked.user.email}.`, { ephemeral: true });
    } catch (error) {
      await reply(request, `Link failed: ${friendlyErrorText(error)}`, { ephemeral: true });
    }
  };

  const handleAttachments = async (request: MatrixRequest, files: MatrixAttachment[], text: string): Promise<void> => {
    const session = await getSession(request);
    const workspace = session.getInfo().workspace;
    const turnId = randomUUID().slice(0, 12);
    const outDir = outboxPath(workspace, turnId);
    await ensureOutDir(outDir);
    const stagedFiles: StagedFile[] = [];
    const imagePaths: string[] = [];
    const transcripts: string[] = [];

    for (const file of files) {
      const size = Number(file.size ?? 0);
      if (size > Math.min(config.maxFileSize, MAX_ATTACHMENT_DOWNLOAD)) {
        await reply(request, `Skipped ${file.name || file.id}: file is too large.`);
        continue;
      }
      const media = await client.getMedia(file.mxcUri);
      const buffer = media.buffer;
      const mimeType = file.mimeType || media.contentType || inferChannelMimeType(file.name || "attachment");
      const staged = await stageFile(buffer, file.name || media.filename || `matrix-${file.id}`, mimeType, { workspace, turnId, maxFileSize: config.maxFileSize });
      stagedFiles.push(staged);
      if (mimeType.startsWith("image/")) imagePaths.push(staged.localPath);
      if (mimeType.startsWith("audio/")) {
        const result = await transcribeAudio(staged.localPath, {
          preferredBackend: config.voicePreferredBackend === "auto" ? undefined : config.voicePreferredBackend as TranscriptionBackend,
          language: config.voiceDefaultLanguage,
        });
        if (result.text.trim()) transcripts.push(`Audio transcript (${staged.safeName}, via ${result.backend}):\n${result.text.trim()}`);
      }
    }

    const audioOnly = stagedFiles.length > 0 && stagedFiles.every((file) => file.mimeType.startsWith("audio/"));
    if ((preferencesStore.get(request.contextKey).voiceTranscribeOnly ?? config.voiceTranscribeOnly) && audioOnly && !text.trim()) {
      await reply(request, transcripts.join("\n\n") || "No transcript produced.");
      return;
    }
    const prompt: AgentPromptInput = {};
    const textParts = [text.trim(), ...transcripts].filter(Boolean);
    if (textParts.length) prompt.text = textParts.join("\n\n");
    if (imagePaths.length) prompt.imagePaths = imagePaths;
    if (stagedFiles.length) prompt.stagedFileInstructions = buildFileInstructions(stagedFiles, outDir);
    await handlePrompt(request, prompt, outDir, { attachments: webChatAttachmentsForStagedFiles(stagedFiles, turnId) });
  };

  const handleMessage = async (event: MatrixMessageEvent): Promise<void> => {
    if (event.sender === config.matrixUserId) return;
    const request = matrixRequestFromMessage(event, { homeserverName: client.homeserverName(), botUserId: config.matrixUserId });
    const text = stripMatrixMention(matrixEventText(event)).trim();
    const attachments = matrixAttachmentsFromEvent(event);
    const actionPermission = permissionForMatrixAction(text);
    if (actionPermission) {
      if (!await authenticate(request, actionPermission)) return;
      await handleButtonAction(request, text);
      return;
    }
    const parsed = parseMatrixMessageCommand(text, config.matrixCommandPrefix);
    if (parsed) {
      await handleCommand(request, parsed.command, parsed.argument);
      return;
    }
    if (!config.matrixMessageContentEnabled && attachments.length === 0) {
      return;
    }
    const permission = attachments.length ? "files.write" : "prompt.send";
    if (!await authenticate(request, permission)) return;
    if (attachments.length) {
      await handleAttachments(request, attachments, text);
      return;
    }
    if (text) {
      await handlePrompt(request, text);
    }
  };

  const handleButtonAction = async (request: MatrixRequest, action: string): Promise<void> => {
    const nodeTargetMatch = action.match(/^node_target:(local|peer:.+)$/);
    if (nodeTargetMatch?.[1]) {
      await deliverChannelAction(runtime, request.context, commandService.renderNodeTargetAction({
        source: "matrix",
        contextKey: request.contextKey,
        argument: "",
        preferencesStore,
        action: `node_target:${nodeTargetMatch[1]}`,
        canUsePeer: (peerId) => userStore.canUsePeer(request.authUser, peerId),
      }));
      peerMirrorController.sync(request.contextKey, request.context);
      return;
    }
    const sessionPageMatch = action.match(/^matrix_sessions_page:([^:]+):(prev|next|refresh)$/);
    if (sessionPageMatch?.[1] && sessionPageMatch[2]) {
      await commandSessionPage(request, sessionPageMatch[1], sessionPageMatch[2] as "prev" | "next" | "refresh");
      return;
    }
    const pickMatch = action.match(/^matrix_pick:([^:]+):(\d+)$/);
    if (pickMatch?.[1]) {
      const pick = picks.get(pickMatch[1]);
      const index = Number.parseInt(pickMatch[2] ?? "", 10);
      const value = pick?.values[index];
      if (!pick || !value) {
        await reply(request, "Selection expired.", { ephemeral: true });
        return;
      }
      if (pick.kind === "agent") await commandAgent(request, value);
      else if (pick.kind === "session") await commandSwitch(request, value);
      else if (pick.kind === "model") await commandModel(request, value);
      else if (pick.kind === "reasoning") await commandReasoning(request, value);
      else if (pick.kind === "launch") await commandLaunch(request, value);
      return;
    }
    const queueMatch = action.match(/^matrix_queue_(run|cancel|top|up|down):(.+):([^:]+)$/);
    if (queueMatch?.[1] && queueMatch[2] === request.contextKey) {
      await commandQueue(request, `${queueMatch[1]} ${queueMatch[3]}`);
      return;
    }
    const peerQueueMatch = action.match(/^matrix_peer_queue_cancel:([^:]+):([^:]+)$/);
    if (peerQueueMatch?.[1] && peerQueueMatch[2]) {
      if (!userStore.canUsePeer(request.authUser, peerQueueMatch[1])) {
        await reply(request, "Access denied for peer target.", { ephemeral: true });
        return;
      }
      await remoteClient.webProxy(peerQueueMatch[1], { method: "POST", path: "/api/queue", body: { action: "cancel", id: peerQueueMatch[2] }, contextKey: request.contextKey }, actorFor(request), request.contextKey);
      await reply(request, `Cancelled remote queued prompt ${peerQueueMatch[2]}.`, { ephemeral: true });
      return;
    }
    const artifactMatch = action.match(/^matrix_artifact_(send|zip|delete):(.+):([^:]+)$/);
    if (artifactMatch?.[1] && artifactMatch[2] === request.contextKey) {
      await commandArtifacts(request, `${artifactMatch[1]} ${artifactMatch[3]}`);
      return;
    }
    const approvalMatch = action.match(/^matrix_external_approval:(yes|persist|no):([a-f0-9]+)$/);
    if (approvalMatch?.[1] && approvalMatch[2]) {
      const session = registry.get(request.contextKey);
      if (!session) {
        await reply(request, "No session for this room.", { ephemeral: true });
        return;
      }
      const result = await respondToExternalApproval(session, config, approvalMatch[2], approvalMatch[1] as "yes" | "persist" | "no");
      await reply(request, result.message, { ephemeral: !result.ok });
      const info = session.getInfo();
      activityStore.append({
        source: "matrix",
        status: result.ok ? "info" : "failed",
        type: "cli_action_required_response",
        contextKey: request.contextKey,
        threadId: session.getActiveThreadId(),
        workspace: info.workspace,
        agentId: info.agentId,
        actor: actorFor(request),
        detail: result.message,
      });
      return;
    }
    const updateMatch = action.match(/^agent-update:(start|log|cancel):(.+)$/);
    if (updateMatch?.[1]) {
      const updateAction = updateMatch[1];
      const value = updateMatch[2] ?? "";
      if (updateAction === "start") await commandUpdate(request, value);
      else await commandUpdate(request, `${updateAction} ${value}`);
      return;
    }
    if (action === "agent-update:jobs") {
      await commandUpdate(request, "jobs");
      return;
    }
    const abortMatch = action.match(/^matrix_abort:(.+)$/);
    if (abortMatch?.[1] === request.contextKey) {
      await commandAbort(request);
    }
  };

  const listMatrixSessionRecords = (request: MatrixRequest, session: AgentSessionService, query: string): MatrixSessionListRecord[] => {
    const pinnedThreadIds = registry.listPinnedThreadIds(request.contextKey);
    return orderPinnedSessions(
      filterSessions(session.listAllSessions(100), query)
        .filter((record) => evaluateWorkspacePolicy(record.cwd, config).allowed),
      pinnedThreadIds,
    ).slice(0, 50);
  };

  const listPinnedSessionRecords = (request: MatrixRequest, session: AgentSessionService): MatrixSessionListRecord[] =>
    registry.listPinnedThreadIds(request.contextKey)
      .map((threadId) => session.getSessionRecord(threadId))
      .filter((record): record is AgentThreadRecord => Boolean(record))
      .filter((record) => evaluateWorkspacePolicy(record.cwd, config).allowed);

  const refreshSessionPageRecords = async (request: MatrixRequest, state: MatrixSessionPageState): Promise<MatrixSessionListRecord[]> => {
    const session = await getSession(request, { deferThreadStart: true });
    state.activeThreadId = session.getInfo().threadId;
    state.pinnedThreadIds = registry.listPinnedThreadIds(request.contextKey);
    return state.source === "pinned" ? listPinnedSessionRecords(request, session) : listMatrixSessionRecords(request, session, state.query);
  };

  const commandSessionPage = async (request: MatrixRequest, pickId: string, action: "prev" | "next" | "refresh"): Promise<void> => {
    const state = sessionPages.get(pickId);
    if (!state || state.contextKey !== request.contextKey) {
      await reply(request, "Selection expired. Run `/sessions` again.", { ephemeral: true });
      return;
    }
    if (action === "refresh") {
      const pick = picks.get(pickId);
      const isRemotePage = pick?.values.some((value) => Boolean(parseRemoteSessionChoice(value)));
      if (!isRemotePage) {
        const refreshed = await refreshSessionPageRecords(request, state);
        state.records = refreshed;
        if (pick) pick.values = refreshed.map((record) => record.id);
      }
    } else {
      state.page += action === "next" ? 1 : -1;
    }
    const rendered = renderMatrixSessionPageAction(state.title ?? (state.source === "pinned" ? "Pinned threads" : (state.query.trim() ? "Matching threads" : "Recent threads")), state.records, pickId, {
      page: state.page,
      pageSize: state.pageSize,
      activeThreadId: state.activeThreadId,
      pinnedThreadIds: state.pinnedThreadIds,
    });
    state.page = rendered.page;
    await reply(request, rendered.text, { buttons: rendered.buttons });
  };

  const createSessionPage = (source: MatrixSessionPageSource, contextKey: ChannelContextKey, query: string, records: MatrixSessionListRecord[], session?: AgentSessionService, values?: string[], title?: string): string => {
    const id = createPick("session", values ?? records.map((record) => record.id));
    sessionPages.set(id, {
      contextKey,
      source,
      query,
      title,
      records,
      activeThreadId: session?.getInfo().threadId,
      pinnedThreadIds: session ? registry.listPinnedThreadIds(contextKey) : [],
      page: 0,
      pageSize: MATRIX_SESSION_PAGE_SIZE,
      createdAt: Date.now(),
    });
    setTimeout(() => sessionPages.delete(id), 10 * 60 * 1000).unref?.();
    return id;
  };

  const createPick = (kind: PickState["kind"], values: string[]): string => {
    const id = randomUUID().replace(/-/g, "").slice(0, 10);
    picks.set(id, { kind, values });
    setTimeout(() => picks.delete(id), 10 * 60 * 1000).unref?.();
    return id;
  };

  const externalMonitor = createChannelExternalMonitorLoop({
    label: "Matrix",
    intervalMs: config.codexExternalBusyCheckMs,
    run: () => monitorChannelExternalContexts({
      config,
      registry,
      promptStore,
      isContextKey: isMatrixContextKey,
      canSendSystemMessages: (contextKey) => canSendSystemMessagesToMatrixContext(userStore, contextKey),
      shouldMonitorContext: (contextKey) => (preferencesStore.get(contextKey).mirrorMode ?? config.matrixMirrorMode) !== "off",
      isAllowed: (contextKey) => {
        const parsed = parseMatrixContextKey(contextKey);
        return Boolean(parsed && isMatrixHomeserverAllowed(config, parsed.homeserver) && isMatrixRoomAllowedByEnv(config, parsed.roomId));
      },
      contextForKey: matrixContextForKey,
      previousLastLine: (contextKey) => externalMirrors.get(contextKey)?.lastLine,
      mirrorSnapshot: mirrorExternalSnapshot,
      updateQueueStatus: updateQueueStatusMessage,
      drainQueue: async (contextKey, context) => {
        const parsed = parseMatrixContextKey(contextKey);
        if (!parsed) return;
        await drainQueue({ contextKey, context, userId: "system", roomId: parsed.roomId, homeserver: parsed.homeserver, isDirectMessage: false, source: "system" });
      },
    }),
  });

  const syncLoop = createMatrixSyncLoop({ client, config, handleMessage });

  return {
    client,
    async start() {
      syncLoop.start();
      console.log(`Matrix bot ready (${config.matrixHomeserverUrl}).`);
      void collectMatrixDiagnostics({
        config,
        userStore,
        timeoutMs: 3_500,
        rateLimit: getMatrixRateLimitMetrics(),
      }).then((diagnostics) => {
        for (const check of diagnostics.checks.filter((item) => item.status === "warn" || item.status === "error")) {
          console.warn(`Matrix ${check.status}: ${check.label}: ${check.detail}`);
        }
        for (const room of diagnostics.roomChecks.filter((item) => item.status === "warn" || item.status === "error")) {
          console.warn(`Matrix ${room.status}: room ${room.roomId}: ${room.detail}`);
        }
      }).catch((error) => console.warn("Matrix diagnostics failed:", friendlyErrorText(error)));
      externalMonitor.start();
      peerMirrorController.startStoredContexts();
    },
    async stop() {
      syncLoop.stop();
      externalMonitor.stop();
      peerMirrorController.closeAll();
      agentUpdates.cancelAll();
    },
  };
}
