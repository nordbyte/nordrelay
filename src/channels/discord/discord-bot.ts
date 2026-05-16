import { randomUUID } from "node:crypto";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type MessageComponentInteraction,
  type User,
} from "discord.js";

import { ADMIN_GROUP_ID, type Permission } from "../../access/access-control.js";
import { agentLabel, agentReasoningLabel, agentReasoningOptions, type AgentId, type AgentPromptInput, type AgentSessionInfo, type AgentSessionService } from "../../agents/shared/agent.js";
import { getAgentActivityLog, getExternalSnapshotForSession } from "../../agents/shared/agent-activity.js";
import { hostAgentLoginCommand, hostAgentLogoutCommand } from "../../agents/shared/agent-auth-commands.js";
import { listAgentAdapterDescriptors } from "../../agents/shared/agent-adapter.js";
import { AgentUpdateManager, type AgentUpdateOperation } from "../../agents/shared/agent-updates.js";
import { enabledAgents } from "../../agents/shared/agent-factory.js";
import { ensureOutDir } from "../../artifacts/artifacts.js";
import { buildFileInstructions, outboxPath, stageFile, type StagedFile } from "../../artifacts/attachments.js";
import { AuditLogStore } from "../../access/audit-log.js";
import { BotPreferencesStore } from "../../state/bot-preferences.js";
import { capabilitiesOf, filterActivityEvents, formatLocalDateTime, parseActivityOptions, renderPromptFailure, trimLine, type TurnProgress } from "../shared/bot-rendering.js";
import { renderAgentUpdateJobAction, renderAgentUpdateJobsAction, renderAgentUpdateLogAction, renderAgentUpdatePickerAction, renderQueueListAction } from "../shared/channel-actions.js";
import {
  createChannelActivityRecorder,
  createChannelAuditRecorder,
  createChannelBusyStore,
  createChannelPermissionChecker,
  createChannelQueueStatusController,
} from "../shared/channel-bridge-controller.js";
import type { ChannelBusyReason, ChannelBusyState, ChannelExternalMirrorState, ChannelPickState } from "../shared/channel-bridge-state.js";
import { createSharedChannelCommandDispatcher } from "../shared/channel-command-core.js";
import { ChannelCommandService } from "../shared/channel-command-service.js";
import { discordHelpCommandList } from "../shared/channel-command-catalog.js";
import { createChannelPromptEngine } from "../shared/channel-prompt-engine.js";
import { queueChannelPromptIfBusy } from "../shared/channel-prompt-queue.js";
import { runChannelPeerPrompt } from "../shared/channel-peer-prompt.js";
import { deliverChannelAction } from "../shared/channel-runtime.js";
import { deliverChannelCliArtifacts } from "../shared/channel-cli-artifacts.js";
import { createChannelExternalMirrorController } from "../shared/channel-external-mirror-controller.js";
import { monitorChannelExternalContexts } from "../shared/channel-external-monitor.js";
import type { ChannelContext } from "../shared/channel-adapter.js";
import type { LoginResult } from "../../agents/codex/codex-auth.js";
import type { ConnectorConfig } from "../../core/config.js";
import { discordContextKey, isDiscordContextKey, parseDiscordContextKey, type ChannelContextKey } from "../shared/context-key.js";
import { DiscordBotChannelRuntime, actionFromDiscordCustomId, discordActionRows, splitDiscordMessage, trimDiscordMessage } from "./discord-channel-runtime.js";
import { createDiscordArtifactCommandHandler, sendRecentDiscordArtifacts } from "./discord-artifacts.js";
import { argumentFromDiscordInteraction, discordCommands, isUnauthenticatedDiscordCommandAllowed, parseDiscordMessageCommand, permissionForDiscordAction, requiredPermissionForDiscordCommand } from "./discord-command-surface.js";
import { discordRateLimiter, getDiscordRateLimitMetrics } from "./discord-rate-limit.js";
import { friendlyErrorText } from "../../core/error-messages.js";
import { spawnConnectorRestart, spawnSelfUpdate } from "../../support/operations.js";
import { RemoteRelayClient } from "../../peers/peer-client.js";
import { PromptStore, toPromptEnvelope, type PromptEnvelope } from "../../state/prompt-store.js";
import { RelayArtifactService } from "../../runtime/relay-artifact-service.js";
import { RelayAuthService } from "../../runtime/relay-auth-service.js";
import { configureRedaction, redactText } from "../../core/redaction.js";
import { renderSessionInfoPlain } from "../shared/session-format.js";
import { canWriteWithLock, SessionLockStore } from "../../access/session-locks.js";
import { SessionRegistry } from "../../state/session-registry.js";
import { transcribeAudio, type TranscriptionBackend } from "../../artifacts/voice.js";
import { evaluateWorkspacePolicy, filterAllowedWorkspaces } from "../../core/workspace-policy.js";
import { UserStore, type AuthenticatedUser } from "../../access/user-management.js";
import { WebActivityStore, type WebActivityActor } from "../../web/web-state.js";

export { isUnauthenticatedDiscordCommandAllowed, permissionForDiscordAction, requiredPermissionForDiscordCommand } from "./discord-command-surface.js";

const EDIT_DEBOUNCE_MS = 1500;
const TYPING_INTERVAL_MS = 4500;
const MAX_SLASH_CHOICES = 25;
const MAX_ATTACHMENT_DOWNLOAD = 25 * 1024 * 1024;

interface DiscordBridge {
  client: Client;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface DiscordRequest {
  contextKey: ChannelContextKey;
  context: ChannelContext;
  user: User;
  username?: string;
  guildId?: string;
  channelId: string;
  channelName?: string;
  isDirectMessage: boolean;
  source: "message" | "interaction";
  message?: Message;
  interaction?: ChatInputCommandInteraction | MessageComponentInteraction;
  authUser?: AuthenticatedUser;
}

type BusyState = ChannelBusyState;
type BusyReason = ChannelBusyReason<{ agentLabel: string }>;

type PickState = ChannelPickState<"agent" | "session" | "model" | "reasoning" | "launch" | "queue" | "artifact" | "update">;

type DiscordExternalMirrorState = ChannelExternalMirrorState<string>;

export function createDiscordBridge(config: ConnectorConfig, registry: SessionRegistry): DiscordBridge | null {
  if (!config.discordEnabled) {
    return null;
  }
  if (!config.discordBotToken) {
    console.warn("Discord adapter disabled: DISCORD_ENABLED=true requires DISCORD_BOT_TOKEN.");
    return null;
  }

  configureRedaction(config.telegramRedactPatterns);

  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
  ];
  if (config.discordMessageContentEnabled) {
    intents.push(GatewayIntentBits.MessageContent);
  }

  const client = new Client({
    intents,
    partials: [Partials.Channel],
  });
  const runtime = new DiscordBotChannelRuntime(client);
  const promptStore = new PromptStore(config.workspace, config.stateBackend);
  const preferencesStore = new BotPreferencesStore(config.workspace, config.stateBackend);
  const activityStore = new WebActivityStore(config.workspace, config.stateBackend, config.auditMaxEvents);
  const auditLog = new AuditLogStore(config.workspace, config.stateBackend, config.auditMaxEvents);
  const lockStore = new SessionLockStore(config.workspace, config.stateBackend);
  const userStore = new UserStore();
  const artifactService = new RelayArtifactService(config);
  const authService = new RelayAuthService(config);
  const agentUpdates = new AgentUpdateManager();
  const commandService = new ChannelCommandService(config);
  const busyStates = createChannelBusyStore<ChannelContextKey>();
  const turnProgress = new Map<ChannelContextKey, TurnProgress>();
  const draining = new Set<ChannelContextKey>();
  const picks = new Map<string, PickState>();
  const responseOwners = new Map<string, ChannelContextKey>();
  const externalMirrors = new Map<ChannelContextKey, DiscordExternalMirrorState>();
  const queueStatusMessages = createChannelQueueStatusController<ChannelContextKey, string>({
    send: async (_contextKey, context, text) => (await runtime.sendMessage(context, { text, fallbackText: text })).messageId,
    edit: async (_contextKey, context, messageId, text) => {
      await runtime.editMessage(context, messageId, { text, fallbackText: text });
    },
  });
  let externalMonitor: NodeJS.Timeout | undefined;

  const getBusyState = (contextKey: ChannelContextKey): BusyState => busyStates.get(contextKey);

  const actorFor = (request: DiscordRequest): WebActivityActor => ({
    channel: "discord",
    id: request.authUser?.user.id ?? `discord:${request.user.id}`,
    label: request.authUser?.user.displayName || request.authUser?.user.email || request.user.globalName || request.user.username,
    username: request.authUser?.user.email ?? request.user.username,
    channelUserId: request.user.id,
  });

  const appendActivity = createChannelActivityRecorder<DiscordRequest>({
    source: "discord",
    workspace: config.workspace,
    activityStore,
    actorFor,
  });

  const audit = createChannelAuditRecorder<DiscordRequest>({
    channelId: "discord",
    auditLog,
    actorFor,
    actorIdFor: (request) => request.user.id,
  });

  const hasPermission = createChannelPermissionChecker<DiscordRequest>(userStore);

  const reply = async (
    request: DiscordRequest,
    content: string,
    options: { buttons?: Array<Array<{ label: string; action: string }>>; ephemeral?: boolean } = {},
  ): Promise<void> => {
    const chunks = splitDiscordMessage(content);
    if (request.interaction) {
      const interaction = request.interaction;
      const bucket = request.context.topicId ?? request.context.chatId;
      const first = trimDiscordMessage(chunks.shift() ?? ".");
      const payload = {
        content: first,
        components: discordActionRows(options.buttons),
        allowedMentions: { parse: [] as never[] },
        ephemeral: options.ephemeral,
      };
      if (interaction.replied || interaction.deferred) {
        await discordRateLimiter.run(bucket, "sendMessage", () => interaction.followUp(payload))
          .catch(() => runtime.sendMessage(request.context, { text: first, fallbackText: first, buttons: options.buttons }));
      } else {
        await discordRateLimiter.run(bucket, "sendMessage", () => interaction.reply(payload));
      }
      for (const chunk of chunks) {
        await discordRateLimiter.run(bucket, "sendMessage", () => interaction.followUp({ content: chunk, allowedMentions: { parse: [] } }))
          .catch(() => runtime.sendMessage(request.context, { text: chunk, fallbackText: chunk }));
      }
      return;
    }
    const first = chunks.shift() ?? ".";
    await runtime.sendMessage(request.context, { text: first, fallbackText: first, buttons: options.buttons });
    for (const chunk of chunks) {
      await runtime.sendMessage(request.context, { text: chunk, fallbackText: chunk });
    }
  };

  const authenticate = async (request: DiscordRequest, permission: Permission | null, commandName?: string): Promise<boolean> => {
    if (commandName && isUnauthenticatedDiscordCommandAllowed(commandName)) {
      return true;
    }

    if (!userStore.hasAdminUser()) {
      await reply(request, "NordRelay has no admin user yet. Run `nordrelay user create-admin` on the host.", { ephemeral: true });
      return false;
    }

    const authUser = userStore.resolveDiscordUser(request.user.id);
    if (!authUser) {
      audit(request, {
        action: "permission_denied",
        status: "denied",
        description: "Discord account is not linked",
      });
      if (request.isDirectMessage) {
        await reply(request, "Unauthorized. Link this Discord account to a NordRelay user first.", { ephemeral: true });
      }
      return false;
    }
    request.authUser = authUser;

    if (!isDiscordGuildAllowed(request.guildId) || !isDiscordChannelAllowedByEnv(request.channelId)) {
      audit(request, {
        action: "permission_denied",
        status: "denied",
        description: "Discord guild or channel is outside configured allow-list",
      });
      await reply(request, "This Discord guild or channel is not allowed for NordRelay.", { ephemeral: true });
      return false;
    }

    const chatAllowed = userStore.isDiscordChannelAllowed({
      guildId: request.guildId,
      channelId: request.channelId,
      isDirectMessage: request.isDirectMessage,
    }, authUser);
    if (!chatAllowed && commandName !== "register_channel") {
      audit(request, {
        action: "permission_denied",
        status: "denied",
        description: "Discord channel is not enabled or outside user scope",
      });
      if (request.isDirectMessage) {
        await reply(request, "This Discord channel is not enabled for NordRelay. An admin can use `/register_channel` in the channel.", { ephemeral: true });
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

  const getSession = async (request: DiscordRequest, options?: { deferThreadStart?: boolean }): Promise<AgentSessionService> =>
    registry.getOrCreate(request.contextKey, options);

  const updateSession = (request: DiscordRequest, session: AgentSessionService): void => {
    registry.updateMetadata(request.contextKey, session);
  };

  const artifactDeps = {
    config,
    runtime,
    artifactService,
    getSession,
    reply,
    appendActivity,
  };
  const commandArtifacts = createDiscordArtifactCommandHandler<DiscordRequest>(artifactDeps);

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

  const updateQueueStatusMessage = async (
    contextKey: ChannelContextKey,
    context: ChannelContext,
    text: string,
  ): Promise<void> => {
    await queueStatusMessages.update(contextKey, context, text);
  };

  const ensureActiveThread = async (request: DiscordRequest, session: AgentSessionService): Promise<void> => {
    if (!session.hasActiveThread()) {
      await session.newThread();
      updateSession(request, session);
    }
  };

  const checkAgentAuthStatus = (info: AgentSessionInfo) => authService.check(info);

  const checkLoginAuthStatus = (info: AgentSessionInfo) => authService.check(info);

  const startAgentLogin = (info: AgentSessionInfo): Promise<LoginResult> => authService.startLogin(info);

  const startAgentLogout = (info: AgentSessionInfo): Promise<LoginResult> => authService.startLogout(info);

  const hostLoginCommand = (info: AgentSessionInfo): string => {
    return hostAgentLoginCommand(config, info);
  };

  const hostLogoutCommand = (info: AgentSessionInfo): string => {
    return hostAgentLogoutCommand(config, info);
  };

  const denyIfLocked = async (request: DiscordRequest): Promise<boolean> => {
    const lock = lockStore.get(request.contextKey);
    const isAdmin = request.authUser?.groups.some((group) => group.id === ADMIN_GROUP_ID) ?? false;
    if (canWriteWithLock(lock, request.authUser?.user.id, isAdmin)) {
      return false;
    }
    await reply(request, `Session is locked by ${lock?.ownerLabel || lock?.ownerUserId || "another user"}.`);
    return true;
  };

  const remoteClient = new RemoteRelayClient();

  const handleRemotePrompt = async (request: DiscordRequest, envelope: PromptEnvelope): Promise<boolean> => {
    const targetPeerId = preferencesStore.get(request.contextKey).targetPeerId ?? undefined;
    return runChannelPeerPrompt<string>({
      targetPeerId,
      contextKey: request.contextKey,
      prompt: envelope,
      remoteClient,
      editMinIntervalMs: EDIT_DEBOUNCE_MS,
      typingIntervalMs: TYPING_INTERVAL_MS,
      sendTyping: () => runtime.sendTyping(request.context),
      sendResponse: async (text) => {
        const rendered = trimDiscordMessage(text);
        const sent = await runtime.sendMessage(request.context, { text: rendered, fallbackText: rendered });
        return sent.messageId;
      },
      editResponse: async (messageId, text) => {
        const rendered = trimDiscordMessage(text);
        await runtime.editMessage(request.context, messageId, { text: rendered, fallbackText: rendered });
      },
      sendTurnStart: (remotePrompt) => reply(request, `Remote peer working on:\n${remotePrompt}`),
      sendToolStart: (toolName) => reply(request, `Remote tool: ${toolName}`),
      sendQueued: async (queueId) => {
        await reply(request, `Remote prompt queued${queueId ? `: ${queueId}` : ""}.`, queueId ? {
          buttons: [[{ label: "Cancel queued message", action: `discord_peer_queue_cancel:${targetPeerId}:${queueId}` }]],
        } : undefined);
      },
      sendCompleted: () => reply(request, "Remote turn completed."),
      sendFailure: (message) => reply(request, `Remote peer failed: ${message}`),
    });
  };

  const handlePrompt = async (request: DiscordRequest, input: AgentPromptInput, artifactOutDir?: string, options: { fromQueue?: boolean } = {}): Promise<void> => {
    const session = await getSession(request);
    const envelope = toPromptEnvelope(input, artifactOutDir);
    envelope.activityActor = actorFor(request);

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
      actionPrefix: "discord",
      reply,
      appendActivity,
      audit,
    })) {
      return;
    }

    const busyState = getBusyState(request.contextKey);
    busyState.processing = true;
    const engine = createChannelPromptEngine({
      runtime,
      context: request.context,
      contextKey: request.contextKey,
      promptDescription: envelope.description,
      abortAction: `discord_abort:${request.contextKey}`,
      trimMessage: trimDiscordMessage,
      splitMessage: splitDiscordMessage,
      editDebounceMs: EDIT_DEBOUNCE_MS,
      typingIntervalMs: TYPING_INTERVAL_MS,
      toolVerbosity: config.toolVerbosity,
      logPrefix: "Discord",
      onResponseMessage: (messageId) => responseOwners.set(messageId, request.contextKey),
      onToolStart: (toolName) => appendActivity(request, {
        status: "running",
        type: "tool_started",
        prompt: envelope.description,
        detail: toolName,
        threadId: session.getInfo().threadId,
        workspace: session.getInfo().workspace,
        agentId: session.getInfo().agentId,
      }),
      onToolEnd: (isError) => appendActivity(request, {
        status: isError ? "failed" : "completed",
        type: isError ? "tool_failed" : "tool_completed",
        prompt: envelope.description,
        detail: "tool",
        threadId: session.getInfo().threadId,
        workspace: session.getInfo().workspace,
        agentId: session.getInfo().agentId,
      }),
    });
    const progress = engine.progress;
    turnProgress.set(request.contextKey, progress);
    engine.start();

    try {
      const info = session.getInfo();
      if ((info.capabilities ?? capabilitiesOf(info)).auth) {
        const auth = await checkAgentAuthStatus(info);
        if (!auth.authenticated) {
          throw new Error(`${agentLabel(info.agentId)} is not authenticated: ${auth.detail}`);
        }
      }
      await ensureActiveThread(request, session);
      const currentInfo = session.getInfo();
      const workspacePolicy = evaluateWorkspacePolicy(currentInfo.workspace, config);
      if (!workspacePolicy.allowed) {
        throw new Error(workspacePolicy.warning ?? "Current workspace is blocked by policy.");
      }

      promptStore.setLastPrompt(request.contextKey, envelope);
      appendActivity(request, {
        status: "running",
        type: "prompt_started",
        prompt: envelope.description,
        threadId: currentInfo.threadId,
        workspace: currentInfo.workspace,
        agentId: currentInfo.agentId,
      });
      audit(request, {
        action: "prompt_started",
        status: "ok",
        agentId: currentInfo.agentId,
        threadId: currentInfo.threadId,
        workspace: currentInfo.workspace,
        description: envelope.description,
      });

      await session.prompt(envelope.input, engine.callbacks);
      updateSession(request, session);
      progress.status = "completed";
      progress.completedAt = Date.now();
      progress.updatedAt = progress.completedAt;
      await engine.finalize();
      await artifactService.persistWorkspaceArtifactsForTurn(session.getInfo().workspace, engine.turnId, new Date(engine.startedAt));
      if (config.discordAutoSendArtifacts) {
        await sendRecentDiscordArtifacts(artifactDeps, request, session, new Date(engine.startedAt), engine.turnId);
      }
      appendActivity(request, {
        status: "completed",
        type: "prompt_completed",
        prompt: envelope.description,
        threadId: session.getInfo().threadId,
        workspace: session.getInfo().workspace,
        agentId: session.getInfo().agentId,
        durationMs: Date.now() - engine.startedAt,
      });
      audit(request, {
        action: "prompt_completed",
        status: "ok",
        agentId: session.getInfo().agentId,
        threadId: session.getInfo().threadId,
        workspace: session.getInfo().workspace,
        description: envelope.description,
      });
    } catch (error) {
      progress.status = "failed";
      progress.completedAt = Date.now();
      progress.updatedAt = progress.completedAt;
      progress.error = friendlyErrorText(error);
      const errorText = renderPromptFailure(engine.accumulatedText(), error);
      await engine.fail(errorText);
      appendActivity(request, {
        status: "failed",
        type: "prompt_failed",
        prompt: envelope.description,
        detail: friendlyErrorText(error),
        threadId: session.getInfo().threadId,
        workspace: session.getInfo().workspace,
        agentId: session.getInfo().agentId,
        durationMs: Date.now() - engine.startedAt,
      });
      audit(request, {
        action: "prompt_failed",
        status: "failed",
        agentId: session.getInfo().agentId,
        threadId: session.getInfo().threadId,
        workspace: session.getInfo().workspace,
        description: envelope.description,
        detail: friendlyErrorText(error),
      });
    } finally {
      engine.stop();
      busyState.processing = false;
      await drainQueue(request).catch((error) => console.error("Failed to drain Discord queue:", error));
    }
  };

  const drainQueue = async (request: DiscordRequest): Promise<void> => {
    if (draining.has(request.contextKey)) return;
    draining.add(request.contextKey);
    try {
      while (true) {
        const session = await getSession(request, { deferThreadStart: true });
        if (session.isProcessing() || getBusyReason(request.contextKey).busy) return;
        const next = promptStore.dequeue(request.contextKey);
        if (!next) return;
        await reply(request, `Processing queued prompt ${next.id}: ${next.description}`);
        await handlePrompt(request, next.input, next.artifactOutDir, { fromQueue: true });
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
      autoSend: config.discordAutoSendArtifacts,
      sendSummaryWhenAutoSendDisabled: true,
      logPrefix: "Discord",
      sendSummary: (summary) => runtime.sendMessage(context, { text: summary, fallbackText: summary }).then(() => {}),
      sendArtifact: (artifact) => runtime.sendFile(context, { localPath: artifact.localPath, name: artifact.name }).then(() => {}).catch((error) => {
        console.error(`Failed to send Discord CLI artifact ${artifact.name}:`, error);
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
    minUpdateMs: () => config.discordMirrorMinUpdateMs,
    mirrorMode: (contextKey) => preferencesStore.get(contextKey).mirrorMode ?? config.discordMirrorMode,
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
      const text = prompt ? `**Working on** ${prompt}` : `**Working on** external ${snapshot.agentLabel} task...`;
      await runtime.sendMessage(context, {
        text,
        fallbackText: prompt ? `Working on ${prompt}` : `Working on external ${snapshot.agentLabel} task...`,
      });
      state.workingNoticeTurnKey = turnKey;
    },
    sendStatus: async (_contextKey, context, _state, rendered) => {
      const sent = await runtime.sendMessage(context, { text: rendered.html, fallbackText: rendered.plain, parseMode: "html" });
      return sent.messageId;
    },
    editStatus: (_contextKey, context, _state, messageId, rendered) =>
      runtime.editMessage(context, messageId, { text: rendered.html, fallbackText: rendered.plain, parseMode: "html" }),
    sendEvent: (_contextKey, context, _state, rendered) => deliverChannelAction(runtime, context, rendered).then(() => {}),
    sendDone: (_contextKey, context, state, text) => {
      if (state.statusMessageId) {
        return runtime.editMessage(context, state.statusMessageId, { text, fallbackText: text });
      }
      return runtime.sendMessage(context, { text, fallbackText: text }).then(() => {});
    },
    sendFinalAnswer: async (_contextKey, context, _state, snapshot, text) => {
      await runtime.sendMessage(context, {
        text: `**${snapshot.agentLabel} CLI final answer:**`,
        fallbackText: `${snapshot.agentLabel} CLI final answer:`,
      });
      for (const chunk of splitDiscordMessage(text)) {
        await runtime.sendMessage(context, { text: chunk, fallbackText: chunk });
      }
    },
    deliverArtifacts: (contextKey, context, session, state, turnId) =>
      deliverCliGeneratedArtifacts(contextKey, context, session, state.startedAt, turnId),
  });

  const mirrorExternalSnapshot = externalMirrorController.mirror;

  const commandDispatcher = createSharedChannelCommandDispatcher<DiscordRequest>({
    transport: "discord",
    bindings: [
      { names: ["start", "help"], handler: (request) => commandHelp(request) },
      { names: ["channels"], handler: (request) => deliverChannelAction(runtime, request.context, commandService.renderChannels()).then(() => {}) },
      { names: ["peers"], handler: (request) => deliverChannelAction(runtime, request.context, commandService.renderPeers()).then(() => {}) },
      { names: ["target"], handler: (request, argument) => deliverChannelAction(runtime, request.context, commandService.renderTargetPreference({ source: "discord", contextKey: request.contextKey, argument, preferencesStore })).then(() => {}) },
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
      { names: ["sync"], handler: (request) => commandSync(request) },
      { names: ["tasks", "progress"], handler: (request) => commandProgress(request) },
      { names: ["activity"], handler: (request, argument) => commandActivity(request, argument) },
      { names: ["audit"], handler: (request, argument) => commandAudit(request, argument) },
      { names: ["artifacts"], handler: (request, argument) => commandArtifacts(request, argument) },
      { names: ["logs"], handler: (request, argument) => commandLogs(request, argument) },
      { names: ["version", "health", "status"], handler: (request) => commandVersion(request) },
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
      { names: ["register_channel"], handler: (request) => commandRegisterChannel(request) },
      { names: ["link"], handler: (request, argument) => commandLink(request, argument) },
      { names: ["whoami"], handler: (request) => reply(request, request.authUser ? `${request.authUser.user.displayName} <${request.authUser.user.email}>\nGroups: ${request.authUser.groups.map((group) => group.name).join(", ")}` : "Not linked.") },
      { names: ["prompt"], handler: (request, argument) => handlePrompt(request, argument) },
    ],
  });

  const handleCommand = async (request: DiscordRequest, command: string, argument: string): Promise<void> => {
    const normalized = command.toLowerCase();
    const permission = requiredPermissionForDiscordCommand(normalized, argument);
    if (!await authenticate(request, permission, normalized)) {
      return;
    }

    audit(request, { action: "command", status: "ok", description: `/${normalized} ${argument}`.trim() });

    const result = await commandDispatcher.dispatch(request, normalized, argument);
    if (!result.matched) {
      await reply(request, `Unknown command: /${normalized}`);
    }
  };

  const commandHelp = async (request: DiscordRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    await reply(request, [
      "NordRelay Discord adapter is ready.",
      "",
      "Send a message to prompt the selected agent, or use slash commands.",
      "",
      `Core commands: ${discordHelpCommandList()}.`,
      "",
      renderSessionInfoPlain(session.getInfo()),
    ].join("\n"));
  };

  const commandAgent = async (request: DiscordRequest, argument: string): Promise<void> => {
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
    await reply(request, "Select agent:", {
      buttons: choices.map((id, index) => [{ label: agentLabel(id), action: `discord_pick:${pickId}:${index}` }]),
    });
  };

  const commandAuth = async (request: DiscordRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const info = session.getInfo();
    if (!capabilitiesOf(info).auth) {
      await deliverChannelAction(runtime, request.context, commandService.renderHostAuthInstruction(info.agentLabel, hostLoginCommand(info), "login"));
      return;
    }
    const status = await checkAgentAuthStatus(info);
    await deliverChannelAction(runtime, request.context, commandService.renderAuthStatus({
      label: info.agentLabel,
      authenticated: status.authenticated,
      method: status.method,
      detail: status.detail,
    }));
  };

  const commandLogin = async (request: DiscordRequest): Promise<void> => {
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
    appendActivity(request, {
      status: result.success ? "info" : "failed",
      type: result.success ? "login_started" : "login_failed",
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      detail: redactText(result.message),
    });
    await deliverChannelAction(runtime, request.context, commandService.renderAuthActionResult("login", {
      ...result,
      message: redactText(result.message),
    }));
  };

  const commandLogout = async (request: DiscordRequest): Promise<void> => {
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
    appendActivity(request, {
      status: result.success ? "info" : "failed",
      type: result.success ? "logout_completed" : "logout_failed",
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      detail: redactText(result.message),
    });
    await deliverChannelAction(runtime, request.context, commandService.renderAuthActionResult("logout", {
      ...result,
      message: redactText(result.message),
    }));
  };

  const commandSession = async (request: DiscordRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    await reply(request, `Discord session:\n${renderSessionInfoPlain(session.getInfo())}`);
  };

  const commandSessions = async (request: DiscordRequest, query: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const records = session.listAllSessions(50).filter((record) => !query.trim() || [record.id, record.title, record.cwd, record.firstUserMessage].some((value) => value?.toLowerCase().includes(query.toLowerCase()))).slice(0, 10);
    if (records.length === 0) {
      await reply(request, "No sessions found.");
      return;
    }
    const pickId = createPick("session", records.map((record) => record.id));
    await reply(request, [
      "Sessions:",
      ...records.map((record, index) => `${index + 1}. ${record.title || record.id}\n   ${record.id}\n   ${record.cwd || "-"}`),
    ].join("\n"), {
      buttons: records.map((record, index) => [{ label: trimLine(record.title || record.id, 70), action: `discord_pick:${pickId}:${index}` }]),
    });
  };

  const commandNew = async (request: DiscordRequest, workspace: string): Promise<void> => {
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
    const info = await session.newThread(workspaceValue);
    updateSession(request, session);
    appendActivity(request, { status: "info", type: "session_new", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId, detail: info.workspace });
    await reply(request, `New thread created.\n\n${renderSessionInfoPlain(info)}`);
  };

  const commandSwitch = async (request: DiscordRequest, threadId: string): Promise<void> => {
    if (!threadId.trim()) {
      await reply(request, "Usage: `/switch <thread-id>`");
      return;
    }
    const session = await getSession(request, { deferThreadStart: true });
    const info = await session.switchSession(threadId.trim());
    updateSession(request, session);
    appendActivity(request, { status: "info", type: "session_switch", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId });
    await reply(request, `Switched session.\n\n${renderSessionInfoPlain(info)}`);
  };

  const commandModel = async (request: DiscordRequest, argument: string): Promise<void> => {
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
    const models = session.listModels().map((model) => model.slug).slice(0, MAX_SLASH_CHOICES);
    const pickId = createPick("model", models);
    await reply(request, "Select model:", {
      buttons: models.map((model, index) => [{ label: trimLine(model, 80), action: `discord_pick:${pickId}:${index}` }]),
    });
  };

  const commandReasoning = async (request: DiscordRequest, argument: string): Promise<void> => {
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
    await reply(request, `Select ${agentReasoningLabel(session.getInfo().agentId)}:`, {
      buttons: options.map((value, index) => [{ label: value, action: `discord_pick:${pickId}:${index}` }]),
    });
  };

  const commandFast = async (request: DiscordRequest, argument: string): Promise<void> => {
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

  const commandLaunch = async (request: DiscordRequest, argument: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    if (!capabilitiesOf(session.getInfo()).launchProfiles) {
      await reply(request, `Launch profiles are not supported for ${session.getInfo().agentLabel}.`);
      return;
    }
    const parts = argument.trim().split(/\s+/).filter(Boolean);
    const requested = parts[0] ?? "";
    const confirmed = parts.slice(1).some((part) => part.toLowerCase() === "confirm");
    if (requested) {
      const profile = session.listLaunchProfiles().find((candidate) => candidate.id === requested);
      if (!profile) {
        await reply(request, `Unknown launch profile: ${requested}`);
        return;
      }
      if (profile.unsafe && !confirmed) {
        await reply(request, [
          `Confirm launch profile: ${profile.label}`,
          `Behavior: ${profile.behavior}`,
          "",
          "WARNING: This profile uses danger-full-access.",
          `Run \`/launch ${profile.id} confirm\` to enable it for new or reattached threads in this Discord context.`,
        ].join("\n"));
        return;
      }
      session.setLaunchProfile(profile.id);
      updateSession(request, session);
      await reply(request, `Launch profile set to ${profile.label}.\nBehavior: ${profile.behavior}`);
      return;
    }
    const profiles = session.listLaunchProfiles();
    const pickId = createPick("launch", profiles.map((profile) => profile.id));
    await reply(request, "Select launch profile:", {
      buttons: profiles.map((profile, index) => [{ label: trimLine(profile.label || profile.id, 80), action: `discord_pick:${pickId}:${index}` }]),
    });
  };

  const commandQueue = async (request: DiscordRequest, argument: string): Promise<void> => {
    const [action, id] = argument.trim().split(/\s+/, 2);
    if (!action) {
      const queue = promptStore.list(request.contextKey);
      if (queue.length === 0) {
        await reply(request, promptStore.isPaused(request.contextKey) ? "Queue is paused and empty." : "Queue is empty.");
        return;
      }
      await deliverChannelAction(runtime, request.context, {
        ...renderQueueListAction(queue, promptStore.isPaused(request.contextKey)),
        buttons: queue.slice(0, 5).map((item) => [
          { label: `Run ${item.id}`, action: `discord_queue_run:${request.contextKey}:${item.id}` },
          { label: "Top", action: `discord_queue_top:${request.contextKey}:${item.id}` },
          { label: "Up", action: `discord_queue_up:${request.contextKey}:${item.id}` },
          { label: "Down", action: `discord_queue_down:${request.contextKey}:${item.id}` },
          { label: `Cancel ${item.id}`, action: `discord_queue_cancel:${request.contextKey}:${item.id}` },
        ]),
      });
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
        await handlePrompt(request, item.input, item.artifactOutDir);
        return;
      }
    } else {
      await reply(request, "Usage: `/queue [pause|resume|clear|run <id>|cancel <id>|top <id>|up <id>|down <id>]`");
      return;
    }
    await reply(request, "Queue updated.");
  };

  const commandAbort = async (request: DiscordRequest): Promise<void> => {
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

  const commandRetry = async (request: DiscordRequest): Promise<void> => {
    const cached = promptStore.getLastPrompt(request.contextKey);
    if (!cached) {
      await reply(request, "Nothing to retry. Send a message first.");
      return;
    }
    await handlePrompt(request, cached.input, cached.artifactOutDir);
  };

  const commandSync = async (request: DiscordRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    if (!capabilitiesOf(session.getInfo()).externalActivity) {
      await reply(request, `${session.getInfo().agentLabel} has no external state watcher.`);
      return;
    }
    const result = session.syncFromAgentState({ reattach: true });
    if (result.changed) updateSession(request, session);
    await reply(request, `Sync complete: ${result.changedFields.join(", ") || "already current"}.`);
  };

  const commandProgress = async (request: DiscordRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const external = getExternalSnapshotForSession(session, config, { maxEvents: 0 });
    const state = getBusyState(request.contextKey);
    await deliverChannelAction(runtime, request.context, commandService.renderProgress(
      turnProgress.get(request.contextKey),
      promptStore.list(request.contextKey).length,
      {
        processing: state.processing || session.isProcessing(),
        switching: state.switching,
        transcribing: false,
        approving: false,
        external: Boolean(external?.activity.active),
      },
      session.getInfo(),
    ));
  };

  const commandActivity = async (request: DiscordRequest, argument: string): Promise<void> => {
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

  const commandAudit = async (request: DiscordRequest, argument: string): Promise<void> => {
    const limit = Math.max(1, Math.min(100, Number.parseInt(argument, 10) || 20));
    await deliverChannelAction(runtime, request.context, commandService.renderAudit(auditLog.list(limit)));
  };

  const commandLogs = async (request: DiscordRequest, argument: string): Promise<void> => {
    await deliverChannelAction(runtime, request.context, await commandService.renderLogs(argument));
  };

  const commandVersion = async (request: DiscordRequest): Promise<void> => {
    await deliverChannelAction(runtime, request.context, await commandService.renderVersion());
  };

  const commandDiagnostics = async (request: DiscordRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const external = getExternalSnapshotForSession(session, config, { maxEvents: 3 });
    const rateLimit = getDiscordRateLimitMetrics();
    await reply(request, [
      "Diagnostics:",
      `Context: ${request.contextKey}`,
      `Channel: ${request.guildId || "DM"} / ${request.channelId}`,
      `Agent: ${session.getInfo().agentLabel}`,
      `Thread: ${session.getInfo().threadId || "-"}`,
      `Workspace: ${session.getInfo().workspace}`,
      `Queue: ${promptStore.list(request.contextKey).length}${promptStore.isPaused(request.contextKey) ? " paused" : ""}`,
      `External: ${external?.activity.active ? "active" : "idle"}`,
      `Discord rate limit: queued ${rateLimit.queued}, running ${rateLimit.running}, retries ${rateLimit.retries}`,
    ].join("\n"));
  };

  const commandUpdate = async (request: DiscordRequest, argument: string): Promise<void> => {
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
      appendActivity(request, {
        status: "info",
        type: "agent_update_cancel_requested",
        workspace: config.workspace,
        detail: second,
      });
      return;
    }
    if (target === "input" && second) {
      const input = tokens.slice(2).join(" ");
      if (!input.trim()) {
        await reply(request, "Usage: `/update input <job-id> <text>`");
        return;
      }
      await deliverChannelAction(runtime, request.context, renderAgentUpdateJobAction(agentUpdates.sendInput(second, input)));
      appendActivity(request, {
        status: "info",
        type: "agent_update_input_sent",
        workspace: config.workspace,
        detail: second,
      });
      return;
    }
    const operation: AgentUpdateOperation = target === "install" ? "install" : "update";
    const agentId = (operation === "install" ? second : target) as AgentId;
    if (!enabledAgents(config).includes(agentId) && !listAgentAdapterDescriptors().some((descriptor) => descriptor.id === agentId)) {
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

  const commandLock = async (request: DiscordRequest): Promise<void> => {
    const actor = actorFor(request);
    lockStore.set(request.contextKey, {
      userId: request.authUser?.user.id ?? request.user.id,
      label: actor.label,
      channel: "discord",
      channelUserId: request.user.id,
    }, config.sessionLockTtlMs);
    await reply(request, "Session locked to you.");
  };

  const commandRestart = async (request: DiscordRequest): Promise<void> => {
    spawnConnectorRestart();
    appendActivity(request, {
      status: "info",
      type: "connector_restart_requested",
      workspace: config.workspace,
      detail: "Discord restart command",
    });
    await reply(request, "Restarting connector. Discord may disconnect briefly.");
  };

  const commandWorkspaces = async (request: DiscordRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const info = session.getInfo();
    if (!capabilitiesOf(info).workspaces) {
      await reply(request, `${info.agentLabel} workspace listing is not supported.`);
      return;
    }
    await deliverChannelAction(runtime, request.context, commandService.renderWorkspaces(
      info,
      filterAllowedWorkspaces(session.listWorkspaces(), config),
    ));
  };

  const commandPin = async (request: DiscordRequest, argument: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const threadId = argument.trim() || session.getActiveThreadId();
    if (!threadId) {
      await reply(request, "No active thread to pin. Use `/pin <thread-id>`.");
      return;
    }
    if (!session.getSessionRecord(threadId)) {
      await reply(request, `Unknown ${session.getInfo().agentLabel} session: ${threadId}`);
      return;
    }
    const pinned = registry.pinThread(request.contextKey, threadId);
    appendActivity(request, {
      status: "info",
      type: "session_pinned",
      threadId,
      workspace: session.getSessionRecord(threadId)?.cwd ?? session.getInfo().workspace,
      agentId: session.getInfo().agentId,
      detail: threadId,
    });
    await reply(request, `Pinned thread: ${threadId}\nTotal pinned: ${pinned.length}`);
  };

  const commandUnpin = async (request: DiscordRequest, argument: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const threadId = argument.trim() || session.getActiveThreadId();
    if (!threadId) {
      await reply(request, "No active thread to unpin. Use `/unpin <thread-id>`.");
      return;
    }
    const pinned = registry.unpinThread(request.contextKey, threadId);
    appendActivity(request, {
      status: "info",
      type: "session_unpinned",
      threadId,
      workspace: session.getInfo().workspace,
      agentId: session.getInfo().agentId,
      detail: threadId,
    });
    await reply(request, `Unpinned thread: ${threadId}\nTotal pinned: ${pinned.length}`);
  };

  const commandPinned = async (request: DiscordRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const pinned = registry.listPinnedThreadIds(request.contextKey);
    const records = pinned
      .map((threadId) => session.getSessionRecord(threadId))
      .filter((record): record is NonNullable<ReturnType<AgentSessionService["getSessionRecord"]>> => Boolean(record));
    if (records.length === 0) {
      await reply(request, "No pinned threads.");
      return;
    }
    const pickId = createPick("session", records.map((record) => record.id));
    await reply(request, [
      `Pinned threads (${records.length}):`,
      ...records.map((record, index) => `${index + 1}. ${record.title || record.id}\n   ${record.id}\n   ${record.cwd || "-"}`),
    ].join("\n"), {
      buttons: records.map((record, index) => [{ label: trimLine(record.title || record.id, 70), action: `discord_pick:${pickId}:${index}` }]),
    });
  };

  const commandHandback = async (request: DiscordRequest): Promise<void> => {
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
    appendActivity(request, {
      status: "info",
      type: "handback",
      threadId: result.threadId,
      workspace: result.workspace,
      agentId: session.getInfo().agentId,
      detail: result.command ?? result.threadId ?? "handback",
    });
    await deliverChannelAction(runtime, request.context, commandService.renderHandback(result));
  };

  const commandMirror = async (request: DiscordRequest, argument: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const info = session.getInfo();
    await deliverChannelAction(runtime, request.context, commandService.renderMirrorPreference({
      source: "discord",
      contextKey: request.contextKey,
      argument,
      preferencesStore,
      cliMirrorSupported: capabilitiesOf(info).cliMirror,
      agentLabel: info.agentLabel,
    }));
  };

  const commandNotify = async (request: DiscordRequest, argument: string): Promise<void> => {
    await deliverChannelAction(runtime, request.context, commandService.renderNotifyPreference({
      source: "discord",
      contextKey: request.contextKey,
      argument,
      preferencesStore,
    }));
  };

  const commandVoice = async (request: DiscordRequest, argument: string): Promise<void> => {
    await deliverChannelAction(runtime, request.context, await commandService.renderVoicePreference({
      source: "discord",
      contextKey: request.contextKey,
      argument,
      preferencesStore,
    }));
  };

  const commandRegisterChannel = async (request: DiscordRequest): Promise<void> => {
    const channel = userStore.registerDiscordChannel({
      guildId: request.guildId,
      channelId: request.channelId,
      title: request.channelName,
      type: request.isDirectMessage ? "dm" : "guild",
      enabled: true,
    });
    audit(request, { action: "discord_channel_updated", status: "ok", description: channel.channelId });
    await reply(request, `Discord channel registered: ${channel.title || channel.channelId}`);
  };

  const commandLink = async (request: DiscordRequest, code: string): Promise<void> => {
    if (!userStore.hasAdminUser()) {
      await reply(request, "NordRelay has no admin user yet. Run `nordrelay user create-admin` on the host.", { ephemeral: true });
      return;
    }
    try {
      const linked = userStore.consumeDiscordLinkCode(code, {
        discordUserId: request.user.id,
        username: request.user.username,
        globalName: request.user.globalName ?? undefined,
      });
      request.authUser = linked;
      audit(request, { action: "discord_linked", status: "ok", description: request.user.id });
      await reply(request, `Linked Discord account to ${linked.user.email}.`, { ephemeral: true });
    } catch (error) {
      await reply(request, `Link failed: ${friendlyErrorText(error)}`, { ephemeral: true });
    }
  };

  const handleAttachments = async (request: DiscordRequest, message: Message, text: string): Promise<void> => {
    const session = await getSession(request);
    const workspace = session.getInfo().workspace;
    const turnId = randomUUID().slice(0, 12);
    const outDir = outboxPath(workspace, turnId);
    await ensureOutDir(outDir);
    const stagedFiles: StagedFile[] = [];
    const imagePaths: string[] = [];
    const transcripts: string[] = [];

    for (const attachment of message.attachments.values()) {
      if (attachment.size > Math.min(config.maxFileSize, MAX_ATTACHMENT_DOWNLOAD)) {
        await reply(request, `Skipped ${attachment.name || attachment.id}: file is too large.`);
        continue;
      }
      const response = await fetch(attachment.url);
      if (!response.ok) {
        throw new Error(`Failed to download ${attachment.name || attachment.id}: ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = attachment.contentType || inferMimeType(attachment.name || "attachment");
      const staged = await stageFile(buffer, attachment.name || `discord-${attachment.id}`, mimeType, {
        workspace,
        turnId,
        maxFileSize: config.maxFileSize,
      });
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
    await handlePrompt(request, prompt, outDir);
  };

  const handleMessage = async (message: Message): Promise<void> => {
    if (message.author.bot) return;
    const request = requestFromMessage(message);
    const text = message.content.trim();
    const parsed = parseDiscordMessageCommand(text);
    if (parsed) {
      if (config.discordCommandMode === "slash") return;
      await handleCommand(request, parsed.command, parsed.argument);
      return;
    }
    if (!config.discordMessageContentEnabled && message.attachments.size === 0) {
      return;
    }
    const permission = message.attachments.size > 0 ? "files.write" : "prompt.send";
    if (!await authenticate(request, permission)) return;
    if (message.attachments.size > 0) {
      await handleAttachments(request, message, text);
      return;
    }
    if (text) {
      await handlePrompt(request, text);
    }
  };

  const handleInteraction = async (interaction: Interaction): Promise<void> => {
    if (interaction.isChatInputCommand()) {
      if (config.discordCommandMode === "message") return;
      const request = requestFromInteraction(interaction);
      const argument = argumentFromDiscordInteraction(interaction);
      await handleCommand(request, interaction.commandName, argument);
      return;
    }

    if (!interaction.isButton()) {
      return;
    }
    const action = actionFromDiscordCustomId(interaction.customId);
    if (!action) return;
    const request = requestFromInteraction(interaction);
    if (!await authenticate(request, permissionForDiscordAction(action))) return;
    await handleButtonAction(request, action);
  };

  const handleButtonAction = async (request: DiscordRequest, action: string): Promise<void> => {
    if (request.interaction?.isButton()) {
      await request.interaction.deferUpdate().catch(() => {});
    }
    const pickMatch = action.match(/^discord_pick:([^:]+):(\d+)$/);
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
    const queueMatch = action.match(/^discord_queue_(run|cancel|top|up|down):(.+):([^:]+)$/);
    if (queueMatch?.[1] && queueMatch[2] === request.contextKey) {
      await commandQueue(request, `${queueMatch[1]} ${queueMatch[3]}`);
      return;
    }
    const peerQueueMatch = action.match(/^discord_peer_queue_cancel:([^:]+):([^:]+)$/);
    if (peerQueueMatch?.[1] && peerQueueMatch[2]) {
      await remoteClient.webProxy(peerQueueMatch[1], {
        method: "POST",
        path: "/api/queue",
        body: { action: "cancel", id: peerQueueMatch[2] },
        contextKey: request.contextKey,
      }, actorFor(request), request.contextKey);
      await reply(request, `Cancelled remote queued prompt ${peerQueueMatch[2]}.`, { ephemeral: true });
      return;
    }
    const artifactMatch = action.match(/^discord_artifact_(send|zip|delete):(.+):([^:]+)$/);
    if (artifactMatch?.[1] && artifactMatch[2] === request.contextKey) {
      await commandArtifacts(request, `${artifactMatch[1]} ${artifactMatch[3]}`);
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
    const abortMatch = action.match(/^discord_abort:(.+)$/);
    if (abortMatch?.[1] === request.contextKey) {
      await commandAbort(request);
      return;
    }
  };

  const createPick = (kind: PickState["kind"], values: string[]): string => {
    const id = randomUUID().replace(/-/g, "").slice(0, 10);
    picks.set(id, { kind, values });
    setTimeout(() => picks.delete(id), 10 * 60 * 1000).unref?.();
    return id;
  };

  const monitorExternalContexts = async (): Promise<void> => {
    await monitorChannelExternalContexts({
      config,
      registry,
      promptStore,
      isContextKey: isDiscordContextKey,
      canSendSystemMessages: (contextKey) => canSendSystemMessagesToDiscordContext(userStore, contextKey),
      isAllowed: (contextKey) => {
        const parsed = parseDiscordContextKey(contextKey);
        if (!parsed) return false;
        const guildId = parsed.guildId?.startsWith("dm-") ? undefined : parsed.guildId;
        return isDiscordGuildAllowed(guildId) && isDiscordChannelAllowedByEnv(parsed.channelId);
      },
      contextForKey: (contextKey) => {
        const parsed = parseDiscordContextKey(contextKey);
        if (!parsed) return null;
        return {
          channelId: "discord",
          chatId: parsed.threadId ?? parsed.channelId,
          ...(parsed.threadId ? { topicId: parsed.threadId } : {}),
        };
      },
      previousLastLine: (contextKey) => externalMirrors.get(contextKey)?.lastLine,
      mirrorSnapshot: mirrorExternalSnapshot,
      updateQueueStatus: updateQueueStatusMessage,
      drainQueue: async (contextKey, context) => {
        const parsed = parseDiscordContextKey(contextKey);
        if (!parsed) return;
        const systemRequest: DiscordRequest = {
          contextKey,
          context,
          user: { id: "system", username: "system", bot: true } as User,
          channelId: parsed.threadId ?? parsed.channelId,
          guildId: parsed.guildId,
          isDirectMessage: !parsed.guildId || parsed.guildId.startsWith("dm-"),
          source: "message",
        };
        await drainQueue(systemRequest);
      },
    });
  };

  const registerSlashCommands = async (): Promise<void> => {
    if (!config.discordClientId || !config.discordAutoRegisterCommands || config.discordCommandMode === "message" || !config.discordBotToken) {
      return;
    }
    const rest = new REST({ version: "10" }).setToken(config.discordBotToken);
    const commands = discordCommands();
    if (config.discordGuildIds.length > 0) {
      for (const guildId of config.discordGuildIds) {
        await rest.put(Routes.applicationGuildCommands(config.discordClientId, guildId), { body: commands });
      }
      console.log(`Discord slash commands registered for ${config.discordGuildIds.length} guild(s).`);
      return;
    }
    await rest.put(Routes.applicationCommands(config.discordClientId), { body: commands });
    console.log("Discord global slash commands registered.");
  };

  client.on(Events.MessageCreate, (message) => {
    void handleMessage(message).catch((error) => {
      console.error("Discord message handling failed:", error);
    });
  });
  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction).catch((error) => {
      console.error("Discord interaction handling failed:", error);
    });
  });
  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Discord bot ready as ${readyClient.user.tag}`);
    void registerSlashCommands().catch((error) => {
      console.error("Failed to register Discord slash commands:", error);
    });
  });

  return {
    client,
    async start() {
      await client.login(config.discordBotToken);
      externalMonitor = setInterval(() => {
        void monitorExternalContexts().catch((error) => console.error("Failed to monitor Discord external activity:", error));
      }, config.codexExternalBusyCheckMs);
      externalMonitor.unref?.();
    },
    async stop() {
      if (externalMonitor) clearInterval(externalMonitor);
      agentUpdates.cancelAll();
      await client.destroy();
    },
  };

  function requestFromMessage(message: Message): DiscordRequest {
    const threadId = message.channel.isThread() ? message.channel.id : undefined;
    const parentId = message.channel.isThread() ? message.channel.parentId ?? message.channel.id : message.channel.id;
    const channelName = "name" in message.channel && typeof message.channel.name === "string" ? message.channel.name : undefined;
    const guildKey = message.guildId ?? `dm-${message.author.id}`;
    return {
      contextKey: discordContextKey({ guildId: guildKey, channelId: parentId, threadId }),
      context: {
        channelId: "discord",
        chatId: threadId ?? parentId,
        ...(threadId ? { topicId: threadId } : {}),
        userId: message.author.id,
        username: message.author.username,
      },
      user: message.author,
      username: message.author.username,
      guildId: message.guildId ?? undefined,
      channelId: parentId,
      channelName,
      isDirectMessage: !message.guildId,
      source: "message",
      message,
    };
  }

  function requestFromInteraction(interaction: ChatInputCommandInteraction | MessageComponentInteraction): DiscordRequest {
    const channel = interaction.channel;
    const threadId = channel?.isThread() ? channel.id : undefined;
    const parentId = channel?.isThread() ? channel.parentId ?? channel.id : interaction.channelId;
    const channelName = channel && "name" in channel && typeof channel.name === "string" ? channel.name : undefined;
    const guildKey = interaction.guildId ?? `dm-${interaction.user.id}`;
    return {
      contextKey: discordContextKey({ guildId: guildKey, channelId: parentId, threadId }),
      context: {
        channelId: "discord",
        chatId: threadId ?? parentId,
        ...(threadId ? { topicId: threadId } : {}),
        userId: interaction.user.id,
        username: interaction.user.username,
      },
      user: interaction.user,
      username: interaction.user.username,
      guildId: interaction.guildId ?? undefined,
      channelId: parentId,
      channelName,
      isDirectMessage: !interaction.guildId,
      source: "interaction",
      interaction,
    };
  }

  function isDiscordGuildAllowed(guildId: string | undefined): boolean {
    return !guildId || config.discordAllowedGuildIds.length === 0 || config.discordAllowedGuildIds.includes(guildId);
  }

  function isDiscordChannelAllowedByEnv(channelId: string): boolean {
    return config.discordAllowedChannelIds.length === 0 || config.discordAllowedChannelIds.includes(channelId);
  }
}

export function canSendSystemMessagesToDiscordContext(userStore: UserStore, contextKey: ChannelContextKey): boolean {
  if (!userStore.hasAdminUser()) {
    return false;
  }
  const parsed = parseDiscordContextKey(contextKey);
  if (!parsed) {
    return false;
  }
  if (!parsed.guildId || parsed.guildId.startsWith("dm-")) {
    const userId = parsed.guildId?.startsWith("dm-") ? parsed.guildId.slice(3) : undefined;
    return Boolean(userId && userStore.resolveDiscordUser(userId));
  }
  return userStore.snapshot().discordChannels.some((channel) =>
    channel.enabled &&
    channel.channelId === parsed.channelId &&
    (channel.guildId ?? "") === (parsed.guildId ?? "")
  );
}

function inferMimeType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".webm")) return "audio/webm";
  return "application/octet-stream";
}
