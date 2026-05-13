import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";

import { ADMIN_GROUP_ID } from "./access-control.js";
import {
  buildFileInstructions,
  outboxPath,
  stageFile,
  type StagedFile,
} from "./attachments.js";
import {
  collectArtifactReport,
  collectRecentWorkspaceArtifacts,
  createArtifactZipBundle,
  ensureOutDir,
  formatArtifactSummary,
  getArtifactTurnReport,
  isTelegramImagePreview,
  listRecentArtifactReports,
  persistWorkspaceArtifactReport,
  pruneConnectorTurnDirs,
  removeArtifactTurn,
  telegramArtifactFilename,
  totalArtifactSize,
  type Artifact,
  type ArtifactTurnReport,
} from "./artifacts.js";
import { listAgentAdapterDescriptors } from "./agent-adapter.js";
import { AgentUpdateManager } from "./agent-updates.js";
import { AuditLogStore, type AuditEvent } from "./audit-log.js";
import {
  formatSessionLabel,
  renderHelpMessage,
  renderWelcomeFirstTime,
  renderWelcomeReturning,
} from "./bot-ui.js";
import {
  BotPreferencesStore,
  formatQuietHours,
  isQuietNow,
  parseMirrorMode,
  parseNotifyMode,
  parseQuietHours,
  parseVoiceBackendPreference,
  type ContextPreferences,
  type TelegramMirrorMode,
  type TelegramNotifyMode,
  type VoiceBackendPreference,
} from "./bot-preferences.js";
import {
  logTailRequests,
  parseLogsCommand,
  renderAgentUpdateJobAction,
  renderAgentsAction,
  renderArtifactReportsAction,
  renderChannelsAction,
  renderLogTailsAction,
  renderQueueListAction,
  renderQueuedPromptDetailAction,
  type ChannelActionResponse,
} from "./channel-actions.js";
import { listChannelDescriptors } from "./channel-adapter.js";
import { deliverChannelAction } from "./channel-runtime.js";
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
} from "./agent.js";
import {
  getAgentActivityLog,
  getAgentDiagnostics,
  getExternalActivityForSession,
  getExternalSnapshotForSession,
} from "./agent-activity.js";
import { enabledAgents } from "./agent-factory.js";
import { checkAuthStatus, clearAuthCache, startLogin as startCodexLogin, startLogout as startCodexLogout, type LoginResult } from "./codex-auth.js";
import { checkClaudeCodeAuthStatus, startClaudeCodeLogin, startClaudeCodeLogout } from "./claude-code-auth.js";
import { formatLaunchProfileBehavior } from "./codex-launch.js";
import type { ConnectorConfig, ToolVerbosity } from "./config.js";
import { contextKeyFromCtx, isTelegramContextKey, isTopicContextKey, parseContextKey, type TelegramContextKey } from "./context-key.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML } from "./format.js";
import {
  getConnectorHealth,
  getVersionChecks,
  readConnectorState,
  readFormattedLogTail,
  spawnConnectorRestart,
} from "./operations.js";
import { PromptStore, toPromptEnvelope, type PromptEnvelope, type QueuedPrompt } from "./prompt-store.js";
import { checkHermesAuthStatus, startHermesLogin, startHermesLogout } from "./hermes-auth.js";
import { checkOpenClawAuthStatus } from "./openclaw-auth.js";
import { checkPiAuthStatus } from "./pi-auth.js";
import { configureRedaction, redactText } from "./redaction.js";
import { canWriteWithLock, SessionLockStore } from "./session-locks.js";
import {
  renderLaunchSummaryHTML,
  renderLaunchSummaryPlain,
  renderSessionInfoHTML,
  renderSessionInfoPlain,
} from "./session-format.js";
import { SessionRegistry } from "./session-registry.js";
import { getAvailableBackends, transcribeAudio, type TranscriptionBackend } from "./voice.js";
import { getTelegramRateLimitMetrics, telegramRateLimiter } from "./telegram-rate-limit.js";
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
import { registerTelegramUpdateCommands } from "./telegram-update-commands.js";
import {
  appendWithCap,
  authHelpText,
  buildArtifactActionsKeyboard,
  buildStreamingPreview,
  capabilitiesOf,
  filterActivityEvents,
  filterArtifactReports,
  filterSessions,
  formatAgentLaunchProfileLabel,
  formatAgentSettingScope,
  formatCliPathHTML,
  formatCliPathPlain,
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
  parseActivityOptions,
  parseFastModeArgument,
  parseToggle,
  renderActivityTimeline,
  renderAgentDiagnostics,
  renderAuditEvents,
  renderDiagnosticsHTML,
  renderDiagnosticsPlain,
  renderExternalMirrorEvent,
  renderExternalMirrorStatus,
  renderHealthHTML,
  renderHealthPlain,
  renderPromptFailure,
  renderProgressHTML,
  renderProgressPlain,
  renderSessionLocks,
  renderTodoList,
  renderToolEndMessage,
  renderToolStartMessage,
  renderVersionCheckHTML,
  renderVersionCheckPlain,
  requiresTurnApproval,
  trimLine,
  type RuntimeDiagnostics,
} from "./bot-rendering.js";
import { UserStore, type AuthenticatedUser } from "./user-management.js";
import {
  evaluateWorkspacePolicy,
  filterAllowedWorkspaces,
  renderWorkspacePolicyLine,
} from "./workspace-policy.js";

export { formatToolSummaryLine, formatTurnUsageLine, summarizeToolName } from "./bot-rendering.js";
export { registerCommands } from "./telegram-command-menu.js";

const EDIT_DEBOUNCE_MS = 1500;
const TYPING_INTERVAL_MS = 4500;
const TOOL_OUTPUT_PREVIEW_LIMIT = 500;
const MAX_AUDIO_FILE_SIZE = 25 * 1024 * 1024;
const MEDIA_GROUP_FLUSH_MS = 1200;
const LAUNCH_PROFILES_COMMAND = "/launch_profiles";

interface RateLimitBucket {
  count: number;
  resetAt: number;
  blockedUntil?: number;
}

type ToolState = {
  toolName: string;
  partialResult: string;
  messageId?: number;
  finalStatus?: RenderedText;
};

type MediaGroupPart =
  | {
      kind: "photo";
      fileId: string;
      fileName: string;
      mimeType: string;
      caption?: string;
    }
  | {
      kind: "document";
      fileId: string;
      fileName: string;
      mimeType: string;
      fileSize?: number;
      caption?: string;
    };

type PendingMediaGroup = {
  ctx: Context;
  contextKey: TelegramContextKey;
  chatId: TelegramChatId;
  session: AgentSessionService;
  messageThreadId?: number;
  parts: MediaGroupPart[];
  timer: NodeJS.Timeout;
};

type TurnProgress = {
  status: "running" | "completed" | "failed";
  promptDescription: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  currentTool?: string;
  lastTool?: string;
  toolCounts: Map<string, number>;
  textCharacters: number;
  error?: string;
};

type BusyState = {
  processing: boolean;
  switching: boolean;
  transcribing: boolean;
  approving: boolean;
  external?: boolean;
};

type BusyReason =
  | { busy: false; kind: "idle" }
  | { busy: true; kind: "connector"; state: BusyState }
  | { busy: true; kind: "external"; activity: AgentExternalActivity };

type ExternalMirrorState = {
  threadId: string;
  rolloutPath: string;
  lastLine: number;
  statusMessageId?: number;
  turnId?: string | null;
  startedAt?: Date | null;
  latestStatus?: string;
  latestStatusAt?: number;
  latestAgentLine?: number;
  latestMirroredEventLine?: number;
  artifactsDeliveredForTurnId?: string | null;
};

type QueueStatusState = {
  messageId?: number;
  lastText?: string;
};

export function createBot(config: ConnectorConfig, registry: SessionRegistry): Bot<Context> {
  configureRedaction(config.telegramRedactPatterns);
  telegramRateLimiter.configure({
    minIntervalMs: config.telegramRateLimitMinIntervalMs,
    editMinIntervalMs: config.telegramEditMinIntervalMs,
    maxRetries: 5,
  });
  const bot = new Bot<Context>(config.telegramBotToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));
  const telegramChannelRuntime = new TelegramBotChannelRuntime(bot);

  const contextBusy = new Map<
    TelegramContextKey,
    BusyState
  >();
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
  const turnProgress = new Map<TelegramContextKey, TurnProgress>();
  const promptStore = new PromptStore(config.workspace, config.stateBackend);
  const preferencesStore = new BotPreferencesStore(config.workspace, config.stateBackend);
  const auditLog = new AuditLogStore(config.workspace, config.stateBackend, config.auditMaxEvents);
  const lockStore = new SessionLockStore(config.workspace, config.stateBackend);
  const userStore = new UserStore();
  const contextUsers = new WeakMap<Context, AuthenticatedUser>();
  const agentUpdates = new AgentUpdateManager();
  const linkAttempts = new Map<string, RateLimitBucket>();
  const drainingQueues = new Set<TelegramContextKey>();
  const externalQueueTimers = new Map<TelegramContextKey, NodeJS.Timeout>();
  const externalMirrors = new Map<TelegramContextKey, ExternalMirrorState>();
  const queueStatusMessages = new Map<TelegramContextKey, QueueStatusState>();
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
  const externalMonitorInterval = setInterval(() => {
    void monitorExternalContexts().catch((error) => {
      console.error("Failed to monitor external agent activity:", error);
    });
  }, config.codexExternalBusyCheckMs);
  externalMonitorInterval.unref?.();
  setTimeout(() => {
    void monitorExternalContexts().catch((error) => {
      console.error("Failed to run initial external agent monitor:", error);
    });
  }, 0).unref?.();

  registry.onRemove((key) => {
    contextBusy.delete(key);
    turnProgress.delete(key);
    externalMirrors.delete(key);
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

  const getBusyState = (
    contextKey: TelegramContextKey,
  ): BusyState => {
    let state = contextBusy.get(contextKey);
    if (!state) {
      state = { processing: false, switching: false, transcribing: false, approving: false };
      contextBusy.set(contextKey, state);
    }
    return state;
  };

  const getExternalActivity = (session: AgentSessionService | undefined): AgentExternalActivity | null =>
    getExternalActivityForSession(session, config);

  const getBusyReason = (contextKey: TelegramContextKey): BusyReason => {
    const state = contextBusy.get(contextKey);
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

  const isBusy = (contextKey: TelegramContextKey): boolean => {
    return getBusyReason(contextKey).busy;
  };

  const getContextSession = async (
    ctx: Context,
    options?: { deferThreadStart?: boolean },
  ): Promise<{ contextKey: TelegramContextKey; session: AgentSessionService } | null> => {
    const contextKey = contextKeyFromCtx(ctx);
    if (!contextKey) {
      return null;
    }

    const session = await registry.getOrCreate(contextKey, options);
    return { contextKey, session };
  };

  const updateSessionMetadata = (contextKey: TelegramContextKey, session: AgentSessionService): void => {
    registry.updateMetadata(contextKey, session);
  };

  const checkAgentAuthStatus = async (info: AgentSessionInfo) => {
    if (idOf(info) === "pi") {
      return checkPiAuthStatus(info.model);
    }
    if (idOf(info) === "hermes") {
      return checkHermesAuthStatus({
        baseUrl: config.hermesApiBaseUrl,
        apiKey: config.hermesApiKey,
      });
    }
    if (idOf(info) === "openclaw") {
      return checkOpenClawAuthStatus({
        gatewayUrl: config.openClawGatewayUrl,
        token: config.openClawGatewayToken,
        password: config.openClawGatewayPassword,
      });
    }
    if (idOf(info) === "claude-code") {
      return checkClaudeCodeAuthStatus(config.claudeCodeCliPath);
    }
    return checkAuthStatus(config.codexApiKey);
  };

  const agentIdForAuth = (info?: AgentSessionInfo): AgentId => info ? idOf(info) : "codex";

  const labelForAuth = (info?: AgentSessionInfo): string => info ? labelOf(info) : "Codex";

  const checkLoginAuthStatus = async (info?: AgentSessionInfo): Promise<{ authenticated: boolean; method: string; detail: string }> => {
    const agentId = agentIdForAuth(info);
    if (agentId === "hermes") {
      return checkHermesAuthStatus({
        baseUrl: config.hermesApiBaseUrl,
        apiKey: config.hermesApiKey,
      });
    }
    if (agentId === "claude-code") {
      return checkClaudeCodeAuthStatus(config.claudeCodeCliPath);
    }
    return checkAuthStatus(config.codexApiKey);
  };

  const replyChannelAction = async (ctx: Context, rendered: ChannelActionResponse): Promise<void> => {
    const channelContext = telegramChannelContextFromCtx(ctx);
    if (!channelContext) {
      return;
    }
    await deliverChannelAction(telegramChannelRuntime, channelContext, rendered);
  };

  const agentUpdateContext = () => ({
    piCliPath: config.piCliPath,
    hermesCliPath: config.hermesCliPath,
    openClawCliPath: config.openClawCliPath,
    claudeCodeCliPath: config.claudeCodeCliPath,
  });

  const startTelegramAgentUpdate = async (ctx: Context, agentId: AgentId): Promise<void> => {
    try {
      const job = agentUpdates.start(agentId, agentUpdateContext());
      const contextKey = contextKeyFromCtx(ctx);
      if (contextKey) {
        audit({
          action: "command",
          status: "ok",
          contextKey,
          agentId,
          description: `update ${agentId}`,
          detail: job.summary,
        });
      }
      const rendered = renderAgentUpdateJobAction(job);
      await replyChannelAction(ctx, rendered);
    } catch (error) {
      const message = `Failed to start ${agentLabel(agentId)} update: ${friendlyErrorText(error)}`;
      await safeReply(ctx, `<b>Update failed:</b> ${escapeHTML(message)}`, { fallbackText: message });
    }
  };

  const startAgentLogin = (info?: AgentSessionInfo): Promise<LoginResult> => {
    const agentId = agentIdForAuth(info);
    if (agentId === "hermes") {
      return startHermesLogin(config.hermesCliPath);
    }
    if (agentId === "claude-code") {
      return startClaudeCodeLogin(config.claudeCodeCliPath);
    }
    return startCodexLogin();
  };

  const startAgentLogout = (info?: AgentSessionInfo): Promise<LoginResult> => {
    const agentId = agentIdForAuth(info);
    if (agentId === "hermes") {
      return startHermesLogout(config.hermesCliPath);
    }
    if (agentId === "claude-code") {
      return startClaudeCodeLogout(config.claudeCodeCliPath);
    }
    return startCodexLogout();
  };

  const hostLoginCommand = (info?: AgentSessionInfo): string => {
    const agentId = agentIdForAuth(info);
    if (agentId === "hermes") {
      return `${config.hermesCliPath ?? "hermes"} login --no-browser`;
    }
    if (agentId === "claude-code") {
      return `${config.claudeCodeCliPath ?? "claude"} auth login`;
    }
    return "codex login --device-auth";
  };

  const hostLogoutCommand = (info?: AgentSessionInfo): string => {
    const agentId = agentIdForAuth(info);
    if (agentId === "hermes") {
      return `${config.hermesCliPath ?? "hermes"} logout`;
    }
    if (agentId === "claude-code") {
      return `${config.claudeCodeCliPath ?? "claude"} auth logout`;
    }
    return "codex logout";
  };

  const isTopicContext = (contextKey: TelegramContextKey): boolean => isTopicContextKey(contextKey);

  const getPreferences = (contextKey: TelegramContextKey): ContextPreferences => preferencesStore.get(contextKey);

  const getEffectiveMirrorMode = (contextKey: TelegramContextKey): TelegramMirrorMode =>
    getPreferences(contextKey).mirrorMode ?? config.telegramMirrorMode;

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

  const queueCancelCallbackData = (
    action: "cancel" | "remove" | "top" | "up" | "down" | "run",
    contextKey: TelegramContextKey,
    queueId: string,
  ): string => `queue_${action}:${contextKey}:${queueId}`;

  const createQueuedPromptCancelKeyboard = (
    contextKey: TelegramContextKey,
    queueId: string,
    label = "Cancel queued message",
  ): InlineKeyboard => new InlineKeyboard().text(label, queueCancelCallbackData("cancel", contextKey, queueId));

  const renderQueueList = (
    contextKey: TelegramContextKey,
    queue: QueuedPrompt[],
  ): { plain: string; html: string; keyboard?: InlineKeyboard } => {
    const paused = promptStore.isPaused(contextKey);
    const rendered = renderQueueListAction(queue, paused);
    if (queue.length === 0) {
      return rendered;
    }

    const keyboard = new InlineKeyboard();
    queue.forEach((item, index) => {
      keyboard
        .text(`Run ${index + 1}`, queueCancelCallbackData("run", contextKey, item.id))
        .text("Top", queueCancelCallbackData("top", contextKey, item.id))
        .text("Cancel", queueCancelCallbackData("remove", contextKey, item.id))
        .row();
      keyboard
        .text("Up", queueCancelCallbackData("up", contextKey, item.id))
        .text("Down", queueCancelCallbackData("down", contextKey, item.id))
        .row();
    });
    return { ...rendered, keyboard };
  };

  const createSystemContext = (contextKey: TelegramContextKey): Context => {
    const parsed = parseContextKey(contextKey);
    return {
      api: bot.api,
      chat: { id: parsed.chatId, type: "private" },
      message: parsed.messageThreadId ? { message_thread_id: parsed.messageThreadId } : undefined,
    } as unknown as Context;
  };

  const updateQueueStatusMessage = async (
    contextKey: TelegramContextKey,
    text: string,
  ): Promise<void> => {
    if (!canSendSystemMessagesToContext(contextKey)) {
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

  const monitorExternalContexts = async (): Promise<void> => {
    const contextKeys = new Set<TelegramContextKey>([
      ...registry.listContexts().map((context) => context.contextKey),
      ...promptStore.listContextKeys(),
    ].filter(isTelegramContextKey));

    for (const contextKey of contextKeys) {
      await monitorExternalContext(contextKey);
    }
  };

  const monitorExternalContext = async (contextKey: TelegramContextKey): Promise<void> => {
    if (!isTelegramContextKey(contextKey)) {
      return;
    }
    if (!canSendSystemMessagesToContext(contextKey)) {
      return;
    }

    const session = await registry.getOrCreate(contextKey, { deferThreadStart: true }).catch(() => null);
    if (!session) {
      return;
    }

    const info = session.getInfo();
    if (!capabilitiesOf(info).externalActivity) {
      const parsed = parseContextKey(contextKey);
      const queueLength = promptStore.list(contextKey).length;
      if (queueLength > 0 && !promptStore.isPaused(contextKey) && !session.isProcessing()) {
        await drainQueuedPrompts(createSystemContext(contextKey), contextKey, parsed.chatId, session);
      }
      return;
    }

    const threadId = session.getActiveThreadId();
    const parsed = parseContextKey(contextKey);
    const queueLength = promptStore.list(contextKey).length;
    const paused = promptStore.isPaused(contextKey);

    if (!threadId) {
      if (queueLength > 0 && !paused && !session.isProcessing()) {
        await drainQueuedPrompts(createSystemContext(contextKey), contextKey, parsed.chatId, session);
      }
      return;
    }

    const previous = externalMirrors.get(contextKey);
    const snapshot = getExternalSnapshotForSession(session, config, {
      afterLine: previous?.lastLine ?? Number.MAX_SAFE_INTEGER,
    }) ?? getExternalSnapshotForSession(session, config, {
      maxEvents: 0,
    });

    if (!snapshot) {
      if (queueLength > 0 && !paused && !session.isProcessing()) {
        await drainQueuedPrompts(createSystemContext(contextKey), contextKey, parsed.chatId, session);
      }
      return;
    }

    if (!session.isProcessing()) {
      await mirrorExternalSnapshot(contextKey, parsed.chatId, session, snapshot);
    }

    const activity = snapshot.activity;
    if (activity.active && queueLength > 0) {
      await updateQueueStatusMessage(
        contextKey,
        `Waiting for ${info.agentLabel} CLI task... ${queueLength} queued${paused ? " (paused)" : ""}.`,
      );
      return;
    }

    if (!activity.active && queueLength > 0 && !paused && !session.isProcessing()) {
      await updateQueueStatusMessage(contextKey, `CLI task finished, running queued prompt 1/${queueLength}.`);
      await drainQueuedPrompts(createSystemContext(contextKey), contextKey, parsed.chatId, session);
    }
  };

  const mirrorExternalSnapshot = async (
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: AgentSessionService,
    snapshot: AgentExternalSnapshot,
  ): Promise<void> => {
    const parsed = parseContextKey(contextKey);
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

    const mirrorMode = getEffectiveMirrorMode(contextKey);
    if (snapshot.activity.active) {
      state.turnId = snapshot.activity.turnId;
      state.startedAt = snapshot.activity.startedAt;
      if (mirrorMode === "off" || mirrorMode === "final") {
        state.lastLine = Math.max(state.lastLine, snapshot.lineCount);
        return;
      }
      const status = renderExternalMirrorStatus(snapshot, promptStore.list(contextKey).length);
      const now = Date.now();
      const canUpdateStatus = !state.latestStatusAt || now - state.latestStatusAt >= config.telegramMirrorMinUpdateMs;
      if (!state.statusMessageId) {
        const message = await sendTextMessage(bot.api, chatId, status.html, {
          fallbackText: status.plain,
          messageThreadId: parsed.messageThreadId,
        });
        state.statusMessageId = message.message_id;
        state.latestStatusAt = now;
      } else if (state.latestStatus !== status.plain && canUpdateStatus) {
        await safeEditMessage(bot, chatId, state.statusMessageId, status.html, {
          fallbackText: status.plain,
        });
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
          await sendTextMessage(bot.api, chatId, rendered.html, {
            fallbackText: rendered.plain,
            messageThreadId: parsed.messageThreadId,
          });
          state.latestMirroredEventLine = event.lineNumber;
        }
      }
      await sendChatActionSafe(bot.api, chatId, "typing", parsed.messageThreadId).catch(() => {});
      state.lastLine = Math.max(state.lastLine, snapshot.lineCount);
      return;
    }

    if (!previous) {
      state.lastLine = Math.max(state.lastLine, snapshot.lineCount);
      return;
    }

    const terminalEvent = [...snapshot.events].reverse().find((event) => event.kind === "task" && event.status && event.status !== "started");
    if (terminalEvent) {
      if (mirrorMode !== "off") {
        const doneText = `${snapshot.agentLabel} CLI task ${terminalEvent.status}.`;
        if (state.statusMessageId) {
          await safeEditMessage(bot, chatId, state.statusMessageId, escapeHTML(doneText), {
            fallbackText: doneText,
          });
        } else if (shouldNotify(contextKey, "minimal")) {
          await sendTextMessage(bot.api, chatId, escapeHTML(doneText), {
            fallbackText: doneText,
            messageThreadId: parsed.messageThreadId,
          });
        }
      }

      const finalAgent = snapshot.events.filter((event) => event.kind === "agent" && event.text).at(-1);
      if (mirrorMode !== "off" && mirrorMode !== "status" && finalAgent?.text && finalAgent.lineNumber !== state.latestAgentLine) {
        await sendTextMessage(bot.api, chatId, `<b>${escapeHTML(snapshot.agentLabel)} CLI final answer:</b>`, {
          fallbackText: `${snapshot.agentLabel} CLI final answer:`,
          messageThreadId: parsed.messageThreadId,
        });
        for (const chunk of splitMarkdownForTelegram(finalAgent.text)) {
          await sendTextMessage(bot.api, chatId, chunk.text, {
            parseMode: chunk.parseMode,
            fallbackText: chunk.fallbackText,
            messageThreadId: parsed.messageThreadId,
          });
        }
        state.latestAgentLine = finalAgent.lineNumber;
      }

      await deliverCliGeneratedArtifacts(contextKey, chatId, session, state.startedAt, terminalEvent.turnId, parsed.messageThreadId);
    }

    state.lastLine = Math.max(state.lastLine, snapshot.lineCount);
  };

  const canSendSystemMessagesToContext = (contextKey: TelegramContextKey): boolean => {
    if (!userStore.hasAdminUser()) {
      return false;
    }
    const parsed = parseContextKey(contextKey);
    if (parsed.chatId > 0) {
      return Boolean(userStore.resolveTelegramUser(parsed.chatId));
    }
    return userStore.snapshot().telegramChats.some((chat) => chat.chatId === parsed.chatId && chat.enabled);
  };

  const deliverCliGeneratedArtifacts = async (
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: AgentSessionService,
    startedAt: Date | null | undefined,
    turnId: string | null,
    messageThreadId?: number,
  ): Promise<void> => {
    if (!canSendSystemMessagesToContext(contextKey)) {
      return;
    }
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
    if (isEmptyArtifactReport(report)) {
      if (state) state.artifactsDeliveredForTurnId = turnId;
      return;
    }

    const persistedReport = await persistWorkspaceArtifactReport(workspace, turnId, report).catch((error) => {
      console.error("Failed to persist CLI artifact report:", error);
      return null;
    });

    if (!config.telegramAutoSendArtifacts) {
      if (state) state.artifactsDeliveredForTurnId = turnId;
      return;
    }

    const summary = formatArtifactSummary(report.artifacts, report.skippedCount, report.omittedCount);
    await sendTextMessage(bot.api, chatId, escapeHTML(summary), {
      fallbackText: summary,
      messageThreadId,
    });
    for (const artifact of (persistedReport?.artifacts ?? report.artifacts)) {
      await sendArtifactFileByApi(bot.api, chatId, artifact, messageThreadId);
    }
    if (state) state.artifactsDeliveredForTurnId = turnId;
  };

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
        if (!canSendSystemMessagesToContext(contextKey)) {
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
    patch: Omit<AuditEvent, "id" | "timestamp" | "channelId" | "contextKey" | "actorId" | "actorRole" | "agentId" | "threadId" | "workspace">,
  ): void => {
    const info = session.getInfo();
    audit({
      contextKey,
      actorId: ctx.from?.id,
      actorRole: getUserRole(ctx),
      agentId: idOf(info),
      threadId: info.threadId,
      workspace: info.workspace,
      ...patch,
    });
  };

  const denyIfLocked = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: AgentSessionService,
  ): Promise<boolean> => {
    const lock = lockStore.get(contextKey);
    const isAdmin = isAdminUser(ctx);
    if (canWriteWithLock(lock, ctx.from?.id, isAdmin)) {
      return false;
    }

    const owner = formatLockOwner(lock);
    const text = `Session is locked by ${owner}. Use /locks to inspect or ask an admin to /unlock.`;
    auditContext(ctx, contextKey, session, {
      action: "prompt_started",
      status: "denied",
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
      await session.newThread();
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
      if (!canSendSystemMessagesToContext(contextKey)) {
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

  const handleUserPrompt = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: AgentSessionService,
    prompt: AgentPromptInput | PromptEnvelope,
    options: { fromQueue?: boolean; approved?: boolean } = {},
  ): Promise<void> => {
    if (!canSendSystemMessagesToContext(contextKey)) {
      return;
    }
    const parsed = parseContextKey(contextKey);
    const messageThreadId = parsed.messageThreadId;
    const envelope = isPromptEnvelopeLike(prompt) ? prompt : toPromptEnvelope(prompt);

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
    const progress: TurnProgress = {
      status: "running",
      promptDescription: envelope.description,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      toolCounts: new Map(),
      textCharacters: 0,
    };
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

    const typingInterval = setInterval(() => {
      void sendChatActionSafe(bot.api, chatId, "typing", messageThreadId).catch(() => {});
    }, TYPING_INTERVAL_MS);
    void sendChatActionSafe(bot.api, chatId, "typing", messageThreadId).catch(() => {});

    const stopTyping = (): void => {
      clearInterval(typingInterval);
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
        progress.textCharacters += delta.length;
        progress.updatedAt = Date.now();
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
        progress.currentTool = toolName;
        progress.lastTool = toolName;
        progress.updatedAt = Date.now();
        progress.toolCounts.set(toolName, (progress.toolCounts.get(toolName) ?? 0) + 1);
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
        progress.updatedAt = Date.now();
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
        progress.currentTool = undefined;
        progress.updatedAt = Date.now();
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
        progress.updatedAt = Date.now();
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
        progress.updatedAt = Date.now();
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
        scheduleExternalQueueDrain(ctx, contextKey, chatId, session);
        turnProgress.delete(contextKey);
        return;
      }

      promptStore.setLastPrompt(contextKey, envelope);
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
      if (envelope.artifactOutDir) {
        if (config.telegramAutoSendArtifacts) {
          await deliverArtifacts(ctx, chatId, envelope.artifactOutDir, session.getInfo().workspace, messageThreadId);
        } else {
          await pruneArtifacts(session.getInfo().workspace);
        }
      }
      progress.status = "completed";
      progress.completedAt = Date.now();
      progress.updatedAt = progress.completedAt;
      auditContext(ctx, contextKey, session, {
        action: "prompt_completed",
        status: "ok",
        description: envelope.description,
      });
    } catch (error) {
      progress.status = "failed";
      progress.error = friendlyErrorText(error);
      auditContext(ctx, contextKey, session, {
        action: "prompt_failed",
        status: "failed",
        description: envelope.description,
        detail: progress.error,
      });
      progress.completedAt = Date.now();
      progress.updatedAt = progress.completedAt;
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

  const drainQueuedPrompts = async (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: AgentSessionService,
  ): Promise<void> => {
    if (drainingQueues.has(contextKey)) {
      return;
    }
    if (!canSendSystemMessagesToContext(contextKey)) {
      return;
    }

    drainingQueues.add(contextKey);
    try {
      while (true) {
        if (promptStore.isPaused(contextKey)) {
          await updateQueueStatusMessage(contextKey, `Queue paused. ${promptStore.list(contextKey).length} queued.`);
          return;
        }

        const busy = getBusyReason(contextKey);
        if (busy.busy) {
          if (busy.kind === "external") {
            scheduleExternalQueueDrain(ctx, contextKey, chatId, session);
          }
          return;
        }

        const next = promptStore.dequeue(contextKey);
        if (!next) {
          const nextRunnableAt = promptStore.nextRunnableAt(contextKey);
          const queued = promptStore.list(contextKey).length;
          if (nextRunnableAt && queued > 0) {
            await updateQueueStatusMessage(contextKey, `Next queued prompt is scheduled for ${formatLocalDateTime(new Date(nextRunnableAt))}. ${queued} queued.`);
          }
          return;
        }

        const remainingBeforeRun = promptStore.list(contextKey).length + 1;
        await updateQueueStatusMessage(contextKey, `Running queued prompt 1/${remainingBeforeRun}: ${next.description}`);
        await safeReply(ctx, escapeHTML(`Processing queued prompt ${next.id}: ${next.description}`), {
          fallbackText: `Processing queued prompt ${next.id}: ${next.description}`,
        });
        await handleUserPrompt(ctx, contextKey, chatId, session, next, { fromQueue: true });
      }
    } finally {
      drainingQueues.delete(contextKey);
    }
  };

  const deliverArtifacts = async (
    ctx: Context,
    chatId: TelegramChatId,
    outDir: string,
    workspace: string,
    messageThreadId?: number,
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
    await deliverArtifactReport(ctx, chatId, report, messageThreadId);
    await pruneArtifacts(workspace);
  };

  const deliverArtifactReport = async (
    ctx: Context,
    chatId: TelegramChatId,
    report: ArtifactTurnReport,
    messageThreadId?: number,
  ): Promise<void> => {
    if (isEmptyArtifactReport(report)) {
      return;
    }

    await sendChatActionSafe(ctx.api, chatId, "upload_document", messageThreadId).catch(() => {});

    let failedCount = 0;
    let bundledArtifact: Artifact | null = null;

    if (report.artifacts.length > 5) {
      bundledArtifact = await createArtifactZipBundle(report.artifacts, report.outDir, {
        maxFileSize: config.maxFileSize,
      });
    }

    const deliveredArtifacts = bundledArtifact ? [bundledArtifact] : report.artifacts;
    for (const artifact of deliveredArtifacts) {
      const sent = await sendArtifactFile(ctx, chatId, artifact, messageThreadId);
      if (!sent) {
        failedCount += 1;
      }
    }

    const summary = formatArtifactSummary(report.artifacts, report.skippedCount + failedCount, report.omittedCount);
    if (summary) {
      const bundleNote = bundledArtifact ? `\nSent as ZIP: ${bundledArtifact.name}` : "";
      await safeReply(ctx, escapeHTML(`${summary}${bundleNote}`), {
        fallbackText: `${summary}${bundleNote}`,
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
      if (!canSendSystemMessagesToContext(pending.contextKey)) {
        return;
      }
      await processMediaGroup(pending);
    } catch (error) {
      console.error("Failed to process media group:", error);
      if (!canSendSystemMessagesToContext(pending.contextKey)) {
        return;
      }
      await safeReply(pending.ctx, `<b>Failed to process media group:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to process media group: ${friendlyErrorText(error)}`,
      });
    }
  };

  const processMediaGroup = async (pending: PendingMediaGroup): Promise<void> => {
    if (!canSendSystemMessagesToContext(pending.contextKey)) {
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
      if (!canSendSystemMessagesToContext(pending.contextKey)) {
        return;
      }
      const text = skippedCount > 0 ? "No media group files could be staged." : "Media group was empty.";
      await safeReply(pending.ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    if (!canSendSystemMessagesToContext(pending.contextKey)) {
      return;
    }
    const receivedText = `Received ${stagedFiles.length} media group file${stagedFiles.length === 1 ? "" : "s"}${skippedCount > 0 ? ` (${skippedCount} skipped)` : ""}.`;
    await safeReply(pending.ctx, escapeHTML(receivedText), { fallbackText: receivedText });
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

    await setReaction(pending.ctx, "👀");
    try {
      await handleUserPrompt(pending.ctx, pending.contextKey, pending.chatId, pending.session, toPromptEnvelope(promptInput, outDir));
      await setReaction(pending.ctx, "👍");
    } catch {
      await clearReaction(pending.ctx);
    }
  };

  bot.use(createTelegramAccessMiddleware({ userStore, contextUsers, audit }));

  registerTelegramAccessCommands({ bot, userStore, contextUsers, linkAttempts, audit, getUserRole });

  bot.command("start", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const info = session.getInfo();
    const authStatus = capabilitiesOf(info).auth ? await checkAgentAuthStatus(info) : null;
    const authWarning = authStatus && !authStatus.authenticated
      ? [`${labelOf(info)} is not authenticated.`, authStatus.detail, authHelpText(info)].filter(Boolean).join(" ")
      : undefined;
    const isReturning = registry.hasMetadata(contextKey);

    if (isReturning) {
      const welcome = renderWelcomeReturning(
        renderSessionInfoHTML(info),
        renderSessionInfoPlain(info),
        isTopicContext(contextKey),
        authWarning,
      );
      await safeReply(ctx, welcome.html, { fallbackText: welcome.plain });
    } else {
      const welcome = renderWelcomeFirstTime(authWarning);
      await safeReply(ctx, [welcome.html, "", renderLaunchSummaryHTML(info)].join("\n"), {
        fallbackText: [welcome.plain, "", renderLaunchSummaryPlain(info)].join("\n"),
      });
    }
  });

  bot.command("help", async (ctx) => {
    const help = renderHelpMessage();
    await safeReply(ctx, help.html, { fallbackText: help.plain });
  });

  bot.command("channels", async (ctx) => {
    const rendered = renderChannelsAction(listChannelDescriptors());
    await replyChannelAction(ctx, rendered);
  });

  bot.command("agents", async (ctx) => {
    const rendered = renderAgentsAction(listAgentAdapterDescriptors(), enabledAgents(config));
    await replyChannelAction(ctx, rendered);
  });

  bot.command("agent", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot switch agent while a prompt is running."), {
        fallbackText: "Cannot switch agent while a prompt is running.",
      });
      return;
    }

    const availableAgents = enabledAgents(config);
    const currentAgent = idOf(session.getInfo());
    if (availableAgents.length <= 1) {
      const only = agentLabel(availableAgents[0] ?? currentAgent);
      await safeReply(ctx, `<b>Current agent:</b> <code>${escapeHTML(only)}</code>\nNo other agents are enabled.`, {
        fallbackText: `Current agent: ${only}\nNo other agents are enabled.`,
      });
      return;
    }

    pendingAgentPicks.set(contextKey, availableAgents);
    const keyboard = new InlineKeyboard();
    for (const availableAgent of availableAgents) {
      keyboard.text(`${agentLabel(availableAgent)}${availableAgent === currentAgent ? " ✓" : ""}`, `agent_${availableAgent}`).row();
    }

    await safeReply(ctx, `<b>Current agent:</b> <code>${escapeHTML(agentLabel(currentAgent))}</code>\nSelect agent for this Telegram context:`, {
      fallbackText: `Current agent: ${agentLabel(currentAgent)}\nSelect agent for this Telegram context:`,
      replyMarkup: keyboard,
    });
  });

  bot.command("auth", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    const info = contextSession?.session.getInfo();
    if (info && !capabilitiesOf(info).auth) {
      const text = `${labelOf(info)} uses its local CLI authentication. Run its login flow on the host if needed.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    const authStatus = info ? await checkAgentAuthStatus(info) : await checkAuthStatus(config.codexApiKey);
    const icon = authStatus.authenticated ? "✅" : "❌";
    const html = [
      `<b>${icon} Auth status:</b> ${authStatus.authenticated ? "authenticated" : "not authenticated"}`,
      `<b>Method:</b> <code>${escapeHTML(authStatus.method)}</code>`,
      `<b>Detail:</b> <code>${escapeHTML(authStatus.detail)}</code>`,
    ].join("\n");
    const plain = [
      `${icon} Auth status: ${authStatus.authenticated ? "authenticated" : "not authenticated"}`,
      `Method: ${authStatus.method}`,
      `Detail: ${authStatus.detail}`,
    ].join("\n");

    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("login", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    const info = contextSession?.session.getInfo();
    if (info && !capabilitiesOf(info).login) {
      const text = `${labelOf(info)} login is not managed by NordRelay. Run the CLI login flow on the host.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    const authStatus = await checkLoginAuthStatus(info);
    if (agentIdForAuth(info) !== "hermes" && authStatus.authenticated) {
      await safeReply(ctx, `<b>✅ Already authenticated</b> via <code>${escapeHTML(authStatus.method)}</code>.`, {
        fallbackText: `✅ Already authenticated via ${authStatus.method}.`,
      });
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(
        ctx,
        [
          "<b>Telegram-initiated login is disabled.</b>",
          "",
          `Run <code>${escapeHTML(hostLoginCommand(info))}</code> on the host.`,
        ].join("\n"),
        {
          fallbackText: [
            "Telegram-initiated login is disabled.",
            "",
            `Run '${hostLoginCommand(info)}' on the host.`,
          ].join("\n"),
        },
      );
      return;
    }

    const result = await startAgentLogin(info);
    if (result.success) {
      await safeReply(ctx, `<b>🔑 Login initiated.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
        fallbackText: `🔑 Login initiated.\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ Login failed.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ Login failed.\n\n${result.message}`,
    });
  });

  bot.command("logout", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    const info = contextSession?.session.getInfo();
    if (info && !capabilitiesOf(info).logout) {
      const text = `${labelOf(info)} logout is not managed by NordRelay. Run the CLI logout flow on the host.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    const authStatus = await checkLoginAuthStatus(info);
    if (authStatus.method === "api-key") {
      await safeReply(
        ctx,
        [
          `<b>Cannot logout via Telegram when ${escapeHTML(labelForAuth(info))} uses API-key authentication.</b>`,
          "",
          "Remove the API key from .env to use CLI-based auth instead.",
        ].join("\n"),
        {
          fallbackText: [
            `Cannot logout via Telegram when ${labelForAuth(info)} uses API-key authentication.`,
            "",
            "Remove the API key from .env to use CLI-based auth instead.",
          ].join("\n"),
        },
      );
      return;
    }

    if (!config.enableTelegramLogin) {
      await safeReply(ctx, [
        "<b>Telegram-initiated auth management is disabled.</b>",
        "",
        `Run <code>${escapeHTML(hostLogoutCommand(info))}</code> on the host.`,
      ].join("\n"), {
        fallbackText: [
          "Telegram-initiated auth management is disabled.",
          "",
          `Run '${hostLogoutCommand(info)}' on the host.`,
        ].join("\n"),
      });
      return;
    }

    if (agentIdForAuth(info) !== "hermes" && !authStatus.authenticated) {
      await safeReply(ctx, escapeHTML("Not currently authenticated."), {
        fallbackText: "Not currently authenticated.",
      });
      return;
    }

    const result = await startAgentLogout(info);
    if (result.success) {
      await safeReply(ctx, `<b>🔓 Logged out.</b>\n\n${escapeHTML(result.message)}`, {
        fallbackText: `🔓 Logged out.\n\n${result.message}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ Logout failed.</b>\n\n<code>${escapeHTML(result.message)}</code>`, {
      fallbackText: `❌ Logout failed.\n\n${result.message}`,
    });
  });

  bot.command("mirror", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { contextKey, session } = contextSession;
    if (!capabilitiesOf(session.getInfo()).cliMirror) {
      const text = `CLI mirroring is not supported for ${labelOf(session.getInfo())} yet.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }
    const argument = (ctx.message?.text ?? "").replace(/^\/mirror(?:@\w+)?\s*/i, "").trim();
    if (argument) {
      const mode = parseMirrorMode(argument, getEffectiveMirrorMode(contextKey));
      if (!["off", "status", "final", "full"].includes(argument.toLowerCase())) {
        await safeReply(ctx, escapeHTML("Usage: /mirror [off|status|final|full]"), {
          fallbackText: "Usage: /mirror [off|status|final|full]",
        });
        return;
      }
      preferencesStore.update(contextKey, { mirrorMode: mode });
    }

    const mode = getEffectiveMirrorMode(contextKey);
    const plain = [
      `CLI mirroring: ${mode}`,
      `Minimum update interval: ${config.telegramMirrorMinUpdateMs} ms`,
      "Modes: off, status, final, full",
    ].join("\n");
    const html = [
      `<b>CLI mirroring:</b> <code>${escapeHTML(mode)}</code>`,
      `<b>Minimum update interval:</b> <code>${config.telegramMirrorMinUpdateMs} ms</code>`,
      "<b>Modes:</b> <code>off</code>, <code>status</code>, <code>final</code>, <code>full</code>",
    ].join("\n");
    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("notify", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { contextKey } = contextSession;
    const argument = (ctx.message?.text ?? "").replace(/^\/notify(?:@\w+)?\s*/i, "").trim();
    if (argument) {
      const quietMatch = argument.match(/^quiet\s+(.+)$/i);
      if (quietMatch) {
        let quietHours;
        try {
          quietHours = quietMatch[1]!.toLowerCase() === "off" ? null : parseQuietHours(quietMatch[1]);
        } catch (error) {
          await safeReply(ctx, escapeHTML(`Invalid quiet hours: ${friendlyErrorText(error)}`), {
            fallbackText: `Invalid quiet hours: ${friendlyErrorText(error)}`,
          });
          return;
        }
        preferencesStore.update(contextKey, { quietHours });
      } else {
        const mode = parseNotifyMode(argument, getEffectiveNotifyMode(contextKey));
        if (!["off", "minimal", "all"].includes(argument.toLowerCase())) {
          await safeReply(ctx, escapeHTML("Usage: /notify [off|minimal|all] or /notify quiet HH-HH"), {
            fallbackText: "Usage: /notify [off|minimal|all] or /notify quiet HH-HH",
          });
          return;
        }
        preferencesStore.update(contextKey, { notifyMode: mode });
      }
    }

    const mode = getEffectiveNotifyMode(contextKey);
    const quietHours = getEffectiveQuietHours(contextKey);
    const plain = [
      `Notifications: ${mode}`,
      `Quiet hours: ${formatQuietHours(quietHours)}`,
      `Currently quiet: ${isQuietNow(quietHours) ? "yes" : "no"}`,
    ].join("\n");
    const html = [
      `<b>Notifications:</b> <code>${escapeHTML(mode)}</code>`,
      `<b>Quiet hours:</b> <code>${escapeHTML(formatQuietHours(quietHours))}</code>`,
      `<b>Currently quiet:</b> <code>${isQuietNow(quietHours) ? "yes" : "no"}</code>`,
    ].join("\n");
    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("workspaces", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { session } = contextSession;
    const agentName = labelOf(session.getInfo());
    const workspaces = filterAllowedWorkspaces(session.listWorkspaces(), config);
    const currentWorkspace = session.getInfo().workspace;
    const lines = workspaces.slice(0, 20).map((workspace, index) => {
      const prefix = workspace === currentWorkspace ? "*" : `${index + 1}.`;
      const policy = renderWorkspacePolicyLine(workspace, config);
      return `${prefix} ${workspace}${policy ? ` (${policy})` : ""}`;
    });
    const currentPolicy = evaluateWorkspacePolicy(currentWorkspace, config);
    const header = [
      "Workspaces:",
      `Current: ${currentWorkspace}`,
      currentPolicy.warning ? `Current warning: ${currentPolicy.warning}` : undefined,
      config.workspaceAllowedRoots.length > 0 ? `Allowed roots: ${config.workspaceAllowedRoots.join(", ")}` : "Allowed roots: unrestricted",
      "",
    ].filter((line): line is string => Boolean(line));
    const plain = [...header, ...(lines.length > 0 ? lines : [`No workspaces found in ${agentName} state.`])].join("\n");
    const html = [
      "<b>Workspaces:</b>",
      `<b>Current:</b> <code>${escapeHTML(currentWorkspace)}</code>`,
      currentPolicy.warning ? `<b>Current warning:</b> <code>${escapeHTML(currentPolicy.warning)}</code>` : undefined,
      `<b>Allowed roots:</b> <code>${escapeHTML(config.workspaceAllowedRoots.length > 0 ? config.workspaceAllowedRoots.join(", ") : "unrestricted")}</code>`,
      "",
      ...(lines.length > 0 ? lines.map((line) => `<code>${escapeHTML(line)}</code>`) : [`<code>No workspaces found in ${escapeHTML(agentName)} state.</code>`]),
    ].filter((line): line is string => Boolean(line)).join("\n");
    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("voice", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { contextKey } = contextSession;
    const argument = (ctx.message?.text ?? "").replace(/^\/voice(?:@\w+)?\s*/i, "").trim();
    if (argument) {
      const parts = argument.split(/\s+/);
      const key = parts[0]?.toLowerCase();
      const value = parts.slice(1).join(" ").trim();
      if (key === "backend" && value) {
        preferencesStore.update(contextKey, { voiceBackend: parseVoiceBackendPreference(value) });
      } else if (key === "language") {
        preferencesStore.update(contextKey, { voiceLanguage: value && value.toLowerCase() !== "auto" ? value : null });
      } else if (key === "transcribe_only" || key === "transcribe-only") {
        const enabled = parseToggle(value);
        if (enabled === undefined) {
          await safeReply(ctx, escapeHTML("Usage: /voice transcribe_only on|off"), {
            fallbackText: "Usage: /voice transcribe_only on|off",
          });
          return;
        }
        preferencesStore.update(contextKey, { voiceTranscribeOnly: enabled });
      } else {
        await safeReply(ctx, escapeHTML("Usage: /voice, /voice backend auto|parakeet|faster-whisper|openai, /voice language auto|<code>, /voice transcribe_only on|off"), {
          fallbackText: "Usage: /voice, /voice backend auto|parakeet|faster-whisper|openai, /voice language auto|<code>, /voice transcribe_only on|off",
        });
        return;
      }
    }

    const backends = await getAvailableBackends().catch(() => []);

    if (backends.length === 0) {
      await safeReply(
        ctx,
        [
          "<b>Voice transcription is not available.</b>",
          "",
          "Install <code>faster-whisper</code> + ffmpeg, install <code>parakeet-coreml</code> on macOS Apple Silicon, or set <code>OPENAI_API_KEY</code>.",
          "<i>Cloud transcription uses OPENAI_API_KEY, not CODEX_API_KEY.</i>",
        ].join("\n"),
        {
          fallbackText: [
            "Voice transcription is not available.",
            "",
            "Install faster-whisper + ffmpeg, install parakeet-coreml on macOS Apple Silicon, or set OPENAI_API_KEY.",
            "Cloud transcription uses OPENAI_API_KEY, not CODEX_API_KEY.",
          ].join("\n"),
        },
      );
      return;
    }

    const joined = backends.join(" + ");
    const backendPreference = getEffectiveVoiceBackend(contextKey);
    const language = getEffectiveVoiceLanguage(contextKey);
    const transcribeOnly = isVoiceTranscribeOnly(contextKey);
    const plain = [
      `Voice backends: ${joined}`,
      `Preferred backend: ${backendPreference}`,
      `Language: ${language ?? "auto"}`,
      `Transcribe only: ${transcribeOnly ? "on" : "off"}`,
    ].join("\n");
    const html = [
      `<b>Voice backends:</b> <code>${escapeHTML(joined)}</code>`,
      `<b>Preferred backend:</b> <code>${escapeHTML(backendPreference)}</code>`,
      `<b>Language:</b> <code>${escapeHTML(language ?? "auto")}</code>`,
      `<b>Transcribe only:</b> <code>${transcribeOnly ? "on" : "off"}</code>`,
    ].join("\n");
    await safeReply(ctx, html, {
      fallbackText: plain,
    });
  });

  bot.command(["status", "health"], async (ctx) => {
    const health = await getConnectorHealth({ piCliPath: config.piCliPath, hermesCliPath: config.hermesCliPath, openClawCliPath: config.openClawCliPath, claudeCodeCliPath: config.claudeCodeCliPath });
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    const authStatus = contextSession
      ? await checkAgentAuthStatus(contextSession.session.getInfo())
      : await checkAuthStatus(config.codexApiKey);
    const html = renderHealthHTML(health, authStatus.authenticated, getUserRole(ctx));
    const plain = renderHealthPlain(health, authStatus.authenticated, getUserRole(ctx));
    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("version", async (ctx) => {
    const health = await getConnectorHealth({ piCliPath: config.piCliPath, hermesCliPath: config.hermesCliPath, openClawCliPath: config.openClawCliPath, claudeCodeCliPath: config.claudeCodeCliPath });
    const state = await readConnectorState();
    const versions = await getVersionChecks({ piCliPath: config.piCliPath, hermesCliPath: config.hermesCliPath, openClawCliPath: config.openClawCliPath, claudeCodeCliPath: config.claudeCodeCliPath });
    const plain = [
      renderVersionCheckPlain(versions.nordrelay),
      `Runtime status: ${state.status ?? "unknown"}`,
      formatCliPathPlain("Codex CLI", health.codexCliPath, health.codexCli),
      renderVersionCheckPlain(versions.codex),
      formatCliPathPlain("Pi CLI", health.piCliPath, health.piCli),
      renderVersionCheckPlain(versions.pi),
      formatCliPathPlain("Hermes CLI", health.hermesCliPath, health.hermesCli),
      renderVersionCheckPlain(versions.hermes),
      formatCliPathPlain("OpenClaw CLI", health.openClawCliPath, health.openClawCli),
      renderVersionCheckPlain(versions.openclaw),
      formatCliPathPlain("Claude Code CLI", health.claudeCodeCliPath, health.claudeCodeCli),
      renderVersionCheckPlain(versions.claudeCode),
    ].join("\n");
    const html = [
      renderVersionCheckHTML(versions.nordrelay),
      `<b>Runtime status:</b> <code>${escapeHTML(state.status ?? "unknown")}</code>`,
      formatCliPathHTML("Codex CLI", health.codexCliPath, health.codexCli),
      renderVersionCheckHTML(versions.codex),
      formatCliPathHTML("Pi CLI", health.piCliPath, health.piCli),
      renderVersionCheckHTML(versions.pi),
      formatCliPathHTML("Hermes CLI", health.hermesCliPath, health.hermesCli),
      renderVersionCheckHTML(versions.hermes),
      formatCliPathHTML("OpenClaw CLI", health.openClawCliPath, health.openClawCli),
      renderVersionCheckHTML(versions.openclaw),
      formatCliPathHTML("Claude Code CLI", health.claudeCodeCliPath, health.claudeCodeCli),
      renderVersionCheckHTML(versions.claudeCode),
    ].join("\n");
    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command(["tasks", "progress"], async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const progress = turnProgress.get(contextSession.contextKey);
    const queue = promptStore.list(contextSession.contextKey);
    const externalActivity = getExternalActivity(contextSession.session);
    const busyState: BusyState = {
      ...getBusyState(contextSession.contextKey),
      external: Boolean(externalActivity?.active),
    };
    const info = contextSession.session.getInfo();
    const plain = renderProgressPlain(progress, queue.length, busyState, info);
    const html = renderProgressHTML(progress, queue.length, busyState, info);
    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("activity", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const info = contextSession.session.getInfo();
    if (!capabilitiesOf(info).activityLog) {
      const text = `${labelOf(info)} activity timelines are not available yet.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    const threadId = contextSession.session.getActiveThreadId();
    if (!threadId) {
      await safeReply(ctx, escapeHTML("No active thread yet."), { fallbackText: "No active thread yet." });
      return;
    }

    const options = parseActivityOptions((ctx.message?.text ?? "").replace(/^\/activity(?:@\w+)?\s*/i, "").trim());
    const events = filterActivityEvents(getAgentActivityLog(contextSession.session, config, options.exportFile ? 200 : options.limit), options);
    const rendered = renderActivityTimeline(threadId, events, options);
    if (options.exportFile && ctx.chat) {
      const exportPath = path.join(tmpdir(), `nordrelay-activity-${threadId}-${randomUUID().slice(0, 8)}.txt`);
      await writeFile(exportPath, rendered.plain, "utf8");
      try {
        await telegramRateLimiter.run(chatBucket(ctx.chat.id), "sendDocument", () =>
          ctx.api.sendDocument(ctx.chat!.id, new InputFile(exportPath, path.basename(exportPath)), {
            ...(ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}),
          })
        );
      } finally {
        await unlink(exportPath).catch(() => {});
      }
      return;
    }
    await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
  });

  bot.command("audit", async (ctx) => {
    const rawText = ctx.message?.text ?? "";
    const limitArg = rawText.replace(/^\/audit(?:@\w+)?\s*/i, "").trim();
    const limit = /^\d+$/.test(limitArg) ? Number(limitArg) : 20;
    const events = auditLog.list(limit);
    const rendered = renderAuditEvents(events);
    await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
  });

  bot.command("lock", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession || !ctx.from) {
      return;
    }
    const { contextKey, session } = contextSession;
    const existing = lockStore.get(contextKey);
    if (existing && existing.ownerId !== ctx.from.id && !isAdminUser(ctx)) {
      const text = `Session is already locked by ${formatLockOwner(existing)}.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }
    const lock = lockStore.set(contextKey, ctx.from.id, formatTelegramName(ctx), config.sessionLockTtlMs);
    auditContext(ctx, contextKey, session, {
      action: "lock_updated",
      status: "ok",
      detail: `locked by ${lock.ownerId}`,
    });
    const text = `Session locked by ${formatLockOwner(lock)}${lock.expiresAt ? ` until ${formatLocalDateTime(new Date(lock.expiresAt))}` : ""}.`;
    await safeReply(ctx, escapeHTML(text), { fallbackText: text });
  });

  bot.command("unlock", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { contextKey, session } = contextSession;
    const lock = lockStore.get(contextKey);
    if (lock && lock.ownerId !== ctx.from?.id && !isAdminUser(ctx)) {
      const text = `Only ${formatLockOwner(lock)} or an admin can unlock this session.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }
    const removed = lockStore.clear(contextKey);
    auditContext(ctx, contextKey, session, {
      action: "lock_updated",
      status: "ok",
      detail: removed ? "unlocked" : "no lock",
    });
    const text = removed ? "Session lock released." : "No active lock for this session.";
    await safeReply(ctx, escapeHTML(text), { fallbackText: text });
  });

  bot.command("locks", async (ctx) => {
    const locks = lockStore.list();
    const rendered = renderSessionLocks(locks);
    await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
  });

  bot.command("diagnostics", async (ctx) => {
    const health = await getConnectorHealth({ piCliPath: config.piCliPath, hermesCliPath: config.hermesCliPath, openClawCliPath: config.openClawCliPath, claudeCodeCliPath: config.claudeCodeCliPath });
    const contextKey = contextKeyFromCtx(ctx);
    const queueLength = contextKey ? promptStore.list(contextKey).length : 0;
    const progress = contextKey ? turnProgress.get(contextKey) : undefined;
    const contextSession = contextKey ? await getContextSession(ctx, { deferThreadStart: true }) : null;
    const authStatus = contextSession
      ? await checkAgentAuthStatus(contextSession.session.getInfo())
      : await checkAuthStatus(config.codexApiKey);
    const agentDiagnostics = contextSession
      ? renderAgentDiagnostics(getAgentDiagnostics(contextSession.session, config))
      : { plain: "Agent state: no context", html: "<b>Agent state:</b> <code>no context</code>" };
    const runtime: RuntimeDiagnostics = {
      rateLimit: getTelegramRateLimitMetrics(),
      externalMirrors: externalMirrors.size,
      externalQueueTimers: externalQueueTimers.size,
      queueStatusMessages: queueStatusMessages.size,
      mirrorMode: contextKey ? getEffectiveMirrorMode(contextKey) : config.telegramMirrorMode,
      notifyMode: contextKey ? getEffectiveNotifyMode(contextKey) : config.telegramNotifyMode,
      quietHours: formatQuietHours(contextKey ? getEffectiveQuietHours(contextKey) : config.telegramQuietHours),
      voiceBackend: contextKey ? getEffectiveVoiceBackend(contextKey) : config.voicePreferredBackend,
      voiceLanguage: contextKey ? getEffectiveVoiceLanguage(contextKey) ?? "auto" : config.voiceDefaultLanguage ?? "auto",
      voiceTranscribeOnly: contextKey ? isVoiceTranscribeOnly(contextKey) : config.voiceTranscribeOnly,
    };
    const plain = `${renderDiagnosticsPlain(config, registry, health, authStatus.authenticated, getUserRole(ctx), queueLength, progress, runtime)}\n${agentDiagnostics.plain}`;
    const html = `${renderDiagnosticsHTML(config, registry, health, authStatus.authenticated, getUserRole(ctx), queueLength, progress, runtime)}\n${agentDiagnostics.html}`;
    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("sync", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const sessionInfo = contextSession.session.getInfo();
    if (!capabilitiesOf(sessionInfo).externalActivity) {
      const plain = [`${labelOf(sessionInfo)} has no external CLI state watcher to sync.`, "", renderSessionInfoPlain(sessionInfo)].join("\n");
      const html = [`<b>${escapeHTML(labelOf(sessionInfo))} has no external CLI state watcher to sync.</b>`, "", renderSessionInfoHTML(sessionInfo)].join("\n");
      await safeReply(ctx, html, { fallbackText: plain });
      return;
    }

    const result = contextSession.session.syncFromAgentState({ reattach: true });
    if (result.changed) {
      updateSessionMetadata(contextSession.contextKey, contextSession.session);
    }
    const fields = result.changedFields.length > 0 ? result.changedFields.join(", ") : "none";
    const plain = [
      result.changed ? `Synced from ${labelOf(sessionInfo)} state.` : "Already in sync.",
      `Changed: ${fields}`,
      `Reattached: ${result.reattached ? "yes" : "no"}`,
      "",
      renderSessionInfoPlain(result.info),
    ].join("\n");
    const html = [
      result.changed ? `<b>Synced from ${escapeHTML(labelOf(sessionInfo))} state.</b>` : "<b>Already in sync.</b>",
      `<b>Changed:</b> <code>${escapeHTML(fields)}</code>`,
      `<b>Reattached:</b> <code>${result.reattached ? "yes" : "no"}</code>`,
      "",
      renderSessionInfoHTML(result.info),
    ].join("\n");
    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("logs", async (ctx) => {
    const rawText = ctx.message?.text ?? "";
    const argument = rawText.replace(/^\/logs(?:@\w+)?\s*/i, "").trim();
    const logRequest = parseLogsCommand(argument);
    const logs = await Promise.all(logTailRequests(logRequest.target).map(async (request) => ({
      title: request.title,
      tail: await readFormattedLogTail(logRequest.lines, request.path),
    })));
    const rendered = renderLogTailsAction(logs);
    await replyChannelAction(ctx, rendered);
  });

  bot.command("restart", async (ctx) => {
    await safeReply(ctx, escapeHTML("Restarting connector..."), {
      fallbackText: "Restarting connector...",
    });
    setTimeout(() => {
      spawnConnectorRestart();
    }, 300);
  });

  registerTelegramUpdateCommands({ bot, agentUpdates, replyChannelAction, startTelegramAgentUpdate });

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
        const info = await session.newThread();
        updateSessionMetadata(contextKey, session);
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
        return;
      }
      await session.abort();
      await safeReply(ctx, escapeHTML("Aborted current operation"), {
        fallbackText: "Aborted current operation",
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

    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, cached);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
  });

  bot.command("queue", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const chatId = ctx.chat?.id;
    const { contextKey, session } = contextSession;
    const rawText = ctx.message?.text ?? "";
    const argument = rawText.replace(/^\/queue(?:@\w+)?\s*/i, "").trim();

    const laterMatch = argument.match(/^later\s+(\d+)(?:m|min|minutes?)?\s+([\s\S]+)$/i);
    if (laterMatch) {
      const minutes = Math.min(7 * 24 * 60, Math.max(1, Number(laterMatch[1])));
      const text = laterMatch[2]!.trim();
      const notBefore = Date.now() + minutes * 60 * 1000;
      const item = promptStore.enqueue(contextKey, toPromptEnvelope(text), { notBefore });
      const message = `Queued prompt ${item.id} for ${formatLocalDateTime(new Date(notBefore))}.`;
      await safeReply(ctx, escapeHTML(message), {
        fallbackText: message,
        replyMarkup: createQueuedPromptCancelKeyboard(contextKey, item.id),
      });
      auditContext(ctx, contextKey, session, {
        action: "prompt_queued",
        status: "ok",
        promptId: item.id,
        description: item.description,
        detail: "scheduled",
      });
      return;
    }

    const inspectMatch = argument.match(/^inspect\s+([a-z0-9]+)$/i);
    if (inspectMatch) {
      const item = promptStore.get(contextKey, inspectMatch[1]!);
      if (!item) {
        await safeReply(ctx, escapeHTML(`No queued prompt found with id ${inspectMatch[1]}.`), {
          fallbackText: `No queued prompt found with id ${inspectMatch[1]}.`,
        });
        return;
      }
      const rendered = renderQueuedPromptDetailAction(item);
      await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
      return;
    }

    if (/^pause$/i.test(argument)) {
      promptStore.pause(contextKey);
      const message = `Queue paused. ${promptStore.list(contextKey).length} queued.`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      await updateQueueStatusMessage(contextKey, message);
      return;
    }

    if (/^resume$/i.test(argument)) {
      promptStore.resume(contextKey);
      const message = `Queue resumed. ${promptStore.list(contextKey).length} queued.`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      if (chatId) {
        void drainQueuedPrompts(ctx, contextKey, chatId, session).catch((error) => {
          console.error("Failed to drain queue after resume:", error);
        });
      }
      return;
    }

    const moveMatch = argument.match(/^move\s+([a-z0-9]+)\s+(top|up|down)$/i);
    if (moveMatch) {
      const direction = moveMatch[2]!.toLowerCase();
      const item = direction === "top"
        ? promptStore.moveToTop(contextKey, moveMatch[1]!)
        : direction === "up"
          ? promptStore.moveUp(contextKey, moveMatch[1]!)
          : promptStore.moveDown(contextKey, moveMatch[1]!);
      if (!item) {
        await safeReply(ctx, escapeHTML(`No queued prompt found with id ${moveMatch[1]}.`), {
          fallbackText: `No queued prompt found with id ${moveMatch[1]}.`,
        });
        return;
      }
      const message = `Moved queued prompt ${item.id} ${direction}.`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    const runMatch = argument.match(/^run\s+([a-z0-9]+)$/i);
    if (runMatch) {
      const item = promptStore.remove(contextKey, runMatch[1]!);
      if (!item) {
        await safeReply(ctx, escapeHTML(`No queued prompt found with id ${runMatch[1]}.`), {
          fallbackText: `No queued prompt found with id ${runMatch[1]}.`,
        });
        return;
      }

      promptStore.enqueueFront(contextKey, item);
      promptStore.resume(contextKey);
      if (!chatId) {
        return;
      }
      const busy = getBusyReason(contextKey);
      if (busy.busy) {
        const message = `Queued prompt ${item.id} moved to top and will run when the current task finishes.`;
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
        if (busy.kind === "external") {
          scheduleExternalQueueDrain(ctx, contextKey, chatId, session);
        }
        return;
      }

      const next = promptStore.dequeue(contextKey);
      if (next) {
        await handleUserPrompt(ctx, contextKey, chatId, session, next, { fromQueue: true });
      }
      return;
    }

    if (argument) {
      await safeReply(ctx, escapeHTML("Usage: /queue, /queue pause, /queue resume, /queue later <minutes> <prompt>, /queue inspect <id>, /queue move <id> top|up|down, /queue run <id>"), {
        fallbackText: "Usage: /queue, /queue pause, /queue resume, /queue later <minutes> <prompt>, /queue inspect <id>, /queue move <id> top|up|down, /queue run <id>",
      });
      return;
    }

    const queue = promptStore.list(contextKey);
    if (queue.length === 0) {
      const rendered = renderQueueList(contextKey, queue);
      await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
      return;
    }

    const rendered = renderQueueList(contextKey, queue);
    await safeReply(ctx, rendered.html, {
      fallbackText: rendered.plain,
      replyMarkup: rendered.keyboard,
    });
  });

  bot.command("clearqueue", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const count = promptStore.clear(contextSession.contextKey);
    const message = `Cleared ${count} queued prompt${count === 1 ? "" : "s"}.`;
    await safeReply(ctx, escapeHTML(message), { fallbackText: message });
  });

  bot.command("cancel", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const id = rawText.replace(/^\/cancel(?:@\w+)?\s*/i, "").trim();
    if (!id) {
      await safeReply(ctx, escapeHTML("Usage: /cancel <queue-id>"), {
        fallbackText: "Usage: /cancel <queue-id>",
      });
      return;
    }

    const removed = promptStore.remove(contextSession.contextKey, id);
    if (!removed) {
      await safeReply(ctx, escapeHTML(`No queued prompt found with id ${id}.`), {
        fallbackText: `No queued prompt found with id ${id}.`,
      });
      return;
    }

    await safeReply(ctx, escapeHTML(`Cancelled queued prompt ${removed.id}.`), {
      fallbackText: `Cancelled queued prompt ${removed.id}.`,
    });
  });

  bot.command("artifacts", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession || !ctx.chat) {
      return;
    }

    const workspace = contextSession.session.getInfo().workspace;
    const rawText = ctx.message?.text ?? "";
    const argument = rawText.replace(/^\/artifacts(?:@\w+)?\s*/i, "").trim();
    const reports = await listRecentArtifactReports(workspace, 10, config.maxFileSize);

    if (reports.length === 0) {
      await safeReply(ctx, escapeHTML("No generated artifacts found for this workspace."), {
        fallbackText: "No generated artifacts found for this workspace.",
      });
      return;
    }

    if (argument) {
      const parts = argument.split(/\s+/).filter(Boolean);
      if (parts[0]?.toLowerCase() === "delete" && parts[1]) {
        const selected = reports.find((report) => report.turnId === parts[1] || report.turnId.startsWith(parts[1]!));
        if (!selected) {
          await safeReply(ctx, escapeHTML(`No artifact turn found for "${parts[1]}".`), {
            fallbackText: `No artifact turn found for "${parts[1]}".`,
          });
          return;
        }
        const removed = await removeArtifactTurn(workspace, selected.turnId);
        const text = removed ? `Deleted artifact turn: ${selected.turnId}` : `Artifact turn not found: ${selected.turnId}`;
        await safeReply(ctx, escapeHTML(text), { fallbackText: text });
        return;
      }

      const filtered = filterArtifactReports(reports, argument);
      if (filtered) {
        if (filtered.length === 0) {
          await safeReply(ctx, escapeHTML(`No artifacts matched "${argument}".`), {
            fallbackText: `No artifacts matched "${argument}".`,
          });
          return;
        }
        const rendered = renderArtifactReportsAction(filtered);
        await safeReply(ctx, rendered.html, {
          fallbackText: rendered.plain,
          replyMarkup: buildArtifactActionsKeyboard(filtered),
        });
        return;
      }

      const shouldZip = parts[0]?.toLowerCase() === "zip";
      const requestedTurn = shouldZip ? parts[1] : parts[0];
      const selected =
        !requestedTurn || requestedTurn.toLowerCase() === "latest"
          ? reports[0]
          : reports.find((report) => report.turnId === requestedTurn || report.turnId.startsWith(requestedTurn));

      if (!selected) {
        await safeReply(ctx, escapeHTML(`No artifact turn found for "${argument}".`), {
          fallbackText: `No artifact turn found for "${argument}".`,
        });
        return;
      }

      if (shouldZip) {
        await deliverArtifactReportZip(ctx, ctx.chat.id, selected, ctx.message?.message_thread_id);
      } else {
        await deliverArtifactReport(ctx, ctx.chat.id, selected, ctx.message?.message_thread_id);
      }
      return;
    }

    const { html, plain } = renderArtifactReportsAction(reports);
    await safeReply(ctx, html, {
      fallbackText: plain,
      replyMarkup: buildArtifactActionsKeyboard(reports),
    });
  });

  bot.command("session", async (ctx) => {
    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const info = session.getInfo();
    const contextLabel = isTopicContext(contextKey) ? "Topic session" : "Chat session";
    const policyLine = renderWorkspacePolicyLine(info.workspace, config);

    const plainLines = [`${contextLabel}:`, policyLine, renderSessionInfoPlain(info)].filter((line): line is string => line !== undefined);
    const htmlLines = [`<b>${escapeHTML(contextLabel)}:</b>`, policyLine ? `<i>${escapeHTML(policyLine)}</i>` : undefined, renderSessionInfoHTML(info)].filter((line): line is string => line !== undefined);

    await safeReply(ctx, htmlLines.join("\n"), { fallbackText: plainLines.join("\n") });
  });

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
    ];
    const plainLines = [
      `Selected launch profile: ${selectedLaunchProfile.launchProfileLabel}`,
      `Behavior: ${selectedLaunchProfile.launchProfileBehavior}`,
      "",
      "Select a profile for new or reattached threads:",
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

    const heading = query ? `Matching threads (${orderedSessions.length})` : `Recent threads (${orderedSessions.length})`;
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

  bot.callbackQuery(/^agent_(codex|pi|hermes|openclaw|claude-code)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const selectedAgent = ctx.match?.[1] as AgentId | undefined;
    const contextKey = contextKeyFromCtx(ctx);
    if (!chatId || !contextKey || !selectedAgent) {
      await ctx.answerCallbackQuery();
      return;
    }

    const picks = pendingAgentPicks.get(contextKey);
    if (!picks?.includes(selectedAgent)) {
      await ctx.answerCallbackQuery({ text: "Expired, run /agent again" });
      return;
    }
    if (isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Switching to ${agentLabel(selectedAgent)}...` });
    pendingAgentPicks.delete(contextKey);
    try {
      const session = await registry.switchAgent(contextKey, selectedAgent);
      const info = session.getInfo();
      const html = [`<b>Agent switched to ${escapeHTML(labelOf(info))}.</b>`, "", renderSessionInfoHTML(info)].join("\n");
      const plain = [`Agent switched to ${labelOf(info)}.`, "", renderSessionInfoPlain(info)].join("\n");
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
      } else {
        await safeReply(ctx, html, { fallbackText: plain });
      }
    } catch (error) {
      const html = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const plain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
      } else {
        await safeReply(ctx, html, { fallbackText: plain });
      }
    }
  });

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

  bot.callbackQuery(/^queue_(cancel|remove|top|up|down|run):(-?\d+(?::\d+)?):([a-z0-9]+)$/, async (ctx) => {
    const action = ctx.match?.[1] as "cancel" | "remove" | "top" | "up" | "down" | "run" | undefined;
    const contextKey = ctx.match?.[2];
    const queueId = ctx.match?.[3];
    if (!action || !contextKey || !queueId) {
      await ctx.answerCallbackQuery();
      return;
    }

    const currentContextKey = contextKeyFromCtx(ctx);
    if (currentContextKey && currentContextKey !== contextKey) {
      await ctx.answerCallbackQuery({ text: "This queue button belongs to another chat or topic." });
      return;
    }

    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;

    if (action === "top" || action === "up" || action === "down") {
      const item = action === "top"
        ? promptStore.moveToTop(contextKey, queueId)
        : action === "up"
          ? promptStore.moveUp(contextKey, queueId)
          : promptStore.moveDown(contextKey, queueId);
      await ctx.answerCallbackQuery({ text: item ? `Moved ${queueId} ${action}.` : "Queued prompt not found." });
      if (chatId && messageId) {
        const rendered = renderQueueList(contextKey, promptStore.list(contextKey));
        await safeEditMessage(bot, chatId, messageId, rendered.html, {
          fallbackText: rendered.plain,
          replyMarkup: rendered.keyboard,
        });
      }
      return;
    }

    if (action === "run") {
      const item = promptStore.remove(contextKey, queueId);
      if (!item) {
        await ctx.answerCallbackQuery({ text: "Queued prompt already started or was cancelled." });
        return;
      }
      promptStore.enqueueFront(contextKey, item);
      promptStore.resume(contextKey);
      await ctx.answerCallbackQuery({ text: `Queued prompt ${queueId} moved to next.` });
      if (chatId && messageId) {
        const rendered = renderQueueList(contextKey, promptStore.list(contextKey));
        await safeEditMessage(bot, chatId, messageId, rendered.html, {
          fallbackText: rendered.plain,
          replyMarkup: rendered.keyboard,
        });
      }
      const session = registry.get(contextKey);
      if (chatId && session && !getBusyReason(contextKey).busy) {
        void drainQueuedPrompts(ctx, contextKey, chatId, session).catch((error) => {
          console.error("Failed to drain queue after run-now callback:", error);
        });
      }
      return;
    }

    const removed = promptStore.remove(contextKey, queueId);

    if (!removed) {
      await ctx.answerCallbackQuery({ text: "Queued prompt already started or was cancelled." });
      if (chatId && messageId) {
        if (action === "remove") {
          const rendered = renderQueueList(contextKey, promptStore.list(contextKey));
          await safeEditMessage(bot, chatId, messageId, rendered.html, {
            fallbackText: rendered.plain,
            replyMarkup: rendered.keyboard,
          });
        } else {
          const message = `Queued prompt ${queueId} is no longer queued.`;
          await safeEditMessage(bot, chatId, messageId, escapeHTML(message), { fallbackText: message });
        }
      }
      return;
    }

    const message = `Cancelled queued prompt ${removed.id}.`;
    await ctx.answerCallbackQuery({ text: message });
    if (!chatId || !messageId) {
      return;
    }

    if (action === "remove") {
      const rendered = renderQueueList(contextKey, promptStore.list(contextKey));
      await safeEditMessage(bot, chatId, messageId, rendered.html, {
        fallbackText: rendered.plain,
        replyMarkup: rendered.keyboard,
      });
      return;
    }

    await safeEditMessage(bot, chatId, messageId, escapeHTML(message), { fallbackText: message });
  });

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

    await handleUserPrompt(ctx, pending.contextKey, chatId ?? parseContextKey(pending.contextKey).chatId, contextSession.session, pending.prompt, {
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
    const threadId = threadIds?.[index];
    if (!threadId) {
      await ctx.answerCallbackQuery({ text: "Session expired, run /sessions again" });
      return;
    }
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
      const info = await session.newThread(workspace);
      updateSessionMetadata(contextKey, session);
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
        .text("Enable danger-full-access", `launchconfirm_yes:${profile.id}`)
        .row()
        .text("Cancel", `launchconfirm_no:${profile.id}`);
      const html = [
        `<b>Confirm launch profile:</b> <code>${escapeHTML(profile.label)}</code>`,
        `<b>Behavior:</b> <code>${escapeHTML(profile.behavior)}</code>`,
        "",
        "⚠️ <b>This profile uses danger-full-access.</b>",
        "It will apply to new or reattached threads in this Telegram context.",
      ].join("\n");
      const plain = [
        `Confirm launch profile: ${profile.label}`,
        `Behavior: ${profile.behavior}`,
        "",
        "WARNING: This profile uses danger-full-access.",
        "It will apply to new or reattached threads in this Telegram context.",
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
    session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);
    const info = session.getInfo();

    const html = [
      `<b>Launch profile set to</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(info.launchProfileBehavior)}</code>`,
      "",
      "Applies to new or reattached threads.",
    ].join("\n");
    const plain = [
      `Launch profile set to ${info.launchProfileLabel}`,
      `Behavior: ${info.launchProfileBehavior}`,
      "",
      "Applies to new or reattached threads.",
    ].join("\n");

    if (messageId) {
      await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
    } else {
      await safeReply(ctx, html, { fallbackText: plain });
    }
  });

  bot.callbackQuery(/^launchconfirm_(yes|no):([a-z0-9_-]+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const action = ctx.match?.[1];
    const confirmedProfileId = ctx.match?.[2];

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
    session.setLaunchProfile(profile.id);
    updateSessionMetadata(contextKey, session);
    const info = session.getInfo();
    await ctx.answerCallbackQuery({ text: `Launch set to ${info.launchProfileLabel}` });

    const html = [
      `<b>Launch profile set to</b> <code>${escapeHTML(info.launchProfileLabel)}</code>`,
      `<b>Behavior:</b> <code>${escapeHTML(info.launchProfileBehavior)}</code>`,
      "",
      "⚠️ <i>danger-full-access confirmed for new or reattached threads.</i>",
    ].join("\n");
    const plain = [
      `Launch profile set to ${info.launchProfileLabel}`,
      `Behavior: ${info.launchProfileBehavior}`,
      "",
      "danger-full-access confirmed for new or reattached threads.",
    ].join("\n");

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
    const label = agentReasoningLabel(idOf(session.getInfo()));
    const scope = formatAgentSettingScope(session.getInfo(), result.appliedToActiveThread);
    const html = `⚡ ${escapeHTML(label)} set to <code>${escapeHTML(effort)}</code> — ${escapeHTML(scope)}.`;
    await safeEditMessage(bot, chatId, messageId, html, {
      fallbackText: `⚡ ${label} set to ${effort} — ${scope}.`,
    });
  });

  bot.callbackQuery(/^artifact_(send|zip|delete|delete_confirm):([a-zA-Z0-9._-]+)$/, async (ctx) => {
    const action = ctx.match?.[1];
    const turnId = ctx.match?.[2];
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!action || !turnId || !chatId) {
      await ctx.answerCallbackQuery();
      return;
    }

    const contextSession = await getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      await ctx.answerCallbackQuery({ text: "No context" });
      return;
    }

    const workspace = contextSession.session.getInfo().workspace;
    if (action === "delete") {
      await ctx.answerCallbackQuery({ text: "Confirm deletion" });
      const keyboard = new InlineKeyboard()
        .text("Delete artifacts", `artifact_delete_confirm:${turnId}`)
        .row()
        .text("Cancel", NOOP_PAGE_CALLBACK_DATA);
      const html = `<b>Delete artifact turn?</b>\n<code>${escapeHTML(turnId)}</code>`;
      const plain = `Delete artifact turn?\n${turnId}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain, replyMarkup: keyboard });
      } else {
        await safeReply(ctx, html, { fallbackText: plain, replyMarkup: keyboard });
      }
      return;
    }

    if (action === "delete_confirm") {
      const removed = await removeArtifactTurn(workspace, turnId);
      await ctx.answerCallbackQuery({ text: removed ? "Deleted" : "Already gone" });
      const html = removed
        ? `<b>Deleted artifact turn:</b> <code>${escapeHTML(turnId)}</code>`
        : `<b>Artifact turn not found:</b> <code>${escapeHTML(turnId)}</code>`;
      const plain = removed ? `Deleted artifact turn: ${turnId}` : `Artifact turn not found: ${turnId}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
      } else {
        await safeReply(ctx, html, { fallbackText: plain });
      }
      return;
    }

    const report = await getArtifactTurnReport(workspace, turnId, config.maxFileSize);
    if (!report) {
      await ctx.answerCallbackQuery({ text: "Artifact turn not found" });
      return;
    }

    await ctx.answerCallbackQuery({ text: action === "zip" ? "Sending ZIP..." : "Sending artifacts..." });
    if (action === "zip") {
      await deliverArtifactReportZip(ctx, chatId, report, ctx.callbackQuery.message?.message_thread_id);
    } else {
      await deliverArtifactReport(ctx, chatId, report, ctx.callbackQuery.message?.message_thread_id);
    }
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
    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, ctx.chat.id, session, userText);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
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
    } catch (error) {
      const note = "Voice uses faster-whisper/parakeet locally or OPENAI_API_KEY for cloud transcription, not CODEX_API_KEY.";
      await safeReply(ctx, `<b>Transcription failed:</b>\n${escapeHTML(friendlyErrorText(error))}\n\n<i>${escapeHTML(note)}</i>`, {
        fallbackText: `Transcription failed:\n${friendlyErrorText(error)}\n\n${note}`,
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

    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, transcript);
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
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
    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, toPromptEnvelope(promptInput, outDir));
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
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

    await setReaction(ctx, "👀");
    try {
      await handleUserPrompt(ctx, contextKey, chatId, session, toPromptEnvelope(promptInput, outDir));
      await setReaction(ctx, "👍");
    } catch {
      await clearReaction(ctx);
    }
  });

  bot.catch((error) => {
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    console.error("Telegram bot error:", message);
  });

  return bot;
}
