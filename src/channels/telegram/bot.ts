import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";

import { ADMIN_GROUP_ID } from "../../access/access-control.js";
import {
  buildFileInstructions,
  outboxPath,
  stageFile,
  type StagedFile,
} from "../../artifacts/attachments.js";
import {
  collectArtifactReport,
  createArtifactZipBundle,
  ensureOutDir,
  formatArtifactSummary,
  isTelegramImagePreview,
  pruneConnectorTurnDirs,
  telegramArtifactFilename,
  totalArtifactSize,
  type Artifact,
  type ArtifactTurnReport,
} from "../../artifacts/artifacts.js";
import { artifactDeliveryPolicy, resolveArtifactDeliveryPolicy, type ArtifactDeliveryPolicy } from "../../artifacts/artifact-delivery.js";
import type { AgentUpdateOperation } from "../../agents/shared/agent-updates.js";
import type { AuditEvent } from "../../access/audit-log.js";
import { formatSessionLabel } from "./bot-ui.js";
import {
  isQuietNow,
  normalizeMirrorRuntimeMode,
  type ContextPreferences,
  type TelegramMirrorMode,
  type TelegramNotifyMode,
  type VoiceBackendPreference,
} from "../../state/bot-preferences.js";
import { renderAgentUpdateJobAction, type ChannelActionResponse } from "../shared/channel-actions.js";
import { buildArtifactActionsKeyboard } from "../shared/bot-rendering.js";
import type { ChannelContext } from "../shared/channel-adapter.js";
import { createChannelActivityRecorder } from "../shared/channel-bridge-controller.js";
import { createChannelBridgeEnvironment } from "../shared/channel-bridge-environment.js";
import { createChannelPeerMirrorController } from "../shared/channel-peer-mirror.js";
import { remotePeerThreadSourceContextKey } from "../shared/channel-peer-context.js";
import { runChannelPeerPrompt } from "../shared/channel-peer-prompt.js";
import { deliverChannelAction } from "../shared/channel-runtime.js";
import { deliverChannelCliArtifacts } from "../shared/channel-cli-artifacts.js";
import { createChannelExternalMirrorController } from "../shared/channel-external-mirror-controller.js";
import { monitorChannelExternalContexts } from "../shared/channel-external-monitor.js";
import { createChannelExternalMonitorLoop } from "../shared/channel-external-monitor-loop.js";
import { configureChannelRuntime } from "../shared/channel-runtime-bootstrap.js";
import { createChannelTurnLifecycle, createChannelTypingLoop } from "../shared/channel-turn-lifecycle.js";
import { QUEUE_DRAIN_FOLLOW_UP_DELAY_MS, QUEUE_PROMPT_LEASE_TTL_MS, runLeasedQueuedPrompt, scheduleQueuedDrain } from "../shared/channel-prompt-queue.js";
import {
  agentLabel,
  agentReasoningLabel,
  agentReasoningOptions,
  type AgentExternalActivity,
  type AgentExternalSnapshot,
  type AgentId,
  type AgentPromptInput,
  type AgentSessionCallbacks,
  type AgentSessionInfo,
  type AgentSessionService,
  type AgentThreadRecord,
} from "../../agents/shared/agent.js";
import {
  agentIdForAuth as resolveAgentIdForAuth,
  agentLabelForAuth,
  hostAgentLoginCommand,
  hostAgentLogoutCommand,
} from "../../agents/shared/agent-auth-commands.js";
import {
  getExternalActivityForSession,
  getExternalSnapshotForSession,
} from "../../agents/shared/agent-activity.js";
import { checkAuthStatus, clearAuthCache, startLogin as startCodexLogin, startLogout as startCodexLogout, type LoginResult } from "../../agents/codex/codex-auth.js";
import { formatLaunchProfileBehavior } from "../../agents/codex/codex-launch.js";
import type { ConnectorConfig, ToolVerbosity } from "../../core/config.js";
import { contextKeyFromCtx, isTelegramContextKey, isTopicContextKey, parseContextKey, type TelegramContextKey } from "../shared/context-key.js";
import { friendlyErrorText } from "../../core/error-messages.js";
import { escapeHTML } from "../../core/format.js";
import { toPromptEnvelope, webChatAttachmentsForStagedFiles, type PromptEnvelope, type QueuedPrompt } from "../../state/prompt-store.js";
import { redactText } from "../../core/redaction.js";
import { canWriteWithLock } from "../../access/session-locks.js";
import { renderSessionInfoHTML, renderSessionInfoPlain } from "../shared/session-format.js";
import { withSelectedNodeHeader } from "../shared/channel-node-context.js";
import { SessionRegistry } from "../../state/session-registry.js";
import { transcribeAudio, type TranscriptionBackend } from "../../artifacts/voice.js";
import { telegramRateLimiter } from "./telegram-rate-limit.js";
import { registerTelegramExternalApprovalCallbacks } from "./telegram-external-approval.js";
import {
  chatBucket,
  downloadTelegramFile,
  isMessageNotModifiedError,
  renderMarkdownChunkWithinLimit,
  safeEditMessage,
  safeEditReplyMarkup,
  safeReply,
  sendChatActionSafe,
  sendTextMessage,
  splitMarkdownForTelegram,
  type RenderedChunk,
  type RenderedText,
  type TelegramChatId,
  type TextOptions,
} from "./telegram-output.js";
import {
  NOOP_PAGE_CALLBACK_DATA,
  TelegramBotChannelRuntime,
  paginateKeyboard,
  telegramChannelContextFromCtx,
  type KeyboardItem,
} from "./telegram-channel-runtime.js";
import { createTelegramAccessMiddleware } from "./telegram-access-middleware.js";
import { registerTelegramAccessCommands } from "./telegram-access-commands.js";
import { registerTelegramAgentCommands } from "./telegram-agent-commands.js";
import { registerTelegramArtifactCommands } from "./telegram-artifact-commands.js";
import { registerTelegramDiagnosticsCommands } from "./telegram-diagnostics-command.js";
import { registerTelegramGeneralCommands } from "./telegram-general-commands.js";
import { registerTelegramLastCommand } from "./telegram-last-command.js";
import { registerTelegramOperationalCommands } from "./telegram-operational-commands.js";
import { selectedTargetNodeLabel } from "../shared/channel-peer-sessions.js";
import { handleTargetPeerSessionCallback, handleTargetPeerSessionsCommand, registerTelegramNodeTargetCallback, replyTargetPeerSession } from "./telegram-peer-session-commands.js";
import { registerTelegramPreferenceCommands } from "./telegram-preference-commands.js";
import {
  createQueuedPromptCancelKeyboard,
  registerTelegramQueueCommands,
} from "./telegram-queue-commands.js";
import { registerTelegramSupportCommands } from "./telegram-support-command.js";
import { registerTelegramUpdateCommands } from "./telegram-update-commands.js";
import { registerTelegramWorkflowCommands } from "./telegram-workflow-commands.js";
import { registerTelegramErrorHandler } from "./telegram-errors.js";
import {
  canSendSystemMessagesToTelegramContext,
  telegramChannelContextFromKey,
  telegramSystemContext,
} from "./telegram-context.js";
import {
  appendWithCap,
  authHelpText,
  buildStreamingPreview,
  capabilitiesOf,
  filterSessions,
  formatAgentLaunchProfileLabel,
  formatAgentSettingScope,
  formatDurationSeconds,
  formatError,
  formatLocalDateTime,
  formatLockOwner,
  formatModelButtonLabel,
  formatRelativeTime,
  formatTelegramName,
  formatToolSummaryLine,
  formatTurnUsageLine,
  getWorkspaceShortName,
  idOf,
  isEmptyArtifactReport,
  isPromptEnvelopeLike,
  isQueuedPromptLike,
  labelOf,
  orderPinnedSessions,
  parseFastModeArgument,
  renderPromptFailure,
  renderTodoList,
  renderToolEndMessage,
  renderToolStartMessage,
  requiresTurnApproval,
  trimLine,
} from "../shared/bot-rendering.js";
import type { AuthenticatedUser } from "../../access/user-management.js";
import type { WebActivityActor, WebActivityEvent } from "../../web/web-state.js";
import {
  evaluateWorkspacePolicy,
  filterAllowedWorkspaces,
  renderWorkspacePolicyLine,
} from "../../core/workspace-policy.js";
import {
  EDIT_DEBOUNCE_MS,
  LAUNCH_PROFILES_COMMAND,
  MAX_AUDIO_FILE_SIZE,
  MEDIA_GROUP_FLUSH_MS,
  TOOL_OUTPUT_PREVIEW_LIMIT,
  TYPING_INTERVAL_MS,
  type MediaGroupPart,
  type PendingMediaGroup,
  type RateLimitBucket,
  type TelegramBusyReason,
  type TelegramBusyState,
  type TelegramExternalMirrorState,
  type TelegramQueueStatusState,
  type ToolState,
} from "./telegram-runtime-types.js";

export { formatToolSummaryLine, formatTurnUsageLine, summarizeToolName } from "../shared/bot-rendering.js";
export { registerCommands } from "./telegram-command-menu.js";

const CLI_ACTIVITY_ACTOR: WebActivityActor = {
  channel: "cli",
  label: "CLI",
};

type BusyState = TelegramBusyState;
type BusyReason = TelegramBusyReason;
type ExternalMirrorState = TelegramExternalMirrorState;
type QueueStatusState = TelegramQueueStatusState;

export function createBot(config: ConnectorConfig, registry: SessionRegistry): Bot<Context> {
  configureChannelRuntime(config);
  telegramRateLimiter.configure({
    minIntervalMs: config.telegramRateLimitMinIntervalMs,
    editMinIntervalMs: config.telegramEditMinIntervalMs,
    maxRetries: 5,
  });
  const bot = new Bot<Context>(config.telegramBotToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));
  const telegramChannelRuntime = new TelegramBotChannelRuntime(bot);

  const env = createChannelBridgeEnvironment<TelegramContextKey, BusyState, number, ExternalMirrorState>(config, {
    busyDefaults: () => ({
      processing: false,
      switching: false,
      transcribing: false,
      approving: false,
    }),
    agentUpdates: {
      onUpdate: (job) => recordTelegramAgentUpdateLifecycle(job),
    },
  });
  const {
    promptStore,
    preferencesStore,
    activityStore,
    auditLog,
    lockStore,
    userStore,
    authService,
    agentUpdates,
    commandService,
    turnProgress,
    externalMirrors,
    remoteClient,
  } = env;
  const contextBusy = env.busyStates;
  const pendingApprovals = new Map<
    string,
    {
      contextKey: TelegramContextKey;
      prompt: PromptEnvelope;
      requestedBy?: number;
      timeout: NodeJS.Timeout;
    }
  >();
  const pendingSessionPicks = new Map<TelegramContextKey, string[]>();
  const pendingWorkspacePicks = new Map<TelegramContextKey, string[]>();
  const pendingSessionButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingWorkspaceButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingLaunchPicks = new Map<TelegramContextKey, string[]>();
  const pendingLaunchButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingUnsafeLaunchConfirmations = new Map<TelegramContextKey, string>();
  const pendingModelButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingEffortButtons = new Map<TelegramContextKey, KeyboardItem[]>();
  const pendingAgentPicks = new Map<TelegramContextKey, AgentId[]>();
  const pendingMediaGroups = new Map<string, PendingMediaGroup>();
  const contextUsers = new WeakMap<Context, AuthenticatedUser>();
  const agentUpdateActors = new Map<string, WebActivityActor>();
  const agentUpdateStates = new Map<string, { status: string; needsInput: boolean }>();
  const artifactPolicyForTelegram = (input: { contextKey: TelegramContextKey; chatId: TelegramChatId; authUser?: AuthenticatedUser | null }): ArtifactDeliveryPolicy => {
    const parsed = parseContextKey(input.contextKey);
    const channelAccess = parsed.chatId < 0
      ? userStore.snapshot().telegramChats.find((chat) => chat.chatId === parsed.chatId) ?? null
      : null;
    const authUser = input.authUser ?? (parsed.chatId > 0 ? userStore.resolveTelegramUser(parsed.chatId) : null);
    return resolveArtifactDeliveryPolicy({ config, channelId: "telegram", authUser, channelAccess });
  };
  const linkAttempts = new Map<string, RateLimitBucket>();
  const drainingQueues = new Set<TelegramContextKey>();
  const externalQueueTimers = new Map<TelegramContextKey, NodeJS.Timeout>();
  const queueStatusMessages = new Map<TelegramContextKey, QueueStatusState>();
  const externalMonitor = createChannelExternalMonitorLoop({
    label: "Telegram",
    intervalMs: config.codexExternalBusyCheckMs,
    run: () => monitorChannelExternalContexts({
      config,
      registry,
      promptStore,
      isContextKey: isTelegramContextKey,
      canSendSystemMessages: (contextKey) => canSendSystemMessagesToTelegramContext(userStore, contextKey as TelegramContextKey),
      shouldMonitorContext: (contextKey) => getEffectiveMirrorMode(contextKey as TelegramContextKey) !== "off",
      contextForKey: (contextKey) => telegramChannelContextFromKey(contextKey as TelegramContextKey),
      previousLastLine: (contextKey) => externalMirrors.get(contextKey)?.lastLine,
      mirrorSnapshot: async (contextKey, _context, session, snapshot) => {
        const parsed = parseContextKey(contextKey);
        await mirrorExternalSnapshot(contextKey, parsed.chatId, session, snapshot);
      },
      updateQueueStatus: (contextKey, _context, text) => updateQueueStatusMessage(contextKey, text),
      drainQueue: async (contextKey, _context, session) => {
        const parsed = parseContextKey(contextKey);
        await drainQueuedPrompts(telegramSystemContext(bot, contextKey), contextKey, parsed.chatId, session);
      },
    }),
  });
  const syncInterval = config.codexSyncIntervalMs > 0
    ? setInterval(() => {
        try {
          registry.syncAllFromAgentState({ reattach: true });
        } catch (error) {
          console.error("Failed to sync sessions from agent state:", error);
        }
      }, config.codexSyncIntervalMs)
    : undefined;
  syncInterval?.unref?.();
  externalMonitor.start();

  registry.onRemove((key) => {
    contextBusy.delete(key);
    turnProgress.delete(key);
    externalMirrors.delete(key);
    peerMirrorController.close(key);
    queueStatusMessages.delete(key);
    const externalQueueTimer = externalQueueTimers.get(key);
    if (externalQueueTimer) {
      clearTimeout(externalQueueTimer);
      externalQueueTimers.delete(key);
    }
    pendingLaunchPicks.delete(key);
    pendingLaunchButtons.delete(key);
    pendingUnsafeLaunchConfirmations.delete(key);
    pendingAgentPicks.delete(key);
    for (const [mediaGroupKey, mediaGroup] of pendingMediaGroups.entries()) {
      if (mediaGroup.contextKey === key) {
        clearTimeout(mediaGroup.timer);
        pendingMediaGroups.delete(mediaGroupKey);
      }
    }
    promptStore.clear(key);
    for (const [approvalId, approval] of pendingApprovals.entries()) {
      if (approval.contextKey === key) {
        clearTimeout(approval.timeout);
        pendingApprovals.delete(approvalId);
      }
    }
  });

  const getBusyState = (contextKey: TelegramContextKey): BusyState => contextBusy.get(contextKey);

  const getExternalActivity = (session: AgentSessionService | undefined): AgentExternalActivity | null =>
    getExternalActivityForSession(session, config);

  const getBusyReason = (contextKey: TelegramContextKey): BusyReason => {
    const state = contextBusy.peek(contextKey);
    const session = registry.get(contextKey);
    if (state?.processing || state?.switching || state?.transcribing || state?.approving || session?.isProcessing()) {
      return { busy: true, kind: "connector", state: state ?? getBusyState(contextKey) };
    }

    const activity = getExternalActivity(session);
    if (activity?.active) {
      return { busy: true, kind: "external", activity };
    }

    return { busy: false, kind: "idle" };
  };

  const isBusy = (contextKey: TelegramContextKey): boolean => getBusyReason(contextKey).busy;

  const getContextSession = async (ctx: Context, options?: { deferThreadStart?: boolean }): Promise<{ contextKey: TelegramContextKey; session: AgentSessionService } | null> => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return null;
    }

    const session = await registry.getOrCreate(contextKey, options);
    return { contextKey, session };
  };

  const updateSessionMetadata = (contextKey: TelegramContextKey, session: AgentSessionService): void => { registry.updateMetadata(contextKey, session); };

  const checkAgentAuthStatus = (info: AgentSessionInfo): Promise<{ authenticated: boolean; method: string; detail: string }> => authService.check(info).then((status) => ({ ...status, method: status.method ?? "unknown" }));

  const agentIdForAuth = resolveAgentIdForAuth;

  const labelForAuth = agentLabelForAuth;

  const checkLoginAuthStatus = async (info?: AgentSessionInfo): Promise<{ authenticated: boolean; method: string; detail: string }> => {
    const status = info ? await authService.check(info) : await checkAuthStatus(config.codexApiKey);
    return { ...status, method: status.method ?? "unknown" };
  };

  const replyChannelAction = async (ctx: Context, rendered: ChannelActionResponse): Promise<void> => {
    const channelContext = telegramChannelContextFromCtx(ctx);
    if (!channelContext) {
      return;
    }
    const contextKey = contextKeyFromCtx(ctx);
    const renderedWithNode = contextKey ? withSelectedNodeHeader(rendered, selectedTargetNodeLabel(preferencesStore, contextKey)) : rendered;
    await deliverChannelAction(telegramChannelRuntime, channelContext, renderedWithNode);
  };

  const agentUpdateContext = () => ({
    piCliPath: config.piCliPath,
    hermesCliPath: config.hermesCliPath,
    openClawCliPath: config.openClawCliPath,
    claudeCodeCliPath: config.claudeCodeCliPath,
  });

  const startTelegramAgentUpdate = async (ctx: Context, agentId: AgentId, operation: AgentUpdateOperation = "update"): Promise<void> => {
    try {
      const job = agentUpdates.start(agentId, agentUpdateContext(), operation);
      const actor = telegramActivityActor(ctx);
      agentUpdateActors.set(job.id, actor);
      agentUpdateStates.set(job.id, { status: job.status, needsInput: job.needsInput });
      appendActivity({
        source: "telegram",
        status: "info",
        type: operation === "install" ? "agent_install_started" : "agent_update_started",
        threadId: null,
        workspace: config.workspace,
        agentId,
        actor,
        detail: `${job.method}: ${job.summary}`,
      });
      const contextKey = contextKeyFromCtx(ctx);
      if (contextKey) {
        audit({
          action: "command",
          status: "ok",
          contextKey,
          agentId,
          actor,
          actorId: getAuthenticatedUser(ctx)?.user.id ?? ctx.from?.id,
          actorRole: getUserRole(ctx),
          description: `${operation} ${agentId}`,
          detail: job.summary,
        });
      }
      const rendered = renderAgentUpdateJobAction(job);
      await replyChannelAction(ctx, rendered);
    } catch (error) {
      const message = `Failed to start ${agentLabel(agentId)} ${operation}: ${friendlyErrorText(error)}`;
      const label = operation === "install" ? "Install" : "Update";
      await safeReply(ctx, `<b>${label} failed:</b> ${escapeHTML(message)}`, { fallbackText: message });
    }
  };

  const startAgentLogin = (info?: AgentSessionInfo): Promise<LoginResult> => info ? authService.startLogin(info) : startCodexLogin();
  const startAgentLogout = (info?: AgentSessionInfo): Promise<LoginResult> => info ? authService.startLogout(info) : startCodexLogout();
  const hostLoginCommand = (info?: AgentSessionInfo): string => hostAgentLoginCommand(config, info);
  const hostLogoutCommand = (info?: AgentSessionInfo): string => hostAgentLogoutCommand(config, info);

  const isTopicContext = (contextKey: TelegramContextKey): boolean => isTopicContextKey(contextKey);

  const getPreferences = (contextKey: TelegramContextKey): ContextPreferences => preferencesStore.get(contextKey);

  const getEffectiveMirrorMode = (contextKey: TelegramContextKey): TelegramMirrorMode =>
    normalizeMirrorRuntimeMode(getPreferences(contextKey).mirrorMode ?? config.telegramMirrorMode);

  const peerMirrorController = createChannelPeerMirrorController({ label: "Telegram", runtime: telegramChannelRuntime, preferencesStore, remoteClient, contextForKey: (contextKey) => isTelegramContextKey(contextKey) ? telegramChannelContextFromKey(contextKey as TelegramContextKey) : null, defaultMirrorMode: () => config.telegramMirrorMode, mirrorMinUpdateMs: config.telegramEditMinIntervalMs, typingIntervalMs: TYPING_INTERVAL_MS });

  const getEffectiveNotifyMode = (contextKey: TelegramContextKey): TelegramNotifyMode =>
    getPreferences(contextKey).notifyMode ?? config.telegramNotifyMode;

  const getEffectiveQuietHours = (contextKey: TelegramContextKey) =>
    getPreferences(contextKey).quietHours === undefined
      ? config.telegramQuietHours
      : getPreferences(contextKey).quietHours;

  const shouldNotify = (
    contextKey: TelegramContextKey,
    level: "minimal" | "all",
  ): boolean => {
    const mode = getEffectiveNotifyMode(contextKey);
    if (mode === "off" || isQuietNow(getEffectiveQuietHours(contextKey))) {
      return false;
    }
    return mode === "all" || level === "minimal";
  };

  const getEffectiveVoiceBackend = (contextKey: TelegramContextKey): VoiceBackendPreference =>
    getPreferences(contextKey).voiceBackend ?? config.voicePreferredBackend;

  const getEffectiveVoiceLanguage = (contextKey: TelegramContextKey): string | null =>
    getPreferences(contextKey).voiceLanguage === undefined
      ? config.voiceDefaultLanguage ?? null
      : getPreferences(contextKey).voiceLanguage ?? null;

  const isVoiceTranscribeOnly = (contextKey: TelegramContextKey): boolean =>
    getPreferences(contextKey).voiceTranscribeOnly ?? config.voiceTranscribeOnly;

  const clearLaunchSelectionState = (contextKey: TelegramContextKey): void => {
    pendingLaunchPicks.delete(contextKey);
    pendingLaunchButtons.delete(contextKey);
    pendingUnsafeLaunchConfirmations.delete(contextKey);
  };

  const handlePageCallback = (
    pattern: RegExp,
    prefix: string,
    buttonsMap: Map<TelegramContextKey, KeyboardItem[]>,
    expiredMessage: string,
  ): void => {
    bot.callbackQuery(pattern, async (ctx) => {
      const ctxKey = contextKeyFromCtx(ctx);
      const messageId = ctx.callbackQuery.message?.message_id;
      const page = Number.parseInt(ctx.match?.[1] ?? "", 10);
      if (!ctxKey || !messageId || Number.isNaN(page)) {
        await ctx.answerCallbackQuery();
        return;
      }
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.answerCallbackQuery();
        return;
      }
      const buttons = buttonsMap.get(ctxKey);
      if (!buttons) {
        await ctx.answerCallbackQuery({ text: expiredMessage });
        return;
      }
      await ctx.answerCallbackQuery();
      try {
        const keyboard = paginateKeyboard(buttons, page, prefix);
        await safeEditReplyMarkup(bot, chatId, messageId, keyboard);
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error(`Failed to update ${prefix} keyboard page`, error);
        }
      }
    });
  };

  const sendBusyReply = async (ctx: Context): Promise<void> => {
    await safeReply(ctx, escapeHTML("Still working on previous message..."), {
      fallbackText: "Still working on previous message...",
    });
  };

  const updateQueueStatusMessage = async (
    contextKey: TelegramContextKey,
    text: string,
  ): Promise<void> => {
    if (!canSendSystemMessagesToTelegramContext(userStore, contextKey)) {
      return;
    }
    const parsed = parseContextKey(contextKey);
    const html = escapeHTML(text);
    const state = queueStatusMessages.get(contextKey) ?? {};
    if (state.lastText === text && state.messageId) {
      return;
    }

    if (!state.messageId) {
      const message = await sendTextMessage(bot.api, parsed.chatId, html, {
        fallbackText: text,
        messageThreadId: parsed.messageThreadId,
      });
      state.messageId = message.message_id;
      state.lastText = text;
      queueStatusMessages.set(contextKey, state);
      return;
    }

    await safeEditMessage(bot, parsed.chatId, state.messageId, html, { fallbackText: text });
    state.lastText = text;
    queueStatusMessages.set(contextKey, state);
  };

  const maybeRequeuePromptAtFront = (
    contextKey: TelegramContextKey,
    prompt: PromptEnvelope,
  ): QueuedPrompt => {
    if (isQueuedPromptLike(prompt)) {
      promptStore.enqueueFront(contextKey, prompt);
      return prompt;
    }

    const item = promptStore.enqueue(contextKey, prompt);
    promptStore.moveToTop(contextKey, item.id);
    return item;
  };

  const deliverCliGeneratedArtifacts = async (
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: AgentSessionService,
    startedAt: Date | null | undefined,
    turnId: string | null,
    messageThreadId?: number,
  ): Promise<void> => {
    if (!canSendSystemMessagesToTelegramContext(userStore, contextKey)) {
      return;
    }
    await deliverChannelCliArtifacts({
      config,
      contextKey,
      session,
      startedAt,
      turnId,
      state: externalMirrors.get(contextKey),
      autoSend: config.telegramAutoSendArtifacts,
      deliveryPolicy: artifactPolicyForTelegram({ contextKey, chatId }),
      sendSummaryWhenAutoSendDisabled: false,
      logPrefix: "Telegram",
      sendSummary: (summary) => sendTextMessage(bot.api, chatId, escapeHTML(summary), {
        fallbackText: summary,
        messageThreadId,
      }).then(() => {}),
      sendArtifact: (artifact) => sendArtifactFileByApi(bot.api, chatId, artifact, messageThreadId).then(() => {}),
      appendActivity,
    });
  };

  const externalMirrorController = createChannelExternalMirrorController<number>({
    config,
    states: externalMirrors,
    typingIntervalMs: TYPING_INTERVAL_MS,
    minUpdateMs: () => config.telegramMirrorMinUpdateMs,
    mirrorMode: (contextKey) => getEffectiveMirrorMode(contextKey as TelegramContextKey),
    queueLength: (contextKey) => promptStore.list(contextKey as TelegramContextKey).length,
    activityActor: () => CLI_ACTIVITY_ACTOR,
    appendActivity,
    sendTyping: async (contextKey) => {
      const parsed = parseContextKey(contextKey as TelegramContextKey);
      await sendChatActionSafe(bot.api, parsed.chatId, "typing", parsed.messageThreadId).catch(() => {});
    },
    sendWorkingNotice: async (contextKey, _context, state, snapshot, prompt) => {
      const turnKey = snapshot.activity.turnId ?? snapshot.activity.startedAt?.toISOString() ?? "unknown";
      if (state.workingNoticeTurnKey === turnKey) {
        return;
      }
      const parsed = parseContextKey(contextKey as TelegramContextKey);
      const fallbackText = prompt ? `Working on ${prompt}` : `Working on external ${snapshot.agentLabel} task...`;
      const html = prompt
        ? `<b>Working on</b> ${escapeHTML(prompt)}`
        : `<b>Working on</b> external ${escapeHTML(snapshot.agentLabel)} task...`;
      await sendTextMessage(bot.api, parsed.chatId, html, {
        fallbackText,
        messageThreadId: parsed.messageThreadId,
      });
      state.workingNoticeTurnKey = turnKey;
    },
    sendStatus: async (contextKey, _context, _state, rendered) => {
      const parsed = parseContextKey(contextKey as TelegramContextKey);
      const message = await sendTextMessage(bot.api, parsed.chatId, rendered.html, { fallbackText: rendered.plain, messageThreadId: parsed.messageThreadId });
      return message.message_id;
    },
    editStatus: async (contextKey, _context, _state, messageId, rendered) => {
      const parsed = parseContextKey(contextKey as TelegramContextKey);
      await safeEditMessage(bot, parsed.chatId, messageId, rendered.html, {
        fallbackText: rendered.plain,
      });
    },
    sendEvent: async (contextKey, _context, _state, rendered) => {
      const parsed = parseContextKey(contextKey as TelegramContextKey);
      await sendTextMessage(bot.api, parsed.chatId, rendered.html, { fallbackText: rendered.plain, messageThreadId: parsed.messageThreadId });
    },
    sendApprovalRequest: async (contextKey, _context, _state, _snapshot, approval, rendered) => {
      const parsed = parseContextKey(contextKey as TelegramContextKey);
      const keyboard = new InlineKeyboard().text("Proceed", `external_approval_yes:${approval.id}`);
      if (approval.prefixRule.length > 0) keyboard.text("Proceed and remember", `external_approval_persist:${approval.id}`);
      keyboard.row().text("Deny", `external_approval_no:${approval.id}`);
      await sendTextMessage(bot.api, parsed.chatId, rendered.html, { fallbackText: rendered.plain, messageThreadId: parsed.messageThreadId, replyMarkup: keyboard });
    },
    sendDone: async (contextKey, _context, state, text) => {
      const parsed = parseContextKey(contextKey as TelegramContextKey);
      if (state.statusMessageId) {
        await safeEditMessage(bot, parsed.chatId, state.statusMessageId, escapeHTML(text), {
          fallbackText: text,
        });
        return;
      }
      await sendTextMessage(bot.api, parsed.chatId, escapeHTML(text), {
        fallbackText: text,
        messageThreadId: parsed.messageThreadId,
      });
    },
    sendFinalAnswer: async (contextKey, _context, _state, snapshot, text) => {
      const parsed = parseContextKey(contextKey as TelegramContextKey);
      await sendTextMessage(bot.api, parsed.chatId, `<b>${escapeHTML(snapshot.agentLabel)} CLI final answer:</b>`, {
        fallbackText: `${snapshot.agentLabel} CLI final answer:`,
        messageThreadId: parsed.messageThreadId,
      });
      for (const chunk of splitMarkdownForTelegram(text)) {
        await sendTextMessage(bot.api, parsed.chatId, chunk.text, {
          parseMode: chunk.parseMode,
          fallbackText: chunk.fallbackText,
          messageThreadId: parsed.messageThreadId,
        });
      }
    },
    deliverArtifacts: (contextKey, _context, session, state, turnId) => {
      const parsed = parseContextKey(contextKey as TelegramContextKey);
      return deliverCliGeneratedArtifacts(contextKey as TelegramContextKey, parsed.chatId, session, state.startedAt, turnId, parsed.messageThreadId);
    },
    shouldSendDone: (contextKey) => shouldNotify(contextKey as TelegramContextKey, "minimal"),
  });

  const mirrorExternalSnapshot = (
    contextKey: TelegramContextKey,
    _chatId: TelegramChatId,
    session: AgentSessionService,
    snapshot: AgentExternalSnapshot,
  ): Promise<void> => externalMirrorController.mirror(contextKey, telegramChannelContextFromKey(contextKey), session, snapshot);

  const scheduleExternalQueueDrain = (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: AgentSessionService,
  ): void => {
    if (externalQueueTimers.has(contextKey)) {
      return;
    }

    const timer = setTimeout(() => {
      externalQueueTimers.delete(contextKey);
      void (async () => {
        if (promptStore.list(contextKey).length === 0) {
          return;
        }
        if (!canSendSystemMessagesToTelegramContext(userStore, contextKey)) {
          return;
        }

        const busy = getBusyReason(contextKey);
        if (busy.kind === "external") {
          const label = busy.activity.agentLabel;
          await updateQueueStatusMessage(
            contextKey,
            `Waiting for ${label} CLI task... ${promptStore.list(contextKey).length} queued${promptStore.isPaused(contextKey) ? " (paused)" : ""}.`,
          );
          scheduleExternalQueueDrain(ctx, contextKey, chatId, session);
          return;
        }
        if (busy.busy) {
          return;
        }

        await updateQueueStatusMessage(contextKey, `CLI task finished, running queued prompt 1/${promptStore.list(contextKey).length}.`);
        await drainQueuedPrompts(ctx, contextKey, chatId, session);
      })().catch((error) => {
      console.error("Failed to drain queue after external CLI activity:", error);
      });
    }, config.codexExternalBusyCheckMs);

    timer.unref?.();
    externalQueueTimers.set(contextKey, timer);
  };

  const getAuthenticatedUser = (ctx: Context): AuthenticatedUser | null => contextUsers.get(ctx) ?? null;

  const getUserRole = (ctx: Context): string => {
    const authUser = getAuthenticatedUser(ctx);
    return authUser?.groups.map((group) => group.name).join(", ") || "unauthenticated";
  };

  const isAdminUser = (ctx: Context): boolean => Boolean(getAuthenticatedUser(ctx)?.groups.some((group) => group.id === ADMIN_GROUP_ID));

  const audit = (event: Omit<AuditEvent, "id" | "timestamp" | "channelId">): void => {
    try {
      auditLog.append(event);
    } catch (error) {
      console.warn("Failed to write audit event:", error instanceof Error ? error.message : String(error));
    }
  };

  const auditContext = (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: AgentSessionService,
    patch: Omit<AuditEvent, "id" | "timestamp" | "channelId" | "contextKey" | "actor" | "actorId" | "actorRole" | "agentId" | "threadId" | "workspace">,
  ): void => {
    const info = session.getInfo();
    const authUser = getAuthenticatedUser(ctx);
    audit({
      contextKey,
      actor: telegramActivityActor(ctx),
      actorId: authUser?.user.id ?? ctx.from?.id,
      actorRole: getUserRole(ctx),
      agentId: idOf(info),
      threadId: info.threadId,
      workspace: info.workspace,
      ...patch,
    });
  };

  function telegramActivityActor(ctx: Context): WebActivityActor {
    const user = ctx.from;
    const authUser = getAuthenticatedUser(ctx);
    const label = authUser?.user.displayName || formatTelegramName(ctx) || user?.username || (user?.id ? String(user.id) : "Telegram user");
    return {
      channel: "telegram",
      id: authUser?.user.id ?? (user?.id !== undefined ? `telegram:${user.id}` : undefined),
      label,
      username: authUser?.user.email ?? user?.username,
      channelUserId: user?.id !== undefined ? String(user.id) : undefined,
    };
  }

  function appendActivity(input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }): WebActivityEvent {
    return activityStore.append(input);
  }

  const appendTelegramBridgeActivity = createChannelActivityRecorder<{
    contextKey: TelegramContextKey;
    context: ChannelContext;
    authUser?: NonNullable<ReturnType<typeof getAuthenticatedUser>>;
    ctx: Context;
  }>({
    source: "telegram",
    workspace: config.workspace,
    activityStore,
    actorFor: (request) => telegramActivityActor(request.ctx),
  });

  function appendTelegramActivity(
    ctx: Context,
    contextKey: TelegramContextKey,
    session: AgentSessionService,
    input: Partial<Omit<WebActivityEvent, "id" | "timestamp" | "source" | "contextKey">> & Pick<WebActivityEvent, "status" | "type"> & { timestamp?: string },
  ): WebActivityEvent {
    const info = session.getInfo();
    const event = appendTelegramBridgeActivity({
      contextKey,
      context: telegramChannelContextFromCtx(ctx) ?? {
        channelId: "telegram",
        chatId: String(ctx.chat?.id ?? contextKey),
        userId: ctx.from?.id !== undefined ? String(ctx.from.id) : undefined,
        username: ctx.from?.username,
      },
      authUser: getAuthenticatedUser(ctx) ?? undefined,
      ctx,
    }, {
      ...input,
      threadId: input.threadId ?? info.threadId,
      workspace: input.workspace ?? info.workspace,
      agentId: input.agentId ?? idOf(info),
    });
    return event;
  }

  function recordTelegramAgentUpdateLifecycle(job: { id: string; agentId: AgentId; agentLabel: string; operation: AgentUpdateOperation; status: string; needsInput: boolean; startedAt: string; updatedAt: string; finishedAt?: string; error?: string }): void {
    const previous = agentUpdateStates.get(job.id);
    const actor = agentUpdateActors.get(job.id);
    if (job.needsInput && !previous?.needsInput) {
      appendActivity({
        source: "telegram",
        status: "info",
        type: "agent_update_input_required",
        threadId: null,
        workspace: config.workspace,
        agentId: job.agentId,
        actor,
        detail: `${job.agentLabel} ${job.operation} may require input.`,
      });
    }
    if (job.status !== "running" && previous?.status === "running") {
      appendActivity({
        source: "telegram",
        status: job.status === "completed" ? "completed" : job.status === "cancelled" ? "aborted" : "failed",
        type: job.operation === "install" ? `agent_install_${job.status}` : `agent_update_${job.status}`,
        threadId: null,
        workspace: config.workspace,
        agentId: job.agentId,
        actor,
        detail: job.error ?? `${job.agentLabel} ${job.operation} ${job.status}.`,
        durationMs: Math.max(0, Date.parse(job.finishedAt ?? job.updatedAt) - Date.parse(job.startedAt)),
      });
      agentUpdateActors.delete(job.id);
    }
    agentUpdateStates.set(job.id, { status: job.status, needsInput: job.needsInput });
  }

  const denyIfLocked = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: AgentSessionService,
  ): Promise<boolean> => {
    const lock = lockStore.get(contextKey);
    const isAdmin = isAdminUser(ctx);
    if (canWriteWithLock(lock, getAuthenticatedUser(ctx)?.user.id, isAdmin)) {
      return false;
    }

    const owner = formatLockOwner(lock);
    const text = `Session is locked by ${owner}. Use /locks to inspect or ask an admin to /unlock.`;
    auditContext(ctx, contextKey, session, {
      action: "prompt_started",
      status: "denied",
      detail: text,
    });
    appendTelegramActivity(ctx, contextKey, session, {
      status: "failed",
      type: "lock_denied",
      detail: text,
    });
    await safeReply(ctx, escapeHTML(text), { fallbackText: text });
    return true;
  };

  const setReaction = async (ctx: Context, emoji: "👀" | "👍" | "❤" | "🔥" | "👏"): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
    } catch {
      // Reactions may not be available in all chats — fail silently.
    }
  };

  const clearReaction = async (ctx: Context): Promise<void> => {
    if (!config.enableTelegramReactions) {
      return;
    }

    try {
      const chatId = ctx.chat?.id;
      const messageId = ctx.message?.message_id;
      if (!chatId || !messageId) return;
      await ctx.api.setMessageReaction(chatId, messageId, []);
    } catch {
      // Fail silently.
    }
  };

  const ensureActiveThread = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: AgentSessionService,
  ): Promise<boolean> => {
    if (session.hasActiveThread()) {
      return true;
    }

    try {
      await registry.startNewThread(contextKey, session);
      updateSessionMetadata(contextKey, session);
      return true;
    } catch (error) {
      await safeReply(ctx, escapeHTML(`Failed to create thread: ${friendlyErrorText(error)}`), {
        fallbackText: `Failed to create thread: ${friendlyErrorText(error)}`,
      });
      return false;
    }
  };

  const requestTurnApproval = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    prompt: PromptEnvelope,
  ): Promise<void> => {
    const approvalId = randomUUID().slice(0, 8);
    const busyState = getBusyState(contextKey);
    busyState.approving = true;

    const timeout = setTimeout(() => {
      const pending = pendingApprovals.get(approvalId);
      if (!pending) {
        return;
      }
      pendingApprovals.delete(approvalId);
      getBusyState(contextKey).approving = false;
      if (!canSendSystemMessagesToTelegramContext(userStore, contextKey)) {
        return;
      }
      const parsed = parseContextKey(contextKey);
      void sendTextMessage(bot.api, parsed.chatId, `Approval timed out for prompt ${approvalId}.`, {
        messageThreadId: parsed.messageThreadId,
      }).catch((error) => {
        console.error("Failed to send approval timeout message:", error);
      });
    }, 5 * 60 * 1000);

    pendingApprovals.set(approvalId, {
      contextKey,
      prompt,
      requestedBy: ctx.from?.id,
      timeout,
    });

    const keyboard = new InlineKeyboard()
      .text("Approve once", `approval_yes:${approvalId}`)
      .row()
      .text("Deny", `approval_no:${approvalId}`);
    const plain = [
      `Approval required for prompt ${approvalId}.`,
      `Prompt: ${prompt.description}`,
      "This is required because the current launch profile is review/unsafe.",
    ].join("\n");
    const html = [
      `<b>Approval required</b> <code>${escapeHTML(approvalId)}</code>`,
      `<b>Prompt:</b> ${escapeHTML(prompt.description)}`,
      "This is required because the current launch profile is review/unsafe.",
    ].join("\n");
    await safeReply(ctx, html, { fallbackText: plain, replyMarkup: keyboard });
  };

  const handleRemoteUserPrompt = async (ctx: Context, contextKey: TelegramContextKey, chatId: TelegramChatId, prompt: PromptEnvelope): Promise<boolean> => {
    const preferences = preferencesStore.get(contextKey), targetPeerId = preferences.targetPeerId ?? undefined;
    const { messageThreadId } = parseContextKey(contextKey);
    return runChannelPeerPrompt<number>({
      targetPeerId,
      targetThreadId: preferences.targetThreadId,
      contextKey,
      prompt,
      remoteClient,
      mirrorMode: () => getEffectiveMirrorMode(contextKey),
      canUsePeer: (peerId) => userStore.canUsePeer(getAuthenticatedUser(ctx), peerId),
      editMinIntervalMs: config.telegramEditMinIntervalMs,
      typingIntervalMs: TYPING_INTERVAL_MS,
      sendTyping: () => sendChatActionSafe(ctx.api, chatId, "typing", messageThreadId),
      sendResponse: async (text) => {
        const message = await sendTextMessage(ctx.api, chatId, escapeHTML(text), {
          fallbackText: text,
          messageThreadId,
        });
        return message.message_id;
      },
      editResponse: (messageId, text) => safeEditMessage(bot, chatId, messageId, escapeHTML(text), {
        fallbackText: text,
      }),
      sendTurnStart: (remotePrompt) => safeReply(ctx, `<b>Remote peer working on:</b>\n${escapeHTML(remotePrompt)}`, {
        fallbackText: `Remote peer working on:\n${remotePrompt}`,
      }),
      sendToolStart: (toolName) => safeReply(ctx, `<b>Remote tool:</b> <code>${escapeHTML(toolName)}</code>`, {
        fallbackText: `Remote tool: ${toolName}`,
      }),
      sendQueued: async (queueId) => {
        const keyboard = queueId ? new InlineKeyboard().text("Cancel queued message", `peer_queue_cancel:${targetPeerId}:${queueId}`) : undefined;
        await safeReply(ctx, escapeHTML(`Remote prompt queued${queueId ? `: ${queueId}` : ""}.`), {
          fallbackText: `Remote prompt queued${queueId ? `: ${queueId}` : ""}.`,
          replyMarkup: keyboard,
        });
      },
      sendCompleted: () => safeReply(ctx, escapeHTML("Remote turn completed."), { fallbackText: "Remote turn completed." }),
      sendFailure: (message) => safeReply(ctx, escapeHTML(`Remote peer failed: ${message}`), {
        fallbackText: `Remote peer failed: ${message}`,
      }),
    });
  };

  bot.callbackQuery(/^peer_queue_cancel:([^:]+):([a-z0-9]+)$/, async (ctx) => {
    const targetPeerId = ctx.match?.[1];
    const queueId = ctx.match?.[2];
    const contextKey = contextKeyFromCtx(ctx);
    if (!targetPeerId || !queueId || !contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }
    try {
      if (!userStore.canUsePeer(getAuthenticatedUser(ctx), targetPeerId)) throw new Error(`Access denied for peer target: ${targetPeerId}.`);
      const sourceContextKey = remotePeerThreadSourceContextKey(contextKey, preferencesStore.get(contextKey).targetThreadId);
      await remoteClient.webProxy(targetPeerId, {
        method: "POST",
        path: "/api/queue",
        body: { action: "cancel", id: queueId },
        contextKey: sourceContextKey,
      }, telegramActivityActor(ctx), sourceContextKey);
      await ctx.answerCallbackQuery({ text: `Cancelled remote queued prompt ${queueId}.` });
      const chatId = ctx.chat?.id;
      const messageId = ctx.callbackQuery.message?.message_id;
      if (chatId && messageId) {
        await safeEditMessage(bot, chatId, messageId, escapeHTML(`Cancelled remote queued prompt ${queueId}.`), {
          fallbackText: `Cancelled remote queued prompt ${queueId}.`,
        });
      }
    } catch (error) {
      await ctx.answerCallbackQuery({ text: friendlyErrorText(error), show_alert: true });
    }
  });

  registerTelegramNodeTargetCallback({ bot, commandService, preferencesStore, canUsePeer: (ctx, peerId) => userStore.canUsePeer(getAuthenticatedUser(ctx), peerId), syncPeerMirror: (key) => peerMirrorController.sync(key, telegramChannelContextFromKey(key)) });
  const handleUserPrompt = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: AgentSessionService,
    prompt: AgentPromptInput | PromptEnvelope,
    options: { fromQueue?: boolean; approved?: boolean } = {},
  ): Promise<void> => {
    if (!canSendSystemMessagesToTelegramContext(userStore, contextKey)) {
      return;
    }
    const parsed = parseContextKey(contextKey);
    const messageThreadId = parsed.messageThreadId;
    const rawEnvelope = isPromptEnvelopeLike(prompt) ? prompt : toPromptEnvelope(prompt);
    const envelope: PromptEnvelope = {
      ...rawEnvelope,
      activityActor: rawEnvelope.activityActor ?? telegramActivityActor(ctx),
    };

    if (!options.fromQueue && await handleRemoteUserPrompt(ctx, contextKey, chatId, envelope)) {
      return;
    }

    if (!options.fromQueue && await denyIfLocked(ctx, contextKey, session)) {
      return;
    }

    const busy = getBusyReason(contextKey);
    if (busy.busy) {
      if (options.fromQueue) {
        maybeRequeuePromptAtFront(contextKey, envelope);
        if (busy.kind === "external") {
          scheduleExternalQueueDrain(ctx, contextKey, chatId, session);
        }
        await sendBusyReply(ctx);
        return;
      }

      const item = promptStore.enqueue(contextKey, envelope);
      const position = promptStore.list(contextKey).findIndex((queued) => queued.id === item.id) + 1;
      const label = labelOf(session.getInfo());
      const queuedMessage = busy.kind === "external"
        ? `Queued prompt ${item.id} at position ${position}. The ${label} session is still active and is processing a previous task.`
        : `Queued prompt ${item.id} at position ${position}.`;
      await safeReply(ctx, escapeHTML(queuedMessage), {
        fallbackText: queuedMessage,
        replyMarkup: createQueuedPromptCancelKeyboard(contextKey, item.id),
      });
      auditContext(ctx, contextKey, session, {
        action: "prompt_queued",
        status: "ok",
        promptId: item.id,
        description: item.description,
        detail: busy.kind,
      });
      appendTelegramActivity(ctx, contextKey, session, {
        status: "queued",
        type: "prompt_queued",
        prompt: item.description,
        detail: `Queued prompt ${item.id} at position ${position}; busy=${busy.kind}`,
        actor: envelope.activityActor,
      });
      if (busy.kind === "external") {
        scheduleExternalQueueDrain(ctx, contextKey, chatId, session);
      }
      return;
    }

    if (!options.approved && requiresTurnApproval(session.getInfo())) {
      await requestTurnApproval(ctx, contextKey, envelope);
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.processing = true;
    const turnLifecycle = createChannelTurnLifecycle(envelope.description);
    const progress = turnLifecycle.progress;
    turnProgress.set(contextKey, progress);

    const abortKeyboard = new InlineKeyboard().text("⏹ Abort", `agent_abort:${contextKey}`);
    const toolVerbosity: ToolVerbosity = config.toolVerbosity;
    const toolStates = new Map<string, ToolState>();
    const toolCounts = new Map<string, number>();
    let accumulatedText = "";
    let responseMessageId: number | undefined;
    let responseMessagePromise: Promise<void> | undefined;
    let lastRenderedText = "";
    let lastEditAt = 0;
    let flushTimer: NodeJS.Timeout | undefined;
    let isFlushing = false;
    let flushPending = false;
    let finalized = false;
    let planMessageId: number | undefined;
    let lastRenderedPlan = "";
    let planMessageSending = false;
    let lastTurnUsage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;
    let promptStartedAt: number | undefined;
    const toolActivityNames = new Map<string, string>();
    const toolActivityStartedAt = new Map<string, number>();

    const typingLoop = createChannelTypingLoop({
      intervalMs: TYPING_INTERVAL_MS,
      sendTyping: () => sendChatActionSafe(bot.api, chatId, "typing", messageThreadId),
    });
    typingLoop.start();

    const stopTyping = (): void => {
      typingLoop.stop();
    };

    const clearFlushTimer = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
    };

    const renderPreview = (): RenderedChunk => {
      const previewText = buildStreamingPreview(accumulatedText);
      return renderMarkdownChunkWithinLimit(previewText);
    };

    const buildFinalResponseText = (text: string): string => {
      const trimmedText = text.trim();
      const usageLine =
        config.showTurnTokenUsage && lastTurnUsage ? formatTurnUsageLine(lastTurnUsage) : "";

      if (toolVerbosity === "summary") {
        const footerLines = [formatToolSummaryLine(toolCounts), usageLine].filter((line): line is string => Boolean(line));
        if (footerLines.length === 0) {
          return trimmedText;
        }

        const footer = footerLines.join("\n");
        return trimmedText ? `${trimmedText}\n\n${footer}` : footer;
      }

      if (toolVerbosity === "all" && usageLine) {
        return trimmedText ? `${trimmedText}\n\n${usageLine}` : usageLine;
      }

      return trimmedText;
    };

    const ensureResponseMessage = async (): Promise<void> => {
      if (responseMessageId) {
        return;
      }
      if (responseMessagePromise) {
        await responseMessagePromise;
        return;
      }

      responseMessagePromise = (async () => {
        const preview = renderPreview();
        const message = await sendTextMessage(bot.api, chatId, preview.text, {
          parseMode: preview.parseMode,
          fallbackText: preview.fallbackText,
          replyMarkup: abortKeyboard,
          messageThreadId,
        });
        responseMessageId = message.message_id;
        lastRenderedText = preview.text;
        lastEditAt = Date.now();
      })();

      try {
        await responseMessagePromise;
      } finally {
        responseMessagePromise = undefined;
      }
    };

    const flushResponse = async (force = false): Promise<void> => {
      if (!accumulatedText) {
        return;
      }
      if (!responseMessageId) {
        await ensureResponseMessage();
        return;
      }
      if (isFlushing) {
        flushPending = true;
        return;
      }

      const now = Date.now();
      if (!force && now - lastEditAt < EDIT_DEBOUNCE_MS) {
        return;
      }

      const nextText = renderPreview();
      if (nextText.text === lastRenderedText) {
        return;
      }

      isFlushing = true;
      try {
        await safeEditMessage(bot, chatId, responseMessageId, nextText.text, {
          parseMode: nextText.parseMode,
          fallbackText: nextText.fallbackText,
          replyMarkup: abortKeyboard,
        });
        lastRenderedText = nextText.text;
        lastEditAt = Date.now();
      } finally {
        isFlushing = false;
        if (flushPending) {
          flushPending = false;
          scheduleFlush();
        }
      }
    };

    const scheduleFlush = (): void => {
      if (flushTimer || finalized) {
        return;
      }

      const delay = Math.max(0, EDIT_DEBOUNCE_MS - (Date.now() - lastEditAt));
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void flushResponse().catch((error) => {
          console.error("Failed to update Telegram response message", error);
        });
      }, delay);
    };

    const removeAbortKeyboard = async (): Promise<void> => {
      if (!responseMessageId) {
        return;
      }

      try {
        await safeEditReplyMarkup(bot, chatId, responseMessageId);
      } catch (error) {
        if (!isMessageNotModifiedError(error)) {
          console.error("Failed to clear Abort button", error);
        }
      }
    };

    const deliverRenderedChunks = async (chunks: RenderedChunk[]): Promise<void> => {
      if (chunks.length === 0) {
        return;
      }

      const [firstChunk, ...remainingChunks] = chunks;
      if (responseMessageId) {
        await safeEditMessage(bot, chatId, responseMessageId, firstChunk.text, {
          parseMode: firstChunk.parseMode,
          fallbackText: firstChunk.fallbackText,
        });
        await removeAbortKeyboard();
      } else {
        const message = await sendTextMessage(bot.api, chatId, firstChunk.text, {
          parseMode: firstChunk.parseMode,
          fallbackText: firstChunk.fallbackText,
          messageThreadId,
        });
        responseMessageId = message.message_id;
      }

      for (const chunk of remainingChunks) {
        await sendTextMessage(bot.api, chatId, chunk.text, {
          parseMode: chunk.parseMode,
          fallbackText: chunk.fallbackText,
          messageThreadId,
        });
      }
    };

    const finalizeResponse = async (): Promise<void> => {
      if (finalized) {
        return;
      }
      finalized = true;
      turnLifecycle.recordCompleted();

      stopTyping();
      clearFlushTimer();
      if (responseMessagePromise) {
        try {
          await responseMessagePromise;
        } catch {
          // If the initial send failed, we will fall back to sending the final response below.
        }
      }

      const finalText = buildFinalResponseText(accumulatedText);
      if (!finalText) {
        const html = "<b>✅ Done</b>";
        const plainText = "✅ Done";

        if (responseMessageId) {
          await safeEditMessage(bot, chatId, responseMessageId, html, { fallbackText: plainText });
          await removeAbortKeyboard();
        } else {
          await safeReply(ctx, html, { fallbackText: plainText });
        }
        return;
      }

      await deliverRenderedChunks(splitMarkdownForTelegram(finalText));
    };

    const callbacks: AgentSessionCallbacks = {
      onTextDelta: (delta: string) => {
        accumulatedText += delta;
        turnLifecycle.recordTextDelta(delta.length);
        if (!responseMessageId) {
          void ensureResponseMessage()
            .then(() => {
              scheduleFlush();
            })
            .catch((error) => {
              console.error("Failed to send initial Telegram response message", error);
            });
          return;
        }

        scheduleFlush();
      },
      onToolStart: (toolName: string, toolCallId: string) => {
        turnLifecycle.recordToolStart(toolName);
        toolActivityNames.set(toolCallId, toolName);
        toolActivityStartedAt.set(toolCallId, Date.now());
        appendTelegramActivity(ctx, contextKey, session, {
          status: "running",
          type: "tool_started",
          prompt: envelope.description,
          detail: toolName,
          actor: envelope.activityActor,
        });
        if (toolVerbosity === "summary") {
          toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
          return;
        }

        if (toolVerbosity === "none") {
          return;
        }

        toolStates.set(toolCallId, { toolName, partialResult: "" });
        if (toolVerbosity !== "all") {
          return;
        }

        const messageText = renderToolStartMessage(toolName);

        void (async () => {
          const message = await sendTextMessage(bot.api, chatId, messageText.text, {
            parseMode: messageText.parseMode,
            fallbackText: messageText.fallbackText,
            messageThreadId,
          });
          const state = toolStates.get(toolCallId);
          if (!state) {
            return;
          }

          state.messageId = message.message_id;
          if (state.finalStatus) {
            await safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
              parseMode: state.finalStatus.parseMode,
              fallbackText: state.finalStatus.fallbackText,
            });
          }
        })().catch((error) => {
          console.error(`Failed to send tool start message for ${toolName}`, error);
        });
      },
      onToolUpdate: (toolCallId: string, partialResult: string) => {
        turnLifecycle.recordToolUpdate();
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state || !partialResult) {
          return;
        }

        state.partialResult = appendWithCap(state.partialResult, partialResult, TOOL_OUTPUT_PREVIEW_LIMIT);
      },
      onToolEnd: (toolCallId: string, isError: boolean) => {
        turnLifecycle.recordToolEnd();
        const activityToolName = toolActivityNames.get(toolCallId) ?? "tool";
        const activityStartedAt = toolActivityStartedAt.get(toolCallId);
        appendTelegramActivity(ctx, contextKey, session, {
          status: isError ? "failed" : "completed",
          type: isError ? "tool_failed" : "tool_completed",
          prompt: envelope.description,
          detail: activityToolName,
          actor: envelope.activityActor,
          durationMs: activityStartedAt ? Date.now() - activityStartedAt : undefined,
        });
        toolActivityNames.delete(toolCallId);
        toolActivityStartedAt.delete(toolCallId);
        if (toolVerbosity === "none" || toolVerbosity === "summary") {
          return;
        }

        const state = toolStates.get(toolCallId);
        if (!state) {
          return;
        }

        state.finalStatus = renderToolEndMessage(state.toolName, state.partialResult, isError);
        if (toolVerbosity === "errors-only") {
          if (!isError) {
            return;
          }

          void sendTextMessage(bot.api, chatId, state.finalStatus.text, {
            parseMode: state.finalStatus.parseMode,
            fallbackText: state.finalStatus.fallbackText,
            messageThreadId,
          }).catch((error) => {
            console.error(`Failed to send tool error message for ${state.toolName}`, error);
          });
          return;
        }

        if (!state.messageId) {
          return;
        }

        void safeEditMessage(bot, chatId, state.messageId, state.finalStatus.text, {
          parseMode: state.finalStatus.parseMode,
          fallbackText: state.finalStatus.fallbackText,
        }).catch((error) => {
          console.error(`Failed to update tool message for ${state.toolName}`, error);
        });
      },
      onTodoUpdate: (items) => {
        turnLifecycle.touch();
        if (toolVerbosity === "none") {
          return;
        }

        const rendered = renderTodoList(items);
        if (rendered === lastRenderedPlan) {
          return;
        }

        lastRenderedPlan = rendered;
        if (!planMessageId) {
          if (planMessageSending) return;
          planMessageSending = true;
          void sendTextMessage(bot.api, chatId, rendered, { parseMode: "HTML", messageThreadId })
            .then((msg) => {
              planMessageId = msg.message_id;
            })
            .catch((err) => {
              console.error("Failed to send plan message", err);
            })
            .finally(() => {
              planMessageSending = false;
            });
        } else {
          void safeEditMessage(bot, chatId, planMessageId, rendered, { parseMode: "HTML" }).catch((err) => {
            console.error("Failed to update plan message", err);
          });
        }
      },
      onTurnComplete: (usage) => {
        lastTurnUsage = usage;
        turnLifecycle.touch();
      },
      onAgentEnd: () => {
        void finalizeResponse().catch((error) => {
          console.error("Failed to finalize Telegram response message", error);
        });
      },
    };

    try {
      const sessionInfo = session.getInfo();
      if (capabilitiesOf(sessionInfo).auth) {
        const authStatus = await checkAgentAuthStatus(sessionInfo);
        if (!authStatus.authenticated) {
          await safeReply(
            ctx,
            [
              `<b>⚠️ ${escapeHTML(labelOf(sessionInfo))} is not authenticated.</b>`,
              "",
              `<code>${escapeHTML(authStatus.detail)}</code>`,
              "",
              authHelpText(sessionInfo),
            ].join("\n"),
            {
              fallbackText: [
                `⚠️ ${labelOf(sessionInfo)} is not authenticated.`,
                "",
                authStatus.detail,
                "",
                authHelpText(sessionInfo),
              ].join("\n"),
            },
          );
          return;
        }
      }

      if (idOf(sessionInfo) === "pi" && !config.piEnabled) {
        await safeReply(
          ctx,
          "<b>⚠️ Pi is disabled.</b>\nEnable it with <code>NORDRELAY_PI_ENABLED=true</code>.",
          {
            fallbackText: "⚠️ Pi is disabled.\nEnable it with NORDRELAY_PI_ENABLED=true.",
          },
        );
        return;
      }

      if (idOf(sessionInfo) === "hermes" && !config.hermesEnabled) {
        await safeReply(
          ctx,
          "<b>⚠️ Hermes is disabled.</b>\nEnable it with <code>NORDRELAY_HERMES_ENABLED=true</code>.",
          {
            fallbackText: "⚠️ Hermes is disabled.\nEnable it with NORDRELAY_HERMES_ENABLED=true.",
          },
        );
        return;
      }

      if (idOf(sessionInfo) === "openclaw" && !config.openClawEnabled) {
        await safeReply(
          ctx,
          "<b>⚠️ OpenClaw is disabled.</b>\nEnable it with <code>NORDRELAY_OPENCLAW_ENABLED=true</code>.",
          {
            fallbackText: "⚠️ OpenClaw is disabled.\nEnable it with NORDRELAY_OPENCLAW_ENABLED=true.",
          },
        );
        return;
      }

      if (idOf(sessionInfo) === "claude-code" && !config.claudeCodeEnabled) {
        await safeReply(
          ctx,
          "<b>⚠️ Claude Code is disabled.</b>\nEnable it with <code>NORDRELAY_CLAUDE_CODE_ENABLED=true</code>.",
          {
            fallbackText: "⚠️ Claude Code is disabled.\nEnable it with NORDRELAY_CLAUDE_CODE_ENABLED=true.",
          },
        );
        return;
      }

      if (!(await ensureActiveThread(ctx, contextKey, session))) {
        return;
      }
      const workspacePolicy = evaluateWorkspacePolicy(session.getInfo().workspace, config);
      if (!workspacePolicy.allowed) {
        await safeReply(ctx, `<b>Workspace blocked:</b> ${escapeHTML(workspacePolicy.warning ?? "Current workspace is blocked by policy.")}`, {
          fallbackText: `Workspace blocked: ${workspacePolicy.warning ?? "Current workspace is blocked by policy."}`,
        });
        return;
      }

      const finalExternalActivity = getExternalActivity(session);
      if (finalExternalActivity?.active) {
        const item = maybeRequeuePromptAtFront(contextKey, envelope);
        const label = finalExternalActivity.agentLabel;
        const message = `Queued prompt ${item.id} at position 1. The ${label} session became active in ${label} CLI and is processing another task.`;
        await safeReply(ctx, escapeHTML(message), {
          fallbackText: message,
          replyMarkup: createQueuedPromptCancelKeyboard(contextKey, item.id),
        });
        await updateQueueStatusMessage(contextKey, `Waiting for ${label} CLI task... ${promptStore.list(contextKey).length} queued.`);
        appendTelegramActivity(ctx, contextKey, session, {
          status: "queued",
          type: "prompt_queued",
          prompt: item.description,
          detail: `Queued prompt ${item.id} at position 1; external ${label} CLI task active`,
          actor: envelope.activityActor,
        });
        scheduleExternalQueueDrain(ctx, contextKey, chatId, session);
        turnProgress.delete(contextKey);
        return;
      }

      promptStore.setLastPrompt(contextKey, envelope);
      promptStartedAt = Date.now();
      appendTelegramActivity(ctx, contextKey, session, {
        status: "running",
        type: "prompt_started",
        prompt: envelope.description,
        actor: envelope.activityActor,
      });
      auditContext(ctx, contextKey, session, {
        action: "prompt_started",
        status: "ok",
        description: envelope.description,
      });
      const artifactStartedAt = new Date();
      const artifactTurnId = envelope.artifactOutDir
        ? path.basename(path.dirname(envelope.artifactOutDir))
        : randomUUID().slice(0, 12);
      await session.prompt(envelope.input, callbacks);
      updateSessionMetadata(contextKey, session);
      await finalizeResponse();
      await deliverCliGeneratedArtifacts(contextKey, chatId, session, artifactStartedAt, artifactTurnId, messageThreadId);
      if (config.artifactsEnabled && envelope.artifactOutDir) {
        const artifactPolicy = artifactPolicyForTelegram({ contextKey, chatId, authUser: getAuthenticatedUser(ctx) });
        if (artifactPolicy.sendSummary || artifactPolicy.autoSendFiles || artifactPolicy.autoSendZip) {
          await deliverArtifacts(ctx, chatId, envelope.artifactOutDir, session.getInfo().workspace, messageThreadId, artifactPolicy);
        } else {
          await pruneArtifacts(session.getInfo().workspace);
        }
      }
      turnLifecycle.recordCompleted();
      auditContext(ctx, contextKey, session, {
        action: "prompt_completed",
        status: "ok",
        description: envelope.description,
      });
      appendTelegramActivity(ctx, contextKey, session, {
        status: "completed",
        type: "prompt_completed",
        prompt: envelope.description,
        actor: envelope.activityActor,
        durationMs: promptStartedAt ? Date.now() - promptStartedAt : undefined,
      });
    } catch (error) {
      turnLifecycle.recordFailed(friendlyErrorText(error));
      auditContext(ctx, contextKey, session, {
        action: "prompt_failed",
        status: "failed",
        description: envelope.description,
        detail: progress.error,
      });
      if (promptStartedAt) {
        appendTelegramActivity(ctx, contextKey, session, {
          status: "failed",
          type: "prompt_failed",
          prompt: envelope.description,
          detail: progress.error,
          actor: envelope.activityActor,
          durationMs: Date.now() - promptStartedAt,
        });
      }
      stopTyping();
      clearFlushTimer();
      if (responseMessagePromise) {
        try {
          await responseMessagePromise;
        } catch {
          // Ignore; we will send an error message below.
        }
      }

      if (finalized) {
        console.error("Codex prompt error after finalization:", formatError(error));
      } else {
        finalized = true;

        const combinedText = buildFinalResponseText(renderPromptFailure(accumulatedText, error));
        const chunks = splitMarkdownForTelegram(combinedText);
        try {
          await deliverRenderedChunks(chunks);
        } catch (telegramError) {
          console.error("Failed to send error message to Telegram:", telegramError);
        }
      }
    } finally {
      stopTyping();
      clearFlushTimer();
      busyState.processing = false;
      void drainQueuedPrompts(ctx, contextKey, chatId, session).catch((error) => {
        console.error("Failed to drain queued prompts:", error);
      });
    }
  };

  const startUserPrompt = (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: AgentSessionService,
    prompt: AgentPromptInput | PromptEnvelope,
    options: { fromQueue?: boolean; approved?: boolean; reaction?: boolean } = {},
  ): Promise<void> => {
    const { reaction = true, ...promptOptions } = options;
    void (async () => {
      if (reaction) {
        await setReaction(ctx, "👀");
      }
      try {
        await handleUserPrompt(ctx, contextKey, chatId, session, prompt, promptOptions);
        if (reaction) {
          await setReaction(ctx, "👍");
        }
      } catch (error) {
        if (reaction) {
          await clearReaction(ctx);
        }
        console.error("Failed to run Telegram prompt in background:", error);
      }
    })();
    return Promise.resolve();
  };

  const drainQueuedPrompts = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: AgentSessionService,
  ): Promise<void> => {
    if (drainingQueues.has(contextKey)) {
      return;
    }
    if (!canSendSystemMessagesToTelegramContext(userStore, contextKey)) {
      return;
    }

    drainingQueues.add(contextKey);
    let startedPrompt = false;
    try {
      if (promptStore.isPaused(contextKey)) {
        await updateQueueStatusMessage(contextKey, `Queue paused. ${promptStore.list(contextKey).length} queued.`);
        return;
      }

      const busy = getBusyReason(contextKey);
      if (busy.busy) {
        if (busy.kind === "external") scheduleExternalQueueDrain(ctx, contextKey, chatId, session);
        return;
      }
      const leaseOwner = `telegram:${contextKey}`;
      const next = promptStore.leaseNext(contextKey, leaseOwner, QUEUE_PROMPT_LEASE_TTL_MS);
      if (!next) {
        const nextRunnableAt = promptStore.nextRunnableAt(contextKey);
        const queued = promptStore.list(contextKey).length;
        if (nextRunnableAt && queued > 0) {
          await updateQueueStatusMessage(contextKey, `Next queued prompt is scheduled for ${formatLocalDateTime(new Date(nextRunnableAt))}. ${queued} queued.`);
        }
        return;
      }

      startedPrompt = true;
      const remainingBeforeRun = promptStore.list(contextKey).length;
      await updateQueueStatusMessage(contextKey, `Running queued prompt 1/${remainingBeforeRun}: ${next.description}`);
      await safeReply(ctx, escapeHTML(`Processing queued prompt ${next.id}: ${next.description}`), {
        fallbackText: `Processing queued prompt ${next.id}: ${next.description}`,
      });
      await runLeasedQueuedPrompt({ renew: () => promptStore.renewLease(contextKey, next, leaseOwner, QUEUE_PROMPT_LEASE_TTL_MS), complete: () => promptStore.completeLease(contextKey, next, leaseOwner), fail: (message) => promptStore.failLease(contextKey, next, leaseOwner, message), run: () => handleUserPrompt(ctx, contextKey, chatId, session, next, { fromQueue: true }) });
    } finally {
      drainingQueues.delete(contextKey);
    }
    if (startedPrompt && promptStore.list(contextKey).length > 0 && !promptStore.isPaused(contextKey)) {
      scheduleQueuedDrain(() => void drainQueuedPrompts(ctx, contextKey, chatId, session)
        .catch((error) => console.error("Failed to drain queued Telegram prompts:", error)), QUEUE_DRAIN_FOLLOW_UP_DELAY_MS);
    }
  };

  const deliverArtifacts = async (
    ctx: Context,
    chatId: TelegramChatId,
    outDir: string,
    workspace: string,
    messageThreadId?: number,
    policy: ArtifactDeliveryPolicy = artifactPolicyForTelegram({ contextKey: contextKeyFromCtx(ctx) ?? String(chatId), chatId, authUser: getAuthenticatedUser(ctx) }),
  ): Promise<void> => {
    const { artifacts, skippedCount } = await collectArtifactReport(outDir, config.maxFileSize);
    const report: ArtifactTurnReport = {
      turnId: path.basename(path.dirname(outDir)) || "turn",
      outDir,
      updatedAt: new Date(),
      artifacts,
      skippedCount,
      totalSizeBytes: totalArtifactSize(artifacts),
      source: "turn",
    };
    await deliverArtifactReport(ctx, chatId, report, messageThreadId, policy);
    const contextKey = contextKeyFromCtx(ctx);
    const session = contextKey ? registry.get(contextKey) : undefined;
    if (contextKey && session) {
      appendTelegramActivity(ctx, contextKey, session, {
        status: "info",
        type: "artifacts_sent",
        detail: formatArtifactSummary(report.artifacts, report.skippedCount, report.omittedCount),
      });
    }
    await pruneArtifacts(workspace);
  };

  const deliverArtifactReport = async (
    ctx: Context,
    chatId: TelegramChatId,
    report: ArtifactTurnReport,
    messageThreadId?: number,
    policy: ArtifactDeliveryPolicy = artifactPolicyForTelegram({ contextKey: contextKeyFromCtx(ctx) ?? String(chatId), chatId, authUser: getAuthenticatedUser(ctx) }),
  ): Promise<void> => {
    if (isEmptyArtifactReport(report)) {
      return;
    }

    await sendChatActionSafe(ctx.api, chatId, "upload_document", messageThreadId).catch(() => {});

    let failedCount = 0;
    let bundledArtifact: Artifact | null = null;

    if (policy.autoSendZip || report.artifacts.length > 5) {
      bundledArtifact = await createArtifactZipBundle(report.artifacts, report.outDir, {
        maxFileSize: config.maxFileSize,
      });
    }

    const deliverFiles = policy.autoSendFiles || policy.autoSendZip;
    if (deliverFiles) {
      const deliveredArtifacts = bundledArtifact
        ? [bundledArtifact]
        : report.artifacts.filter((artifact) => !policy.imagesOnly || isTelegramImagePreview(artifact)).slice(0, 5);
      for (const artifact of deliveredArtifacts) {
        const sent = await sendArtifactFile(ctx, chatId, artifact, messageThreadId);
        if (!sent) {
          failedCount += 1;
        }
      }
    }

    const summary = formatArtifactSummary(report.artifacts, report.skippedCount + failedCount, report.omittedCount);
    if (summary && policy.sendSummary) {
      const bundleNote = deliverFiles && bundledArtifact ? `\nSent as ZIP: ${bundledArtifact.name}` : "";
      await safeReply(ctx, escapeHTML(`${summary}${bundleNote}`), {
        fallbackText: `${summary}${bundleNote}`,
        replyMarkup: policy.includeActions ? buildArtifactActionsKeyboard([report]) : undefined,
      });
    }
  };

  const pruneArtifacts = async (workspace: string): Promise<void> => {
    await pruneConnectorTurnDirs(workspace, {
      maxAgeMs: config.artifactRetentionDays * 24 * 60 * 60 * 1000,
      maxTurnDirs: config.artifactMaxTurnDirs,
      maxInboxDirs: config.artifactMaxInboxDirs,
    }).catch((error) => {
      console.error("Failed to prune connector artifact directories:", error);
    });
  };

  const deliverArtifactReportZip = async (
    ctx: Context,
    chatId: TelegramChatId,
    report: ArtifactTurnReport,
    messageThreadId?: number,
  ): Promise<void> => {
    const bundle = await createArtifactZipBundle(report.artifacts, report.outDir, {
      maxFileSize: config.maxFileSize,
      bundleName: `nordrelay-artifacts-${report.turnId}.zip`,
    });

    if (!bundle) {
      await safeReply(ctx, escapeHTML("Could not create a ZIP bundle for this artifact turn."), {
        fallbackText: "Could not create a ZIP bundle for this artifact turn.",
      });
      return;
    }

    const sent = await sendArtifactFile(ctx, chatId, bundle, messageThreadId);
    if (sent) {
      const text = `Sent ZIP artifact bundle: ${bundle.name}`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
    }
  };

  const sendArtifactFile = async (
    ctx: Context,
    chatId: TelegramChatId,
    artifact: Artifact,
    messageThreadId?: number,
  ): Promise<boolean> => {
    return sendArtifactFileByApi(ctx.api, chatId, artifact, messageThreadId);
  };

  const sendArtifactFileByApi = async (
    api: Context["api"],
    chatId: TelegramChatId,
    artifact: Artifact,
    messageThreadId?: number,
  ): Promise<boolean> => {
    const commonOptions = {
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    };

    try {
      if (isTelegramImagePreview(artifact)) {
        await telegramRateLimiter.run(chatBucket(chatId), "sendPhoto", () =>
          api.sendPhoto(chatId, new InputFile(artifact.localPath, telegramArtifactFilename(artifact)), {
            ...commonOptions,
            caption: trimLine(redactText(artifact.name), 1024),
          })
        );
      } else {
        await telegramRateLimiter.run(chatBucket(chatId), "sendDocument", () =>
          api.sendDocument(chatId, new InputFile(artifact.localPath, telegramArtifactFilename(artifact)), {
            ...commonOptions,
          })
        );
      }
      return true;
    } catch (error) {
      console.error(`Failed to send artifact ${artifact.name}:`, error);
      return false;
    }
  };

  const enqueueMediaGroupPart = (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: AgentSessionService,
    mediaGroupId: string,
    part: MediaGroupPart,
  ): void => {
    const key = `${contextKey}:${mediaGroupId}`;
    const existing = pendingMediaGroups.get(key);

    if (existing) {
      clearTimeout(existing.timer);
      existing.ctx = ctx;
      existing.messageThreadId = ctx.message?.message_thread_id;
      existing.parts.push(part);
      existing.timer = setTimeout(() => {
        void flushMediaGroup(key);
      }, MEDIA_GROUP_FLUSH_MS);
      return;
    }

    const pending: PendingMediaGroup = {
      ctx,
      contextKey,
      chatId,
      session,
      messageThreadId: ctx.message?.message_thread_id,
      parts: [part],
      timer: setTimeout(() => {
        void flushMediaGroup(key);
      }, MEDIA_GROUP_FLUSH_MS),
    };
    pendingMediaGroups.set(key, pending);
  };

  const flushMediaGroup = async (key: string): Promise<void> => {
    const pending = pendingMediaGroups.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    pendingMediaGroups.delete(key);

    try {
      if (!canSendSystemMessagesToTelegramContext(userStore, pending.contextKey)) {
        return;
      }
      await processMediaGroup(pending);
    } catch (error) {
      console.error("Failed to process media group:", error);
      if (!canSendSystemMessagesToTelegramContext(userStore, pending.contextKey)) {
        return;
      }
      await safeReply(pending.ctx, `<b>Failed to process media group:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to process media group: ${friendlyErrorText(error)}`,
      });
    }
  };

  const processMediaGroup = async (pending: PendingMediaGroup): Promise<void> => {
    if (!canSendSystemMessagesToTelegramContext(userStore, pending.contextKey)) {
      return;
    }
    const busyState = getBusyState(pending.contextKey);
    busyState.transcribing = true;

    const turnId = randomUUID().slice(0, 12);
    const workspace = pending.session.getCurrentWorkspace();
    const outDir = outboxPath(workspace, turnId);
    const stagedFiles: StagedFile[] = [];
    const imagePaths: string[] = [];
    const captions = pending.parts
      .map((part) => part.caption?.trim())
      .filter((caption): caption is string => Boolean(caption));
    let skippedCount = 0;

    try {
      await sendChatActionSafe(pending.ctx.api, pending.chatId, "typing", pending.messageThreadId).catch(() => {});
      await ensureOutDir(outDir);

      for (const [index, part] of pending.parts.entries()) {
        if (part.kind === "document" && part.fileSize && part.fileSize > config.maxFileSize) {
          skippedCount += 1;
          continue;
        }

        let tempFilePath: string | undefined;
        try {
          const downloadLimit = part.kind === "photo" ? 20 * 1024 * 1024 : config.maxFileSize;
          tempFilePath = await downloadTelegramFile(pending.ctx.api, config.telegramBotToken, part.fileId, downloadLimit);
          const buffer = await readFile(tempFilePath);
          const originalName = part.kind === "photo" ? `photo-${index + 1}-${turnId}.jpg` : `${index + 1}-${part.fileName}`;
          const staged = await stageFile(buffer, originalName, part.mimeType, {
            workspace,
            turnId,
            maxFileSize: config.maxFileSize,
          });
          stagedFiles.push(staged);
          if (part.kind === "photo") {
            imagePaths.push(staged.localPath);
          }
        } catch (error) {
          skippedCount += 1;
          console.error(`Failed to stage media group item ${index + 1}:`, error);
        } finally {
          if (tempFilePath) {
            await unlink(tempFilePath).catch(() => {});
          }
        }
      }
    } finally {
      busyState.transcribing = false;
    }

    if (stagedFiles.length === 0) {
      if (!canSendSystemMessagesToTelegramContext(userStore, pending.contextKey)) {
        return;
      }
      const text = skippedCount > 0 ? "No media group files could be staged." : "Media group was empty.";
      await safeReply(pending.ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    if (!canSendSystemMessagesToTelegramContext(userStore, pending.contextKey)) {
      return;
    }
    const receivedText = `Received ${stagedFiles.length} media group file${stagedFiles.length === 1 ? "" : "s"}${skippedCount > 0 ? ` (${skippedCount} skipped)` : ""}.`;
    await safeReply(pending.ctx, escapeHTML(receivedText), { fallbackText: receivedText });
    appendTelegramActivity(pending.ctx, pending.contextKey, pending.session, {
      status: "info",
      type: "attachment_staged",
      detail: receivedText,
    });
    await sendChatActionSafe(pending.ctx.api, pending.chatId, "typing", pending.messageThreadId).catch(() => {});

    const promptInput: AgentPromptInput = {
      stagedFileInstructions: buildFileInstructions(stagedFiles, outDir),
    };
    if (imagePaths.length > 0) {
      promptInput.imagePaths = imagePaths;
    }
    if (captions.length > 0) {
      promptInput.text = Array.from(new Set(captions)).join("\n\n");
    }

    await startUserPrompt(pending.ctx, pending.contextKey, pending.chatId, pending.session, { ...toPromptEnvelope(promptInput, outDir), attachments: webChatAttachmentsForStagedFiles(stagedFiles, turnId) });
  };

  bot.use(createTelegramAccessMiddleware({ userStore, contextUsers, audit }));

  registerTelegramAccessCommands({ bot, userStore, contextUsers, linkAttempts, audit, getUserRole });

  registerTelegramGeneralCommands({ bot, config, registry, getContextSession, checkAgentAuthStatus, isTopicContext, replyChannelAction, commandService, preferencesStore, canUsePeer: (ctx, peerId) => userStore.canUsePeer(getAuthenticatedUser(ctx), peerId), onTargetChanged: (contextKey) => peerMirrorController.sync(contextKey, telegramChannelContextFromKey(contextKey)) });

  registerTelegramAgentCommands({
    bot,
    config,
    registry,
    pendingAgentPicks,
    getContextSession,
    isBusy,
    checkAgentAuthStatus,
    checkLoginAuthStatus,
    agentIdForAuth,
    labelForAuth,
    startAgentLogin,
    startAgentLogout,
    hostLoginCommand,
    hostLogoutCommand,
    selectedNodeLabel: (contextKey) => selectedTargetNodeLabel(preferencesStore, contextKey),
    appendActivity: (ctx, input) => appendActivity({
      source: "telegram",
      ...input,
      threadId: input.threadId ?? null,
      workspace: input.workspace ?? config.workspace,
      actor: input.actor ?? telegramActivityActor(ctx),
    }),
  });

  registerTelegramPreferenceCommands({ bot, config, commandService, preferencesStore, getContextSession, remoteClient, canUsePeer: (ctx, peerId) => userStore.canUsePeer(getAuthenticatedUser(ctx), peerId), onMirrorChanged: (contextKey) => peerMirrorController.sync(contextKey, telegramChannelContextFromKey(contextKey)) });

  registerTelegramDiagnosticsCommands({
    bot,
    config,
    registry,
    promptStore,
    turnProgress,
    externalMirrors,
    externalQueueTimers,
    queueStatusMessages,
    getContextSession,
    checkAgentAuthStatus,
    getUserRole,
    getEffectiveMirrorMode,
    getEffectiveNotifyMode,
    getEffectiveQuietHours,
    getEffectiveVoiceBackend,
    getEffectiveVoiceLanguage,
    isVoiceTranscribeOnly,
    replyChannelAction,
    commandService,
  });

  registerTelegramOperationalCommands({
    bot,
    config,
    promptStore,
    auditLog,
    lockStore,
    turnProgress,
    getContextSession,
    getBusyState,
    getExternalActivity,
    isAdminUser,
    auditContext,
    getLockOwner: (ctx) => {
      const authUser = getAuthenticatedUser(ctx);
      if (!authUser) {
        return null;
      }
      return {
        userId: authUser.user.id,
        label: authUser.user.displayName || authUser.user.email,
        channel: "telegram",
        channelUserId: ctx.from?.id !== undefined ? String(ctx.from.id) : undefined,
      };
    },
    updateSessionMetadata,
  });

  registerTelegramSupportCommands({ bot, config, auditLog, agentUpdates, getUserRole, audit });
  registerTelegramUpdateCommands({
    bot,
    agentUpdates,
    replyChannelAction,
    startTelegramAgentUpdate,
    appendActivity: (ctx, input) => appendActivity({
      source: "telegram",
      ...input,
      threadId: input.threadId ?? null,
      workspace: input.workspace ?? config.workspace,
      actor: input.actor ?? telegramActivityActor(ctx),
    }),
  });

  bot.command("new", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot create a new thread while a prompt is running."), {
        fallbackText: "Cannot create a new thread while a prompt is running.",
      });
      return;
    }

    const currentPolicy = evaluateWorkspacePolicy(session.getCurrentWorkspace(), config);
    if (!currentPolicy.allowed) {
      await safeReply(ctx, escapeHTML(currentPolicy.warning ?? "Current workspace is blocked by workspace policy."), {
        fallbackText: currentPolicy.warning ?? "Current workspace is blocked by workspace policy.",
      });
      return;
    }

    const workspaces = filterAllowedWorkspaces(session.listWorkspaces(), config);
    if (workspaces.length <= 1) {
      try {
        const info = await registry.startNewThread(contextKey, session);
        appendTelegramActivity(ctx, contextKey, session, {
          status: "info",
          type: "session_new",
          threadId: info.threadId,
          workspace: info.workspace,
          agentId: info.agentId,
          detail: info.workspace,
        });
        const label = isTopicContext(contextKey) ? "New thread created for this topic." : "New thread created.";
        const policyLine = renderWorkspacePolicyLine(info.workspace, config);
        const plainText = [label, policyLine, "", renderSessionInfoPlain(info)].filter((line): line is string => line !== undefined).join("\n");
        const html = [`<b>${escapeHTML(label)}</b>`, policyLine ? `<i>${escapeHTML(policyLine)}</i>` : undefined, "", renderSessionInfoHTML(info)].filter((line): line is string => line !== undefined).join("\n");
        await safeReply(ctx, html, { fallbackText: plainText });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      }
      return;
    }

    pendingWorkspacePicks.set(contextKey, workspaces);
    const currentWorkspace = session.getCurrentWorkspace();
    const workspaceButtons = workspaces.map((workspace, index) => ({
      label: `${workspace === currentWorkspace ? "📂" : "📁"} ${getWorkspaceShortName(workspace)}`,
      callbackData: `ws_${index}`,
    }));
    pendingWorkspaceButtons.set(contextKey, workspaceButtons);
    const keyboard = paginateKeyboard(workspaceButtons, 0, "ws");

    await safeReply(ctx, "<b>Select workspace for new thread:</b>", {
      fallbackText: "Select workspace for new thread:",
      replyMarkup: keyboard,
    });
  });

  bot.command(["abort", "stop"], async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    try {
      const busy = getBusyReason(contextKey);
      if (busy.kind === "external") {
        const text = `Cannot abort the external ${busy.activity.agentLabel} CLI task from NordRelay. Stop it in the terminal where it is running; queued Telegram messages will wait.`;
        await safeReply(ctx, escapeHTML(text), { fallbackText: text });
        appendTelegramActivity(ctx, contextKey, session, {
          status: "failed",
          type: "prompt_abort_rejected",
          detail: text,
        });
        return;
      }
      await session.abort();
      await safeReply(ctx, escapeHTML("Aborted current operation"), {
        fallbackText: "Aborted current operation",
      });
      appendTelegramActivity(ctx, contextKey, session, {
        status: "aborted",
        type: "prompt_aborted",
        detail: "Abort requested from Telegram.",
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("retry", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    if (isBusy(contextKey)) {
      await sendBusyReply(ctx);
      return;
    }

    const cached = promptStore.getLastPrompt(contextKey);
    if (!cached) {
      await safeReply(ctx, escapeHTML("Nothing to retry. Send a message first."), {
        fallbackText: "Nothing to retry. Send a message first.",
      });
      return;
    }

    await startUserPrompt(ctx, contextKey, chatId, session, cached);
  });

  registerTelegramLastCommand({ bot, config, getContextSession, preferencesStore, remoteClient, actor: (ctx) => telegramActivityActor(ctx), canUsePeer: (ctx, peerId) => userStore.canUsePeer(getAuthenticatedUser(ctx), peerId) });
  registerTelegramWorkflowCommands({ bot, config, promptStore, getContextSession, handleUserPrompt: startUserPrompt });

  registerTelegramQueueCommands({
    bot,
    promptStore,
    getContextSession,
    getBusyReason,
    getSession: (contextKey) => registry.get(contextKey),
    updateQueueStatusMessage,
    scheduleExternalQueueDrain,
    drainQueuedPrompts,
    handleUserPrompt: startUserPrompt,
    auditContext,
    activityActor: telegramActivityActor,
    appendActivity: appendTelegramActivity,
  });

  registerTelegramArtifactCommands({
    bot,
    config,
    getContextSession,
    deliverArtifactReport: (ctx, chatId, report, messageThreadId) =>
      deliverArtifactReport(ctx, chatId, report, messageThreadId, artifactDeliveryPolicy("auto-files")),
    deliverArtifactReportZip,
    getArtifactDeliveryMode: (ctx) => getAuthenticatedUser(ctx)?.user.preferences?.artifactDelivery,
    setArtifactDeliveryMode: async (ctx, mode) => { const authUser = getAuthenticatedUser(ctx); if (!authUser) throw new Error("Authenticated Telegram user required."); const updated = userStore.updateUser(authUser.user.id, { preferences: { artifactDelivery: mode } }); contextUsers.set(ctx, updated); return updated.user.preferences?.artifactDelivery ?? config.telegramArtifactDeliveryMode; },
    appendActivity: (ctx, input) => appendActivity({
      source: "telegram",
      ...input,
      threadId: input.threadId ?? null,
      workspace: input.workspace ?? config.workspace,
      actor: input.actor ?? telegramActivityActor(ctx),
    }),
  });

  bot.command("session", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (await replyTargetPeerSession({ ctx, contextKey, preferencesStore, remoteClient, actor: telegramActivityActor(ctx), canUsePeer: (peerId) => userStore.canUsePeer(getAuthenticatedUser(ctx), peerId) })) return;
    const info = session.getInfo({ includeUsage: true });
    const contextLabel = isTopicContext(contextKey) ? "Topic session" : "Chat session";
    const policyLine = renderWorkspacePolicyLine(info.workspace, config);

    const plainLines = [
      `Node: ${selectedTargetNodeLabel(preferencesStore, contextKey)}`,
      "",
      `${contextLabel}:`,
      policyLine,
      renderSessionInfoPlain(info),
    ].filter((line): line is string => line !== undefined);
    const htmlLines = [
      `<b>Node:</b> <code>${escapeHTML(selectedTargetNodeLabel(preferencesStore, contextKey))}</code>`,
      "",
      `<b>${escapeHTML(contextLabel)}:</b>`,
      policyLine ? `<i>${escapeHTML(policyLine)}</i>` : undefined,
      renderSessionInfoHTML(info),
    ].filter((line): line is string => line !== undefined);

    await safeReply(ctx, htmlLines.join("\n"), { fallbackText: plainLines.join("\n") });
  });

  const parseLaunchCommandArgument = (ctx: Context): { profileId: string; confirmed: boolean; applyToCurrent: boolean } | null => {
    const message = ctx.message;
    const text = message && "text" in message ? String(message.text ?? "") : "";
    const argument = text.replace(/^\/(?:launch|launch_profiles)(?:@\w+)?\s*/i, "").trim();
    if (!argument) {
      return null;
    }
    const parts = argument.split(/\s+/).filter(Boolean);
    return {
      profileId: parts[0] ?? "",
      confirmed: parts.slice(1).some((part) => part.toLowerCase() === "confirm"),
      applyToCurrent: parts.slice(1).some((part) => ["apply", "current", "now"].includes(part.toLowerCase())),
    };
  };

  const setTelegramLaunchProfile = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: AgentSessionService,
    profileId: string,
    applyToCurrent: boolean,
  ): Promise<{ info: AgentSessionInfo; appliedToActiveThread: boolean }> => {
    const result = applyToCurrent && session.setLaunchProfileForCurrentSession
      ? await session.setLaunchProfileForCurrentSession(profileId)
      : { value: session.setLaunchProfile(profileId).id, appliedToActiveThread: false };
    updateSessionMetadata(contextKey, session);
    const info = session.getInfo();
    appendTelegramActivity(ctx, contextKey, session, {
      status: "info",
      type: result.appliedToActiveThread ? "launch_profile_applied" : "launch_profile_changed",
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      detail: info.launchProfileLabel,
    });
    return { info, appliedToActiveThread: result.appliedToActiveThread };
  };

  const externalLaunchApplyBlocker = (session: AgentSessionService): string | null => {
    const external = getExternalSnapshotForSession(session, config, { maxEvents: 0 });
    return external?.activity.active && !session.isProcessing()
      ? `Cannot apply launch profile while the external ${external.agentLabel} CLI task is still running.`
      : null;
  };

  const renderLaunchProfileResult = (
    info: AgentSessionInfo,
    profileBehavior: string,
    applyRequested: boolean,
    appliedToActiveThread: boolean,
  ): { html: string; plain: string } => {
    const suffix = applyRequested
      ? appliedToActiveThread
        ? "Applied to the current idle thread."
        : "No active idle thread was attached; applies to the next thread."
      : "Applies to new or reattached threads.";
    const html = [
      `<b>Launch profile set to</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(profileBehavior || info.launchProfileBehavior)}</code>`,
      "",
      escapeHTML(suffix),
    ].join("\n");
    const plain = [
      `Launch profile set to ${info.launchProfileLabel}`,
      `Behavior: ${profileBehavior || info.launchProfileBehavior}`,
      "",
      suffix,
    ].join("\n");
    return { html, plain };
  };

  const openLaunchProfilesPicker = async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const info = session.getInfo();
    if (!capabilitiesOf(info).launchProfiles) {
      const text = `Launch profiles are not supported for ${labelOf(info)}.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change launch profile while a prompt is running."), {
        fallbackText: "Cannot change launch profile while a prompt is running.",
      });
      return;
    }

    const profiles = session.listLaunchProfiles();
    const commandArgument = parseLaunchCommandArgument(ctx);
    if (commandArgument?.profileId) {
      const profile = profiles.find((candidate) => candidate.id === commandArgument.profileId);
      if (!profile) {
        const text = `Unknown launch profile: ${commandArgument.profileId}`;
        await safeReply(ctx, escapeHTML(text), { fallbackText: text });
        return;
      }
      if (profile.unsafe && !commandArgument.confirmed) {
        const command = `/launch ${profile.id} confirm${commandArgument.applyToCurrent ? " apply" : ""}`;
        const html = [
          `<b>Confirm launch profile:</b> <code>${escapeHTML(profile.label)}</code>`,
          `<b>Behavior:</b> <code>${escapeHTML(profile.behavior)}</code>`,
          "",
          "⚠️ <b>This profile uses danger-full-access.</b>",
          `Run <code>${escapeHTML(command)}</code> to ${commandArgument.applyToCurrent ? "apply it to the current idle thread" : "enable it for new or reattached threads"}.`,
        ].join("\n");
        const plain = [
          `Confirm launch profile: ${profile.label}`,
          `Behavior: ${profile.behavior}`,
          "",
          "WARNING: This profile uses danger-full-access.",
          `Run ${command} to ${commandArgument.applyToCurrent ? "apply it to the current idle thread" : "enable it for new or reattached threads"}.`,
        ].join("\n");
        await safeReply(ctx, html, { fallbackText: plain });
        return;
      }
      const blocker = commandArgument.applyToCurrent ? externalLaunchApplyBlocker(session) : null;
      if (blocker) {
        await safeReply(ctx, escapeHTML(blocker), { fallbackText: blocker });
        return;
      }
      const { info: updatedInfo, appliedToActiveThread } = await setTelegramLaunchProfile(ctx, contextKey, session, profile.id, commandArgument.applyToCurrent);
      const resultText = renderLaunchProfileResult(updatedInfo, profile.behavior, commandArgument.applyToCurrent, appliedToActiveThread);
      await safeReply(ctx, resultText.html, { fallbackText: resultText.plain });
      return;
    }

    const selectedLaunchProfile = session.getInfo();
    const launchButtons = profiles.map((profile, index) => ({
      label: formatAgentLaunchProfileLabel(profile, profile.id === selectedLaunchProfile.launchProfileId),
      callbackData: `launch_${index}`,
    }));

    pendingLaunchPicks.set(
      contextKey,
      profiles.map((profile) => profile.id),
    );
    pendingLaunchButtons.set(contextKey, launchButtons);
    pendingUnsafeLaunchConfirmations.delete(contextKey);

    const keyboard = paginateKeyboard(launchButtons, 0, "launch");
    const htmlLines = [
      `<b>Selected launch profile:</b> <code>${escapeHTML(selectedLaunchProfile.launchProfileLabel)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(selectedLaunchProfile.launchProfileBehavior)}</code>`,
      "",
      "Select a profile for new or reattached threads:",
      "Use <code>/launch &lt;profile-id&gt; apply</code> to apply a profile to the current idle thread.",
    ];
    const plainLines = [
      `Selected launch profile: ${selectedLaunchProfile.launchProfileLabel}`,
      `Behavior: ${selectedLaunchProfile.launchProfileBehavior}`,
      "",
      "Select a profile for new or reattached threads:",
      "Use /launch <profile-id> apply to apply a profile to the current idle thread.",
    ];

    if (selectedLaunchProfile.unsafeLaunch) {
      htmlLines.splice(2, 0, "⚠️ <i>Selected profile uses danger-full-access.</i>");
      plainLines.splice(2, 0, "⚠️ Selected profile uses danger-full-access.");
    }

    if (info.nextLaunchProfileId) {
      htmlLines.splice(2, 0, `<b>Active thread still uses:</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`);
      plainLines.splice(2, 0, `Active thread still uses: ${info.launchProfileLabel}`);
    }

    await safeReply(ctx, htmlLines.join("\n"), {
      fallbackText: plainLines.join("\n"),
      replyMarkup: keyboard,
    });
  };

  bot.command(["launch", "launch_profiles"], openLaunchProfilesPicker);
  bot.hears(/^\/launch-profiles(?:@\w+)?$/i, openLaunchProfilesPicker);

  bot.command("handback", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot hand back while a prompt is running. Use /abort first."), {
        fallbackText: "Cannot hand back while a prompt is running. Use /abort first.",
      });
      return;
    }

    if (!session.hasActiveThread()) {
      await safeReply(ctx, escapeHTML("No active thread to hand back."), {
        fallbackText: "No active thread to hand back.",
      });
      return;
    }

    try {
      const info = session.handback();
      updateSessionMetadata(contextKey, session);
      appendTelegramActivity(ctx, contextKey, session, {
        status: "info",
        type: "handback",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: idOf(session.getInfo()),
        detail: info.command ?? info.threadId ?? "handback",
      });

      if (!info.threadId) {
        await safeReply(
          ctx,
          escapeHTML(
            "This thread has not started yet, so there is no resumable thread ID. Send a message to create one, or use /new to start fresh.",
          ),
          {
            fallbackText:
              "This thread has not started yet, so there is no resumable thread ID. Send a message to create one, or use /new to start fresh.",
          },
        );
        return;
      }

      const shellEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
      const resumeCommand = info.command ?? `cd ${shellEscape(info.workspace)} && codex resume ${shellEscape(info.threadId)}`;
      const handbackLabel = info.label ?? "Codex CLI";

      let copiedToClipboard = false;
      if (process.platform === "darwin") {
        try {
          const { spawnSync } = await import("node:child_process");
          const result = spawnSync("pbcopy", [], {
            input: resumeCommand,
            timeout: 2000,
            stdio: ["pipe", "ignore", "ignore"],
          });
          copiedToClipboard = result.status === 0;
        } catch {
          // Ignore clipboard failures.
        }
      }

      const plainText = [
        `🔄 Thread handed back to ${handbackLabel}.`,
        "",
        "Run this in your terminal:",
        resumeCommand,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 Command copied to clipboard!" : undefined,
        "",
        "Send any message here to start a new NordRelay thread.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      const html = [
        `<b>🔄 Thread handed back to ${escapeHTML(handbackLabel)}.</b>`,
        "",
        "Run this in your terminal:",
        `<pre>${escapeHTML(resumeCommand)}</pre>`,
        copiedToClipboard ? "" : undefined,
        copiedToClipboard ? "📋 <i>Command copied to clipboard!</i>" : undefined,
        "",
        "Send any message here to start a new NordRelay thread.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");

      await safeReply(ctx, html, { fallbackText: plainText });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  bot.command("attach", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot attach while a prompt is running."), {
        fallbackText: "Cannot attach while a prompt is running.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const threadId = rawText.replace(/^\/attach(?:@\w+)?\s*/, "").trim();

    if (!threadId) {
      await safeReply(ctx, escapeHTML("Usage: /attach <thread-id>"), {
        fallbackText: "Usage: /attach <thread-id>",
      });
      return;
    }

    const requestedThread = session.getSessionRecord(threadId);
    if (!requestedThread) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(`Unknown ${labelOf(session.getInfo())} session: ${threadId}`)}`, {
        fallbackText: `Failed: Unknown ${labelOf(session.getInfo())} session: ${threadId}`,
      });
      return;
    }
    const workspacePolicy = evaluateWorkspacePolicy(requestedThread.cwd, config);
    if (!workspacePolicy.allowed) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(workspacePolicy.warning ?? "Thread workspace blocked by policy.")}`, {
        fallbackText: `Failed: ${workspacePolicy.warning ?? "Thread workspace blocked by policy."}`,
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      appendTelegramActivity(ctx, contextKey, session, {
        status: "info",
        type: "session_attach",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        detail: threadId,
      });
      const policyLine = renderWorkspacePolicyLine(info.workspace, config);
      const html = ["<b>Attached to thread.</b>", policyLine ? `<i>${escapeHTML(policyLine)}</i>` : undefined, "", renderSessionInfoHTML(info)].filter((line): line is string => line !== undefined).join("\n");
      const plain = ["Attached to thread.", policyLine, "", renderSessionInfoPlain(info)].filter((line): line is string => line !== undefined).join("\n");
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    } finally {
      busyState.switching = false;
    }
  });

  bot.command(["sessions", "switch"], async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot switch sessions while a prompt is running."), {
        fallbackText: "Cannot switch sessions while a prompt is running.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const threadId = rawText.replace(/^\/(?:sessions|switch)(?:@\w+)?\s*/, "").trim();
    if (await handleTargetPeerSessionsCommand({
      ctx,
      contextKey,
      rawText,
      preferencesStore,
      remoteClient,
      actor: telegramActivityActor(ctx),
      canUsePeer: (peerId) => userStore.canUsePeer(getAuthenticatedUser(ctx), peerId),
      pendingSessionPicks,
      pendingSessionButtons,
      syncPeerMirror: (key) => peerMirrorController.sync(key, telegramChannelContextFromKey(key)),
    })) {
      return;
    }

    const requestedThread = threadId ? session.getSessionRecord(threadId) : null;
    if (threadId && requestedThread) {
      const workspacePolicy = evaluateWorkspacePolicy(requestedThread.cwd, config);
      if (!workspacePolicy.allowed) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(workspacePolicy.warning ?? "Thread workspace blocked by policy.")}`, {
          fallbackText: `Failed: ${workspacePolicy.warning ?? "Thread workspace blocked by policy."}`,
        });
        return;
      }
      const busyState = getBusyState(contextKey);
      busyState.switching = true;
      try {
        const info = await session.switchSession(threadId);
        updateSessionMetadata(contextKey, session);
        appendTelegramActivity(ctx, contextKey, session, {
          status: "info",
          type: "session_switch",
          threadId: info.threadId,
          workspace: info.workspace,
          agentId: info.agentId,
          detail: threadId,
        });
        const policyLine = renderWorkspacePolicyLine(info.workspace, config);
        const html = ["<b>Switched thread.</b>", policyLine ? `<i>${escapeHTML(policyLine)}</i>` : undefined, "", renderSessionInfoHTML(info)].filter((line): line is string => line !== undefined).join("\n");
        const plain = ["Switched thread.", policyLine, "", renderSessionInfoPlain(info)].filter((line): line is string => line !== undefined).join("\n");
        await safeReply(ctx, html, { fallbackText: plain });
      } catch (error) {
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
          fallbackText: `Failed: ${friendlyErrorText(error)}`,
        });
      } finally {
        busyState.switching = false;
      }
      return;
    }

    const query = threadId;
    const pinnedThreadIds = registry.listPinnedThreadIds(contextKey);
    const pinnedSet = new Set(pinnedThreadIds);
    const sessions = orderPinnedSessions(
      filterSessions(session.listAllSessions(100), query)
        .filter((listedSession) => evaluateWorkspacePolicy(listedSession.cwd, config).allowed),
      pinnedThreadIds,
    ).slice(0, 50);
    if (sessions.length === 0) {
      const message = query ? `No threads found matching "${query}".` : "No recent threads found.";
      await safeReply(ctx, escapeHTML(message), {
        fallbackText: message,
      });
      return;
    }

    const groupedSessions = new Map<string, typeof sessions>();
    for (const listedSession of sessions) {
      const workspaceSessions = groupedSessions.get(listedSession.cwd);
      if (workspaceSessions) {
        workspaceSessions.push(listedSession);
      } else {
        groupedSessions.set(listedSession.cwd, [listedSession]);
      }
    }

    const orderedSessions: typeof sessions = [];

    for (const workspaceSessions of groupedSessions.values()) {
      orderedSessions.push(...workspaceSessions);
    }

    pendingSessionPicks.set(
      contextKey,
      orderedSessions.map((listedSession) => listedSession.id),
    );

    const activeThreadId = session.getInfo().threadId;
    const sessionButtons = orderedSessions.map((listedSession, index) => {
      return {
        label: formatSessionLabel({
          workspace: listedSession.cwd,
          title: listedSession.title || listedSession.firstUserMessage || "",
          relativeTime: formatRelativeTime(listedSession.updatedAt),
          model: listedSession.model || undefined,
          isActive: listedSession.id === activeThreadId,
          isPinned: pinnedSet.has(listedSession.id),
        }),
        callbackData: `sess_${index}`,
      };
    });
    pendingSessionButtons.set(contextKey, sessionButtons);
    const keyboard = paginateKeyboard(sessionButtons, 0, "sess");

    const heading = `${query ? "Matching threads" : "Recent threads"} on Local node · Agent: ${session.getInfo().agentLabel} (${orderedSessions.length})`;
    await safeReply(ctx, `<b>${escapeHTML(heading)}</b>:\nTap to switch.`, {
      fallbackText: `${heading}:\nTap to switch.`,
      replyMarkup: keyboard,
    });
  });

  bot.command("pin", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { contextKey, session } = contextSession;
    const rawText = ctx.message?.text ?? "";
    const requestedThreadId = rawText.replace(/^\/pin(?:@\w+)?\s*/i, "").trim();
    const threadId = requestedThreadId || session.getInfo().threadId;
    if (!threadId) {
      await safeReply(ctx, escapeHTML("No active thread to pin. Use /pin <thread-id>."), {
        fallbackText: "No active thread to pin. Use /pin <thread-id>.",
      });
      return;
    }
    if (!session.getSessionRecord(threadId)) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(`Unknown ${labelOf(session.getInfo())} session: ${threadId}`)}`, {
        fallbackText: `Failed: Unknown ${labelOf(session.getInfo())} session: ${threadId}`,
      });
      return;
    }

    const pinned = registry.pinThread(contextKey, threadId);
    appendTelegramActivity(ctx, contextKey, session, {
      status: "info",
      type: "session_pinned",
      threadId,
      detail: threadId,
    });
    await safeReply(ctx, `<b>Pinned thread:</b> <code>${escapeHTML(threadId)}</code>\n<b>Total pinned:</b> <code>${pinned.length}</code>`, {
      fallbackText: `Pinned thread: ${threadId}\nTotal pinned: ${pinned.length}`,
    });
  });

  bot.command("unpin", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { contextKey, session } = contextSession;
    const rawText = ctx.message?.text ?? "";
    const requestedThreadId = rawText.replace(/^\/unpin(?:@\w+)?\s*/i, "").trim();
    const threadId = requestedThreadId || session.getInfo().threadId;
    if (!threadId) {
      await safeReply(ctx, escapeHTML("No active thread to unpin. Use /unpin <thread-id>."), {
        fallbackText: "No active thread to unpin. Use /unpin <thread-id>.",
      });
      return;
    }

    const pinned = registry.unpinThread(contextKey, threadId);
    appendTelegramActivity(ctx, contextKey, session, {
      status: "info",
      type: "session_unpinned",
      threadId,
      detail: threadId,
    });
    await safeReply(ctx, `<b>Unpinned thread:</b> <code>${escapeHTML(threadId)}</code>\n<b>Total pinned:</b> <code>${pinned.length}</code>`, {
      fallbackText: `Unpinned thread: ${threadId}\nTotal pinned: ${pinned.length}`,
    });
  });

  bot.command("pinned", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { contextKey, session } = contextSession;
    const pinnedThreadIds = registry.listPinnedThreadIds(contextKey);
    const pinnedSessions = pinnedThreadIds
      .map((threadId) => session.getSessionRecord(threadId))
      .filter((record): record is AgentThreadRecord => Boolean(record));
    if (pinnedSessions.length === 0) {
      await safeReply(ctx, escapeHTML("No pinned threads."), { fallbackText: "No pinned threads." });
      return;
    }

    const activeThreadId = session.getInfo().threadId;
    pendingSessionPicks.set(contextKey, pinnedSessions.map((record) => record.id));
    const sessionButtons = pinnedSessions.map((record, index) => ({
      label: formatSessionLabel({
        workspace: record.cwd,
        title: record.title || record.firstUserMessage || "",
        relativeTime: formatRelativeTime(record.updatedAt),
        model: record.model || undefined,
        isActive: record.id === activeThreadId,
        isPinned: true,
      }),
      callbackData: `sess_${index}`,
    }));
    pendingSessionButtons.set(contextKey, sessionButtons);
    await safeReply(ctx, `<b>Pinned threads</b> (${pinnedSessions.length}):\nTap to switch.`, {
      fallbackText: `Pinned threads (${pinnedSessions.length}):\nTap to switch.`,
      replyMarkup: paginateKeyboard(sessionButtons, 0, "sess"),
    });
  });

  bot.command("model", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change model while a prompt is running."), {
        fallbackText: "Cannot change model while a prompt is running.",
      });
      return;
    }

    const info = session.getInfo();
    await session.refreshModels({ force: true }).catch((error) => {
      console.warn(
        `Failed to refresh ${labelOf(info)} models: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const models = session.listModels();
    if (models.length === 0) {
      await safeReply(ctx, escapeHTML("No models available."), {
        fallbackText: "No models available.",
      });
      return;
    }

    const currentModel = session.getInfo().model ?? "(default)";
    const modelButtons = models.map((model) => ({
      label: formatModelButtonLabel(model, model.slug === currentModel),
      callbackData: `model_${model.slug}`,
    }));
    pendingModelButtons.set(contextKey, modelButtons);
    const keyboard = paginateKeyboard(modelButtons, 0, "model");

    await safeReply(
      ctx,
      [`<b>Current model:</b> <code>${escapeHTML(currentModel)}</code>`, "", "Select a model for new threads:"].join("\n"),
      {
        fallbackText: [`Current model: ${currentModel}`, "", "Select a model for new threads:"].join("\n"),
        replyMarkup: keyboard,
      },
    );
  });

  bot.command("fast", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (!capabilitiesOf(session.getInfo()).fastMode) {
      const text = `Fast mode is not supported for ${labelOf(session.getInfo())}.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot change fast mode while a prompt is running."), {
        fallbackText: "Cannot change fast mode while a prompt is running.",
      });
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const argument = rawText.replace(/^\/fast(?:@\w+)?\s*/i, "").trim();
    const currentFastMode = session.getInfo().fastMode;
    const nextFastMode = parseFastModeArgument(argument, currentFastMode);
    if (nextFastMode === undefined) {
      await safeReply(ctx, escapeHTML("Usage: /fast [on|off]"), {
        fallbackText: "Usage: /fast [on|off]",
      });
      return;
    }

    try {
      const result = session.setFastMode(nextFastMode);
      updateSessionMetadata(contextKey, session);
      const info = session.getInfo();
      appendTelegramActivity(ctx, contextKey, session, {
        status: "info",
        type: "fast_mode_changed",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        detail: result.enabled ? "on" : "off",
      });
      const plain = [
        `Fast mode: ${result.enabled ? "on" : "off"}`,
        `Launch profile: ${result.profile.label} (${formatLaunchProfileBehavior(result.profile)})`,
        result.appliedToActiveThread
          ? "Applied to the current idle thread and future threads."
          : "Applies to the next thread in this Telegram context.",
        "",
        renderSessionInfoPlain(info),
      ].join("\n");
      const html = [
        `<b>Fast mode:</b> <code>${result.enabled ? "on" : "off"}</code>`,
        `<b>Launch profile:</b> <code>${escapeHTML(result.profile.label)}</code> <i>(${escapeHTML(formatLaunchProfileBehavior(result.profile))})</i>`,
        result.appliedToActiveThread
          ? "Applied to the current idle thread and future threads."
          : "Applies to the next thread in this Telegram context.",
        "",
        renderSessionInfoHTML(info),
      ].join("\n");
      await safeReply(ctx, html, { fallbackText: plain });
    } catch (error) {
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed: ${friendlyErrorText(error)}`,
      });
    }
  });

  const openReasoningPicker = async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const info = session.getInfo();
    if (!capabilitiesOf(info).reasoningSelection) {
      const text = `${agentReasoningLabel(idOf(info))} selection is not supported for ${labelOf(info)}.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }
    const efforts = agentReasoningOptions(idOf(info));
    const current = info.reasoningEffort;
    const effortButtons = efforts.map((effort) => ({
      label: effort === current ? `${effort} ✓` : effort,
      callbackData: `effort_${effort}`,
    }));
    pendingEffortButtons.set(contextKey, effortButtons);
    const keyboard = paginateKeyboard(effortButtons, 0, "effort");
    const label = agentReasoningLabel(idOf(info));
    const text = current
      ? `<b>${escapeHTML(label)}:</b> <code>${escapeHTML(current)}</code>\n\nSelect for new threads:`
      : `<b>${escapeHTML(label)}:</b> not set (model default)\n\nSelect for new threads:`;
    await safeReply(ctx, text, {
      fallbackText: text.replace(/<[^>]+>/g, ""),
      replyMarkup: keyboard,
    });
  };

  bot.command(["effort", "reasoning"], openReasoningPicker);

  bot.callbackQuery(NOOP_PAGE_CALLBACK_DATA, async (ctx) => {
    await ctx.answerCallbackQuery();
  });
  handlePageCallback(/^sess_page_(\d+)$/, "sess", pendingSessionButtons, "Expired, run /sessions again");
  handlePageCallback(/^ws_page_(\d+)$/, "ws", pendingWorkspaceButtons, "Expired, run /new again");
  handlePageCallback(
    /^launch_page_(\d+)$/,
    "launch",
    pendingLaunchButtons,
    `Expired, run ${LAUNCH_PROFILES_COMMAND} again`,
  );
  handlePageCallback(/^model_page_(\d+)$/, "model", pendingModelButtons, "Expired, run /model again");
  handlePageCallback(/^effort_page_(\d+)$/, "effort", pendingEffortButtons, "Expired, run /reasoning again");

  bot.callbackQuery(/^(?:codex_abort|agent_abort):(.+)$/, async (ctx) => {
    const contextKey = ctx.match?.[1];
    if (!contextKey) {
      await ctx.answerCallbackQuery();
      return;
    }

    const session = registry.get(contextKey);
    if (!session) {
      await ctx.answerCallbackQuery({ text: "Nothing to abort" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Aborting..." });
    await session.abort();
  });

  registerTelegramExternalApprovalCallbacks({ bot, config, registry, appendActivity: appendTelegramActivity });

  bot.callbackQuery(/^approval_(yes|no):([a-z0-9]+)$/, async (ctx) => {
    const action = ctx.match?.[1];
    const approvalId = ctx.match?.[2];
    if (!action || !approvalId) {
      await ctx.answerCallbackQuery();
      return;
    }

    const pending = pendingApprovals.get(approvalId);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Approval expired" });
      return;
    }

    if (pending.requestedBy !== undefined && ctx.from?.id !== pending.requestedBy && !isAdminUser(ctx)) {
      await ctx.answerCallbackQuery({ text: "Only the requester or an admin can approve" });
      return;
    }

    clearTimeout(pending.timeout);
    pendingApprovals.delete(approvalId);
    getBusyState(pending.contextKey).approving = false;

    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (action === "no") {
      await ctx.answerCallbackQuery({ text: "Denied" });
      const text = `<b>Denied prompt</b> <code>${escapeHTML(approvalId)}</code>.`;
      if (chatId && messageId) {
        await safeEditMessage(bot, chatId, messageId, text, {
          fallbackText: `Denied prompt ${approvalId}.`,
        });
      }
      const session = registry.get(pending.contextKey);
      if (session) {
        appendTelegramActivity(ctx, pending.contextKey, session, {
          status: "aborted",
          type: "prompt_approval_denied",
          prompt: pending.prompt.description,
          detail: approvalId,
          actor: pending.prompt.activityActor,
        });
      }
      if (chatId && session) {
        void drainQueuedPrompts(ctx, pending.contextKey, chatId, session).catch((error) => {
          console.error("Failed to drain queue after approval denial:", error);
        });
      }
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      await ctx.answerCallbackQuery({ text: "No context" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Approved" });
    if (chatId && messageId) {
      await safeEditMessage(bot, chatId, messageId, `<b>Approved prompt</b> <code>${escapeHTML(approvalId)}</code>.`, {
        fallbackText: `Approved prompt ${approvalId}.`,
      });
    }
    appendTelegramActivity(ctx, pending.contextKey, contextSession.session, {
      status: "info",
      type: "prompt_approval_approved",
      prompt: pending.prompt.description,
      detail: approvalId,
      actor: pending.prompt.activityActor,
    });

    await startUserPrompt(ctx, pending.contextKey, chatId ?? parseContextKey(pending.contextKey).chatId, contextSession.session, pending.prompt, {
      approved: true,
    });
  });

  bot.callbackQuery(/^sess_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const threadIds = pendingSessionPicks.get(contextKey);
    const threadChoice = threadIds?.[index];
    if (!threadChoice) {
      await ctx.answerCallbackQuery({ text: "Session expired, run /sessions again" });
      return;
    }
    if (await handleTargetPeerSessionCallback({
      ctx,
      bot,
      chatId,
      messageId,
      contextKey,
      threadChoice,
      preferencesStore,
      remoteClient,
      actor: telegramActivityActor(ctx),
      canUsePeer: (peerId) => userStore.canUsePeer(getAuthenticatedUser(ctx), peerId),
      syncPeerMirror: (key) => peerMirrorController.sync(key, telegramChannelContextFromKey(key)),
    })) {
      pendingSessionPicks.delete(contextKey);
      pendingSessionButtons.delete(contextKey);
      return;
    }
    const threadId = threadChoice;
    const threadRecord = session.getSessionRecord(threadId);
    const workspacePolicy = evaluateWorkspacePolicy(threadRecord?.cwd ?? session.getCurrentWorkspace(), config);
    if (!workspacePolicy.allowed) {
      await ctx.answerCallbackQuery({ text: "Workspace blocked" });
      await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(workspacePolicy.warning ?? "Thread workspace blocked by policy.")}`, {
        fallbackText: `Failed: ${workspacePolicy.warning ?? "Thread workspace blocked by policy."}`,
      });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Switching..." });
    pendingSessionPicks.delete(contextKey);
    pendingSessionButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await session.switchSession(threadId);
      updateSessionMetadata(contextKey, session);
      appendTelegramActivity(ctx, contextKey, session, {
        status: "info",
        type: "session_switch",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        detail: threadId,
      });
      const policyLine = renderWorkspacePolicyLine(info.workspace, config);
      const plainText = ["Switched session.", policyLine, "", renderSessionInfoPlain(info)].filter((line): line is string => line !== undefined).join("\n");
      const html = ["<b>Switched session.</b>", policyLine ? `<i>${escapeHTML(policyLine)}</i>` : undefined, "", renderSessionInfoHTML(info)].filter((line): line is string => line !== undefined).join("\n");

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^ws_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const workspaces = pendingWorkspacePicks.get(contextKey);
    const workspace = workspaces?.[index];
    if (!workspace) {
      await ctx.answerCallbackQuery({ text: "Expired, run /new again" });
      return;
    }
    const workspacePolicy = evaluateWorkspacePolicy(workspace, config);
    if (!workspacePolicy.allowed) {
      await ctx.answerCallbackQuery({ text: "Workspace blocked" });
      await safeReply(ctx, escapeHTML(workspacePolicy.warning ?? "Workspace blocked by policy."), {
        fallbackText: workspacePolicy.warning ?? "Workspace blocked by policy.",
      });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Creating thread..." });
    pendingWorkspacePicks.delete(contextKey);
    pendingWorkspaceButtons.delete(contextKey);

    const busyState = getBusyState(contextKey);
    busyState.switching = true;
    try {
      const info = await registry.startNewThread(contextKey, session, { workspace });
      appendTelegramActivity(ctx, contextKey, session, {
        status: "info",
        type: "session_new",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        detail: workspace,
      });
      const label = isTopicContext(contextKey) ? "New thread created for this topic." : "New thread created.";
      const policyLine = renderWorkspacePolicyLine(info.workspace, config);
      const plainText = [label, policyLine, "", renderSessionInfoPlain(info)].filter((line): line is string => line !== undefined).join("\n");
      const html = [`<b>${escapeHTML(label)}</b>`, policyLine ? `<i>${escapeHTML(policyLine)}</i>` : undefined, "", renderSessionInfoHTML(info)].filter((line): line is string => line !== undefined).join("\n");

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    } finally {
      busyState.switching = false;
    }
  });

  bot.callbackQuery(/^launch_(\d+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const index = Number.parseInt(ctx.match?.[1] ?? "", 10);

    if (!chatId || Number.isNaN(index)) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const launchProfileIds = pendingLaunchPicks.get(contextKey);
    const profileId = launchProfileIds?.[index];
    if (!profileId) {
      await ctx.answerCallbackQuery({ text: `Expired, run ${LAUNCH_PROFILES_COMMAND} again` });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const profile = session.listLaunchProfiles().find((candidate) => candidate.id === profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Launch profile no longer exists" });
      return;
    }

    if (profile.unsafe) {
      pendingUnsafeLaunchConfirmations.set(contextKey, profile.id);
      pendingLaunchPicks.delete(contextKey);
      pendingLaunchButtons.delete(contextKey);

      await ctx.answerCallbackQuery({ text: "Confirm danger-full-access" });
      const confirmKeyboard = new InlineKeyboard()
        .text("Enable for next launches", `launchconfirm_yes:${profile.id}:next`)
        .row()
        .text("Apply to current session", `launchconfirm_yes:${profile.id}:apply`)
        .row()
        .text("Cancel", `launchconfirm_no:${profile.id}`);
      const html = [
        `<b>Confirm launch profile:</b> <code>${escapeHTML(profile.label)}</code>`,
        `<b>Behavior:</b> <code>${escapeHTML(profile.behavior)}</code>`,
        "",
        "⚠️ <b>This profile uses danger-full-access.</b>",
        "Choose whether to apply it only to future launches or to the current idle thread now.",
      ].join("\n");
      const plain = [
        `Confirm launch profile: ${profile.label}`,
        `Behavior: ${profile.behavior}`,
        "",
        "WARNING: This profile uses danger-full-access.",
        "Choose whether to apply it only to future launches or to the current idle thread now.",
      ].join("\n");

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      } else {
        await safeReply(ctx, html, {
          fallbackText: plain,
          replyMarkup: confirmKeyboard,
        });
      }
      return;
    }

    await ctx.answerCallbackQuery({ text: `Launch set to ${profile.label}` });
    clearLaunchSelectionState(contextKey);
    const { info } = await setTelegramLaunchProfile(ctx, contextKey, session, profile.id, false);
    const resultText = renderLaunchProfileResult(info, profile.behavior, false, false);
    const applyKeyboard = new InlineKeyboard().text("Apply to current session", `launchapply:${profile.id}`);

    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, resultText.html, {
        fallbackText: resultText.plain,
        replyMarkup: applyKeyboard,
      });
    } else {
      await safeReply(ctx, resultText.html, {
        fallbackText: resultText.plain,
        replyMarkup: applyKeyboard,
      });
    }
  });

  bot.callbackQuery(/^launchapply:([a-z0-9_-]+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const profileId = ctx.match?.[1];
    if (!chatId || !messageId || !profileId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const profile = session.listLaunchProfiles().find((candidate) => candidate.id === profileId);
    if (!profile) {
      await ctx.answerCallbackQuery({ text: "Launch profile no longer exists" });
      return;
    }
    if (profile.unsafe) {
      await ctx.answerCallbackQuery({ text: "Confirm danger-full-access first" });
      return;
    }

    const blocker = externalLaunchApplyBlocker(session);
    if (blocker) {
      await ctx.answerCallbackQuery({ text: "External CLI task is still running" });
      await safeEditMessage(bot, chatId, messageId, escapeHTML(blocker), { fallbackText: blocker });
      return;
    }
    const { info, appliedToActiveThread } = await setTelegramLaunchProfile(ctx, contextKey, session, profile.id, true);
    const resultText = renderLaunchProfileResult(info, profile.behavior, true, appliedToActiveThread);
    await ctx.answerCallbackQuery({ text: appliedToActiveThread ? "Applied to current session" : "Launch profile updated" });
    await safeEditMessage(bot, chatId, messageId, resultText.html, { fallbackText: resultText.plain });
  });

  bot.callbackQuery(/^launchconfirm_(yes|no):([a-z0-9_-]+)(?::(apply|next))?$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const action = ctx.match?.[1];
    const confirmedProfileId = ctx.match?.[2];
    const mode = ctx.match?.[3] === "apply" ? "apply" : "next";

    if (!chatId || !messageId || !action || !confirmedProfileId) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const profileId = pendingUnsafeLaunchConfirmations.get(contextKey);
    if (!profileId || profileId !== confirmedProfileId) {
      await ctx.answerCallbackQuery({ text: `Expired, run ${LAUNCH_PROFILES_COMMAND} again` });
      return;
    }

    if (action === "no") {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>Launch change cancelled.</b>\n\nRun ${LAUNCH_PROFILES_COMMAND} again to pick another profile.`,
        {
          fallbackText: `Launch change cancelled.\n\nRun ${LAUNCH_PROFILES_COMMAND} again to pick another profile.`,
        },
      );
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    const profile = session.listLaunchProfiles().find((candidate) => candidate.id === profileId);
    if (!profile) {
      clearLaunchSelectionState(contextKey);
      await ctx.answerCallbackQuery({ text: "Launch profile no longer exists" });
      await safeEditMessage(
        bot,
        chatId,
        messageId,
        `<b>Launch profile expired.</b>\n\nRun ${LAUNCH_PROFILES_COMMAND} again.`,
        {
          fallbackText: `Launch profile expired.\n\nRun ${LAUNCH_PROFILES_COMMAND} again.`,
        },
      );
      return;
    }

    clearLaunchSelectionState(contextKey);
    const applyToCurrent = mode === "apply";
    const blocker = applyToCurrent ? externalLaunchApplyBlocker(session) : null;
    if (blocker) {
      await ctx.answerCallbackQuery({ text: "External CLI task is still running" });
      await safeEditMessage(bot, chatId, messageId, escapeHTML(blocker), { fallbackText: blocker });
      return;
    }
    const { info, appliedToActiveThread } = await setTelegramLaunchProfile(ctx, contextKey, session, profile.id, applyToCurrent);
    await ctx.answerCallbackQuery({ text: applyToCurrent && appliedToActiveThread ? "Applied to current session" : `Launch set to ${info.launchProfileLabel}` });

    const resultText = renderLaunchProfileResult(info, profile.behavior, applyToCurrent, appliedToActiveThread);
    const html = `${resultText.html}\n\n⚠️ <i>danger-full-access confirmed.</i>`;
    const plain = `${resultText.plain}\n\ndanger-full-access confirmed.`;

    await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
  });

  bot.callbackQuery(/^model_(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const slug = ctx.match?.[1];

    if (!chatId || !slug) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingModelButtons.get(contextKey);
    if (!buttons) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    const modelExists = buttons.some((button) => button.callbackData === `model_${slug}`);
    if (!modelExists) {
      await ctx.answerCallbackQuery({ text: "Expired, run /model again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Setting model..." });
    pendingModelButtons.delete(contextKey);

    try {
      const result = await session.setModelForCurrentSession(slug);
      updateSessionMetadata(contextKey, session);
      const info = session.getInfo();
      appendTelegramActivity(ctx, contextKey, session, {
        status: "info",
        type: "model_changed",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        detail: result.value,
      });
      const scope = formatAgentSettingScope(session.getInfo(), result.appliedToActiveThread);
      const html = `<b>Model set to</b> <code>${escapeHTML(result.value)}</code> — ${escapeHTML(scope)}.`;
      const plainText = `Model set to ${result.value} — ${scope}.`;

      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plainText });
      } else {
        await safeReply(ctx, html, { fallbackText: plainText });
      }
    } catch (error) {
      const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const errPlain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, errHtml, { fallbackText: errPlain });
      } else {
        await safeReply(ctx, errHtml, { fallbackText: errPlain });
      }
    }
  });

  bot.callbackQuery(/^effort_(off|none|minimal|low|medium|high|xhigh)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const effort = ctx.match?.[1];

    if (!chatId || !messageId || !effort) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const buttons = pendingEffortButtons.get(contextKey);
    if (!buttons || !buttons.some((button) => button.callbackData === `effort_${effort}`)) {
      await ctx.answerCallbackQuery({ text: "Expired, run /reasoning again" });
      return;
    }

    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Effort set to ${effort}` });
    pendingEffortButtons.delete(contextKey);
    const result = await session.setReasoningEffortForCurrentSession(effort);
    updateSessionMetadata(contextKey, session);
    const info = session.getInfo();
    appendTelegramActivity(ctx, contextKey, session, {
      status: "info",
      type: "reasoning_changed",
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      detail: result.value,
    });
    const label = agentReasoningLabel(idOf(session.getInfo()));
    const scope = formatAgentSettingScope(session.getInfo(), result.appliedToActiveThread);
    const html = `⚡ ${escapeHTML(label)} set to <code>${escapeHTML(effort)}</code> — ${escapeHTML(scope)}.`;
    await safeEditMessage(bot, chatId, messageId, html, {
      fallbackText: `⚡ ${label} set to ${effort} — ${scope}.`,
    });
  });

  bot.on("message:text", async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const userText = ctx.message.text.trim();
    if (!userText || userText.startsWith("/")) {
      return;
    }

    const { contextKey, session } = contextSession;
    await startUserPrompt(ctx, contextKey, ctx.chat.id, session, userText);
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;

    const fileId = ctx.message.voice?.file_id ?? ctx.message.audio?.file_id;
    if (!fileId) {
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;
    let transcript: string | undefined;

    try {
      await sendChatActionSafe(ctx.api, chatId, "typing", ctx.message?.message_thread_id);
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, fileId);

      const backendPreference = getEffectiveVoiceBackend(contextKey);
      const language = getEffectiveVoiceLanguage(contextKey);
      const result = await transcribeAudio(tempFilePath, {
        preferredBackend: backendPreference === "auto" ? undefined : backendPreference as TranscriptionBackend,
        language,
      });
      transcript = result.text.trim();
      if (!transcript) {
        await safeReply(ctx, escapeHTML("Transcription was empty. Please try again or send text instead."), {
          fallbackText: "Transcription was empty. Please try again or send text instead.",
        });
        return;
      }

      const preview = trimLine(transcript.replace(/\s+/g, " "), 100);
      await safeReply(
        ctx,
        `🎙️ <b>Transcribed:</b> ${escapeHTML(preview)} <i>(via ${escapeHTML(result.backend)}, ${formatDurationSeconds(result.durationMs / 1000)})</i>`,
        { fallbackText: `🎙️ Transcribed: ${preview} (via ${result.backend}, ${formatDurationSeconds(result.durationMs / 1000)})` },
      );
      appendTelegramActivity(ctx, contextKey, session, {
        status: "info",
        type: "voice_transcribed",
        prompt: preview,
        detail: result.backend,
        durationMs: result.durationMs,
      });
    } catch (error) {
      const note = "Voice uses faster-whisper, Cohere Transcribe, or parakeet locally, or OPENAI_API_KEY for cloud transcription, not CODEX_API_KEY.";
      await safeReply(ctx, `<b>Transcription failed:</b>\n${escapeHTML(friendlyErrorText(error))}\n\n<i>${escapeHTML(note)}</i>`, {
        fallbackText: `Transcription failed:\n${friendlyErrorText(error)}\n\n${note}`,
      });
      appendTelegramActivity(ctx, contextKey, session, {
        status: "failed",
        type: "voice_transcription_failed",
        detail: friendlyErrorText(error),
      });
      return;
    } finally {
      busyState.transcribing = false;
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    if (!transcript) {
      return;
    }
    if (isVoiceTranscribeOnly(contextKey)) {
      return;
    }

    await startUserPrompt(ctx, contextKey, chatId, session, transcript);
  });

  bot.on("message:photo", async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;

    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    if (!photo) {
      return;
    }

    if (ctx.message.media_group_id) {
      enqueueMediaGroupPart(ctx, contextKey, chatId, session, ctx.message.media_group_id, {
        kind: "photo",
        fileId: photo.file_id,
        fileName: `photo-${photo.file_unique_id}.jpg`,
        mimeType: "image/jpeg",
        caption: ctx.message.caption?.trim(),
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;

    try {
      await sendChatActionSafe(ctx.api, chatId, "upload_photo", ctx.message?.message_thread_id);
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, photo.file_id, 20 * 1024 * 1024);
    } catch (error) {
      await safeReply(ctx, `<b>Failed to download photo:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to download photo: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
      if (!tempFilePath) {
        // Download failed — nothing to clean up further
      }
    }

    const turnId = randomUUID().slice(0, 12);
    const workspace = session.getCurrentWorkspace();
    const outDir = outboxPath(workspace, turnId);
    await ensureOutDir(outDir);

    let stagedPhoto: StagedFile;
    try {
      const buffer = await readFile(tempFilePath);
      stagedPhoto = await stageFile(buffer, `photo-${turnId}.jpg`, "image/jpeg", {
        workspace,
        turnId,
        maxFileSize: config.maxFileSize,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed to stage photo:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to stage photo: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      await unlink(tempFilePath).catch(() => {});
    }

    const caption = ctx.message.caption?.trim();
    const promptInput: AgentPromptInput = {
      imagePaths: [stagedPhoto.localPath],
      stagedFileInstructions: buildFileInstructions([stagedPhoto], outDir),
    };
    if (caption) {
      promptInput.text = caption;
    }
    appendTelegramActivity(ctx, contextKey, session, {
      status: "info",
      type: "attachment_staged",
      detail: stagedPhoto.safeName,
    });
    await startUserPrompt(ctx, contextKey, chatId, session, { ...toPromptEnvelope(promptInput, outDir), attachments: webChatAttachmentsForStagedFiles([stagedPhoto], turnId) });
  });

  bot.on("message:document", async (ctx) => {
    const contextSession = await getContextSession(ctx);
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const chatId = ctx.chat.id;

    const doc = ctx.message.document;
    if (!doc) {
      return;
    }

    if (ctx.message.media_group_id) {
      enqueueMediaGroupPart(ctx, contextKey, chatId, session, ctx.message.media_group_id, {
        kind: "document",
        fileId: doc.file_id,
        fileName: doc.file_name ?? "document",
        mimeType: doc.mime_type ?? "application/octet-stream",
        fileSize: doc.file_size,
        caption: ctx.message.caption?.trim(),
      });
      return;
    }

    if (doc.file_size && doc.file_size > config.maxFileSize) {
      const sizeMB = Math.round(doc.file_size / 1024 / 1024);
      const maxMB = Math.round(config.maxFileSize / 1024 / 1024);
      await safeReply(ctx, `<b>File too large</b> (${sizeMB} MB, max ${maxMB} MB)`, {
        fallbackText: `File too large (${sizeMB} MB, max ${maxMB} MB)`,
      });
      return;
    }

    const busyState = getBusyState(contextKey);
    busyState.transcribing = true;
    let tempFilePath: string | undefined;

    try {
      await sendChatActionSafe(ctx.api, chatId, "typing", ctx.message?.message_thread_id);
      tempFilePath = await downloadTelegramFile(ctx.api, config.telegramBotToken, doc.file_id, config.maxFileSize);
    } catch (error) {
      await safeReply(ctx, `<b>Failed to download file:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to download file: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      busyState.transcribing = false;
    }

    const turnId = randomUUID().slice(0, 12);
    const workspace = session.getCurrentWorkspace();
    const originalName = doc.file_name ?? "document";
    const mimeType = doc.mime_type ?? "application/octet-stream";

    let stagedFile: StagedFile;
    try {
      const buffer = await readFile(tempFilePath);
      stagedFile = await stageFile(buffer, originalName, mimeType, {
        workspace,
        turnId,
        maxFileSize: config.maxFileSize,
      });
    } catch (error) {
      await safeReply(ctx, `<b>Failed to stage file:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to stage file: ${friendlyErrorText(error)}`,
      });
      return;
    } finally {
      if (tempFilePath) {
        await unlink(tempFilePath).catch(() => {});
      }
    }

    await safeReply(ctx, `📎 <b>Received:</b> <code>${escapeHTML(stagedFile.safeName)}</code>`, {
      fallbackText: `📎 Received: ${stagedFile.safeName}`,
    });
    appendTelegramActivity(ctx, contextKey, session, {
      status: "info",
      type: "attachment_staged",
      detail: stagedFile.safeName,
    });

    // Keep typing visible during the gap between staging and prompt execution
    await sendChatActionSafe(ctx.api, chatId, "typing", ctx.message?.message_thread_id).catch(() => {});

    const outDir = outboxPath(workspace, turnId);
    await ensureOutDir(outDir);

    const promptInput: AgentPromptInput = {
      stagedFileInstructions: buildFileInstructions([stagedFile], outDir),
    };
    const caption = ctx.message.caption?.trim();
    if (caption) {
      promptInput.text = caption;
    }

    await startUserPrompt(ctx, contextKey, chatId, session, { ...toPromptEnvelope(promptInput, outDir), attachments: webChatAttachmentsForStagedFiles([stagedFile], turnId) });
  });

  registerTelegramErrorHandler(bot);

  peerMirrorController.startStoredContexts();

  return bot;
}
