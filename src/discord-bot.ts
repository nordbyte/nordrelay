import { randomUUID } from "node:crypto";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type APIApplicationCommandOption,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type MessageComponentInteraction,
  type User,
} from "discord.js";

import { ADMIN_GROUP_ID, permissionForCommand, type Permission } from "./access-control.js";
import { agentLabel, agentReasoningLabel, agentReasoningOptions, type AgentId, type AgentPromptInput, type AgentSessionCallbacks, type AgentSessionInfo, type AgentSessionService } from "./agent.js";
import { getExternalSnapshotForSession } from "./agent-activity.js";
import { listAgentAdapterDescriptors } from "./agent-adapter.js";
import { AgentUpdateManager, type AgentUpdateOperation } from "./agent-updates.js";
import { enabledAgents } from "./agent-factory.js";
import { collectRecentWorkspaceArtifacts, ensureOutDir } from "./artifacts.js";
import { buildFileInstructions, outboxPath, stageFile, type StagedFile } from "./attachments.js";
import { AuditLogStore, type AuditEvent } from "./audit-log.js";
import { BotPreferencesStore, parseMirrorMode, parseNotifyMode } from "./bot-preferences.js";
import { capabilitiesOf, formatDurationSeconds, formatLocalDateTime, renderPromptFailure, trimLine } from "./bot-rendering.js";
import { renderChannelsAction, renderAgentsAction, renderAgentUpdateJobAction, renderAgentUpdateJobsAction } from "./channel-actions.js";
import { deliverChannelAction } from "./channel-runtime.js";
import type { ChannelContext } from "./channel-adapter.js";
import { listChannelDescriptors } from "./channel-adapter.js";
import { checkAuthStatus } from "./codex-auth.js";
import { checkClaudeCodeAuthStatus } from "./claude-code-auth.js";
import type { ConnectorConfig, ToolVerbosity } from "./config.js";
import { discordContextKey, isDiscordContextKey, parseDiscordContextKey, type TelegramContextKey } from "./context-key.js";
import { DiscordBotChannelRuntime, actionFromDiscordCustomId, discordActionRows, splitDiscordMessage, trimDiscordMessage } from "./discord-channel-runtime.js";
import { friendlyErrorText } from "./error-messages.js";
import { checkHermesAuthStatus } from "./hermes-auth.js";
import { getAgentUpdateLogPath, getConnectorHealth, getUpdateLogPath, getVersionChecks, readFormattedLogTail, spawnConnectorRestart, spawnSelfUpdate } from "./operations.js";
import { checkOpenClawAuthStatus } from "./openclaw-auth.js";
import { checkPiAuthStatus } from "./pi-auth.js";
import { PromptStore, toPromptEnvelope, type PromptEnvelope, type QueuedPrompt } from "./prompt-store.js";
import { RelayArtifactService } from "./relay-artifact-service.js";
import { configureRedaction } from "./redaction.js";
import { renderSessionInfoPlain } from "./session-format.js";
import { canWriteWithLock, SessionLockStore } from "./session-locks.js";
import { SessionRegistry } from "./session-registry.js";
import { transcribeAudio, type TranscriptionBackend } from "./voice.js";
import { evaluateWorkspacePolicy, filterAllowedWorkspaces } from "./workspace-policy.js";
import { UserStore, type AuthenticatedUser } from "./user-management.js";
import { WebActivityStore, type WebActivityActor } from "./web-state.js";

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
  contextKey: TelegramContextKey;
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

export function createDiscordBridge(config: ConnectorConfig, registry: SessionRegistry): DiscordBridge | null {
  if (!config.discordEnabled) {
    return null;
  }
  if (!config.discordBotToken) {
    throw new Error("DISCORD_ENABLED=true requires DISCORD_BOT_TOKEN.");
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
  const busyStates = new Map<TelegramContextKey, BusyState>();
  const draining = new Set<TelegramContextKey>();
  const picks = new Map<string, PickState>();
  const responseOwners = new Map<string, TelegramContextKey>();
  let externalMonitor: NodeJS.Timeout | undefined;

  const getBusyState = (contextKey: TelegramContextKey): BusyState => {
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
      const first = trimDiscordMessage(chunks.shift() ?? ".");
      const payload = {
        content: first,
        components: discordActionRows(options.buttons),
        allowedMentions: { parse: [] as never[] },
        ephemeral: options.ephemeral,
      };
      if (request.interaction.replied || request.interaction.deferred) {
        await request.interaction.followUp(payload).catch(() => runtime.sendMessage(request.context, { text: first, fallbackText: first, buttons: options.buttons }));
      } else {
        await request.interaction.reply(payload);
      }
      for (const chunk of chunks) {
        await request.interaction.followUp({ content: chunk, allowedMentions: { parse: [] } }).catch(() => runtime.sendMessage(request.context, { text: chunk, fallbackText: chunk }));
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
    if (commandName === "link") {
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

  const getBusyReason = (contextKey: TelegramContextKey): BusyReason => {
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

  const denyIfLocked = async (request: DiscordRequest): Promise<boolean> => {
    const lock = lockStore.get(request.contextKey);
    const isAdmin = request.authUser?.groups.some((group) => group.id === ADMIN_GROUP_ID) ?? false;
    if (canWriteWithLock(lock, request.authUser?.user.id, isAdmin)) {
      return false;
    }
    await reply(request, `Session is locked by ${lock?.ownerLabel || lock?.ownerUserId || "another user"}.`);
    return true;
  };

  const handlePrompt = async (request: DiscordRequest, input: AgentPromptInput, artifactOutDir?: string, options: { fromQueue?: boolean } = {}): Promise<void> => {
    const session = await getSession(request);
    const envelope = toPromptEnvelope(input, artifactOutDir);
    envelope.activityActor = actorFor(request);

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
        void ensureResponse().then(() => scheduleFlush()).catch((error) => console.error("Failed to send Discord response:", error));
      },
      onToolStart: (toolName) => {
        toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
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
      await finalize();
      await artifactService.persistWorkspaceArtifactsForTurn(session.getInfo().workspace, turnId, new Date(startedAt));
      if (config.telegramAutoSendArtifacts) {
        await sendRecentArtifacts(request, session, new Date(startedAt), turnId);
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

  const sendRecentArtifacts = async (request: DiscordRequest, session: AgentSessionService, since: Date, turnId: string): Promise<void> => {
    const report = await collectRecentWorkspaceArtifacts(session.getInfo().workspace, {
      since,
      until: new Date(),
      maxFileSize: config.maxFileSize,
      limit: 5,
    });
    if (report.artifacts.length === 0) {
      return;
    }
    await reply(request, `${report.artifacts.length} artifacts generated.`);
    for (const artifact of report.artifacts.slice(0, 5)) {
      await runtime.sendFile(request.context, { localPath: artifact.localPath, name: artifact.name }).catch((error) => {
        console.error(`Failed to send Discord artifact ${artifact.name}:`, error);
      });
    }
    appendActivity(request, {
      status: "info",
      type: "artifacts_sent",
      detail: `${report.artifacts.length} artifacts for ${turnId}`,
      threadId: session.getInfo().threadId,
      workspace: session.getInfo().workspace,
      agentId: session.getInfo().agentId,
    });
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
        await deliverChannelAction(runtime, request.context, renderChannelsAction(listChannelDescriptors()));
        return;
      case "agents":
        await deliverChannelAction(runtime, request.context, renderAgentsAction(listAgentAdapterDescriptors(), enabledAgents(config)));
        return;
      case "agent":
        await commandAgent(request, argument);
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
      case "activity":
      case "tasks":
        await commandActivity(request, argument);
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
      "Core commands: `/agent`, `/session`, `/sessions`, `/new`, `/switch`, `/model`, `/reasoning`, `/fast`, `/queue`, `/stop`, `/retry`, `/artifacts`, `/logs`, `/version`, `/diagnostics`, `/update`, `/lock`, `/unlock`.",
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
    const requested = argument.trim();
    if (requested) {
      session.setLaunchProfile(requested);
      updateSession(request, session);
      await reply(request, `Launch profile set to ${requested}.`);
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
      await reply(request, [
        `Queue${promptStore.isPaused(request.contextKey) ? " (paused)" : ""}:`,
        ...queue.map((item, index) => `${index + 1}. ${item.id}: ${item.description}`),
      ].join("\n"), {
        buttons: queue.slice(0, 10).map((item) => [
          { label: `Run ${item.id}`, action: `discord_queue_run:${request.contextKey}:${item.id}` },
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

  const commandActivity = async (request: DiscordRequest, argument: string): Promise<void> => {
    const limit = Math.max(1, Math.min(20, Number.parseInt(argument, 10) || 10));
    const events = activityStore.list({ limit, source: "all" });
    await reply(request, events.map((event) => `${formatLocalDateTime(new Date(event.timestamp))} ${event.source}/${event.status} ${event.type}: ${event.prompt || event.detail || ""}`).join("\n") || "No activity.");
  };

  const commandArtifacts = async (request: DiscordRequest, argument: string): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const [action, turnId] = argument.trim().split(/\s+/, 2);
    if (action === "zip" && turnId) {
      const zip = await artifactService.createZip(session.getInfo().workspace, turnId);
      if (!zip) {
        await reply(request, "Could not create ZIP for artifact turn.");
        return;
      }
      await runtime.sendFile(request.context, { localPath: zip.path, name: zip.name });
      return;
    }
    const reports = await artifactService.list(session.getInfo().workspace, 10);
    await reply(request, reports.map((report) => `${report.turnId}: ${report.artifacts.length} files, ${report.totalSizeBytes} bytes`).join("\n") || "No generated artifacts found for this workspace.");
  };

  const commandLogs = async (request: DiscordRequest, argument: string): Promise<void> => {
    const tokens = argument.trim().split(/\s+/).filter(Boolean);
    const target = tokens.find((token) => ["connector", "update", "agent-updates"].includes(token)) as "connector" | "update" | "agent-updates" | undefined;
    const lines = Number.parseInt(tokens.find((token) => /^\d+$/.test(token)) ?? "", 10) || 40;
    const filePath = target === "update" ? getUpdateLogPath() : target === "agent-updates" ? getAgentUpdateLogPath() : undefined;
    const tail = await readFormattedLogTail(lines, filePath);
    await reply(request, `Logs:\n\`\`\`\n${trimLine(tail.plain || "(empty)", 1800)}\n\`\`\``);
  };

  const commandVersion = async (request: DiscordRequest): Promise<void> => {
    const cliOptions = { piCliPath: config.piCliPath, hermesCliPath: config.hermesCliPath, openClawCliPath: config.openClawCliPath, claudeCodeCliPath: config.claudeCodeCliPath };
    const [health, versions] = await Promise.all([getConnectorHealth(cliOptions), getVersionChecks(cliOptions)]);
    await reply(request, [
      `NordRelay: ${health.version}`,
      ...Object.values(versions).map((version) => `${version.status === "current" ? "OK" : "WARN"} ${version.label}: ${version.installedLabel || "-"} latest ${version.latestVersion || "-"}`),
    ].join("\n"));
  };

  const commandDiagnostics = async (request: DiscordRequest): Promise<void> => {
    const session = await getSession(request, { deferThreadStart: true });
    const external = getExternalSnapshotForSession(session, config, { maxEvents: 3 });
    await reply(request, [
      "Diagnostics:",
      `Context: ${request.contextKey}`,
      `Channel: ${request.guildId || "DM"} / ${request.channelId}`,
      `Agent: ${session.getInfo().agentLabel}`,
      `Thread: ${session.getInfo().threadId || "-"}`,
      `Workspace: ${session.getInfo().workspace}`,
      `Queue: ${promptStore.list(request.contextKey).length}${promptStore.isPaused(request.contextKey) ? " paused" : ""}`,
      `External: ${external?.activity.active ? "active" : "idle"}`,
    ].join("\n"));
  };

  const commandUpdate = async (request: DiscordRequest, argument: string): Promise<void> => {
    const [target, second] = argument.trim().split(/\s+/, 2);
    if (!target) {
      const update = spawnSelfUpdate();
      await reply(request, `NordRelay update started with ${update.method}. Log: ${update.logPath}`);
      return;
    }
    if (target === "jobs") {
      await deliverChannelAction(runtime, request.context, renderAgentUpdateJobsAction(agentUpdates.list()));
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

  const commandMirror = async (request: DiscordRequest, argument: string): Promise<void> => {
    const mode = parseMirrorMode(argument, preferencesStore.get(request.contextKey).mirrorMode ?? config.telegramMirrorMode);
    preferencesStore.update(request.contextKey, { mirrorMode: mode });
    await reply(request, `CLI mirror mode: ${mode}`);
  };

  const commandNotify = async (request: DiscordRequest, argument: string): Promise<void> => {
    const mode = parseNotifyMode(argument, preferencesStore.get(request.contextKey).notifyMode ?? config.telegramNotifyMode);
    preferencesStore.update(request.contextKey, { notifyMode: mode });
    await reply(request, `Notify mode: ${mode}`);
  };

  const commandVoice = async (request: DiscordRequest, argument: string): Promise<void> => {
    if (argument.trim() === "transcribe-only on") preferencesStore.update(request.contextKey, { voiceTranscribeOnly: true });
    else if (argument.trim() === "transcribe-only off") preferencesStore.update(request.contextKey, { voiceTranscribeOnly: false });
    const prefs = preferencesStore.get(request.contextKey);
    await reply(request, `Voice backend: ${prefs.voiceBackend ?? config.voicePreferredBackend}\nLanguage: ${prefs.voiceLanguage ?? config.voiceDefaultLanguage ?? "auto"}\nTranscribe only: ${prefs.voiceTranscribeOnly ?? config.voiceTranscribeOnly}`);
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
    const parsed = parseMessageCommand(text);
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
      const argument = argumentFromInteraction(interaction);
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
      const session = await registry.getOrCreate(contextKey, { deferThreadStart: true }).catch(() => null);
      if (!session) continue;
      const context: ChannelContext = {
        channelId: "discord",
        chatId: parsed.threadId ?? parsed.channelId,
        topicId: parsed.threadId,
      };
      const snapshot = getExternalSnapshotForSession(session, config, { maxEvents: 1 });
      if (snapshot?.activity.active) {
        await runtime.sendTyping(context).catch(() => {});
        if (promptStore.list(contextKey).length > 0) {
          await runtime.sendMessage(context, {
            text: `Waiting for ${snapshot.agentLabel} CLI task... ${promptStore.list(contextKey).length} queued.`,
            fallbackText: `Waiting for ${snapshot.agentLabel} CLI task... ${promptStore.list(contextKey).length} queued.`,
          }).catch(() => {});
        }
        continue;
      }
      if (promptStore.list(contextKey).length > 0 && !promptStore.isPaused(contextKey) && !session.isProcessing()) {
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

function parseMessageCommand(text: string): { command: string; argument: string } | null {
  const match = text.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  return match?.[1] ? { command: match[1].toLowerCase(), argument: match[2]?.trim() ?? "" } : null;
}

function argumentFromInteraction(interaction: ChatInputCommandInteraction): string {
  if (interaction.commandName === "prompt") {
    return interaction.options.getString("text") ?? "";
  }
  if (interaction.commandName === "queue") {
    return [interaction.options.getString("action"), interaction.options.getString("id")].filter(Boolean).join(" ");
  }
  if (interaction.commandName === "update") {
    return [interaction.options.getString("target"), interaction.options.getString("agent")].filter(Boolean).join(" ");
  }
  return interaction.options.getString("value") ?? interaction.options.getString("query") ?? interaction.options.getString("thread_id") ?? "";
}

function requiredPermissionForDiscordCommand(command: string, argument: string): Permission | null {
  if (command === "prompt") return "prompt.send";
  if (command === "queue") return argument.trim() ? "queue.write" : "queue.read";
  return permissionForCommand(command);
}

function permissionForDiscordAction(action: string): Permission | null {
  if (action.startsWith("discord_queue_")) return "queue.write";
  if (action.startsWith("discord_abort:")) return "prompt.abort";
  if (action.startsWith("discord_pick:")) return "sessions.write";
  return "inspect";
}

function discordCommands(): Array<Record<string, unknown>> {
  const textOption = (name = "value", description = "Value", required = false): APIApplicationCommandOption => ({
    type: 3,
    name,
    description,
    required,
  });
  return [
    command("start", "Start or inspect the current NordRelay context"),
    command("help", "Show Discord adapter help"),
    command("prompt", "Send a prompt to the selected agent", [textOption("text", "Prompt text", true)]),
    command("agent", "Select or show the active agent", [textOption("value", "Agent id")]),
    command("session", "Show the active session"),
    command("sessions", "Browse recent sessions", [textOption("query", "Search query")]),
    command("new", "Create a new session", [textOption("value", "Workspace path")]),
    command("switch", "Switch to a session", [textOption("thread_id", "Thread id", true)]),
    command("attach", "Attach a session", [textOption("thread_id", "Thread id", true)]),
    command("model", "Select or show models", [textOption("value", "Model id")]),
    command("reasoning", "Select reasoning effort", [textOption("value", "Reasoning value")]),
    command("effort", "Select reasoning effort", [textOption("value", "Reasoning value")]),
    command("fast", "Toggle fast mode", [textOption("value", "on/off")]),
    command("launch", "Select launch profile", [textOption("value", "Launch profile id")]),
    command("queue", "Show or manage queue", [textOption("action", "pause/resume/clear/run/cancel/top/up/down"), textOption("id", "Queue id")]),
    command("clearqueue", "Clear queue"),
    command("cancel", "Cancel queued prompt", [textOption("value", "Queue id", true)]),
    command("abort", "Abort the active task"),
    command("stop", "Abort the active task"),
    command("retry", "Retry the last prompt"),
    command("sync", "Sync from local agent state"),
    command("activity", "Show recent activity", [textOption("value", "Limit")]),
    command("tasks", "Show recent tasks", [textOption("value", "Limit")]),
    command("artifacts", "List or send artifacts", [textOption("value", "zip <turn-id>")]),
    command("logs", "Show logs", [textOption("value", "Target and line count")]),
    command("version", "Show versions"),
    command("status", "Show status"),
    command("health", "Show health"),
    command("diagnostics", "Show diagnostics"),
    command("support", "Show support diagnostics"),
    command("update", "Update NordRelay or agents", [textOption("target", "jobs, install, or agent id"), textOption("agent", "Agent id for install")]),
    command("lock", "Lock this context"),
    command("unlock", "Unlock this context"),
    command("locks", "List locks"),
    command("mirror", "Set mirror mode", [textOption("value", "off/status/final/full")]),
    command("notify", "Set notification mode", [textOption("value", "off/minimal/all")]),
    command("voice", "Show or change voice settings", [textOption("value", "transcribe-only on/off")]),
    command("register_channel", "Enable this Discord channel for NordRelay"),
    command("link", "Link this Discord account with a NordRelay code", [textOption("value", "Link code", true)]),
    command("whoami", "Show linked NordRelay user"),
    command("channels", "Show channel adapters"),
    command("agents", "Show agent adapters"),
  ];
}

function command(name: string, description: string, options: APIApplicationCommandOption[] = []): Record<string, unknown> {
  return {
    name,
    description,
    type: 1,
    dm_permission: true,
    options,
  };
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
