import { randomUUID } from "node:crypto";

import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";

import { ADMIN_GROUP_ID, type Permission } from "../../access/access-control.js";
import { agentLabel, agentReasoningLabel, agentReasoningOptions, type AgentId, type AgentPromptInput, type AgentSessionInfo, type AgentSessionService } from "../../agents/shared/agent.js";
import { getAgentActivityLog, getExternalSnapshotForSession } from "../../agents/shared/agent-activity.js";
import { respondToExternalApproval } from "../../agents/shared/agent-approval.js";
import { hostAgentLoginCommand, hostAgentLogoutCommand } from "../../agents/shared/agent-auth-commands.js";
import { listAgentAdapterDescriptors } from "../../agents/shared/agent-adapter.js";
import type { AgentUpdateOperation } from "../../agents/shared/agent-updates.js";
import { enabledAgents } from "../../agents/shared/agent-factory.js";
import { ensureOutDir } from "../../artifacts/artifacts.js";
import { buildFileInstructions, outboxPath, stageFile, type StagedFile } from "../../artifacts/attachments.js";
import { capabilitiesOf, filterActivityEvents, parseActivityOptions, trimLine } from "../shared/bot-rendering.js";
import { parseAgentUpdateId, renderAgentUpdateJobAction, renderAgentUpdateJobsAction, renderAgentUpdateLogAction, renderAgentUpdatePickerAction, renderQueueListAction } from "../shared/channel-actions.js";
import type { ChannelContext } from "../shared/channel-adapter.js";
import {
  createChannelActivityRecorder,
  createChannelAuditRecorder,
  createChannelPermissionChecker,
} from "../shared/channel-bridge-controller.js";
import { createChannelBridgeEnvironment } from "../shared/channel-bridge-environment.js";
import { createSharedChannelCommandDispatcher } from "../shared/channel-command-core.js";
import { slackHelpCommandList } from "../shared/channel-command-catalog.js";
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
import { isSlackContextKey, parseSlackContextKey, type ChannelContextKey } from "../shared/context-key.js";
import { friendlyErrorText } from "../../core/error-messages.js";
import { spawnConnectorRestart, spawnSelfUpdate } from "../../support/operations.js";
import { toPromptEnvelope, webChatAttachmentsForStagedFiles, type PromptEnvelope } from "../../state/prompt-store.js";
import { resolveArtifactDeliveryPolicy, type ArtifactDeliveryMode } from "../../artifacts/artifact-delivery.js";
import { redactText } from "../../core/redaction.js";
import { renderSessionInfoPlain } from "../shared/session-format.js";
import { canWriteWithLock } from "../../access/session-locks.js";
import { SessionRegistry } from "../../state/session-registry.js";
import { createSlackArtifactCommandHandler, sendRecentSlackArtifacts } from "./slack-artifacts.js";
import { SlackBotChannelRuntime, actionFromSlackActionId, splitSlackMessage, trimSlackMessage } from "./slack-channel-runtime.js";
import type { SlackActionBody, SlackBoltApp, SlackBridge, SlackBusyReason, SlackBusyState, SlackExternalMirrorState, SlackPickState, SlackRequest, SlackSlashCommandPayload } from "./slack-types.js";
import {
  canSendSystemMessagesToSlackContext,
  isSlackChannelAllowedByEnv,
  isSlackTeamAllowed,
  slackRequestFromAction,
  slackRequestFromMessage,
  slackRequestFromSlashCommand,
  stripSlackMention,
  type SlackFile,
  type SlackMessageEvent,
} from "./slack-request-context.js";
import { isUnauthenticatedSlackCommandAllowed, parseSlackMessageCommand, parseSlackSlashCommand, permissionForSlackAction, requiredPermissionForSlackCommand } from "./slack-command-surface.js";
import { collectSlackDiagnostics } from "./slack-diagnostics.js";
import { getSlackRateLimitMetrics } from "./slack-rate-limit.js";
import { transcribeAudio, type TranscriptionBackend } from "../../artifacts/voice.js";
import type { AuthenticatedUser } from "../../access/user-management.js";
import type { WebActivityActor } from "../../web/web-state.js";
import { filterAllowedWorkspaces } from "../../core/workspace-policy.js";

export { isUnauthenticatedSlackCommandAllowed, permissionForSlackAction, requiredPermissionForSlackCommand } from "./slack-command-surface.js";
export { canSendSystemMessagesToSlackContext } from "./slack-request-context.js";

const EDIT_DEBOUNCE_MS = 1500;
const TYPING_INTERVAL_MS = 4500;
const MAX_CHOICES = 25;
const MAX_ATTACHMENT_DOWNLOAD = 25 * 1024 * 1024;

type BusyState = SlackBusyState;
type BusyReason = SlackBusyReason;
type PickState = SlackPickState;

export function createSlackBridge(config: ConnectorConfig, registry: SessionRegistry): SlackBridge | null {
  if (!config.slackEnabled) {
    return null;
  }
  if (!config.slackBotToken) {
    console.warn("Slack adapter disabled: SLACK_ENABLED=true requires SLACK_BOT_TOKEN.");
    return null;
  }

  configureChannelRuntime(config);

  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackSocketMode ? config.slackAppToken : undefined,
    signingSecret: config.slackSigningSecret,
    socketMode: config.slackSocketMode,
  });
  const runtime = new SlackBotChannelRuntime(app.client as WebClient);
  const env = createChannelBridgeEnvironment<ChannelContextKey, BusyState, string, SlackExternalMirrorState>(config, {
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

  const artifactPolicyForRequest = (request: SlackRequest) => resolveArtifactDeliveryPolicy({ config, channelId: "slack", authUser: request.authUser, channelAccess: request.isDirectMessage ? null : userStore.snapshot().slackChannels.find((channel) => channel.channelId === request.channelId && (!request.teamId || channel.teamId === request.teamId)) ?? null });
  const artifactPolicyForContext = (context: ChannelContext) => resolveArtifactDeliveryPolicy({ config, channelId: "slack", channelAccess: userStore.snapshot().slackChannels.find((channel) => channel.channelId === context.chatId) ?? null });
  const picks = new Map<string, PickState>();
  const queueStatusMessages = env.queueStatusMessages!;

  const slackContextForKey = (contextKey: ChannelContextKey): ChannelContext | null => {
    const parsed = parseSlackContextKey(contextKey);
    return parsed ? { channelId: "slack", chatId: parsed.channelId, ...(parsed.threadTs ? { topicId: parsed.threadTs } : {}) } : null;
  };

  const getBusyState = (contextKey: ChannelContextKey): BusyState => busyStates.get(contextKey);

  const actorFor = (request: SlackRequest): WebActivityActor => ({
    channel: "slack",
    id: request.authUser?.user.id ?? `slack:${request.userId}`,
    label: request.authUser?.user.displayName || request.authUser?.user.email || request.username || request.userId,
    username: request.authUser?.user.email ?? request.username,
    channelUserId: request.userId,
  });

  const appendActivity = createChannelActivityRecorder<SlackRequest>({
    source: "slack",
    workspace: config.workspace,
    activityStore,
    actorFor,
  });

  const audit = createChannelAuditRecorder<SlackRequest>({
    channelId: "slack",
    auditLog,
    actorFor,
    actorIdFor: (request) => request.userId,
  });

  const peerMirrorController = createChannelPeerMirrorController({
    label: "Slack",
    runtime,
    preferencesStore,
    remoteClient,
    contextForKey: slackContextForKey,
    defaultMirrorMode: () => config.slackMirrorMode,
    mirrorMinUpdateMs: EDIT_DEBOUNCE_MS,
  });

  const hasPermission = createChannelPermissionChecker<SlackRequest>(userStore);

  const reply = async (
    request: SlackRequest,
    content: string,
    options: { buttons?: Array<Array<{ label: string; action: string }>>; ephemeral?: boolean } = {},
  ): Promise<void> => {
    if (options.ephemeral && request.respond) {
      await request.respond({
        text: trimSlackMessage(content),
        response_type: "ephemeral",
        replace_original: false,
      }).catch(() => runtime.sendMessage(request.context, { text: trimSlackMessage(content), fallbackText: trimSlackMessage(content), buttons: options.buttons }));
      return;
    }
    for (const [index, chunk] of splitSlackMessage(content).entries()) {
      await runtime.sendMessage(request.context, {
        text: chunk,
        fallbackText: chunk,
        buttons: index === splitSlackMessage(content).length - 1 ? options.buttons : undefined,
      });
    }
  };

  const authenticate = async (request: SlackRequest, permission: Permission | null, commandName?: string): Promise<boolean> => {
    if (commandName && isUnauthenticatedSlackCommandAllowed(commandName)) {
      return true;
    }
    if (!userStore.hasAdminUser()) {
      await reply(request, "NordRelay has no admin user yet. Run `nordrelay user create-admin` on the host.", { ephemeral: true });
      return false;
    }
    const authUser = userStore.resolveSlackUser({ slackUserId: request.userId, teamId: request.teamId });
    if (!authUser) {
      audit(request, {
        action: "permission_denied",
        status: "denied",
        description: "Slack account is not linked",
      });
      if (request.isDirectMessage || request.respond) {
        await reply(request, "Unauthorized. Link this Slack account to a NordRelay user first.", { ephemeral: true });
      }
      return false;
    }
    request.authUser = authUser;

    if (!isSlackTeamAllowed(config, request.teamId) || !isSlackChannelAllowedByEnv(config, request.channelId)) {
      audit(request, {
        action: "permission_denied",
        status: "denied",
        description: "Slack team or channel is outside configured allow-list",
      });
      await reply(request, "This Slack team or channel is not allowed for NordRelay.", { ephemeral: true });
      return false;
    }

    const channelAllowed = userStore.isSlackChannelAllowed({
      teamId: request.teamId,
      channelId: request.channelId,
      isDirectMessage: request.isDirectMessage,
    }, authUser);
    if (!channelAllowed && commandName !== "register_channel") {
      audit(request, {
        action: "permission_denied",
        status: "denied",
        description: "Slack channel is not enabled or outside user scope",
      });
      if (request.isDirectMessage || request.respond) {
        await reply(request, "This Slack channel is not enabled for NordRelay. An admin can use `/register_channel` in the channel.", { ephemeral: true });
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

  const getSession = async (request: SlackRequest, options?: { deferThreadStart?: boolean }): Promise<AgentSessionService> => registry.getOrCreate(request.contextKey, options);
  const updateSession = (request: SlackRequest, session: AgentSessionService): void => { registry.updateMetadata(request.contextKey, session); };

  const artifactDeps = {
    config,
    runtime,
    artifactService,
    getSession,
    reply,
    appendActivity,
    getArtifactDeliveryMode: (request: SlackRequest) => request.authUser?.user.preferences?.artifactDelivery,
    setArtifactDeliveryMode: async (request: SlackRequest, mode: ArtifactDeliveryMode | null) => { if (!request.authUser) throw new Error("Authenticated Slack user required."); const updated = userStore.updateUser(request.authUser.user.id, { preferences: { artifactDelivery: mode } }); request.authUser = updated; return updated.user.preferences?.artifactDelivery ?? config.slackArtifactDeliveryMode; },
  };
  const commandArtifacts = createSlackArtifactCommandHandler<SlackRequest>(artifactDeps);

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

  const ensureActiveThread = async (request: SlackRequest, session: AgentSessionService): Promise<void> => {
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

  const denyIfLocked = async (request: SlackRequest): Promise<boolean> => {
    const lock = lockStore.get(request.contextKey);
    const isAdmin = request.authUser?.groups.some((group) => group.id === ADMIN_GROUP_ID) ?? false;
    if (canWriteWithLock(lock, request.authUser?.user.id, isAdmin)) {
      return false;
    }
    await reply(request, `Session is locked by ${lock?.ownerLabel || lock?.ownerUserId || "another user"}.`);
    return true;
  };

  const handleRemotePrompt = async (request: SlackRequest, envelope: PromptEnvelope): Promise<boolean> => {
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
        const rendered = trimSlackMessage(text);
        const sent = await runtime.sendMessage(request.context, { text: rendered, fallbackText: rendered });
        return sent.messageId;
      },
      editResponse: async (messageId, text) => {
        const rendered = trimSlackMessage(text);
        await runtime.editMessage(request.context, messageId, { text: rendered, fallbackText: rendered });
      },
      sendTurnStart: (remotePrompt) => reply(request, `Remote peer working on:\n${remotePrompt}`),
      sendToolStart: (toolName) => reply(request, `Remote tool: ${toolName}`),
      sendQueued: async (queueId) => {
        await reply(request, `Remote prompt queued${queueId ? `: ${queueId}` : ""}.`, queueId ? {
          buttons: [[{ label: "Cancel queued message", action: `slack_peer_queue_cancel:${targetPeerId}:${queueId}` }]],
        } : undefined);
      },
      sendCompleted: () => reply(request, "Remote turn completed."),
      sendFailure: (message) => reply(request, `Remote peer failed: ${message}`),
    });
  };

  const handlePrompt = async (request: SlackRequest, input: AgentPromptInput, artifactOutDir?: string, options: { fromQueue?: boolean; attachments?: ReturnType<typeof webChatAttachmentsForStagedFiles> } = {}): Promise<void> => {
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
      actionPrefix: "slack",
      reply,
      appendActivity,
      audit,
    })) {
      return;
    }

    await runChannelLocalPrompt({
      source: "slack",
      label: "Slack",
      config,
      runtime,
      request,
      session,
      envelope,
      busyState: getBusyState(request.contextKey),
      promptStore,
      turnProgress,
      artifactService,
      abortActionPrefix: "slack",
      editDebounceMs: EDIT_DEBOUNCE_MS,
      typingIntervalMs: TYPING_INTERVAL_MS,
      trimMessage: trimSlackMessage,
      splitMessage: splitSlackMessage,
      actor: actorFor(request),
      appendActivity,
      audit,
      checkAgentAuthStatus,
      ensureActiveThread,
      updateSession,
      sendRecentArtifacts: async (startedAt, turnId) => {
        const artifactPolicy = artifactPolicyForRequest(request);
        if (artifactPolicy.sendSummary || artifactPolicy.autoSendFiles || artifactPolicy.autoSendZip) {
          await sendRecentSlackArtifacts(artifactDeps, request, session, startedAt, turnId, artifactPolicy);
        }
      },
      drainQueue: () => drainQueue(request),
    });
  };

  const drainQueue = async (request: SlackRequest): Promise<void> => {
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
      autoSend: config.slackAutoSendArtifacts,
      deliveryPolicy: artifactPolicyForContext(context),
      sendSummaryWhenAutoSendDisabled: false,
      logPrefix: "Slack",
      sendSummary: (summary) => runtime.sendMessage(context, { text: summary, fallbackText: summary }).then(() => {}),
      sendArtifact: (artifact) => runtime.sendFile(context, { localPath: artifact.localPath, name: artifact.name }).then(() => {}).catch((error) => {
        console.error(`Failed to send Slack CLI artifact ${artifact.name}:`, error);
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
    minUpdateMs: () => config.slackMirrorMinUpdateMs,
    mirrorMode: (contextKey) => preferencesStore.get(contextKey).mirrorMode ?? config.slackMirrorMode,
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
          { label: "Proceed", action: `slack_external_approval:yes:${approval.id}` },
          ...(approval.prefixRule.length > 0 ? [{ label: "Proceed and remember", action: `slack_external_approval:persist:${approval.id}` }] : []),
        ],
        [{ label: "Deny", action: `slack_external_approval:no:${approval.id}` }],
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
      for (const chunk of splitSlackMessage(text)) {
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

  const commandDispatcher = createSharedChannelCommandDispatcher<SlackRequest>({
    transport: "slack",
    bindings: [
      { names: ["start", "help"], handler: (request) => commandHelp(request) },
      { names: ["channels"], handler: (request) => deliverChannelAction(runtime, request.context, commandService.renderChannels()).then(() => {}) },
      { names: ["peers"], handler: (request) => deliverChannelAction(runtime, request.context, commandService.renderPeers((peerId) => userStore.canUsePeer(request.authUser, peerId))).then(() => {}) },
      { names: ["nodes"], handler: (request) => deliverChannelAction(runtime, request.context, commandService.renderNodeTargets({ source: "slack", contextKey: request.contextKey, argument: "", preferencesStore, canUsePeer: (peerId) => userStore.canUsePeer(request.authUser, peerId) })).then(() => {}) },
      { names: ["target"], handler: async (request, argument) => {
        await deliverChannelAction(runtime, request.context, commandService.renderTargetPreference({ source: "slack", contextKey: request.contextKey, argument, preferencesStore, canUsePeer: (peerId) => userStore.canUsePeer(request.authUser, peerId) }));
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

  const handleCommand = async (request: SlackRequest, command: string, argument: string): Promise<void> => {
    const normalized = command.toLowerCase();
    const permission = requiredPermissionForSlackCommand(normalized, argument);
    if (!await authenticate(request, permission, normalized)) return;
    audit(request, { action: "command", status: "ok", description: `/${normalized} ${argument}`.trim() });

    const result = await commandDispatcher.dispatch(request, normalized, argument);
    if (!result.matched) {
      await reply(request, `Unknown command: /${normalized}`);
    }
  };

  const commandHelp = async (request: SlackRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    await reply(request, [
      "NordRelay Slack adapter is ready.",
      "",
      "Send a message, mention the app, or use the configured Slash command.",
      "",
      `Core commands: ${slackHelpCommandList()}.`,
      "",
      renderSessionInfoPlain(session.getInfo()),
    ].join("\n"));
  };

  const commandAgent = async (request: SlackRequest, argument: string): Promise<void> => {
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
    await reply(request, "Select agent:", { buttons: choices.map((id, index) => [{ label: agentLabel(id), action: `slack_pick:${pickId}:${index}` }]) });
  };

  const commandAuth = async (request: SlackRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const info = session.getInfo();
    if (!capabilitiesOf(info).auth) {
      await deliverChannelAction(runtime, request.context, commandService.renderHostAuthInstruction(info.agentLabel, hostLoginCommand(info), "login"));
      return;
    }
    const status = await checkAgentAuthStatus(info);
    await deliverChannelAction(runtime, request.context, commandService.renderAuthStatus({ label: info.agentLabel, authenticated: status.authenticated, method: status.method, detail: status.detail }));
  };

  const commandLogin = async (request: SlackRequest): Promise<void> => {
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

  const commandLogout = async (request: SlackRequest): Promise<void> => {
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

  const commandSession = async (request: SlackRequest): Promise<void> => {
    const remoteRendered = await renderTargetPeerSession({ contextKey: request.contextKey, preferencesStore, remoteClient, actor: actorFor(request), canUsePeer: (peerId) => userStore.canUsePeer(request.authUser, peerId) }).catch(async (error) => {
      await reply(request, `Remote session failed: ${friendlyErrorText(error)}`);
      return null;
    });
    if (remoteRendered) {
      await deliverChannelAction(runtime, request.context, remoteRendered);
      return;
    }
    const session = await getSession(request, { deferThreadStart: true });
    await reply(request, `Slack session:\n${renderSessionInfoPlain(session.getInfo({ includeUsage: true }))}`);
  };

  const commandSessions = async (request: SlackRequest, query: string): Promise<void> => {
    const remote = await listTargetPeerSessions({
      contextKey: request.contextKey, preferencesStore, remoteClient, actor: actorFor(request), canUsePeer: (peerId) => userStore.canUsePeer(request.authUser, peerId),
      query,
      limit: 50,
    }).catch(async (error) => {
      await reply(request, `Remote sessions failed: ${friendlyErrorText(error)}`);
      return null;
    });
    if (remote) {
      const records = remote.sessions.slice(0, 10);
      if (records.length === 0) {
        await reply(request, "No remote sessions found.");
        return;
      }
      const pickId = createPick("session", records.map((record) => remoteSessionChoiceValue(remote.peerId, record.id)));
      const heading = `Sessions on ${remote.peerLabel} · Agent: ${remote.agentLabel ?? remote.agentId ?? "-"}`;
      await reply(request, [`${heading}:`, ...records.map((record, index) => `${index + 1}. ${record.title || record.id}\n   ${record.id}\n   ${record.cwd || "-"}`)].join("\n"), {
        buttons: records.map((record, index) => [{ label: trimLine(record.title || record.id, 70), action: `slack_pick:${pickId}:${index}` }]),
      });
      return;
    }
    const session = await getSession(request, { deferThreadStart: true });
    const records = session.listAllSessions(50).filter((record) => !query.trim() || [record.id, record.title, record.cwd, record.firstUserMessage].some((value) => value?.toLowerCase().includes(query.toLowerCase()))).slice(0, 10);
    if (records.length === 0) {
      await reply(request, "No sessions found.");
      return;
    }
    const pickId = createPick("session", records.map((record) => record.id));
    const heading = `Sessions on Local node · Agent: ${session.getInfo().agentLabel}`;
    await reply(request, [`${heading}:`, ...records.map((record, index) => `${index + 1}. ${record.title || record.id}\n   ${record.id}\n   ${record.cwd || "-"}`)].join("\n"), {
      buttons: records.map((record, index) => [{ label: trimLine(record.title || record.id, 70), action: `slack_pick:${pickId}:${index}` }]),
    });
  };

  const commandNew = async (request: SlackRequest, workspace: string): Promise<void> => {
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

  const commandSwitch = async (request: SlackRequest, threadId: string): Promise<void> => {
    if (!threadId.trim()) {
      await reply(request, "Usage: `/switch <thread-id>`");
      return;
    }
    const remoteChoice = parseRemoteSessionChoice(threadId.trim());
    if (remoteChoice) {
      if (!userStore.canUsePeer(request.authUser, remoteChoice.peerId)) { await reply(request, "Access denied for peer target."); return; }
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
    const session = await getSession(request, { deferThreadStart: true });
    const info = await session.switchSession(threadId.trim());
    updateSession(request, session);
    appendActivity(request, { status: "info", type: "session_switch", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId });
    await reply(request, `Switched session.\n\n${renderSessionInfoPlain(info)}`);
  };

  const commandModel = async (request: SlackRequest, argument: string): Promise<void> => {
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
    await reply(request, "Select model:", { buttons: models.map((model, index) => [{ label: trimLine(model, 75), action: `slack_pick:${pickId}:${index}` }]) });
  };

  const commandReasoning = async (request: SlackRequest, argument: string): Promise<void> => {
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
    await reply(request, `Select ${agentReasoningLabel(session.getInfo().agentId)}:`, { buttons: options.map((value, index) => [{ label: value, action: `slack_pick:${pickId}:${index}` }]) });
  };

  const commandFast = async (request: SlackRequest, argument: string): Promise<void> => {
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

  const commandLaunch = async (request: SlackRequest, argument: string): Promise<void> => {
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
        await reply(request, [`Confirm launch profile: ${profile.label}`, `Behavior: ${profile.behavior}`, "", "WARNING: This profile uses danger-full-access.", `Run \`/launch ${profile.id} confirm${applyToCurrent ? " apply" : ""}\` to ${applyToCurrent ? "apply it to the current idle thread" : "enable it for new or reattached threads"} in this Slack context.`].join("\n"));
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
    await reply(request, "Select launch profile:\nUse `/launch <profile-id> apply` to apply a profile to the current idle thread.", { buttons: profiles.map((profile, index) => [{ label: trimLine(profile.label || profile.id, 75), action: `slack_pick:${pickId}:${index}` }]) });
  };

  const commandQueue = async (request: SlackRequest, argument: string): Promise<void> => {
    const [action, id] = argument.trim().split(/\s+/, 2);
    if (!action) {
      const queue = promptStore.list(request.contextKey);
      if (queue.length === 0) {
        await reply(request, promptStore.isPaused(request.contextKey) ? "Queue is paused and empty." : "Queue is empty.");
        return;
      }
      await deliverChannelAction(runtime, request.context, { ...renderQueueListAction(queue, promptStore.isPaused(request.contextKey)), buttons: queue.slice(0, 5).map((item) => [
        { label: `Run ${item.id}`, action: `slack_queue_run:${request.contextKey}:${item.id}` },
        { label: "Top", action: `slack_queue_top:${request.contextKey}:${item.id}` },
        { label: "Up", action: `slack_queue_up:${request.contextKey}:${item.id}` },
        { label: "Down", action: `slack_queue_down:${request.contextKey}:${item.id}` },
        { label: `Cancel ${item.id}`, action: `slack_queue_cancel:${request.contextKey}:${item.id}` },
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

  const commandAbort = async (request: SlackRequest): Promise<void> => {
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

  const commandRetry = async (request: SlackRequest): Promise<void> => {
    const cached = promptStore.getLastPrompt(request.contextKey);
    if (!cached) {
      await reply(request, "Nothing to retry. Send a message first.");
      return;
    }
    await handlePrompt(request, cached.input, cached.artifactOutDir, { attachments: cached.attachments });
  };

  const commandLast = async (request: SlackRequest, argument: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const result = getLastAgentMessageText(session, config, parseLastAgentMessageOptions(argument));
    await reply(request, result.text);
  };

  const commandTemplate = async (request: SlackRequest, argument: string): Promise<void> => {
    if (!argument.trim()) {
      await reply(request, "Usage: `/template <template-id> {\"variable\":\"value\"}`");
      return;
    }
    const { id, variables } = parseChannelWorkflowArgument(argument);
    await handlePrompt(request, channelTemplatePrompt(config, id, variables).prompt);
  };

  const commandWorkflow = async (request: SlackRequest, argument: string): Promise<void> => {
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

  const commandSync = async (request: SlackRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    if (!capabilitiesOf(session.getInfo()).externalActivity) {
      await reply(request, `${session.getInfo().agentLabel} has no external state watcher.`);
      return;
    }
    const result = session.syncFromAgentState({ reattach: true });
    if (result.changed) updateSession(request, session);
    await reply(request, `Sync complete: ${result.changedFields.join(", ") || "already current"}.`);
  };

  const commandProgress = async (request: SlackRequest): Promise<void> => {
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

  const commandActivity = async (request: SlackRequest, argument: string): Promise<void> => {
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

  const commandAudit = async (request: SlackRequest, argument: string): Promise<void> => {
    const limit = Math.max(1, Math.min(100, Number.parseInt(argument, 10) || 20));
    await deliverChannelAction(runtime, request.context, commandService.renderAudit(auditLog.list(limit)));
  };

  const commandDiagnostics = async (request: SlackRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const external = getExternalSnapshotForSession(session, config, { maxEvents: 3 });
    const rateLimit = getSlackRateLimitMetrics();
    const slackDiagnostics = await collectSlackDiagnostics({
      config,
      userStore,
      timeoutMs: 2_500,
      rateLimit,
    });
    await reply(request, [
      "Diagnostics:",
      `Context: ${request.contextKey}`,
      `Channel: ${request.teamId || "team"} / ${request.channelId}`,
      `Agent: ${session.getInfo().agentLabel}`,
      `Thread: ${session.getInfo().threadId || "-"}`,
      `Workspace: ${session.getInfo().workspace}`,
      `Queue: ${promptStore.list(request.contextKey).length}${promptStore.isPaused(request.contextKey) ? " paused" : ""}`,
      `External: ${external?.activity.active ? "active" : "idle"}`,
      `Slack rate limit: queued ${rateLimit.queued}, running ${rateLimit.running}, retries ${rateLimit.retries}`,
      "",
      "Slack readiness:",
      ...slackDiagnostics.checks.map((check) => `${check.status.toUpperCase()} ${check.label}: ${check.detail}`),
      ...slackDiagnostics.channelChecks.map((channel) => `${channel.status.toUpperCase()} channel ${channel.channelId}: ${channel.detail}`),
    ].join("\n"));
  };

  const commandUpdate = async (request: SlackRequest, argument: string): Promise<void> => {
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

  const commandLock = async (request: SlackRequest): Promise<void> => {
    const owner = actorFor(request);
    lockStore.set(request.contextKey, { userId: request.authUser?.user.id ?? request.userId, label: owner.label, channel: "slack", channelUserId: request.userId }, config.sessionLockTtlMs);
    await reply(request, `Session locked to ${owner.label}.`);
  };

  const commandRestart = async (request: SlackRequest): Promise<void> => {
    spawnConnectorRestart();
    appendActivity(request, {
      status: "info",
      type: "connector_restart_requested",
      workspace: config.workspace,
      detail: "Slack restart command",
    });
    await reply(request, "Restarting connector. Slack may disconnect briefly.");
  };

  const commandWorkspaces = async (request: SlackRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    await deliverChannelAction(runtime, request.context, commandService.renderWorkspaces(session.getInfo(), filterAllowedWorkspaces(session.listWorkspaces(), config)));
  };

  const commandPin = async (request: SlackRequest, argument: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const threadId = argument.trim() || session.getActiveThreadId();
    if (!threadId) {
      await reply(request, "No active thread to pin.");
      return;
    }
    const pinned = registry.pinThread(request.contextKey, threadId);
    await reply(request, `Pinned thread ${threadId}.\nPinned threads: ${pinned.length}`);
  };

  const commandUnpin = async (request: SlackRequest, argument: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const threadId = argument.trim() || session.getActiveThreadId();
    if (!threadId) {
      await reply(request, "No active thread to unpin.");
      return;
    }
    const pinned = registry.unpinThread(request.contextKey, threadId);
    await reply(request, `Unpinned thread ${threadId}.\nPinned threads: ${pinned.length}`);
  };

  const commandPinned = async (request: SlackRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const pinned = registry.listPinnedThreadIds(request.contextKey);
    const records = pinned.map((threadId) => session.getSessionRecord(threadId)).filter((record): record is NonNullable<ReturnType<AgentSessionService["getSessionRecord"]>> => Boolean(record));
    if (records.length === 0) {
      await reply(request, "No pinned threads.");
      return;
    }
    const pickId = createPick("session", records.map((record) => record.id));
    await reply(request, [`Pinned threads (${records.length}):`, ...records.map((record, index) => `${index + 1}. ${record.title || record.id}\n   ${record.id}\n   ${record.cwd || "-"}`)].join("\n"), {
      buttons: records.map((record, index) => [{ label: trimLine(record.title || record.id, 75), action: `slack_pick:${pickId}:${index}` }]),
    });
  };

  const commandHandback = async (request: SlackRequest): Promise<void> => {
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

  const commandMirror = async (request: SlackRequest, argument: string): Promise<void> => {
    const remoteResponse = await renderTargetPeerMirrorPreference({
      source: "slack",
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
    await deliverChannelAction(runtime, request.context, commandService.renderMirrorPreference({ source: "slack", contextKey: request.contextKey, argument, preferencesStore, cliMirrorSupported: capabilitiesOf(info).cliMirror, agentLabel: info.agentLabel }));
  };

  const commandNotify = async (request: SlackRequest, argument: string): Promise<void> => {
    await deliverChannelAction(runtime, request.context, commandService.renderNotifyPreference({ source: "slack", contextKey: request.contextKey, argument, preferencesStore }));
  };

  const commandVoice = async (request: SlackRequest, argument: string): Promise<void> => {
    await deliverChannelAction(runtime, request.context, await commandService.renderVoicePreference({ source: "slack", contextKey: request.contextKey, argument, preferencesStore }));
  };

  const commandRegisterChannel = async (request: SlackRequest): Promise<void> => {
    const channel = userStore.registerSlackChannel({ teamId: request.teamId, channelId: request.channelId, title: request.channelName, type: request.isDirectMessage ? "dm" : "channel", enabled: true });
    audit(request, { action: "slack_channel_updated", status: "ok", description: channel.channelId });
    await reply(request, `Slack channel registered: ${channel.title || channel.channelId}`);
  };

  const commandLink = async (request: SlackRequest, code: string): Promise<void> => {
    if (!userStore.hasAdminUser()) {
      await reply(request, "NordRelay has no admin user yet. Run `nordrelay user create-admin` on the host.", { ephemeral: true });
      return;
    }
    try {
      const linked = userStore.consumeSlackLinkCode(code, { slackUserId: request.userId, teamId: request.teamId, username: request.username });
      request.authUser = linked;
      audit(request, { action: "slack_linked", status: "ok", description: request.userId });
      await reply(request, `Linked Slack account to ${linked.user.email}.`, { ephemeral: true });
    } catch (error) {
      await reply(request, `Link failed: ${friendlyErrorText(error)}`, { ephemeral: true });
    }
  };

  const handleAttachments = async (request: SlackRequest, files: SlackFile[], text: string): Promise<void> => {
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
      const downloadUrl = file.url_private_download || file.url_private;
      if (!downloadUrl) {
        await reply(request, `Skipped ${file.name || file.id}: no download URL.`);
        continue;
      }
      const response = await fetch(downloadUrl, { headers: { authorization: `Bearer ${config.slackBotToken}` } });
      if (!response.ok) {
        throw new Error(`Failed to download ${file.name || file.id}: ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = file.mimetype || inferChannelMimeType(file.name || "attachment");
      const staged = await stageFile(buffer, file.name || `slack-${file.id}`, mimeType, { workspace, turnId, maxFileSize: config.maxFileSize });
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

  const handleMessage = async (event: SlackMessageEvent): Promise<void> => {
    if (event.bot_id || event.subtype === "bot_message") return;
    const request = slackRequestFromMessage(event);
    const text = stripSlackMention(event.text ?? "").trim();
    const parsed = parseSlackMessageCommand(text);
    if (parsed) {
      await handleCommand(request, parsed.command, parsed.argument);
      return;
    }
    if (!config.slackMessageContentEnabled && !(event.files?.length)) {
      return;
    }
    const permission = event.files?.length ? "files.write" : "prompt.send";
    if (!await authenticate(request, permission)) return;
    if (event.files?.length) {
      await handleAttachments(request, event.files, text);
      return;
    }
    if (text) {
      await handlePrompt(request, text);
    }
  };

  const handleSlashCommand = async (payload: SlackSlashCommandPayload, respond?: (message: unknown) => Promise<unknown>): Promise<void> => {
    const request = slackRequestFromSlashCommand(payload, respond);
    const parsed = parseSlackSlashCommand(payload.text ?? "");
    await handleCommand(request, parsed.command, parsed.argument);
  };

  const handleButtonAction = async (request: SlackRequest, action: string): Promise<void> => {
    const nodeTargetMatch = action.match(/^node_target:(local|peer:.+)$/);
    if (nodeTargetMatch?.[1]) {
      await deliverChannelAction(runtime, request.context, commandService.renderNodeTargetAction({
        source: "slack",
        contextKey: request.contextKey,
        argument: "",
        preferencesStore,
        action: `node_target:${nodeTargetMatch[1]}`,
        canUsePeer: (peerId) => userStore.canUsePeer(request.authUser, peerId),
      }));
      peerMirrorController.sync(request.contextKey, request.context);
      return;
    }
    const pickMatch = action.match(/^slack_pick:([^:]+):(\d+)$/);
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
    const queueMatch = action.match(/^slack_queue_(run|cancel|top|up|down):(.+):([^:]+)$/);
    if (queueMatch?.[1] && queueMatch[2] === request.contextKey) {
      await commandQueue(request, `${queueMatch[1]} ${queueMatch[3]}`);
      return;
    }
    const peerQueueMatch = action.match(/^slack_peer_queue_cancel:([^:]+):([^:]+)$/);
    if (peerQueueMatch?.[1] && peerQueueMatch[2]) {
      if (!userStore.canUsePeer(request.authUser, peerQueueMatch[1])) {
        await reply(request, "Access denied for peer target.", { ephemeral: true });
        return;
      }
      await remoteClient.webProxy(peerQueueMatch[1], { method: "POST", path: "/api/queue", body: { action: "cancel", id: peerQueueMatch[2] }, contextKey: request.contextKey }, actorFor(request), request.contextKey);
      await reply(request, `Cancelled remote queued prompt ${peerQueueMatch[2]}.`, { ephemeral: true });
      return;
    }
    const artifactMatch = action.match(/^slack_artifact_(send|zip|delete):(.+):([^:]+)$/);
    if (artifactMatch?.[1] && artifactMatch[2] === request.contextKey) {
      await commandArtifacts(request, `${artifactMatch[1]} ${artifactMatch[3]}`);
      return;
    }
    const approvalMatch = action.match(/^slack_external_approval:(yes|persist|no):([a-f0-9]+)$/);
    if (approvalMatch?.[1] && approvalMatch[2]) {
      const session = registry.get(request.contextKey);
      if (!session) {
        await reply(request, "No session for this channel.", { ephemeral: true });
        return;
      }
      const result = await respondToExternalApproval(session, config, approvalMatch[2], approvalMatch[1] as "yes" | "persist" | "no");
      await reply(request, result.message, { ephemeral: !result.ok });
      const info = session.getInfo();
      activityStore.append({
        source: "slack",
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
    const abortMatch = action.match(/^slack_abort:(.+)$/);
    if (abortMatch?.[1] === request.contextKey) {
      await commandAbort(request);
    }
  };

  const createPick = (kind: PickState["kind"], values: string[]): string => {
    const id = randomUUID().replace(/-/g, "").slice(0, 10);
    picks.set(id, { kind, values });
    setTimeout(() => picks.delete(id), 10 * 60 * 1000).unref?.();
    return id;
  };

  const externalMonitor = createChannelExternalMonitorLoop({
    label: "Slack",
    intervalMs: config.codexExternalBusyCheckMs,
    run: () => monitorChannelExternalContexts({
      config,
      registry,
      promptStore,
      isContextKey: isSlackContextKey,
      canSendSystemMessages: (contextKey) => canSendSystemMessagesToSlackContext(userStore, contextKey),
      shouldMonitorContext: (contextKey) => (preferencesStore.get(contextKey).mirrorMode ?? config.slackMirrorMode) !== "off",
      isAllowed: (contextKey) => {
        const parsed = parseSlackContextKey(contextKey);
        return Boolean(parsed && isSlackTeamAllowed(config, parsed.teamId) && isSlackChannelAllowedByEnv(config, parsed.channelId));
      },
      contextForKey: slackContextForKey,
      previousLastLine: (contextKey) => externalMirrors.get(contextKey)?.lastLine,
      mirrorSnapshot: mirrorExternalSnapshot,
      updateQueueStatus: updateQueueStatusMessage,
      drainQueue: async (contextKey, context) => {
        const parsed = parseSlackContextKey(contextKey);
        if (!parsed) return;
        await drainQueue({ contextKey, context, userId: "system", channelId: parsed.channelId, teamId: parsed.teamId, isDirectMessage: false, source: "system" });
      },
    }),
  });

  (app as unknown as SlackBoltApp).event("message", async ({ event }) => {
    await handleMessage(event as SlackMessageEvent);
  });
  (app as unknown as SlackBoltApp).event("app_mention", async ({ event }) => {
    await handleMessage(event as SlackMessageEvent);
  });
  (app as unknown as SlackBoltApp).command(config.slackCommand, async ({ command, ack, respond }) => {
    await ack();
    await handleSlashCommand(command as SlackSlashCommandPayload, respond);
  });
  (app as unknown as SlackBoltApp).action(/^nr:/, async ({ action, body, ack, respond }) => {
    await ack();
    const actionId = String(action.action_id ?? "");
    const parsedAction = actionFromSlackActionId(actionId);
    if (!parsedAction) return;
    const request = slackRequestFromAction(body as SlackActionBody, respond);
    if (!await authenticate(request, permissionForSlackAction(parsedAction))) return;
    await handleButtonAction(request, parsedAction);
  });

  return {
    app,
    async start() {
      await (app as unknown as { start(port?: number): Promise<void> }).start(config.slackSocketMode ? undefined : config.slackPort);
      console.log(`Slack bot ready (${config.slackSocketMode ? "socket mode" : `port ${config.slackPort}`}).`);
      void collectSlackDiagnostics({
        config,
        userStore,
        timeoutMs: 3_500,
        rateLimit: getSlackRateLimitMetrics(),
      }).then((diagnostics) => {
        for (const check of diagnostics.checks.filter((item) => item.status === "warn" || item.status === "error")) {
          console.warn(`Slack ${check.status}: ${check.label}: ${check.detail}`);
        }
        for (const channel of diagnostics.channelChecks.filter((item) => item.status === "warn" || item.status === "error")) {
          console.warn(`Slack ${channel.status}: channel ${channel.channelId}: ${channel.detail}`);
        }
      }).catch((error) => console.warn("Slack diagnostics failed:", friendlyErrorText(error)));
      externalMonitor.start();
      peerMirrorController.startStoredContexts();
    },
    async stop() {
      externalMonitor.stop();
      peerMirrorController.closeAll();
      agentUpdates.cancelAll();
      await (app as unknown as { stop(): Promise<void> }).stop();
    },
  };
}
