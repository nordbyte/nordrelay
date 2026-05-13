import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { autoRetry } from "@grammyjs/auto-retry";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";

import {
  hasTelegramPermission,
  permissionForCallbackData,
  permissionForCommand,
  type TelegramPermission,
  type TelegramRole,
} from "./access-control.js";
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
  type ArtifactReport,
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
  parseAgentUpdateId,
  parseLogsCommand,
  renderAgentUpdateJobAction,
  renderAgentUpdateJobsAction,
  renderAgentUpdateLogAction,
  renderAgentUpdatePickerAction,
  renderAgentsAction,
  renderArtifactReportsAction,
  renderChannelsAction,
  renderLogTailsAction,
  renderQueueListAction,
  renderQueuedPromptDetailAction,
  renderSelfUpdateStartedAction,
  type ChannelActionButton,
} from "./channel-actions.js";
import { listChannelDescriptors } from "./channel-adapter.js";
import {
  CODEX_AGENT_CAPABILITIES,
  agentLabel,
  agentReasoningLabel,
  agentReasoningOptions,
  type AgentActivityEvent,
  type AgentExternalActivity,
  type AgentExternalSnapshot,
  type AgentId,
  type AgentLaunchProfileRecord,
  type AgentModelRecord,
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
import { escapeHTML, formatTelegramHTML } from "./format.js";
import {
  getConnectorHealth,
  getVersionChecks,
  readConnectorState,
  readFormattedLogTail,
  spawnConnectorRestart,
  spawnSelfUpdate,
  type VersionCheck,
} from "./operations.js";
import { PromptStore, toPromptEnvelope, type PromptEnvelope, type QueuedPrompt } from "./prompt-store.js";
import { checkHermesAuthStatus, startHermesLogin, startHermesLogout } from "./hermes-auth.js";
import { checkOpenClawAuthStatus } from "./openclaw-auth.js";
import { checkPiAuthStatus } from "./pi-auth.js";
import { configureRedaction, redactText } from "./redaction.js";
import { canWriteWithLock, SessionLockStore, type SessionLock } from "./session-locks.js";
import {
  renderLaunchSummaryHTML,
  renderLaunchSummaryPlain,
  renderSessionInfoHTML,
  renderSessionInfoPlain,
} from "./session-format.js";
import { SessionRegistry } from "./session-registry.js";
import { getAvailableBackends, transcribeAudio, type TranscriptionBackend } from "./voice.js";
import { getTelegramRateLimitMetrics, telegramRateLimiter, type TelegramRateLimitMetrics } from "./telegram-rate-limit.js";
import {
  evaluateWorkspacePolicy,
  filterAllowedWorkspaces,
  renderWorkspacePolicyLine,
} from "./workspace-policy.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const EDIT_DEBOUNCE_MS = 1500;
const TYPING_INTERVAL_MS = 4500;
const TOOL_OUTPUT_PREVIEW_LIMIT = 500;
const STREAMING_PREVIEW_LIMIT = 3800;
const FORMATTED_CHUNK_TARGET = 3000;
const MAX_AUDIO_FILE_SIZE = 25 * 1024 * 1024;
const MEDIA_GROUP_FLUSH_MS = 1200;
const KEYBOARD_PAGE_SIZE = 6;
const NOOP_PAGE_CALLBACK_DATA = "noop_page";
const LAUNCH_PROFILES_COMMAND = "/launch_profiles";

type TelegramChatId = number | string;
type TelegramParseMode = "HTML";
type KeyboardItem = { label: string; callbackData: string };

type ToolState = {
  toolName: string;
  partialResult: string;
  messageId?: number;
  finalStatus?: RenderedText;
};

type TextOptions = {
  parseMode?: TelegramParseMode;
  fallbackText?: string;
  replyMarkup?: InlineKeyboard;
  messageThreadId?: number;
};

type RenderedText = {
  text: string;
  fallbackText: string;
  parseMode?: TelegramParseMode;
};

type RenderedChunk = RenderedText & {
  sourceText: string;
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

type ActivityFilter = "all" | "tools" | "errors" | "user" | "agent" | "tasks";

type ActivityOptions = {
  limit: number;
  filter: ActivityFilter;
  sinceMs?: number;
  exportFile: boolean;
};

type RuntimeDiagnostics = {
  rateLimit: TelegramRateLimitMetrics;
  externalMirrors: number;
  externalQueueTimers: number;
  queueStatusMessages: number;
  mirrorMode: TelegramMirrorMode;
  notifyMode: TelegramNotifyMode;
  quietHours: string;
  voiceBackend: VoiceBackendPreference;
  voiceLanguage: string;
  voiceTranscribeOnly: boolean;
};

function paginateKeyboard(items: KeyboardItem[], page: number, prefix: string): InlineKeyboard {
  const totalPages = Math.max(1, Math.ceil(items.length / KEYBOARD_PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = currentPage * KEYBOARD_PAGE_SIZE;
  const pageItems = items.slice(start, start + KEYBOARD_PAGE_SIZE);
  const keyboard = new InlineKeyboard();

  pageItems.forEach((item, index) => {
    keyboard.text(item.label, item.callbackData);
    if (index < pageItems.length - 1 || totalPages > 1) {
      keyboard.row();
    }
  });

  if (totalPages > 1) {
    if (currentPage > 0) {
      keyboard.text("◀️ Prev", `${prefix}_page_${currentPage - 1}`);
    }
    keyboard.text(`${currentPage + 1}/${totalPages}`, NOOP_PAGE_CALLBACK_DATA);
    if (currentPage < totalPages - 1) {
      keyboard.text("Next ▶️", `${prefix}_page_${currentPage + 1}`);
    }
  }

  return keyboard;
}

function actionKeyboard(rows: ChannelActionButton[][] | undefined): InlineKeyboard | undefined {
  if (!rows || rows.length === 0) {
    return undefined;
  }
  const keyboard = new InlineKeyboard();
  for (const row of rows) {
    for (const button of row) {
      keyboard.text(button.label, telegramActionData(button.action));
    }
    keyboard.row();
  }
  return keyboard;
}

function telegramActionData(action: string): string {
  if (action === "agent-update:jobs") {
    return "upd_jobs";
  }
  const agentUpdateStart = action.match(/^agent-update:start:(.+)$/);
  if (agentUpdateStart?.[1]) {
    return `upd_agent:${agentUpdateStart[1]}`;
  }
  const agentUpdateLog = action.match(/^agent-update:log:(.+)$/);
  if (agentUpdateLog?.[1]) {
    return `upd_log:${agentUpdateLog[1]}`;
  }
  const agentUpdateCancel = action.match(/^agent-update:cancel:(.+)$/);
  if (agentUpdateCancel?.[1]) {
    return `upd_cancel:${agentUpdateCancel[1]}`;
  }
  return action;
}

export function createBot(config: ConnectorConfig, registry: SessionRegistry): Bot<Context> {
  configureRedaction(config.telegramRedactPatterns);
  telegramRateLimiter.configure({
    minIntervalMs: config.telegramRateLimitMinIntervalMs,
    editMinIntervalMs: config.telegramEditMinIntervalMs,
    maxRetries: 5,
  });
  const bot = new Bot<Context>(config.telegramBotToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

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
  const agentUpdates = new AgentUpdateManager();
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
      await safeReply(ctx, rendered.html, {
        fallbackText: rendered.plain,
        replyMarkup: actionKeyboard(rendered.buttons),
      });
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

  const deliverCliGeneratedArtifacts = async (
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: AgentSessionService,
    startedAt: Date | null | undefined,
    turnId: string | null,
    messageThreadId?: number,
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

  const getUserRole = (ctx: Context): TelegramRole => {
    const fromId = ctx.from?.id;
    if (fromId !== undefined && config.telegramAdminUserIdSet.has(fromId)) {
      return "admin";
    }
    if (fromId !== undefined && config.telegramReadOnlyUserIdSet.has(fromId)) {
      return "readonly";
    }
    return "operator";
  };

  const getRequiredPermission = (ctx: Context): TelegramPermission => {
    if (ctx.callbackQuery?.data) {
      return permissionForCallbackData(ctx.callbackQuery.data);
    }

    if (ctx.message?.voice || ctx.message?.audio || ctx.message?.photo || ctx.message?.document) {
      return "files";
    }
    const text = ctx.message?.text?.trim();
    if (!text) {
      return "inspect";
    }
    if (!text.startsWith("/")) {
      return "prompt";
    }

    const command = extractCommandName(text);
    if (command === "queue") {
      const argument = text.replace(/^\/queue(?:@\w+)?\s*/i, "").trim();
      return argument ? "prompt" : "inspect";
    }
    return permissionForCommand(command);
  };

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
    const isAdmin = getUserRole(ctx) === "admin";
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
      await processMediaGroup(pending);
    } catch (error) {
      console.error("Failed to process media group:", error);
      await safeReply(pending.ctx, `<b>Failed to process media group:</b> ${escapeHTML(friendlyErrorText(error))}`, {
        fallbackText: `Failed to process media group: ${friendlyErrorText(error)}`,
      });
    }
  };

  const processMediaGroup = async (pending: PendingMediaGroup): Promise<void> => {
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
      const text = skippedCount > 0 ? "No media group files could be staged." : "Media group was empty.";
      await safeReply(pending.ctx, escapeHTML(text), { fallbackText: text });
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

  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const authorized =
      config.telegramAllowAnyChat ||
      (fromId !== undefined && config.telegramAllowedUserIdSet.has(fromId)) ||
      (chatId !== undefined && config.telegramAllowedChatIdSet.has(chatId));

    if (!authorized) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Unauthorized" }).catch(() => {});
      } else if (ctx.chat) {
        await safeReply(ctx, escapeHTML("Unauthorized"), { fallbackText: "Unauthorized" });
      }
      return;
    }

    const role = getUserRole(ctx);
    const permission = getRequiredPermission(ctx);
    if (!hasTelegramPermission(config.telegramRolePolicies, role, permission)) {
      const message = `Access denied: ${permission} permission required.`;
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: message }).catch(() => {});
      } else {
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      }
      return;
    }

    await next();
  });

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
    await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
  });

  bot.command("agents", async (ctx) => {
    const rendered = renderAgentsAction(listAgentAdapterDescriptors(), enabledAgents(config));
    await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
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
    if (existing && existing.ownerId !== ctx.from.id && getUserRole(ctx) !== "admin") {
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
    if (lock && lock.ownerId !== ctx.from?.id && getUserRole(ctx) !== "admin") {
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
    await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
  });

  bot.command("restart", async (ctx) => {
    await safeReply(ctx, escapeHTML("Restarting connector..."), {
      fallbackText: "Restarting connector...",
    });
    setTimeout(() => {
      spawnConnectorRestart();
    }, 300);
  });

  bot.command("update", async (ctx) => {
    const rawText = ctx.message?.text ?? "";
    const argument = rawText.replace(/^\/update(?:@\w+)?\s*/i, "").trim();
    const tokens = argument.split(/\s+/).filter(Boolean);
    const subcommand = tokens[0]?.toLowerCase();

    if (subcommand === "agents" || subcommand === "agent") {
      const rendered = renderAgentUpdatePickerAction(listAgentAdapterDescriptors());
      await safeReply(ctx, rendered.html, { fallbackText: rendered.plain, replyMarkup: actionKeyboard(rendered.buttons) });
      return;
    }

    if (subcommand === "jobs" || subcommand === "status") {
      const rendered = renderAgentUpdateJobsAction(agentUpdates.list());
      await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
      return;
    }

    if (subcommand === "log" && tokens[1]) {
      const rendered = renderAgentUpdateLogAction(agentUpdates.readLog(tokens[1]));
      await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
      return;
    }

    if (subcommand === "cancel" && tokens[1]) {
      const job = agentUpdates.cancel(tokens[1]);
      const rendered = renderAgentUpdateJobAction(job);
      await safeReply(ctx, rendered.html, {
        fallbackText: rendered.plain,
        replyMarkup: actionKeyboard(rendered.buttons),
      });
      return;
    }

    if ((subcommand === "input" || subcommand === "send") && tokens[1] && tokens.slice(2).join(" ").trim()) {
      const job = agentUpdates.sendInput(tokens[1], tokens.slice(2).join(" "));
      const rendered = renderAgentUpdateJobAction(job);
      await safeReply(ctx, rendered.html, {
        fallbackText: rendered.plain,
        replyMarkup: actionKeyboard(rendered.buttons),
      });
      return;
    }

    const requestedAgent = parseAgentUpdateId(subcommand);
    if (requestedAgent) {
      await startTelegramAgentUpdate(ctx, requestedAgent);
      return;
    }

    if (subcommand) {
      const usage = "Unknown update target. Use /update, /update agents, /update jobs, /update <agent>, /update log <id>, /update cancel <id>, or /update input <id> <text>.";
      await safeReply(ctx, escapeHTML(usage), { fallbackText: usage });
      return;
    }

    const update = spawnSelfUpdate();
    const rendered = renderSelfUpdateStartedAction(update);
    await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
  });

  bot.callbackQuery("upd_jobs", async (ctx) => {
    await ctx.answerCallbackQuery();
    const rendered = renderAgentUpdateJobsAction(agentUpdates.list());
    await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
  });

  bot.callbackQuery(/^upd_agent:(codex|pi|hermes|openclaw|claude-code)$/, async (ctx) => {
    const agentId = ctx.match?.[1] as AgentId | undefined;
    if (!agentId) {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery({ text: `Starting ${agentLabel(agentId)} update...` });
    await startTelegramAgentUpdate(ctx, agentId);
  });

  bot.callbackQuery(/^upd_log:(.+)$/, async (ctx) => {
    const id = ctx.match?.[1];
    await ctx.answerCallbackQuery();
    if (!id) {
      return;
    }
    const rendered = renderAgentUpdateLogAction(agentUpdates.readLog(id));
    await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
  });

  bot.callbackQuery(/^upd_cancel:(.+)$/, async (ctx) => {
    const id = ctx.match?.[1];
    await ctx.answerCallbackQuery({ text: "Cancelling update..." });
    if (!id) {
      return;
    }
    const job = agentUpdates.cancel(id);
    const rendered = renderAgentUpdateJobAction(job);
    await safeReply(ctx, rendered.html, {
      fallbackText: rendered.plain,
      replyMarkup: actionKeyboard(rendered.buttons),
    });
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

    const role = getUserRole(ctx);
    if (pending.requestedBy !== undefined && ctx.from?.id !== pending.requestedBy && role !== "admin") {
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

export async function registerCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Welcome & status" },
    { command: "help", description: "Command reference" },
    { command: "channels", description: "Messaging adapter status" },
    { command: "agents", description: "Agent adapter status" },
    { command: "agent", description: "Select agent" },
    { command: "new", description: "Start a new thread" },
    { command: "session", description: "Current thread details" },
    { command: "sessions", description: "Browse & switch threads" },
    { command: "sync", description: "Sync active session from CLI state" },
    { command: "pinned", description: "Show pinned threads" },
    { command: "pin", description: "Pin current or given thread" },
    { command: "unpin", description: "Unpin current or given thread" },
    { command: "retry", description: "Resend the last prompt" },
    { command: "queue", description: "Show queued prompts" },
    { command: "cancel", description: "Cancel a queued prompt" },
    { command: "clearqueue", description: "Clear queued prompts" },
    { command: "artifacts", description: "List or resend generated files" },
    { command: "workspaces", description: "List allowed workspaces" },
    { command: "abort", description: "Cancel current operation" },
    { command: "stop", description: "Cancel current operation" },
    { command: "launch_profiles", description: "Select launch profile" },
    { command: "fast", description: "Toggle fast mode" },
    { command: "model", description: "View & change model" },
    { command: "reasoning", description: "Set reasoning effort" },
    { command: "mirror", description: "Control CLI mirroring" },
    { command: "notify", description: "Control notifications" },
    { command: "auth", description: "Check auth status" },
    { command: "login", description: "Start authentication" },
    { command: "logout", description: "Sign out" },
    { command: "voice", description: "Voice transcription status" },
    { command: "tasks", description: "Current turn progress" },
    { command: "progress", description: "Current turn progress" },
    { command: "activity", description: "Thread activity timeline" },
    { command: "audit", description: "Admin: recent audit events" },
    { command: "status", description: "Connector runtime status" },
    { command: "health", description: "Connector health report" },
    { command: "version", description: "Connector version" },
    { command: "logs", description: "Admin: show connector logs" },
    { command: "diagnostics", description: "Admin: connector diagnostics" },
    { command: "lock", description: "Lock session writes to you" },
    { command: "unlock", description: "Release session write lock" },
    { command: "locks", description: "List session write locks" },
    { command: "restart", description: "Admin: restart connector" },
    { command: "update", description: "Admin: update connector or agents" },
    { command: "handback", description: "Hand session back to CLI" },
    { command: "attach", description: "Bind a session to this topic" },
    { command: "switch", description: "Switch to a thread by ID" },
  ]);
}

function renderVersionCheckPlain(check: VersionCheck): string {
  const icon = versionStatusIcon(check);
  const label = check.label === "NordRelay" ? "NordRelay" : `${check.label} version`;
  return `${label}: ${icon} ${formatVersionCheckDetailPlain(check)}`;
}

function renderVersionCheckHTML(check: VersionCheck): string {
  const icon = versionStatusIcon(check);
  const label = check.label === "NordRelay" ? "NordRelay" : `${check.label} version`;
  return `<b>${escapeHTML(label)}:</b> ${icon} ${formatVersionCheckDetailHTML(check)}`;
}

function formatCliPathPlain(label: string, cliPath: string | null, fallback: string): string {
  return cliPath ? `${label} path: ${cliPath}` : `${label}: ${fallback}`;
}

function formatCliPathHTML(label: string, cliPath: string | null, fallback: string): string {
  return cliPath
    ? `<b>${escapeHTML(label)} path:</b> <code>${escapeHTML(cliPath)}</code>`
    : `<b>${escapeHTML(label)}:</b> <code>${escapeHTML(fallback)}</code>`;
}

function formatVersionCheckDetailPlain(check: VersionCheck): string {
  if (check.status === "not-installed") {
    return "not installed";
  }
  if (check.status === "outdated") {
    return `${check.installedLabel} (latest ${check.latestVersion ?? "unknown"})`;
  }
  if (check.status === "current") {
    return `${check.installedLabel} (latest)`;
  }
  return `${check.installedLabel} (latest unknown${check.detail ? `: ${check.detail}` : ""})`;
}

function formatVersionCheckDetailHTML(check: VersionCheck): string {
  if (check.status === "not-installed") {
    return "<code>not installed</code>";
  }
  if (check.status === "outdated") {
    return `<code>${escapeHTML(check.installedLabel)}</code> <i>(latest ${escapeHTML(check.latestVersion ?? "unknown")})</i>`;
  }
  if (check.status === "current") {
    return `<code>${escapeHTML(check.installedLabel)}</code> <i>(latest)</i>`;
  }
  return `<code>${escapeHTML(check.installedLabel)}</code> <i>(latest unknown${check.detail ? `: ${escapeHTML(check.detail)}` : ""})</i>`;
}

function versionStatusIcon(check: VersionCheck): string {
  return check.status === "current" ? "✅" : "⚠️";
}

function renderAuditEvents(events: AuditEvent[]): { plain: string; html: string } {
  if (events.length === 0) {
    return {
      plain: "Audit log is empty.",
      html: escapeHTML("Audit log is empty."),
    };
  }

  const lines = events.map((event) => {
    const time = formatLocalDateTime(new Date(event.timestamp));
    const actor = event.actorId ? `user ${event.actorId}` : "system";
    const prompt = event.promptId ? ` · ${event.promptId}` : "";
    const detail = event.detail ? ` · ${trimLine(event.detail, 90)}` : "";
    const description = event.description ? ` · ${trimLine(event.description, 90)}` : "";
    return `${time} · ${event.status.toUpperCase()} · ${event.action} · ${actor}${prompt}${description}${detail}`;
  });

  return {
    plain: ["Audit:", ...lines].join("\n"),
    html: [
      "<b>Audit:</b>",
      ...lines.map((line) => escapeHTML(line)),
    ].join("\n"),
  };
}

function renderSessionLocks(locks: SessionLock[]): { plain: string; html: string } {
  if (locks.length === 0) {
    return {
      plain: "No active session locks.",
      html: escapeHTML("No active session locks."),
    };
  }

  const lines = locks.map((lock) => {
    const expires = lock.expiresAt ? ` · expires ${formatLocalDateTime(new Date(lock.expiresAt))}` : "";
    return `${lock.contextKey} · ${formatLockOwner(lock)}${expires}`;
  });

  return {
    plain: ["Session locks:", ...lines].join("\n"),
    html: ["<b>Session locks:</b>", ...lines.map((line) => escapeHTML(line))].join("\n"),
  };
}

function formatLockOwner(lock: SessionLock | null): string {
  if (!lock) {
    return "nobody";
  }
  return lock.ownerName ? `${lock.ownerName} (${lock.ownerId})` : `user ${lock.ownerId}`;
}

function formatTelegramName(ctx: Context): string | undefined {
  const firstName = ctx.from?.first_name?.trim();
  const lastName = ctx.from?.last_name?.trim();
  const username = ctx.from?.username?.trim();
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  return fullName || (username ? `@${username}` : undefined);
}

function formatLocalDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
  ].join(" ");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function buildArtifactActionsKeyboard(reports: ArtifactTurnReport[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, report] of reports.slice(0, 5).entries()) {
    const label = `${index + 1}`;
    keyboard
      .text(`${label} Send`, `artifact_send:${report.turnId}`)
      .text(`${label} ZIP`, `artifact_zip:${report.turnId}`)
      .text(`${label} Delete`, `artifact_delete:${report.turnId}`)
      .row();
  }
  return keyboard;
}

function filterArtifactReports(reports: ArtifactTurnReport[], argument: string): ArtifactTurnReport[] | null {
  const normalized = argument.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  let predicate: ((artifact: Artifact) => boolean) | null = null;
  if (normalized === "images" || normalized === "image" || normalized === "photos") {
    predicate = (artifact) => isTelegramImagePreview(artifact);
  } else if (normalized === "docs" || normalized === "documents" || normalized === "files") {
    predicate = (artifact) => !isTelegramImagePreview(artifact);
  } else if (normalized.startsWith("search ")) {
    const query = normalized.slice("search ".length).trim();
    if (!query) {
      return [];
    }
    predicate = (artifact) => artifact.name.toLowerCase().includes(query);
  }

  if (!predicate) {
    return null;
  }

  return reports
    .map((report) => ({
      ...report,
      artifacts: report.artifacts.filter(predicate),
    }))
    .filter((report) => report.artifacts.length > 0);
}

function renderProgressPlain(
  progress: TurnProgress | undefined,
  queueLength: number,
  busyState: BusyState,
  info: AgentSessionInfo,
): string {
  const busyFlags = formatBusyFlags(busyState);
  if (!progress) {
    return [
      "Progress:",
      "Status: idle",
      `Thread: ${info.threadId ?? "(not started yet)"}`,
      `Queue: ${queueLength}`,
      `Busy: ${busyFlags || "no"}`,
    ].join("\n");
  }

  const lines = [
    "Progress:",
    `Status: ${progress.status}`,
    `Prompt: ${progress.promptDescription}`,
    `Elapsed: ${formatDurationSeconds(((progress.completedAt ?? Date.now()) - progress.startedAt) / 1000)}`,
    `Current tool: ${progress.currentTool ?? "-"}`,
    `Last tool: ${progress.lastTool ?? "-"}`,
    `Tools: ${formatToolSummaryLine(progress.toolCounts) || "-"}`,
    `Output chars: ${progress.textCharacters}`,
    `Queue: ${queueLength}`,
    `Busy: ${busyFlags || "no"}`,
  ];
  if (progress.error) {
    lines.push(`Error: ${progress.error}`);
  }
  return lines.join("\n");
}

function renderProgressHTML(
  progress: TurnProgress | undefined,
  queueLength: number,
  busyState: BusyState,
  info: AgentSessionInfo,
): string {
  const busyFlags = formatBusyFlags(busyState);
  if (!progress) {
    return [
      "<b>Progress:</b>",
      "<b>Status:</b> <code>idle</code>",
      `<b>Thread:</b> <code>${escapeHTML(info.threadId ?? "(not started yet)")}</code>`,
      `<b>Queue:</b> <code>${queueLength}</code>`,
      `<b>Busy:</b> <code>${escapeHTML(busyFlags || "no")}</code>`,
    ].join("\n");
  }

  const lines = [
    "<b>Progress:</b>",
    `<b>Status:</b> <code>${escapeHTML(progress.status)}</code>`,
    `<b>Prompt:</b> <code>${escapeHTML(progress.promptDescription)}</code>`,
    `<b>Elapsed:</b> <code>${escapeHTML(formatDurationSeconds(((progress.completedAt ?? Date.now()) - progress.startedAt) / 1000))}</code>`,
    `<b>Current tool:</b> <code>${escapeHTML(progress.currentTool ?? "-")}</code>`,
    `<b>Last tool:</b> <code>${escapeHTML(progress.lastTool ?? "-")}</code>`,
    `<b>Tools:</b> <code>${escapeHTML(formatToolSummaryLine(progress.toolCounts) || "-")}</code>`,
    `<b>Output chars:</b> <code>${progress.textCharacters}</code>`,
    `<b>Queue:</b> <code>${queueLength}</code>`,
    `<b>Busy:</b> <code>${escapeHTML(busyFlags || "no")}</code>`,
  ];
  if (progress.error) {
    lines.push(`<b>Error:</b> <code>${escapeHTML(progress.error)}</code>`);
  }
  return lines.join("\n");
}

function renderExternalMirrorStatus(
  snapshot: AgentExternalSnapshot,
  queueLength: number,
): { plain: string; html: string } {
  const prompt = trimLine(snapshot.latestUserMessage ?? "-", 180);
  const elapsed = snapshot.activity.startedAt
    ? formatDurationSeconds((Date.now() - snapshot.activity.startedAt.getTime()) / 1000)
    : "-";
  const lines = [
    `${snapshot.agentLabel} CLI task running.`,
    `Thread: ${snapshot.threadId}`,
    `Elapsed: ${elapsed}`,
    `Prompt: ${prompt}`,
    `Last tool: ${snapshot.latestToolName ?? "-"}`,
    `Queue: ${queueLength}`,
  ];
  return {
    plain: lines.join("\n"),
    html: [
      `<b>${escapeHTML(snapshot.agentLabel)} CLI task running.</b>`,
      `<b>Thread:</b> <code>${escapeHTML(snapshot.threadId)}</code>`,
      `<b>Elapsed:</b> <code>${escapeHTML(elapsed)}</code>`,
      `<b>Prompt:</b> <code>${escapeHTML(prompt)}</code>`,
      `<b>Last tool:</b> <code>${escapeHTML(snapshot.latestToolName ?? "-")}</code>`,
      `<b>Queue:</b> <code>${queueLength}</code>`,
    ].join("\n"),
  };
}

function renderExternalMirrorEvent(event: AgentActivityEvent): { plain: string; html: string } | null {
  if (event.kind === "task") {
    const status = event.status ?? event.type;
    const plain = `CLI task: ${status}`;
    return {
      plain,
      html: `<b>CLI task:</b> <code>${escapeHTML(status)}</code>`,
    };
  }

  if (event.kind !== "tool") {
    return null;
  }

  const status = event.status ?? event.type;
  const tool = event.toolName ?? "tool";
  const detail = event.text ? `\n${trimLine(event.text.replace(/\s+/g, " "), 180)}` : "";
  const plain = `CLI tool ${status}: ${tool}${detail}`;
  return {
    plain,
    html: `<b>CLI tool ${escapeHTML(status)}:</b> <code>${escapeHTML(tool)}</code>${detail ? `\n<code>${escapeHTML(detail.trim())}</code>` : ""}`,
  };
}

function renderActivityTimeline(
  threadId: string,
  events: AgentActivityEvent[],
  options: ActivityOptions = { limit: 16, filter: "all", exportFile: false },
): { plain: string; html: string } {
  if (events.length === 0) {
    return {
      plain: `Activity:\nThread: ${threadId}\nFilter: ${options.filter}\nNo activity events found.`,
      html: `<b>Activity:</b>\n<b>Thread:</b> <code>${escapeHTML(threadId)}</code>\n<b>Filter:</b> <code>${escapeHTML(options.filter)}</code>\n<code>No activity events found.</code>`,
    };
  }

  const lines = events.map((event) => {
    const time = event.timestamp ? event.timestamp.toISOString().slice(11, 19) : "--:--:--";
    const label = activityEventLabel(event);
    const detail = event.text ? ` · ${trimLine(event.text.replace(/\s+/g, " ").trim(), 120)}` : "";
    const tool = event.toolName ? ` · ${event.toolName}` : "";
    return `${time} · ${label}${tool}${detail}`;
  });

  return {
    plain: ["Activity:", `Thread: ${threadId}`, `Filter: ${options.filter}`, `Events: ${events.length}`, ...lines].join("\n"),
    html: [
      "<b>Activity:</b>",
      `<b>Thread:</b> <code>${escapeHTML(threadId)}</code>`,
      `<b>Filter:</b> <code>${escapeHTML(options.filter)}</code>`,
      `<b>Events:</b> <code>${events.length}</code>`,
      ...lines.map((line) => `<code>${escapeHTML(line)}</code>`),
    ].join("\n"),
  };
}

function parseActivityOptions(argument: string): ActivityOptions {
  const options: ActivityOptions = {
    limit: 16,
    filter: "all",
    exportFile: false,
  };
  const parts = argument.split(/\s+/).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!.toLowerCase();
    if (/^\d+$/.test(part)) {
      options.limit = Math.min(200, Math.max(1, Number(part)));
      continue;
    }
    if (part === "export") {
      options.exportFile = true;
      continue;
    }
    if (isActivityFilter(part)) {
      options.filter = part;
      continue;
    }
    if (part === "since" && parts[index + 1]) {
      options.sinceMs = parseDurationToMs(parts[index + 1]!);
      index += 1;
    }
  }
  return options;
}

function filterActivityEvents(events: AgentActivityEvent[], options: ActivityOptions): AgentActivityEvent[] {
  const cutoff = options.sinceMs ? Date.now() - options.sinceMs : undefined;
  return events
    .filter((event) => {
      if (cutoff && event.timestamp && event.timestamp.getTime() < cutoff) {
        return false;
      }
      switch (options.filter) {
        case "tools":
          return event.kind === "tool";
        case "errors":
          return event.status === "failed" || event.status === "error" || /error|failed/i.test(event.text ?? "");
        case "user":
          return event.kind === "user";
        case "agent":
          return event.kind === "agent";
        case "tasks":
          return event.kind === "task";
        default:
          return true;
      }
    })
    .slice(-options.limit);
}

function isActivityFilter(value: string): value is ActivityFilter {
  return value === "all" || value === "tools" || value === "errors" || value === "user" || value === "agent" || value === "tasks";
}

function formatAgentLaunchProfileLabel(profile: AgentLaunchProfileRecord, selected: boolean): string {
  const prefix = selected ? "✅" : profile.unsafe ? "⚠️" : "🚀";
  return `${prefix} ${profile.label} · ${trimLine(profile.behavior, 24)}`;
}

function formatModelButtonLabel(model: AgentModelRecord, selected: boolean): string {
  const meta = [
    model.contextWindow ? formatCompactNumber(model.contextWindow) : undefined,
    model.supportsImages === true ? "img" : model.supportsImages === false ? "text" : undefined,
    model.supportsThinking === true ? "think" : undefined,
  ].filter(Boolean).join(" ");
  return trimLine(`${selected ? "✅ " : ""}${model.displayName}${meta ? ` · ${meta}` : ""}`, 58);
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000_000) return `${Math.round(value / 100_000_000) / 10}B`;
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
  return String(value);
}

function renderAgentDiagnostics(diagnostics: ReturnType<typeof getAgentDiagnostics>): { plain: string; html: string } {
  return {
    plain: [
      `${diagnostics.agentLabel} state:`,
      ...diagnostics.lines.map((line) => `${line.label}: ${line.value}`),
    ].join("\n"),
    html: [
      `<b>${escapeHTML(diagnostics.agentLabel)} state:</b>`,
      ...diagnostics.lines.map((line) => `<b>${escapeHTML(line.label)}:</b> <code>${escapeHTML(line.value)}</code>`),
    ].join("\n"),
  };
}

function activityEventLabel(event: AgentActivityEvent): string {
  if (event.kind === "task") {
    return `task ${event.status ?? event.type}`;
  }
  if (event.kind === "user") {
    return "user";
  }
  if (event.kind === "agent") {
    return event.phase ? `agent ${event.phase}` : "agent";
  }
  return event.status ? `tool ${event.status}` : "tool";
}

function isEmptyArtifactReport(report: ArtifactReport): boolean {
  return report.artifacts.length === 0 && report.skippedCount === 0 && !(report.omittedCount && report.omittedCount > 0);
}

function formatBusyFlags(state: BusyState): string {
  return Object.entries(state)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(", ");
}

function renderDiagnosticsPlain(
  config: ConnectorConfig,
  registry: SessionRegistry,
  health: Awaited<ReturnType<typeof getConnectorHealth>>,
  authenticated: boolean,
  role: TelegramRole,
  queueLength: number,
  progress: TurnProgress | undefined,
  runtime: RuntimeDiagnostics,
): string {
  const contexts = registry.listContexts();
  return [
    "Diagnostics:",
    `Status: ${health.state.status ?? "unknown"}`,
    `Version: ${health.version}`,
    `Role: ${role}`,
    `Auth: ${authenticated ? "yes" : "no"} (${health.state.authMethod ?? "-"})`,
    `PID: ${health.state.pid ?? "-"} (${health.pidRunning ? "running" : "not running"})`,
    `App PID: ${health.state.appPid ?? "-"} (${health.appPidRunning ? "running" : "not running"})`,
    `Workspace: ${config.workspace}`,
    `State backend: ${config.stateBackend}`,
    `Telegram transport: ${config.telegramTransport}`,
    `Codex CLI: ${health.codexCli}`,
    `Pi CLI: ${health.piCli}`,
    `Hermes CLI: ${health.hermesCli}`,
    `OpenClaw CLI: ${health.openClawCli}`,
    `Claude Code CLI: ${health.claudeCodeCli}`,
    `Hermes API: ${config.hermesApiBaseUrl}`,
    `OpenClaw Gateway: ${config.openClawGatewayUrl}`,
    `Enabled agents/default: ${enabledAgents(config).join(", ")} / ${config.defaultAgent}`,
    `State DB: ${health.databasePath ?? "-"}`,
    `Log file: ${health.logFile}`,
    `Log format: ${config.logFormat}`,
    `Tool verbosity: ${config.toolVerbosity}`,
    `Telegram rate limit queued/running/retries/429: ${runtime.rateLimit.queued}/${runtime.rateLimit.running}/${runtime.rateLimit.retries}/${runtime.rateLimit.rateLimitHits}`,
    `Telegram last retry_after: ${runtime.rateLimit.lastRetryAfterSeconds ?? "-"}s`,
    `CLI mirror mode/update: ${runtime.mirrorMode} / ${config.telegramMirrorMinUpdateMs} ms`,
    `Notify/quiet: ${runtime.notifyMode} / ${runtime.quietHours}`,
    `Voice: ${runtime.voiceBackend} / ${runtime.voiceLanguage} / transcribe-only ${runtime.voiceTranscribeOnly ? "on" : "off"}`,
    `Sync interval: ${config.codexSyncIntervalMs} ms`,
    `External busy check/stale: ${config.codexExternalBusyCheckMs} ms / ${config.codexExternalBusyStaleMs} ms`,
    `External mirrors/timers/status messages: ${runtime.externalMirrors}/${runtime.externalQueueTimers}/${runtime.queueStatusMessages}`,
    `Auto-send artifacts: ${config.telegramAutoSendArtifacts ? "yes" : "no"}`,
    `Artifact ignore dirs/globs: ${config.artifactIgnoreDirs.length}/${config.artifactIgnoreGlobs.length}`,
    `Artifact retention: ${config.artifactRetentionDays}d / ${config.artifactMaxTurnDirs} turns / ${config.artifactMaxInboxDirs} inbox dirs`,
    `Workspace allowed/warn roots: ${config.workspaceAllowedRoots.length}/${config.workspaceWarnRoots.length}`,
    `Allowed users/chats/admins/readonly: ${config.telegramAllowedUserIds.length}/${config.telegramAllowedChatIds.length}/${config.telegramAdminUserIds.length}/${config.telegramReadOnlyUserIds.length}`,
    `Session lock TTL: ${config.sessionLockTtlMs} ms`,
    `Audit max events: ${config.auditMaxEvents}`,
    `Loaded sessions: ${contexts.length}`,
    `Current queue: ${queueLength}`,
    `Current progress: ${progress?.status ?? "idle"}`,
  ].join("\n");
}

function renderDiagnosticsHTML(
  config: ConnectorConfig,
  registry: SessionRegistry,
  health: Awaited<ReturnType<typeof getConnectorHealth>>,
  authenticated: boolean,
  role: TelegramRole,
  queueLength: number,
  progress: TurnProgress | undefined,
  runtime: RuntimeDiagnostics,
): string {
  const contexts = registry.listContexts();
  return [
    "<b>Diagnostics:</b>",
    `<b>Status:</b> <code>${escapeHTML(health.state.status ?? "unknown")}</code>`,
    `<b>Version:</b> <code>${escapeHTML(health.version)}</code>`,
    `<b>Role:</b> <code>${escapeHTML(role)}</code>`,
    `<b>Auth:</b> <code>${authenticated ? "yes" : "no"} (${escapeHTML(health.state.authMethod ?? "-")})</code>`,
    `<b>PID:</b> <code>${escapeHTML(String(health.state.pid ?? "-"))} (${health.pidRunning ? "running" : "not running"})</code>`,
    `<b>App PID:</b> <code>${escapeHTML(String(health.state.appPid ?? "-"))} (${health.appPidRunning ? "running" : "not running"})</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(config.workspace)}</code>`,
    `<b>State backend:</b> <code>${escapeHTML(config.stateBackend)}</code>`,
    `<b>Telegram transport:</b> <code>${escapeHTML(config.telegramTransport)}</code>`,
    `<b>Codex CLI:</b> <code>${escapeHTML(health.codexCli)}</code>`,
    `<b>Pi CLI:</b> <code>${escapeHTML(health.piCli)}</code>`,
    `<b>Hermes CLI:</b> <code>${escapeHTML(health.hermesCli)}</code>`,
    `<b>OpenClaw CLI:</b> <code>${escapeHTML(health.openClawCli)}</code>`,
    `<b>Claude Code CLI:</b> <code>${escapeHTML(health.claudeCodeCli)}</code>`,
    `<b>Hermes API:</b> <code>${escapeHTML(config.hermesApiBaseUrl)}</code>`,
    `<b>OpenClaw Gateway:</b> <code>${escapeHTML(config.openClawGatewayUrl)}</code>`,
    `<b>Enabled agents/default:</b> <code>${escapeHTML(`${enabledAgents(config).join(", ")} / ${config.defaultAgent}`)}</code>`,
    `<b>State DB:</b> <code>${escapeHTML(health.databasePath ?? "-")}</code>`,
    `<b>Log file:</b> <code>${escapeHTML(health.logFile)}</code>`,
    `<b>Log format:</b> <code>${escapeHTML(config.logFormat)}</code>`,
    `<b>Tool verbosity:</b> <code>${escapeHTML(config.toolVerbosity)}</code>`,
    `<b>Telegram rate limit queued/running/retries/429:</b> <code>${runtime.rateLimit.queued}/${runtime.rateLimit.running}/${runtime.rateLimit.retries}/${runtime.rateLimit.rateLimitHits}</code>`,
    `<b>Telegram last retry_after:</b> <code>${escapeHTML(String(runtime.rateLimit.lastRetryAfterSeconds ?? "-"))}s</code>`,
    `<b>CLI mirror mode/update:</b> <code>${escapeHTML(runtime.mirrorMode)} / ${config.telegramMirrorMinUpdateMs} ms</code>`,
    `<b>Notify/quiet:</b> <code>${escapeHTML(runtime.notifyMode)} / ${escapeHTML(runtime.quietHours)}</code>`,
    `<b>Voice:</b> <code>${escapeHTML(runtime.voiceBackend)} / ${escapeHTML(runtime.voiceLanguage)} / transcribe-only ${runtime.voiceTranscribeOnly ? "on" : "off"}</code>`,
    `<b>Sync interval:</b> <code>${config.codexSyncIntervalMs} ms</code>`,
    `<b>External busy check/stale:</b> <code>${config.codexExternalBusyCheckMs} ms / ${config.codexExternalBusyStaleMs} ms</code>`,
    `<b>External mirrors/timers/status messages:</b> <code>${runtime.externalMirrors}/${runtime.externalQueueTimers}/${runtime.queueStatusMessages}</code>`,
    `<b>Auto-send artifacts:</b> <code>${config.telegramAutoSendArtifacts ? "yes" : "no"}</code>`,
    `<b>Artifact ignore dirs/globs:</b> <code>${config.artifactIgnoreDirs.length}/${config.artifactIgnoreGlobs.length}</code>`,
    `<b>Artifact retention:</b> <code>${config.artifactRetentionDays}d / ${config.artifactMaxTurnDirs} turns / ${config.artifactMaxInboxDirs} inbox dirs</code>`,
    `<b>Workspace allowed/warn roots:</b> <code>${config.workspaceAllowedRoots.length}/${config.workspaceWarnRoots.length}</code>`,
    `<b>Allowed users/chats/admins/readonly:</b> <code>${config.telegramAllowedUserIds.length}/${config.telegramAllowedChatIds.length}/${config.telegramAdminUserIds.length}/${config.telegramReadOnlyUserIds.length}</code>`,
    `<b>Session lock TTL:</b> <code>${config.sessionLockTtlMs} ms</code>`,
    `<b>Audit max events:</b> <code>${config.auditMaxEvents}</code>`,
    `<b>Loaded sessions:</b> <code>${contexts.length}</code>`,
    `<b>Current queue:</b> <code>${queueLength}</code>`,
    `<b>Current progress:</b> <code>${escapeHTML(progress?.status ?? "idle")}</code>`,
  ].join("\n");
}

function renderHealthPlain(
  health: Awaited<ReturnType<typeof getConnectorHealth>>,
  authenticated: boolean,
  role: "admin" | "operator" | "readonly",
): string {
  return [
    `Status: ${health.state.status ?? "unknown"}`,
    `Version: ${health.version}`,
    `Role: ${role}`,
    `Auth: ${authenticated ? "yes" : "no"}`,
    `PID: ${health.state.pid ?? "-"} (${health.pidRunning ? "running" : "not running"})`,
    `App PID: ${health.state.appPid ?? "-"} (${health.appPidRunning ? "running" : "not running"})`,
    `Uptime: ${formatDuration(health.uptimeSeconds)}`,
    `Workspace: ${health.state.workspace ?? "-"}`,
    `Codex CLI: ${health.codexCli}`,
    `Pi CLI: ${health.piCli}`,
    `Hermes CLI: ${health.hermesCli}`,
    `OpenClaw CLI: ${health.openClawCli}`,
    `Claude Code CLI: ${health.claudeCodeCli}`,
    `Codex state DB: ${health.databasePath ?? "-"}`,
    `Log: ${health.logFile}`,
  ].join("\n");
}

function renderHealthHTML(
  health: Awaited<ReturnType<typeof getConnectorHealth>>,
  authenticated: boolean,
  role: "admin" | "operator" | "readonly",
): string {
  return [
    `<b>Status:</b> <code>${escapeHTML(health.state.status ?? "unknown")}</code>`,
    `<b>Version:</b> <code>${escapeHTML(health.version)}</code>`,
    `<b>Role:</b> <code>${escapeHTML(role)}</code>`,
    `<b>Auth:</b> <code>${authenticated ? "yes" : "no"}</code>`,
    `<b>PID:</b> <code>${escapeHTML(String(health.state.pid ?? "-"))} (${health.pidRunning ? "running" : "not running"})</code>`,
    `<b>App PID:</b> <code>${escapeHTML(String(health.state.appPid ?? "-"))} (${health.appPidRunning ? "running" : "not running"})</code>`,
    `<b>Uptime:</b> <code>${escapeHTML(formatDuration(health.uptimeSeconds))}</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(health.state.workspace ?? "-")}</code>`,
    `<b>Codex CLI:</b> <code>${escapeHTML(health.codexCli)}</code>`,
    `<b>Pi CLI:</b> <code>${escapeHTML(health.piCli)}</code>`,
    `<b>Hermes CLI:</b> <code>${escapeHTML(health.hermesCli)}</code>`,
    `<b>OpenClaw CLI:</b> <code>${escapeHTML(health.openClawCli)}</code>`,
    `<b>Claude Code CLI:</b> <code>${escapeHTML(health.claudeCodeCli)}</code>`,
    `<b>Codex state DB:</b> <code>${escapeHTML(health.databasePath ?? "-")}</code>`,
    `<b>Log:</b> <code>${escapeHTML(health.logFile)}</code>`,
  ].join("\n");
}

function parseFastModeArgument(argument: string, currentValue: boolean): boolean | undefined {
  if (!argument) {
    return !currentValue;
  }

  const normalized = argument.toLowerCase();
  if (["on", "enable", "enabled", "true", "1"].includes(normalized)) {
    return true;
  }
  if (["off", "disable", "disabled", "false", "0"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseToggle(argument: string): boolean | undefined {
  const normalized = argument.trim().toLowerCase();
  if (["on", "enable", "enabled", "true", "1", "yes"].includes(normalized)) {
    return true;
  }
  if (["off", "disable", "disabled", "false", "0", "no"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseDurationToMs(value: string): number | undefined {
  const match = value.trim().match(/^(\d+)(s|m|h|d)?$/i);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "m").toLowerCase();
  const multiplier = unit === "s"
    ? 1000
    : unit === "h"
      ? 60 * 60 * 1000
      : unit === "d"
        ? 24 * 60 * 60 * 1000
        : 60 * 1000;
  return amount * multiplier;
}

function extractCommandName(text: string): string | undefined {
  const match = text.trim().match(/^\/([a-zA-Z0-9_-]+)(?:@\w+)?(?:\s|$)/);
  return match?.[1]?.toLowerCase();
}

function isPromptEnvelopeLike(value: AgentPromptInput | PromptEnvelope): value is PromptEnvelope {
  return typeof value === "object" && value !== null && "input" in value && "description" in value;
}

function isQueuedPromptLike(value: PromptEnvelope): value is QueuedPrompt {
  return "id" in value &&
    "contextKey" in value &&
    "createdAt" in value &&
    typeof (value as QueuedPrompt).id === "string" &&
    typeof (value as QueuedPrompt).contextKey === "string" &&
    typeof (value as QueuedPrompt).createdAt === "number";
}

function capabilitiesOf(info: AgentSessionInfo) {
  return info.capabilities ?? CODEX_AGENT_CAPABILITIES;
}

function labelOf(info: AgentSessionInfo): string {
  return info.agentLabel ?? agentLabel(info.agentId ?? "codex");
}

function idOf(info: AgentSessionInfo): AgentId {
  return info.agentId ?? "codex";
}

function authHelpText(info: AgentSessionInfo): string {
  const agentId = idOf(info);
  if (agentId === "pi") {
    return "Configure the required Pi provider environment variable on the host.";
  }
  if (agentId === "hermes") {
    return "Start the Hermes API Server, configure HERMES_API_KEY when required, or use /login to start Hermes CLI auth.";
  }
  if (agentId === "openclaw") {
    return "Start the OpenClaw Gateway and configure OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD when the gateway requires one.";
  }
  if (agentId === "claude-code") {
    return "Use /login to start Claude Code CLI auth, or run 'claude auth login' on the host.";
  }
  return "Use /login to start authentication, or set CODEX_API_KEY on the host.";
}

function formatAgentSettingScope(info: AgentSessionInfo, appliedToActiveThread: boolean): string {
  const agentId = idOf(info);
  if (agentId === "hermes") {
    return appliedToActiveThread
      ? "applies to the next Hermes run in this session"
      : "applies to new Hermes sessions";
  }
  if (agentId === "pi") {
    return appliedToActiveThread
      ? "applied to the current idle Pi session and future turns"
      : "applies to new Pi sessions";
  }
  if (agentId === "openclaw") {
    return appliedToActiveThread
      ? "applies to the next OpenClaw run in this session"
      : "applies to new OpenClaw sessions";
  }
  if (agentId === "claude-code") {
    return appliedToActiveThread
      ? "applies to the next Claude Code run in this session"
      : "applies to new Claude Code sessions";
  }
  return appliedToActiveThread
    ? "applied to the current idle thread and future threads"
    : "applies to new threads";
}

function requiresTurnApproval(info: AgentSessionInfo): boolean {
  return info.unsafeLaunch || info.approvalPolicy !== "never";
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function formatDurationSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function renderToolStartMessage(toolName: string): RenderedText {
  return {
    text: `<b>🔧 Running:</b> <code>${escapeHTML(toolName)}</code>`,
    fallbackText: `🔧 Running: ${toolName}`,
    parseMode: "HTML",
  };
}

function renderToolEndMessage(toolName: string, partialResult: string, isError: boolean): RenderedText {
  const preview = summarizeToolOutput(partialResult);
  const icon = isError ? "❌" : "✅";
  const htmlLines = [`<b>${icon}</b> <code>${escapeHTML(toolName)}</code>`];
  const plainLines = [`${icon} ${toolName}`];

  if (preview) {
    htmlLines.push(`<pre>${escapeHTML(preview)}</pre>`);
    plainLines.push(preview);
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

export function formatToolSummaryLine(toolCounts: Map<string, number>): string {
  if (toolCounts.size === 0) {
    return "";
  }

  const summarizedCounts = new Map<string, number>();
  for (const [toolName, count] of toolCounts.entries()) {
    const summaryName = summarizeToolName(toolName);
    summarizedCounts.set(summaryName, (summarizedCounts.get(summaryName) ?? 0) + count);
  }

  const entries = [...summarizedCounts.entries()].sort((left, right) => {
    const countDelta = right[1] - left[1];
    return countDelta !== 0 ? countDelta : left[0].localeCompare(right[0]);
  });
  const tools = entries
    .map(([name, count]) => formatSummaryEntry(name, count))
    .join(", ");
  return `Tools used: ${tools}`;
}

function renderTodoList(items: Array<{ text: string; completed: boolean }>): string {
  const lines = items.map((item) => {
    const icon = item.completed ? "✅" : "⬜";
    return `${icon} ${escapeHTML(item.text)}`;
  });
  return `📋 <b>Plan</b>\n${lines.join("\n")}`;
}

export function formatTurnUsageLine(usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): string {
  return `🪙 in: ${usage.inputTokens} · cached: ${usage.cachedInputTokens} · out: ${usage.outputTokens}`;
}

export function summarizeToolName(toolName: string): string {
  if (toolName.startsWith("🔍 ")) {
    return "web_fetch";
  }

  if (toolName === "file_change") {
    return "file_change";
  }

  if (toolName === "⚠️ error") {
    return "error";
  }

  if (toolName.startsWith("mcp:")) {
    const tool = toolName.split("/").at(-1) ?? toolName;
    if (SUBAGENT_TOOL_NAMES.has(tool)) {
      return "subagent";
    }
    return tool;
  }

  return "bash";
}

function formatSummaryEntry(name: string, count: number): string {
  if (count <= 1) {
    return name;
  }

  const label = name === "subagent" ? "subagents" : name;
  return `${count}x ${label}`;
}

const SUBAGENT_TOOL_NAMES = new Set(["spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent"]);

async function safeReply(ctx: Context, text: string, options: TextOptions = {}): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    return;
  }

  const parseMode = options.parseMode !== undefined ? options.parseMode : ("HTML" as TelegramParseMode);
  const messageThreadId =
    options.messageThreadId ?? ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;

  const chunks = splitTelegramText(redactText(text));
  const fallbackChunks = options.fallbackText ? splitTelegramText(redactText(options.fallbackText)) : [];

  for (const [index, chunk] of chunks.entries()) {
    await sendTextMessage(ctx.api, chatId, chunk, {
      parseMode,
      fallbackText: fallbackChunks[index] ?? chunk,
      replyMarkup: index === 0 ? options.replyMarkup : undefined,
      messageThreadId,
    });
  }
}

async function sendTextMessage(
  api: Context["api"],
  chatId: TelegramChatId,
  text: string,
  options: TextOptions = {},
): Promise<{ message_id: number }> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";
  const safeText = redactText(text);
  const safeFallbackText = options.fallbackText === undefined ? undefined : redactText(options.fallbackText);
  const bucket = chatBucket(chatId);

  try {
    return await telegramRateLimiter.run(bucket, "sendMessage", () =>
      api.sendMessage(chatId, safeText, {
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
        reply_markup: options.replyMarkup,
      })
    );
  } catch (error) {
    if (parseMode && safeFallbackText !== undefined && isTelegramParseError(error)) {
      return await telegramRateLimiter.run(bucket, "sendMessage", () =>
        api.sendMessage(chatId, safeFallbackText, {
          ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
          reply_markup: options.replyMarkup,
        })
      );
    }
    throw error;
  }
}

async function safeEditMessage(
  bot: Bot<Context>,
  chatId: TelegramChatId,
  messageId: number,
  text: string,
  options: TextOptions = {},
): Promise<void> {
  const parseMode = Object.prototype.hasOwnProperty.call(options, "parseMode") ? options.parseMode : "HTML";
  const safeText = redactText(text);
  const safeFallbackText = options.fallbackText === undefined ? undefined : redactText(options.fallbackText);
  const bucket = `${chatBucket(chatId)}:${messageId}`;

  try {
    await telegramRateLimiter.run(bucket, "editMessageText", () =>
      bot.api.editMessageText(chatId, messageId, safeText, {
        ...(parseMode ? { parse_mode: parseMode } : {}),
        reply_markup: options.replyMarkup,
      })
    );
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return;
    }

    if (parseMode && safeFallbackText !== undefined && isTelegramParseError(error)) {
      await telegramRateLimiter.run(bucket, "editMessageText", () =>
        bot.api.editMessageText(chatId, messageId, safeFallbackText, {
          reply_markup: options.replyMarkup,
        })
      );
      return;
    }

    throw error;
  }
}

async function safeEditReplyMarkup(
  bot: Bot<Context>,
  chatId: TelegramChatId,
  messageId: number,
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  try {
    await telegramRateLimiter.run(`${chatBucket(chatId)}:${messageId}`, "editMessageReplyMarkup", () =>
      bot.api.editMessageReplyMarkup(chatId, messageId, {
        reply_markup: replyMarkup ?? new InlineKeyboard(),
      })
    );
  } catch (error) {
    if (!isMessageNotModifiedError(error)) {
      throw error;
    }
  }
}

async function sendChatActionSafe(
  api: Context["api"],
  chatId: TelegramChatId,
  action: Parameters<Context["api"]["sendChatAction"]>[1],
  messageThreadId?: number,
): Promise<void> {
  await telegramRateLimiter.run(chatBucket(chatId), "sendChatAction", () =>
    api.sendChatAction(chatId, action, {
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    })
  );
}

function chatBucket(chatId: TelegramChatId): string {
  return `chat:${String(chatId)}`;
}

async function downloadTelegramFile(
  api: Context["api"],
  token: string,
  fileId: string,
  maxBytes = MAX_AUDIO_FILE_SIZE,
): Promise<string> {
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not return a file path");
  }

  if (file.file_size && file.file_size > maxBytes) {
    throw new Error(
      `Telegram file too large (${Math.round(file.file_size / 1024 / 1024)} MB, max ${Math.round(maxBytes / 1024 / 1024)} MB)`,
    );
  }

  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(file.file_path) || ".bin";
  const tempPath = path.join(tmpdir(), `nordrelay-file-${randomUUID()}${extension}`);
  await writeFile(tempPath, buffer);
  return tempPath;
}

function splitTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT);
    }
    if (cut < TELEGRAM_MESSAGE_LIMIT * 0.5) {
      cut = TELEGRAM_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [""];
}

function splitMarkdownForTelegram(markdown: string): RenderedChunk[] {
  if (!markdown) {
    return [];
  }

  const chunks: RenderedChunk[] = [];
  let remaining = markdown;

  while (remaining) {
    const maxLength = Math.min(remaining.length, FORMATTED_CHUNK_TARGET);
    const initialCut = findPreferredSplitIndex(remaining, maxLength);
    const candidate = remaining.slice(0, initialCut) || remaining.slice(0, 1);
    const rendered = renderMarkdownChunkWithinLimit(candidate);

    chunks.push(rendered);
    remaining = remaining.slice(rendered.sourceText.length).trimStart();
  }

  return chunks;
}

function renderMarkdownChunkWithinLimit(markdown: string): RenderedChunk {
  if (!markdown) {
    return {
      text: "",
      fallbackText: "",
      parseMode: "HTML",
      sourceText: "",
    };
  }

  let sourceText = markdown;
  let rendered = formatMarkdownMessage(sourceText);

  while (rendered.text.length > TELEGRAM_MESSAGE_LIMIT && sourceText.length > 1) {
    const nextLength = Math.max(1, sourceText.length - Math.max(100, Math.ceil(sourceText.length * 0.1)));
    sourceText = sourceText.slice(0, nextLength).trimEnd() || sourceText.slice(0, nextLength);
    rendered = formatMarkdownMessage(sourceText);
  }

  return {
    ...rendered,
    sourceText,
  };
}

function formatMarkdownMessage(markdown: string): RenderedText {
  try {
    return {
      text: formatTelegramHTML(markdown),
      fallbackText: markdown,
      parseMode: "HTML",
    };
  } catch (error) {
    console.error("Failed to format Telegram HTML, falling back to plain text", error);
    return {
      text: markdown,
      fallbackText: markdown,
      parseMode: undefined,
    };
  }
}

function findPreferredSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) {
    return Math.max(1, text.length);
  }

  const newlineIndex = text.lastIndexOf("\n", maxLength);
  if (newlineIndex >= maxLength * 0.5) {
    return Math.max(1, newlineIndex);
  }

  const spaceIndex = text.lastIndexOf(" ", maxLength);
  if (spaceIndex >= maxLength * 0.5) {
    return Math.max(1, spaceIndex);
  }

  return Math.max(1, maxLength);
}

function buildStreamingPreview(text: string): string {
  if (text.length <= STREAMING_PREVIEW_LIMIT) {
    return text;
  }

  return `${text.slice(0, STREAMING_PREVIEW_LIMIT)}\n\n… streaming (preview truncated)`;
}

function appendWithCap(base: string, addition: string, cap: number): string {
  const combined = `${base}${addition}`;
  return combined.length <= cap ? combined : combined.slice(-cap);
}

function summarizeToolOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length <= TOOL_OUTPUT_PREVIEW_LIMIT ? trimmed : `${trimmed.slice(-TOOL_OUTPUT_PREVIEW_LIMIT)}\n…`;
}

function trimLine(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}

function formatRelativeTime(date: Date): string {
  const deltaMs = Date.now() - date.getTime();
  const deltaSeconds = Math.max(0, Math.floor(deltaMs / 1000));

  if (deltaSeconds < 60) {
    return "just now";
  }

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 48) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 14) {
    return `${deltaDays}d ago`;
  }

  const deltaWeeks = Math.floor(deltaDays / 7);
  return `${deltaWeeks}w ago`;
}

function filterSessions<T extends {
  id: string;
  title: string | null;
  cwd: string;
  model: string | null;
  firstUserMessage: string | null;
}>(sessions: T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return sessions;
  }

  return sessions.filter((session) =>
    [
      session.id,
      session.title ?? "",
      session.cwd,
      session.model ?? "",
      session.firstUserMessage ?? "",
    ].some((value) => value.toLowerCase().includes(normalized)),
  );
}

function orderPinnedSessions<T extends { id: string }>(sessions: T[], pinnedThreadIds: string[]): T[] {
  const pinnedIndex = new Map(pinnedThreadIds.map((threadId, index) => [threadId, index]));
  return [...sessions].sort((left, right) => {
    const leftPinned = pinnedIndex.get(left.id);
    const rightPinned = pinnedIndex.get(right.id);
    if (leftPinned !== undefined && rightPinned !== undefined) {
      return leftPinned - rightPinned;
    }
    if (leftPinned !== undefined) {
      return -1;
    }
    if (rightPinned !== undefined) {
      return 1;
    }
    return 0;
  });
}

function isMessageNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("message is not modified");
}

function isTelegramParseError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("can't parse entities") ||
    message.includes("unsupported start tag") ||
    message.includes("unexpected end tag") ||
    message.includes("entity name") ||
    message.includes("parse entities")
  );
}

function renderPromptFailure(accumulatedText: string, error: unknown): string {
  const message = friendlyErrorText(error);
  return accumulatedText.trim() ? `${accumulatedText.trim()}\n\n⚠️ ${message}` : `⚠️ ${message}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
