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

import { ADMIN_GROUP_ID, type Permission } from "./access-control.js";
import { agentLabel, agentReasoningLabel, agentReasoningOptions, type AgentExternalSnapshot, type AgentId, type AgentPromptInput, type AgentSessionCallbacks, type AgentSessionInfo, type AgentSessionService } from "./agent.js";
import { getAgentActivityLog, getExternalSnapshotForSession } from "./agent-activity.js";
import { listAgentAdapterDescriptors } from "./agent-adapter.js";
import { AgentUpdateManager, type AgentUpdateOperation } from "./agent-updates.js";
import { enabledAgents } from "./agent-factory.js";
import { collectRecentWorkspaceArtifacts, ensureOutDir, formatArtifactSummary, persistWorkspaceArtifactReport } from "./artifacts.js";
import { buildFileInstructions, outboxPath, stageFile, type StagedFile } from "./attachments.js";
import { AuditLogStore, type AuditEvent } from "./audit-log.js";
import { BotPreferencesStore } from "./bot-preferences.js";
import { capabilitiesOf, filterActivityEvents, formatLocalDateTime, parseActivityOptions, renderExternalMirrorEvent, renderExternalMirrorStatus, renderPromptFailure, trimLine, type TurnProgress } from "./bot-rendering.js";
import { renderAgentUpdateJobAction, renderAgentUpdateJobsAction, renderAgentUpdateLogAction, renderAgentUpdatePickerAction, renderQueueListAction } from "./channel-actions.js";
import { ChannelCommandService } from "./channel-command-service.js";
import { discordHelpCommandList } from "./channel-command-catalog.js";
import { deliverChannelAction } from "./channel-runtime.js";
import type { ChannelContext } from "./channel-adapter.js";
import { checkAuthStatus, startLogin as startCodexLogin, startLogout as startCodexLogout, type LoginResult } from "./codex-auth.js";
import { checkClaudeCodeAuthStatus, startClaudeCodeLogin, startClaudeCodeLogout } from "./claude-code-auth.js";
import type { ConnectorConfig, ToolVerbosity } from "./config.js";
import { discordContextKey, isDiscordContextKey, parseDiscordContextKey, type ChannelContextKey } from "./context-key.js";
import { DiscordBotChannelRuntime, actionFromDiscordCustomId, discordActionRows, splitDiscordMessage, trimDiscordMessage } from "./discord-channel-runtime.js";
import { createDiscordArtifactCommandHandler, sendRecentDiscordArtifacts } from "./discord-artifacts.js";
import { argumentFromDiscordInteraction, discordCommands, isUnauthenticatedDiscordCommandAllowed, parseDiscordMessageCommand, permissionForDiscordAction, requiredPermissionForDiscordCommand } from "./discord-command-surface.js";
import { discordRateLimiter, getDiscordRateLimitMetrics } from "./discord-rate-limit.js";
import { friendlyErrorText } from "./error-messages.js";
import { checkHermesAuthStatus, startHermesLogin, startHermesLogout } from "./hermes-auth.js";
import { spawnConnectorRestart, spawnSelfUpdate } from "./operations.js";
import { checkOpenClawAuthStatus } from "./openclaw-auth.js";
import { RemoteRelayClient } from "./peer-client.js";
import { checkPiAuthStatus } from "./pi-auth.js";
import { peerPromptProxyPayload } from "./remote-prompt.js";
import { PromptStore, toPromptEnvelope, type QueuedPrompt } from "./prompt-store.js";
import { RelayArtifactService } from "./relay-artifact-service.js";
import { configureRedaction, redactText } from "./redaction.js";
import { renderSessionInfoPlain } from "./session-format.js";
import { canWriteWithLock, SessionLockStore } from "./session-locks.js";
import { SessionRegistry } from "./session-registry.js";
import { transcribeAudio, type TranscriptionBackend } from "./voice.js";
import { evaluateWorkspacePolicy, filterAllowedWorkspaces } from "./workspace-policy.js";
import { UserStore, type AuthenticatedUser } from "./user-management.js";
import { WebActivityStore, type WebActivityActor } from "./web-state.js";

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

type BusyState = { processing: boolean; switching: boolean };
type BusyReason =
  | { busy: false; kind: "idle" }
  | { busy: true; kind: "connector"; state: BusyState }
  | { busy: true; kind: "external"; agentLabel: string };

type PickState = {
  kind: "agent" | "session" | "model" | "reasoning" | "launch" | "queue" | "artifact" | "update";
  values: string[];
};

type DiscordExternalMirrorState = {
  threadId: string;
  rolloutPath: string;
  lastLine: number;
  lastTypingAt?: number;
  workingNoticeTurnKey?: string | null;
  statusMessageId?: string;
  turnId?: string | null;
  startedAt?: Date | null;
  latestStatus?: string;
  latestStatusAt?: number;
  latestAgentLine?: number;
  latestMirroredEventLine?: number;
  artifactsDeliveredForTurnId?: string | null;
  activityStartedTurnKey?: string;
  activityFinishedTurnKey?: string;
  activityToolStartLines?: number[];
  activityToolEndLines?: number[];
};

type DiscordQueueStatusState = {
  messageId?: string;
  lastText?: string;
};

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
  const agentUpdates = new AgentUpdateManager();
  const commandService = new ChannelCommandService(config);
  const busyStates = new Map<ChannelContextKey, BusyState>();
  const turnProgress = new Map<ChannelContextKey, TurnProgress>();
  const draining = new Set<ChannelContextKey>();
  const picks = new Map<string, PickState>();
  const responseOwners = new Map<string, ChannelContextKey>();
  const externalMirrors = new Map<ChannelContextKey, DiscordExternalMirrorState>();
  const queueStatusMessages = new Map<ChannelContextKey, DiscordQueueStatusState>();
  let externalMonitor: NodeJS.Timeout | undefined;

  const getBusyState = (contextKey: ChannelContextKey): BusyState => {
    let state = busyStates.get(contextKey);
    if (!state) {
      state = { processing: false, switching: false };
      busyStates.set(contextKey, state);
    }
    return state;
  };

  const actorFor = (request: DiscordRequest): WebActivityActor => ({
    channel: "discord",
    id: request.authUser?.user.id ?? `discord:${request.user.id}`,
    label: request.authUser?.user.displayName || request.authUser?.user.email || request.user.globalName || request.user.username,
    username: request.authUser?.user.email ?? request.user.username,
    channelUserId: request.user.id,
  });

  const appendActivity = (request: DiscordRequest, input: Omit<Parameters<WebActivityStore["append"]>[0], "source" | "threadId" | "workspace"> & { threadId?: string | null; workspace?: string }): void => {
    activityStore.append({
      source: "discord",
      contextKey: request.contextKey,
      actor: input.actor ?? actorFor(request),
      workspace: input.workspace ?? config.workspace,
      threadId: input.threadId ?? null,
      ...input,
    });
  };

  const audit = (request: DiscordRequest, input: Omit<AuditEvent, "id" | "timestamp" | "channelId" | "contextKey"> & { contextKey?: string }): void => {
    auditLog.append({
      channelId: "discord",
      contextKey: input.contextKey ?? request.contextKey,
      actor: input.actor ?? actorFor(request),
      actorId: request.authUser?.user.id ?? request.user.id,
      actorRole: request.authUser?.groups.map((group) => group.name).join(", ") ?? "unauthenticated",
      ...input,
    });
  };

  const hasPermission = (request: DiscordRequest, permission: Permission | null): boolean =>
    userStore.hasPermission(request.authUser, permission);

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
    const state = busyStates.get(contextKey);
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
    const state = queueStatusMessages.get(contextKey) ?? {};
    if (state.lastText === text && state.messageId) {
      return;
    }
    if (!state.messageId) {
      const sent = await runtime.sendMessage(context, { text, fallbackText: text });
      state.messageId = sent.messageId;
      state.lastText = text;
      queueStatusMessages.set(contextKey, state);
      return;
    }
    await runtime.editMessage(context, state.messageId, { text, fallbackText: text });
    state.lastText = text;
    queueStatusMessages.set(contextKey, state);
  };

  const sendExternalMirrorTyping = async (
    context: ChannelContext,
    state: DiscordExternalMirrorState,
  ): Promise<void> => {
    const now = Date.now();
    if (state.lastTypingAt && now - state.lastTypingAt < TYPING_INTERVAL_MS) {
      return;
    }
    state.lastTypingAt = now;
    await runtime.sendTyping(context).catch(() => {});
  };

  const sendExternalWorkingNotice = async (
    context: ChannelContext,
    state: DiscordExternalMirrorState,
    snapshot: AgentExternalSnapshot,
  ): Promise<void> => {
    const turnKey = snapshot.activity.turnId ?? snapshot.activity.startedAt?.toISOString() ?? "unknown";
    if (state.workingNoticeTurnKey === turnKey) {
      return;
    }

    const prompt = trimLine(snapshot.latestUserMessage ?? "", 250);
    const text = prompt
      ? `**Working on** ${prompt}`
      : `**Working on** external ${snapshot.agentLabel} task...`;
    await runtime.sendMessage(context, {
      text,
      fallbackText: prompt ? `Working on ${prompt}` : `Working on external ${snapshot.agentLabel} task...`,
    });
    state.workingNoticeTurnKey = turnKey;
  };

  const mirrorExternalSnapshot = async (
    contextKey: ChannelContextKey,
    context: ChannelContext,
    session: AgentSessionService,
    snapshot: AgentExternalSnapshot,
  ): Promise<void> => {
    const previous = externalMirrors.get(contextKey);
    let state = previous;
    if (!state || state.threadId !== snapshot.threadId || state.rolloutPath !== snapshot.sourcePath) {
      state = {
        threadId: snapshot.threadId,
        rolloutPath: snapshot.sourcePath,
        lastLine: snapshot.lineCount,
        turnId: snapshot.activity.turnId,
        startedAt: snapshot.activity.startedAt,
      };
      externalMirrors.set(contextKey, state);
    }

    const mirrorMode = preferencesStore.get(contextKey).mirrorMode ?? config.discordMirrorMode;
    if (snapshot.activity.active) {
      state.turnId = snapshot.activity.turnId;
      state.startedAt = snapshot.activity.startedAt;
      const turnKey = snapshot.activity.turnId ?? snapshot.activity.startedAt?.toISOString() ?? "unknown";
      if (state.activityStartedTurnKey !== turnKey) {
        const info = session.getInfo();
        activityStore.append({
          source: "cli",
          status: "running",
          type: "cli_turn_started",
          contextKey,
          threadId: snapshot.threadId,
          workspace: info.workspace,
          agentId: info.agentId,
          actor: { channel: "cli", label: `${snapshot.agentLabel} CLI` },
          prompt: snapshot.latestUserMessage ?? `${snapshot.agentLabel} CLI task`,
          detail: `${snapshot.sourceLabel}: ${snapshot.sourcePath}`,
        });
        state.activityStartedTurnKey = turnKey;
        state.activityFinishedTurnKey = undefined;
        state.activityToolStartLines = [];
        state.activityToolEndLines = [];
      }
      if (mirrorMode !== "off") {
        await sendExternalMirrorTyping(context, state);
      }
      if (mirrorMode === "final") {
        await sendExternalWorkingNotice(context, state, snapshot);
        state.lastLine = Math.max(state.lastLine, snapshot.lineCount);
        return;
      }
      if (mirrorMode === "off") {
        state.lastLine = Math.max(state.lastLine, snapshot.lineCount);
        return;
      }

      const status = renderExternalMirrorStatus(snapshot, promptStore.list(contextKey).length);
      const statusMessage = { text: status.html, fallbackText: status.plain, parseMode: "html" as const };
      const now = Date.now();
      const canUpdateStatus = !state.latestStatusAt || now - state.latestStatusAt >= config.discordMirrorMinUpdateMs;
      if (!state.statusMessageId) {
        const sent = await runtime.sendMessage(context, statusMessage);
        state.statusMessageId = sent.messageId;
        state.latestStatusAt = now;
      } else if (state.latestStatus !== status.plain && canUpdateStatus) {
        await runtime.editMessage(context, state.statusMessageId, statusMessage);
        state.latestStatusAt = now;
      }
      state.latestStatus = status.plain;

      if (mirrorMode === "full") {
        const newEvents = snapshot.events
          .filter((event) => event.lineNumber > (state.latestMirroredEventLine ?? state.lastLine))
          .filter((event) => event.kind === "tool" || event.kind === "task")
          .slice(-4);
        for (const event of newEvents) {
          const rendered = renderExternalMirrorEvent(event);
          if (!rendered) {
            continue;
          }
          await deliverChannelAction(runtime, context, rendered);
          state.latestMirroredEventLine = event.lineNumber;
        }
      }

      const info = session.getInfo();
      const loggedStartLines = new Set(state.activityToolStartLines ?? []);
      const loggedEndLines = new Set(state.activityToolEndLines ?? []);
      for (const event of snapshot.events.filter((event) => event.lineNumber > state.lastLine && event.kind === "tool")) {
        if (event.status === "started" && !loggedStartLines.has(event.lineNumber)) {
          activityStore.append({
            source: "cli",
            status: "running",
            type: "cli_tool_started",
            contextKey,
            threadId: snapshot.threadId,
            workspace: info.workspace,
            agentId: info.agentId,
            actor: { channel: "cli", label: `${snapshot.agentLabel} CLI` },
            prompt: snapshot.latestUserMessage ?? undefined,
            detail: event.toolName ?? "tool",
          });
          loggedStartLines.add(event.lineNumber);
        }
        if ((event.status === "finished" || event.status === "failed") && !loggedEndLines.has(event.lineNumber)) {
          activityStore.append({
            source: "cli",
            status: event.status === "failed" ? "failed" : "completed",
            type: event.status === "failed" ? "cli_tool_failed" : "cli_tool_completed",
            contextKey,
            threadId: snapshot.threadId,
            workspace: info.workspace,
            agentId: info.agentId,
            actor: { channel: "cli", label: `${snapshot.agentLabel} CLI` },
            prompt: snapshot.latestUserMessage ?? undefined,
            detail: event.toolName ?? "tool",
          });
          loggedEndLines.add(event.lineNumber);
        }
      }
      state.activityToolStartLines = [...loggedStartLines].slice(-200);
      state.activityToolEndLines = [...loggedEndLines].slice(-200);
      state.lastLine = Math.max(state.lastLine, snapshot.lineCount);
      return;
    }

    if (!previous) {
      state.lastLine = Math.max(state.lastLine, snapshot.lineCount);
      return;
    }

    const terminalEvent = [...snapshot.events].reverse().find((event) => event.kind === "task" && event.status && event.status !== "started");
    if (terminalEvent) {
      const turnKey = terminalEvent.turnId ?? snapshot.activity.turnId ?? state.startedAt?.toString() ?? "unknown";
      if (state.activityFinishedTurnKey !== turnKey) {
        const info = session.getInfo();
        const startedAt = state.startedAt instanceof Date ? state.startedAt : state.startedAt ? new Date(state.startedAt) : snapshot.activity.startedAt;
        activityStore.append({
          source: "cli",
          status: terminalEvent.status === "aborted" ? "aborted" : terminalEvent.status === "failed" ? "failed" : "completed",
          type: "cli_turn_finished",
          contextKey,
          threadId: snapshot.threadId,
          workspace: info.workspace,
          agentId: info.agentId,
          actor: { channel: "cli", label: `${snapshot.agentLabel} CLI` },
          prompt: snapshot.latestUserMessage ?? undefined,
          detail: `${snapshot.agentLabel} CLI task ${terminalEvent.status ?? "finished"}.`,
          durationMs: startedAt && terminalEvent.timestamp ? Math.max(0, terminalEvent.timestamp.getTime() - startedAt.getTime()) : undefined,
        });
        state.activityFinishedTurnKey = turnKey;
      }
      if (mirrorMode !== "off") {
        const doneText = `${snapshot.agentLabel} CLI task ${terminalEvent.status}.`;
        if (state.statusMessageId) {
          await runtime.editMessage(context, state.statusMessageId, { text: doneText, fallbackText: doneText });
        } else {
          await runtime.sendMessage(context, { text: doneText, fallbackText: doneText });
        }
      }

      const finalAgent = snapshot.events.filter((event) => event.kind === "agent" && event.text).at(-1);
      if (mirrorMode !== "off" && mirrorMode !== "status" && finalAgent?.text && finalAgent.lineNumber !== state.latestAgentLine) {
        await runtime.sendMessage(context, {
          text: `**${snapshot.agentLabel} CLI final answer:**`,
          fallbackText: `${snapshot.agentLabel} CLI final answer:`,
        });
        for (const chunk of splitDiscordMessage(finalAgent.text)) {
          await runtime.sendMessage(context, { text: chunk, fallbackText: chunk });
        }
        state.latestAgentLine = finalAgent.lineNumber;
      }

      await deliverCliGeneratedArtifacts(contextKey, context, session, state.startedAt, terminalEvent.turnId);
    }

    state.workingNoticeTurnKey = undefined;
    state.lastLine = Math.max(state.lastLine, snapshot.lineCount);
  };

  const ensureActiveThread = async (request: DiscordRequest, session: AgentSessionService): Promise<void> => {
    if (!session.hasActiveThread()) {
      await session.newThread();
      updateSession(request, session);
    }
  };

  const checkAgentAuthStatus = async (info: AgentSessionInfo): Promise<{ authenticated: boolean; detail: string; method?: string }> => {
    if (info.agentId === "pi") return checkPiAuthStatus(info.model);
    if (info.agentId === "hermes") return checkHermesAuthStatus({ baseUrl: config.hermesApiBaseUrl, apiKey: config.hermesApiKey });
    if (info.agentId === "openclaw") return checkOpenClawAuthStatus({ gatewayUrl: config.openClawGatewayUrl, token: config.openClawGatewayToken, password: config.openClawGatewayPassword });
    if (info.agentId === "claude-code") return checkClaudeCodeAuthStatus(config.claudeCodeCliPath);
    return checkAuthStatus(config.codexApiKey);
  };

  const checkLoginAuthStatus = async (info: AgentSessionInfo): Promise<{ authenticated: boolean; detail: string; method?: string }> => {
    if (info.agentId === "hermes") return checkHermesAuthStatus({ baseUrl: config.hermesApiBaseUrl, apiKey: config.hermesApiKey });
    if (info.agentId === "claude-code") return checkClaudeCodeAuthStatus(config.claudeCodeCliPath);
    return checkAuthStatus(config.codexApiKey);
  };

  const startAgentLogin = (info: AgentSessionInfo): Promise<LoginResult> => {
    if (info.agentId === "hermes") return startHermesLogin(config.hermesCliPath);
    if (info.agentId === "claude-code") return startClaudeCodeLogin(config.claudeCodeCliPath);
    if (info.agentId === "codex") return startCodexLogin();
    return Promise.resolve({
      success: false,
      message: `${info.agentLabel} login is not managed by NordRelay. Run the agent login flow on the host.`,
    });
  };

  const startAgentLogout = (info: AgentSessionInfo): Promise<LoginResult> => {
    if (info.agentId === "hermes") return startHermesLogout(config.hermesCliPath);
    if (info.agentId === "claude-code") return startClaudeCodeLogout(config.claudeCodeCliPath);
    if (info.agentId === "codex") return startCodexLogout();
    return Promise.resolve({
      success: false,
      message: `${info.agentLabel} logout is not managed by NordRelay. Run the agent logout flow on the host.`,
    });
  };

  const hostLoginCommand = (info: AgentSessionInfo): string => {
    if (info.agentId === "hermes") return `${config.hermesCliPath ?? "hermes"} login --no-browser`;
    if (info.agentId === "claude-code") return `${config.claudeCodeCliPath ?? "claude"} auth login`;
    if (info.agentId === "pi") return `${config.piCliPath ?? "pi"} auth login`;
    if (info.agentId === "openclaw") return `${config.openClawCliPath ?? "openclaw"} login`;
    return "codex login --device-auth";
  };

  const hostLogoutCommand = (info: AgentSessionInfo): string => {
    if (info.agentId === "hermes") return `${config.hermesCliPath ?? "hermes"} logout`;
    if (info.agentId === "claude-code") return `${config.claudeCodeCliPath ?? "claude"} auth logout`;
    if (info.agentId === "pi") return `${config.piCliPath ?? "pi"} auth logout`;
    if (info.agentId === "openclaw") return `${config.openClawCliPath ?? "openclaw"} logout`;
    return "codex logout";
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

  const handleRemotePrompt = async (request: DiscordRequest, envelope: ReturnType<typeof toPromptEnvelope>): Promise<boolean> => {
    const targetPeerId = preferencesStore.get(request.contextKey).targetPeerId;
    if (!targetPeerId) {
      return false;
    }
    let accumulated = "";
    let responseMessageId: string | undefined;
    let lastEditAt = 0;
    const typing = setInterval(() => {
      void runtime.sendTyping(request.context).catch(() => {});
    }, TYPING_INTERVAL_MS);
    typing.unref?.();
    void runtime.sendTyping(request.context).catch(() => {});

    const flush = async (force = false): Promise<void> => {
      if (!accumulated.trim()) return;
      const now = Date.now();
      if (!force && now - lastEditAt < EDIT_DEBOUNCE_MS) return;
      const text = trimDiscordMessage(accumulated);
      if (!responseMessageId) {
        const sent = await runtime.sendMessage(request.context, { text, fallbackText: text });
        responseMessageId = sent.messageId;
      } else {
        await runtime.editMessage(request.context, responseMessageId, { text, fallbackText: text });
      }
      lastEditAt = now;
    };

    const done = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 30 * 60 * 1000);
      timeout.unref?.();
      const subscription = remoteClient.subscribe(targetPeerId, (event) => {
        if (event.type === "turn_start") {
          void reply(request, `Remote peer working on:\n${event.prompt}`).catch(() => {});
        } else if (event.type === "text_delta") {
          accumulated += event.delta;
          void flush(false).catch(() => {});
        } else if (event.type === "tool_start") {
          void reply(request, `Remote tool: ${event.toolName}`).catch(() => {});
        } else if (event.type === "turn_complete") {
          clearTimeout(timeout);
          subscription.close();
          resolve();
        } else if (event.type === "turn_error") {
          accumulated += `\n\nError: ${event.error}`;
          clearTimeout(timeout);
          subscription.close();
          resolve();
        }
      }, (error) => {
        accumulated += `\n\nRemote event stream failed: ${error.message}`;
        clearTimeout(timeout);
        resolve();
      });
    });

    try {
      const result = await remoteClient.webProxy(targetPeerId, await peerPromptProxyPayload(envelope), actorFor(request));
      if (result && typeof result === "object" && "queued" in result && (result as { queued?: boolean }).queued) {
        await reply(request, `Remote prompt queued${(result as { queueId?: unknown }).queueId ? `: ${(result as { queueId?: unknown }).queueId}` : ""}.`);
        return true;
      }
      await done;
      await flush(true);
      if (!accumulated.trim()) {
        await reply(request, "Remote turn completed.");
      }
      return true;
    } catch (error) {
      await reply(request, `Remote peer failed: ${friendlyErrorText(error)}`);
      return true;
    } finally {
      clearInterval(typing);
    }
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

    const busy = getBusyReason(request.contextKey);
    if (busy.busy) {
      const item = options.fromQueue && isQueuedPrompt(envelope)
        ? envelope as QueuedPrompt
        : promptStore.enqueue(request.contextKey, envelope);
      const position = promptStore.list(request.contextKey).findIndex((queued) => queued.id === item.id) + 1;
      const text = busy.kind === "external"
        ? `Queued prompt ${item.id} at position ${position}. The ${busy.agentLabel} session is still active and is processing a previous task.`
        : `Queued prompt ${item.id} at position ${position}.`;
      await reply(request, text, {
        buttons: [[{ label: "Cancel queued message", action: `discord_queue_cancel:${request.contextKey}:${item.id}` }]],
      });
      appendActivity(request, {
        status: "queued",
        type: "prompt_queued",
        prompt: item.description,
        detail: text,
      });
      audit(request, {
        action: "prompt_queued",
        status: "ok",
        promptId: item.id,
        description: item.description,
      });
      return;
    }

    const busyState = getBusyState(request.contextKey);
    busyState.processing = true;
    const typing = setInterval(() => {
      void runtime.sendTyping(request.context).catch(() => {});
    }, TYPING_INTERVAL_MS);
    void runtime.sendTyping(request.context).catch(() => {});

    let accumulatedText = "";
    let responseMessageId: string | undefined;
    let planMessageId: string | undefined;
    let flushTimer: NodeJS.Timeout | undefined;
    let lastEditAt = 0;
    let running = true;
    let finalized = false;
    const toolCounts = new Map<string, number>();
    const toolVerbosity: ToolVerbosity = config.toolVerbosity;
    const startedAt = Date.now();
    const turnId = randomUUID().slice(0, 12);
    const progress: TurnProgress = {
      status: "running",
      promptDescription: envelope.description,
      startedAt,
      updatedAt: startedAt,
      toolCounts,
      textCharacters: 0,
    };
    turnProgress.set(request.contextKey, progress);

    const scheduleFlush = (): void => {
      if (flushTimer || !running) {
        return;
      }
      const delay = Math.max(0, EDIT_DEBOUNCE_MS - (Date.now() - lastEditAt));
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void flushResponse().catch((error) => console.error("Failed to edit Discord response:", error));
      }, delay);
    };

    const ensureResponse = async (): Promise<void> => {
      if (responseMessageId) return;
      const preview = trimDiscordMessage(accumulatedText || "Working...");
      const sent = await runtime.sendMessage(request.context, {
        text: preview,
        fallbackText: preview,
        buttons: [[{ label: "Abort", action: `discord_abort:${request.contextKey}` }]],
      });
      responseMessageId = sent.messageId;
      responseOwners.set(responseMessageId, request.contextKey);
      lastEditAt = Date.now();
    };

    const flushResponse = async (force = false): Promise<void> => {
      if (!accumulatedText.trim()) return;
      await ensureResponse();
      if (!responseMessageId) return;
      const now = Date.now();
      if (!force && now - lastEditAt < EDIT_DEBOUNCE_MS) return;
      await runtime.editMessage(request.context, responseMessageId, {
        text: trimDiscordMessage(accumulatedText),
        fallbackText: trimDiscordMessage(accumulatedText),
        buttons: [[{ label: "Abort", action: `discord_abort:${request.contextKey}` }]],
      });
      lastEditAt = Date.now();
    };

    const finalize = async (): Promise<void> => {
      if (finalized) {
        return;
      }
      finalized = true;
      running = false;
      clearInterval(typing);
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      const finalText = accumulatedText.trim() || "Done.";
      const chunks = splitDiscordMessage(finalText);
      if (responseMessageId) {
        const [first, ...rest] = chunks;
        await runtime.editMessage(request.context, responseMessageId, { text: first ?? "Done.", fallbackText: first ?? "Done." });
        for (const chunk of rest) {
          await runtime.sendMessage(request.context, { text: chunk, fallbackText: chunk });
        }
      } else {
        for (const chunk of chunks) {
          await runtime.sendMessage(request.context, { text: chunk, fallbackText: chunk });
        }
      }
    };

    const callbacks: AgentSessionCallbacks = {
      onTextDelta: (delta) => {
        accumulatedText += delta;
        progress.textCharacters = accumulatedText.length;
        progress.updatedAt = Date.now();
        void ensureResponse().then(() => scheduleFlush()).catch((error) => console.error("Failed to send Discord response:", error));
      },
      onToolStart: (toolName) => {
        toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
        progress.currentTool = toolName;
        progress.lastTool = toolName;
        progress.updatedAt = Date.now();
        appendActivity(request, {
          status: "running",
          type: "tool_started",
          prompt: envelope.description,
          detail: toolName,
          threadId: session.getInfo().threadId,
          workspace: session.getInfo().workspace,
          agentId: session.getInfo().agentId,
        });
        if (toolVerbosity === "all") {
          void runtime.sendMessage(request.context, { text: `Tool started: ${toolName}`, fallbackText: `Tool started: ${toolName}` }).catch(() => {});
        }
      },
      onToolUpdate: () => {},
      onToolEnd: (_toolCallId, isError) => {
        progress.currentTool = undefined;
        progress.updatedAt = Date.now();
        appendActivity(request, {
          status: isError ? "failed" : "completed",
          type: isError ? "tool_failed" : "tool_completed",
          prompt: envelope.description,
          detail: "tool",
          threadId: session.getInfo().threadId,
          workspace: session.getInfo().workspace,
          agentId: session.getInfo().agentId,
        });
      },
      onTodoUpdate: (items) => {
        progress.updatedAt = Date.now();
        const text = [
          "Plan:",
          ...items.map((item) => `${item.completed ? "[x]" : "[ ]"} ${item.text}`),
        ].join("\n");
        if (!planMessageId) {
          void runtime.sendMessage(request.context, { text, fallbackText: text }).then((result) => {
            planMessageId = result.messageId;
          }).catch(() => {});
        } else {
          void runtime.editMessage(request.context, planMessageId, { text, fallbackText: text }).catch(() => {});
        }
      },
      onTurnComplete: () => {},
      onAgentEnd: () => {
        progress.status = "completed";
        progress.completedAt = Date.now();
        progress.updatedAt = progress.completedAt;
        void finalize().catch((error) => console.error("Failed to finalize Discord response:", error));
      },
    };

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

      await session.prompt(envelope.input, callbacks);
      updateSession(request, session);
      progress.status = "completed";
      progress.completedAt = Date.now();
      progress.updatedAt = progress.completedAt;
      await finalize();
      await artifactService.persistWorkspaceArtifactsForTurn(session.getInfo().workspace, turnId, new Date(startedAt));
      if (config.discordAutoSendArtifacts) {
        await sendRecentDiscordArtifacts(artifactDeps, request, session, new Date(startedAt), turnId);
      }
      appendActivity(request, {
        status: "completed",
        type: "prompt_completed",
        prompt: envelope.description,
        threadId: session.getInfo().threadId,
        workspace: session.getInfo().workspace,
        agentId: session.getInfo().agentId,
        durationMs: Date.now() - startedAt,
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
      const errorText = renderPromptFailure(accumulatedText, error);
      if (responseMessageId) {
        await runtime.editMessage(request.context, responseMessageId, { text: trimDiscordMessage(errorText), fallbackText: trimDiscordMessage(errorText) }).catch(() => {});
      } else {
        await reply(request, errorText).catch(() => {});
      }
      appendActivity(request, {
        status: "failed",
        type: "prompt_failed",
        prompt: envelope.description,
        detail: friendlyErrorText(error),
        threadId: session.getInfo().threadId,
        workspace: session.getInfo().workspace,
        agentId: session.getInfo().agentId,
        durationMs: Date.now() - startedAt,
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
      running = false;
      clearInterval(typing);
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
    if (!startedAt || !turnId) {
      return;
    }
    const state = externalMirrors.get(contextKey);
    if (state?.artifactsDeliveredForTurnId === turnId) {
      return;
    }

    const workspace = session.getInfo().workspace;
    const report = await collectRecentWorkspaceArtifacts(workspace, {
      since: startedAt,
      until: new Date(),
      maxFileSize: config.maxFileSize,
      limit: 5,
      ignoreDirs: config.artifactIgnoreDirs,
      ignoreGlobs: config.artifactIgnoreGlobs,
    });
    if (report.artifacts.length === 0 && report.skippedCount === 0 && !report.omittedCount) {
      if (state) state.artifactsDeliveredForTurnId = turnId;
      return;
    }

    const persisted = await persistWorkspaceArtifactReport(workspace, turnId, report).catch((error) => {
      console.error("Failed to persist Discord CLI artifact report:", error);
      return null;
    });
    const summary = formatArtifactSummary(report.artifacts, report.skippedCount, report.omittedCount);
    if (summary) {
      await runtime.sendMessage(context, { text: summary, fallbackText: summary });
    }

    if (config.discordAutoSendArtifacts) {
      for (const artifact of (persisted?.artifacts ?? report.artifacts).slice(0, 5)) {
        await runtime.sendFile(context, { localPath: artifact.localPath, name: artifact.name }).catch((error) => {
          console.error(`Failed to send Discord CLI artifact ${artifact.name}:`, error);
        });
      }
    }

    const info = session.getInfo();
    activityStore.append({
      source: "cli",
      status: "info",
      type: config.discordAutoSendArtifacts ? "artifacts_sent" : "artifacts_detected",
      contextKey,
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      actor: { channel: "cli", label: `${info.agentLabel} CLI` },
      detail: summary,
    });
    if (state) state.artifactsDeliveredForTurnId = turnId;
  };

  const handleCommand = async (request: DiscordRequest, command: string, argument: string): Promise<void> => {
    const normalized = command.toLowerCase();
    const permission = requiredPermissionForDiscordCommand(normalized, argument);
    if (!await authenticate(request, permission, normalized)) {
      return;
    }

    audit(request, { action: "command", status: "ok", description: `/${normalized} ${argument}`.trim() });

    switch (normalized) {
      case "start":
      case "help":
        await commandHelp(request);
        return;
      case "channels":
        await deliverChannelAction(runtime, request.context, commandService.renderChannels());
        return;
      case "peers":
        await deliverChannelAction(runtime, request.context, commandService.renderPeers());
        return;
      case "target":
        await deliverChannelAction(runtime, request.context, commandService.renderTargetPreference({
          source: "discord",
          contextKey: request.contextKey,
          argument,
          preferencesStore,
        }));
        return;
      case "agents":
        await deliverChannelAction(runtime, request.context, commandService.renderAgents());
        return;
      case "agent":
        await commandAgent(request, argument);
        return;
      case "auth":
        await commandAuth(request);
        return;
      case "login":
        await commandLogin(request);
        return;
      case "logout":
        await commandLogout(request);
        return;
      case "session":
        await commandSession(request);
        return;
      case "sessions":
        await commandSessions(request, argument);
        return;
      case "new":
        await commandNew(request, argument);
        return;
      case "switch":
      case "attach":
        await commandSwitch(request, argument);
        return;
      case "model":
        await commandModel(request, argument);
        return;
      case "reasoning":
      case "effort":
        await commandReasoning(request, argument);
        return;
      case "fast":
        await commandFast(request, argument);
        return;
      case "launch":
      case "launch_profiles":
      case "launch-profiles":
        await commandLaunch(request, argument);
        return;
      case "queue":
        await commandQueue(request, argument);
        return;
      case "clearqueue":
        promptStore.clear(request.contextKey);
        await reply(request, "Queue cleared.");
        return;
      case "cancel":
        await commandQueue(request, `cancel ${argument}`);
        return;
      case "abort":
      case "stop":
        await commandAbort(request);
        return;
      case "retry":
        await commandRetry(request);
        return;
      case "sync":
        await commandSync(request);
        return;
      case "tasks":
      case "progress":
        await commandProgress(request);
        return;
      case "activity":
        await commandActivity(request, argument);
        return;
      case "audit":
        await commandAudit(request, argument);
        return;
      case "artifacts":
        await commandArtifacts(request, argument);
        return;
      case "logs":
        await commandLogs(request, argument);
        return;
      case "version":
      case "health":
      case "status":
        await commandVersion(request);
        return;
      case "diagnostics":
        await commandDiagnostics(request);
        return;
      case "support":
        await commandDiagnostics(request);
        return;
      case "restart":
        await commandRestart(request);
        return;
      case "update":
        await commandUpdate(request, argument);
        return;
      case "lock":
        await commandLock(request);
        return;
      case "unlock":
        lockStore.clear(request.contextKey);
        await reply(request, "Session unlocked.");
        return;
      case "locks":
        await reply(request, lockStore.list().map((lock) => `${lock.contextKey}: ${lock.ownerLabel || lock.ownerUserId}`).join("\n") || "No active locks.");
        return;
      case "mirror":
        await commandMirror(request, argument);
        return;
      case "notify":
        await commandNotify(request, argument);
        return;
      case "voice":
        await commandVoice(request, argument);
        return;
      case "workspaces":
        await commandWorkspaces(request);
        return;
      case "pin":
        await commandPin(request, argument);
        return;
      case "unpin":
        await commandUnpin(request, argument);
        return;
      case "pinned":
        await commandPinned(request);
        return;
      case "handback":
        await commandHandback(request);
        return;
      case "register_channel":
        await commandRegisterChannel(request);
        return;
      case "link":
        await commandLink(request, argument);
        return;
      case "whoami":
        await reply(request, request.authUser ? `${request.authUser.user.displayName} <${request.authUser.user.email}>\nGroups: ${request.authUser.groups.map((group) => group.name).join(", ")}` : "Not linked.");
        return;
      case "prompt":
        await handlePrompt(request, argument);
        return;
      default:
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
    const keys = new Set([
      ...registry.listContexts().map((context) => context.contextKey),
      ...promptStore.listContextKeys(),
    ].filter(isDiscordContextKey));

    for (const contextKey of keys) {
      const parsed = parseDiscordContextKey(contextKey);
      if (!parsed) continue;
      if (!canSendSystemMessagesToDiscordContext(userStore, contextKey)) {
        continue;
      }
      const guildId = parsed.guildId?.startsWith("dm-") ? undefined : parsed.guildId;
      if (!isDiscordGuildAllowed(guildId) || !isDiscordChannelAllowedByEnv(parsed.channelId)) {
        continue;
      }
      const session = await registry.getOrCreate(contextKey, { deferThreadStart: true }).catch(() => null);
      if (!session) continue;
      const context: ChannelContext = {
        channelId: "discord",
        chatId: parsed.threadId ?? parsed.channelId,
        topicId: parsed.threadId,
      };
      const snapshot = getExternalSnapshotForSession(session, config, { maxEvents: 1 });
      const previous = externalMirrors.get(contextKey);
      const mirrorSnapshot = snapshot
        ? getExternalSnapshotForSession(session, config, {
          afterLine: previous?.lastLine ?? Number.MAX_SAFE_INTEGER,
        }) ?? snapshot
        : null;
      if (mirrorSnapshot && !session.isProcessing()) {
        await mirrorExternalSnapshot(contextKey, context, session, mirrorSnapshot);
      }
      if (mirrorSnapshot?.activity.active) {
        if (promptStore.list(contextKey).length > 0) {
          await updateQueueStatusMessage(
            contextKey,
            context,
            `Waiting for ${mirrorSnapshot.agentLabel} CLI task... ${promptStore.list(contextKey).length} queued${promptStore.isPaused(contextKey) ? " (paused)" : ""}.`,
          ).catch(() => {});
        }
        continue;
      }
      if (promptStore.list(contextKey).length > 0 && !promptStore.isPaused(contextKey) && !session.isProcessing()) {
        await updateQueueStatusMessage(contextKey, context, `CLI task finished, running queued prompt 1/${promptStore.list(contextKey).length}.`).catch(() => {});
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
      }
    }
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

function isQueuedPrompt(value: unknown): value is QueuedPrompt {
  return Boolean(value && typeof value === "object" && "id" in value && "contextKey" in value);
}
