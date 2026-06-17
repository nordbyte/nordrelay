import type { PeerEventEnvelope } from "../../peers/peer-types.js";
import type { BotPreferencesStore, ChannelMirrorMode, ContextPreferences } from "../../state/bot-preferences.js";
import type { WebChatAction, WebChatMessage } from "../../web/web-state.js";
import type { ActiveSessionDto, RelaySnapshot } from "../../runtime/relay-runtime-types.js";
import type { ChannelActionButton } from "./channel-actions.js";
import type { ChannelContext, ChannelRuntime } from "./channel-adapter.js";
import { formatDurationSeconds, trimLine } from "./bot-rendering.js";
import { remotePeerThreadSourceContextKey } from "./channel-peer-context.js";
import { escapeHTML } from "../../core/format.js";
import { createChannelTypingLoop, type ChannelTypingLoop } from "./channel-turn-lifecycle.js";

export interface ChannelPeerMirrorRemoteClient {
  subscribe(
    peerId: string,
    onEvent: (event: PeerEventEnvelope) => void,
    onError?: (error: Error) => void,
    sourceContextKey?: string,
  ): { close: () => void };
}

export interface ChannelPeerMirrorController {
  sync(contextKey: string, context: ChannelContext): void;
  close(contextKey: string): void;
  closeAll(): void;
  startStoredContexts(): void;
}

export interface ChannelPeerMirrorControllerOptions {
  label: string;
  runtime: ChannelRuntime;
  preferencesStore: BotPreferencesStore;
  remoteClient: ChannelPeerMirrorRemoteClient;
  contextForKey(contextKey: string): ChannelContext | null;
  defaultMirrorMode(): ChannelMirrorMode;
  mirrorMinUpdateMs: number;
  typingIntervalMs: number;
  typingStaleMs?: number;
  actionForWebAction?(peerId: string, action: WebChatAction): ChannelActionButton | null;
}

interface SubscriptionState {
  contextKey: string;
  context: ChannelContext;
  peerId: string;
  sourceContextKey: string;
  close: () => void;
  seenMessageIds: Set<string>;
  mirroredMessageIds: Map<string, string>;
  mirroredMessageTexts: Map<string, string>;
  suppressedTurnKeys: Set<string>;
  initializedHistory: boolean;
  statusMessageId?: string;
  lastStatusEditAt?: number;
  currentThreadId?: string | null;
  currentAgentId?: string;
  currentAgentLabel?: string;
  targetThreadId?: string | null;
  targetAgentId?: string | null;
  activeSessionKey?: string;
  activeSessionLabel?: string;
  workingNoticeKey?: string;
  typingLoop?: ChannelTypingLoop;
  typingSessionKey?: string;
  typingLastRefreshAt?: number;
  typingExpiryTimer?: ReturnType<typeof setTimeout>;
  textStream?: TextStreamMirrorState;
  pending: Promise<void>;
}

interface TextStreamMirrorState {
  key: string;
  aliases: string[];
  text: string;
  threadId: string;
  correlationId?: string;
  turnId?: string;
  messageId?: string;
  lastEditAt?: number;
  flushTimer?: ReturnType<typeof setTimeout>;
}

export function createChannelPeerMirrorController(options: ChannelPeerMirrorControllerOptions): ChannelPeerMirrorController {
  const subscriptions = new Map<string, SubscriptionState>();

  const close = (contextKey: string): void => {
    const existing = subscriptions.get(contextKey);
    if (!existing) return;
    clearTextStream(existing);
    stopPeerTyping(existing);
    existing.close();
    subscriptions.delete(contextKey);
  };

  const ensure = (contextKey: string, context: ChannelContext, preferences: ContextPreferences): void => {
    const peerId = preferences.targetPeerId ?? undefined;
    if (!peerId) {
      close(contextKey);
      return;
    }
    const sourceContextKey = peerMirrorSourceContextKey(contextKey, preferences);
    const currentMode = effectiveMode(options, contextKey);
    if (currentMode === "off") {
      close(contextKey);
      return;
    }
    const existing = subscriptions.get(contextKey);
    if (existing && existing.peerId === peerId && existing.sourceContextKey === sourceContextKey) {
      existing.context = context;
      applyTargetPreferences(existing, preferences);
      return;
    }
    close(contextKey);
    const state: SubscriptionState = {
      contextKey,
      context,
      peerId,
      sourceContextKey,
      close: () => {},
      seenMessageIds: new Set(),
      mirroredMessageIds: new Map(),
      mirroredMessageTexts: new Map(),
      suppressedTurnKeys: new Set(),
      initializedHistory: false,
      pending: Promise.resolve(),
    };
    applyTargetPreferences(state, preferences);
    try {
      const subscription = options.remoteClient.subscribe(peerId, (event) => {
        state.pending = state.pending
          .then(() => handlePeerEvent(options, state, event))
          .catch(() => {});
      }, (error) => {
        stopPeerTyping(state);
        state.pending = state.pending.then(() => sendPeerMirrorStatus(options, state, `${options.label} remote mirror stream failed: ${error.message}`, "error")).catch(() => {});
      }, sourceContextKey);
      state.close = subscription.close;
      subscriptions.set(contextKey, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.pending = state.pending.then(() => sendPeerMirrorStatus(options, state, `${options.label} remote mirror stream failed: ${message}`, "error")).catch(() => {});
    }
  };

  return {
    sync(contextKey, context) {
      const preferences = options.preferencesStore.get(contextKey);
      if (!preferences.targetPeerId) {
        close(contextKey);
        return;
      }
      ensure(contextKey, context, preferences);
    },
    close,
    closeAll() {
      for (const contextKey of [...subscriptions.keys()]) close(contextKey);
    },
    startStoredContexts() {
      for (const entry of options.preferencesStore.list()) {
        if (!entry.preferences.targetPeerId) continue;
        if ((entry.preferences.mirrorMode ?? options.defaultMirrorMode()) === "off") continue;
        const context = options.contextForKey(entry.contextKey);
        if (context) ensure(entry.contextKey, context, entry.preferences);
      }
    },
  };
}

function peerMirrorSourceContextKey(contextKey: string, preferences: ContextPreferences): string {
  return remotePeerThreadSourceContextKey(contextKey, preferences.targetThreadId);
}

async function handlePeerEvent(
  options: ChannelPeerMirrorControllerOptions,
  state: SubscriptionState,
  event: PeerEventEnvelope,
): Promise<void> {
  const mode = effectiveMode(options, state.contextKey);
  applyTargetPreferences(state, options.preferencesStore.get(state.contextKey));
  if (mode === "off") {
    clearTextStream(state);
    stopPeerTyping(state);
    return;
  }
  if (event.type === "status") {
    await options.runtime.sendTyping(state.context).catch(() => {});
    if (mode === "status" || mode === "full") {
      await sendPeerMirrorStatus(options, state, event.message, event.level);
    }
    return;
  }
  if (event.type === "snapshot") {
    rememberSnapshot(state, event.data);
    return;
  }
  if (event.type === "active_sessions_update") {
    await handlePeerActiveSessionsUpdate(options, state, event.active.sessions, mode);
    return;
  }
  if (event.type === "turn_start") {
    await handlePeerTurnStart(options, state, event, mode);
    return;
  }
  if (event.type === "text_delta") {
    await mirrorTextDelta(options, state, event, mode);
    return;
  }
  if (event.type === "assistant_message_complete") {
    await handleAssistantMessageComplete(options, state, event);
    return;
  }
  if (event.type === "turn_complete" || event.type === "turn_error") {
    await handlePeerTurnEnd(options, state, event);
    return;
  }
  if (event.type === "chat_message_added") {
    await mirrorChatMessage(options, state, event.message, mode, "added");
    return;
  }
  if (event.type === "chat_message_updated") {
    await mirrorChatMessage(options, state, event.message, mode, "updated");
    return;
  }
  if (event.type !== "chat_history") {
    return;
  }
  await mirrorChatHistory(options, state, event.messages, mode);
}

async function mirrorChatHistory(
  options: ChannelPeerMirrorControllerOptions,
  state: SubscriptionState,
  messages: WebChatMessage[],
  mode: ChannelMirrorMode,
): Promise<void> {
  if (!state.initializedHistory) {
    for (const message of messages) {
      markMessageSeen(state, message);
    }
    state.initializedHistory = true;
    return;
  }
  const selectedThreadId = state.targetThreadId || state.currentThreadId;
  for (const message of messages) {
    if (selectedThreadId && message.threadId && message.threadId !== selectedThreadId) continue;
    await mirrorChatMessage(options, state, message, mode, "added");
  }
  trimMirrorState(state);
}

async function mirrorChatMessage(
  options: ChannelPeerMirrorControllerOptions,
  state: SubscriptionState,
  message: WebChatMessage,
  mode: ChannelMirrorMode,
  kind: "added" | "updated",
): Promise<void> {
  const aliases = messageMirrorAliases(message);
  const primaryId = aliases[0];
  const existingMessageId = getMirroredMessageId(state, aliases);
  const previousText = getMirroredMessageText(state, aliases);
  if (kind === "added" && state.seenMessageIds.has(primaryId) && !existingMessageId) {
    return;
  }
  if (kind === "updated" && !existingMessageId && previousText === message.text) {
    return;
  }
  const selectedThreadId = state.targetThreadId || state.currentThreadId;
  if (selectedThreadId && message.threadId && message.threadId !== selectedThreadId) {
    markMessageSeen(state, message);
    return;
  }
  if (!shouldMirrorMessage(options, message, mode)) {
    markMessageSeen(state, message);
    return;
  }
  const sentMessageId = await sendOrEditMirroredChatMessage(options, state, message, existingMessageId);
  markMessageSeen(state, message);
  if (sentMessageId) {
    rememberMirroredMessage(state, aliases, sentMessageId, message.text);
  }
  trimMirrorState(state);
}

async function sendOrEditMirroredChatMessage(
  options: ChannelPeerMirrorControllerOptions,
  state: SubscriptionState,
  message: WebChatMessage,
  existingMessageId?: string,
): Promise<string | undefined> {
  const buttons = message.actions
    ?.map((action) => options.actionForWebAction?.(state.peerId, action))
    .filter((action): action is ChannelActionButton => Boolean(action));
  const outbound = {
    text: renderMirroredChatMessage(message, state.peerId),
    fallbackText: `[remote ${state.peerId}] ${message.text}`,
    parseMode: "html",
    buttons: buttons?.length ? [buttons] : undefined,
  } as const;
  if (existingMessageId) {
    const edited = await options.runtime.editMessage(state.context, existingMessageId, outbound)
      .then(() => true)
      .catch(() => false);
    if (edited) {
      return existingMessageId;
    }
  }
  const sent = await options.runtime.sendMessage(state.context, outbound).catch(() => null);
  return sent?.messageId;
}

async function mirrorTextDelta(
  options: ChannelPeerMirrorControllerOptions,
  state: SubscriptionState,
  event: Extract<PeerEventEnvelope, { type: "text_delta" }>,
  mode: ChannelMirrorMode,
): Promise<void> {
  if (mode !== "final" && mode !== "full") {
    return;
  }
  if (!event.delta || !eventMatchesSelectedSession(state, event) || state.suppressedTurnKeys.has(eventTurnKey(state, event))) {
    return;
  }
  const key = eventTurnKey(state, event);
  refreshPeerTyping(options, state, key);
  if (state.textStream && state.textStream.key !== key) {
    await flushTextStream(options, state, true);
    clearTextStream(state);
  }
  if (!state.textStream) {
    const aliases = eventMirrorAliases(state, event);
    state.textStream = {
      key,
      aliases,
      text: "",
      threadId: event.threadId || state.targetThreadId || state.currentThreadId || "pending",
      correlationId: event.correlationId,
      turnId: event.id,
      messageId: getMirroredMessageId(state, aliases),
    };
  }
  state.textStream.text += event.delta;
  await flushTextStream(options, state, false);
}

async function handleAssistantMessageComplete(
  options: ChannelPeerMirrorControllerOptions,
  state: SubscriptionState,
  event: Extract<PeerEventEnvelope, { type: "assistant_message_complete" }>,
): Promise<void> {
  if (!eventMatchesSelectedSession(state, event) || state.suppressedTurnKeys.has(eventTurnKey(state, event))) {
    return;
  }
  await flushTextStream(options, state, true);
  clearTextStream(state);
  stopPeerTyping(state);
}

async function flushTextStream(
  options: ChannelPeerMirrorControllerOptions,
  state: SubscriptionState,
  force: boolean,
): Promise<void> {
  const stream = state.textStream;
  if (!stream || !stream.text.trim()) {
    return;
  }
  if (stream.flushTimer) {
    clearTimeout(stream.flushTimer);
    stream.flushTimer = undefined;
  }
  const now = Date.now();
  const elapsed = stream.lastEditAt ? now - stream.lastEditAt : Number.POSITIVE_INFINITY;
  if (!force && stream.messageId && elapsed < options.mirrorMinUpdateMs) {
    scheduleTextStreamFlush(options, state, options.mirrorMinUpdateMs - elapsed);
    return;
  }
  const message: WebChatMessage = {
    id: stream.key,
    key: stream.key,
    threadId: stream.threadId,
    role: "agent",
    text: stream.text,
    timestamp: new Date().toISOString(),
    source: "web",
    correlationId: stream.correlationId,
    turnId: stream.turnId,
  };
  const sentMessageId = await sendOrEditMirroredChatMessage(options, state, message, stream.messageId ?? getMirroredMessageId(state, stream.aliases));
  if (sentMessageId) {
    stream.messageId = sentMessageId;
    rememberMirroredMessage(state, [...stream.aliases, ...messageMirrorAliases(message)], sentMessageId, stream.text);
  }
  stream.lastEditAt = now;
  trimMirrorState(state);
}

function scheduleTextStreamFlush(
  options: ChannelPeerMirrorControllerOptions,
  state: SubscriptionState,
  delayMs: number,
): void {
  const stream = state.textStream;
  if (!stream || stream.flushTimer) {
    return;
  }
  stream.flushTimer = setTimeout(() => {
    if (!state.textStream) {
      return;
    }
    state.textStream.flushTimer = undefined;
    void flushTextStream(options, state, true).catch(() => {});
  }, Math.max(25, delayMs));
  stream.flushTimer.unref?.();
}

async function handlePeerTurnStart(
  options: ChannelPeerMirrorControllerOptions,
  state: SubscriptionState,
  event: Extract<PeerEventEnvelope, { type: "turn_start" }>,
  mode: ChannelMirrorMode,
): Promise<void> {
  if (!eventMatchesSelectedSession(state, event)) {
    return;
  }
  if (event.source === options.runtime.id) {
    state.suppressedTurnKeys.add(eventTurnKey(state, event));
    return;
  }
  refreshPeerTyping(options, state, `turn:${event.id}:${event.correlationId ?? ""}`);
  if (mode !== "final" && mode !== "full") return;
  await sendPeerWorkingNotice(options, state, {
    key: `turn:${event.id}:${event.correlationId ?? ""}`,
    prompt: event.text || event.prompt,
    agentLabel: state.currentAgentLabel || "Remote",
  });
}

async function handlePeerTurnEnd(
  options: ChannelPeerMirrorControllerOptions,
  state: SubscriptionState,
  event: Extract<PeerEventEnvelope, { type: "turn_complete" | "turn_error" }>,
): Promise<void> {
  const key = eventTurnKey(state, event);
  state.suppressedTurnKeys.delete(key);
  if (!eventMatchesSelectedSession(state, event)) {
    return;
  }
  await flushTextStream(options, state, true);
  if (state.textStream?.key === key) {
    clearTextStream(state);
  }
  stopPeerTyping(state);
}

async function sendPeerMirrorStatus(
  options: ChannelPeerMirrorControllerOptions,
  state: SubscriptionState,
  message: string,
  level: "info" | "warn" | "error",
  optionsOverride: { force?: boolean } = {},
): Promise<void> {
  const now = Date.now();
  if (!optionsOverride.force && state.statusMessageId && state.lastStatusEditAt && now - state.lastStatusEditAt < options.mirrorMinUpdateMs) {
    return;
  }
  const text = `<b>Remote ${escapeHTML(level)}:</b> ${escapeHTML(message)}`;
  if (!state.statusMessageId) {
    const sent = await options.runtime.sendMessage(state.context, {
      text,
      fallbackText: `Remote ${level}: ${message}`,
      parseMode: "html",
    }).catch(() => null);
    state.statusMessageId = sent?.messageId;
  } else {
    await options.runtime.editMessage(state.context, state.statusMessageId, {
      text,
      fallbackText: `Remote ${level}: ${message}`,
      parseMode: "html",
    }).catch(async () => {
      const sent = await options.runtime.sendMessage(state.context, {
        text,
        fallbackText: `Remote ${level}: ${message}`,
        parseMode: "html",
      }).catch(() => null);
      state.statusMessageId = sent?.messageId;
    });
  }
  state.lastStatusEditAt = now;
}

async function handlePeerActiveSessionsUpdate(
  options: ChannelPeerMirrorControllerOptions,
  state: SubscriptionState,
  sessions: ActiveSessionDto[],
  mode: ChannelMirrorMode,
): Promise<void> {
  const active = selectPeerActiveSession(state, sessions);
  if (active) {
    const key = activeSessionKey(active);
    state.activeSessionKey = key;
    state.activeSessionLabel = active.agentLabel || active.agentId || "Agent";
    refreshPeerTyping(options, state, key);
    if (mode === "final" && active.source === "cli") {
      await sendPeerWorkingNotice(options, state, {
        key: activeTurnKey(active),
        prompt: active.prompt,
        agentLabel: active.agentLabel || active.agentId || "Remote",
      });
    }
    if (mode === "status" || mode === "full") {
      await sendPeerMirrorStatus(options, state, renderPeerActiveSessionStatus(active), "info");
    }
    return;
  }

  if (state.activeSessionKey) {
    const label = state.activeSessionLabel || state.currentAgentLabel || "Remote";
    state.activeSessionKey = undefined;
    state.activeSessionLabel = undefined;
    state.workingNoticeKey = undefined;
    stopPeerTyping(state);
    if (mode === "status" || mode === "full") {
      await sendPeerMirrorStatus(options, state, `${label} CLI task finished.`, "info", { force: true });
    }
  }
}

async function sendPeerWorkingNotice(
  options: ChannelPeerMirrorControllerOptions,
  state: SubscriptionState,
  input: { key: string; prompt?: string; agentLabel: string },
): Promise<void> {
  if (state.workingNoticeKey === input.key) {
    return;
  }
  const prompt = trimLine((input.prompt ?? "").replace(/\s+/g, " "), 500);
  const fallbackText = prompt ? `Working on ${prompt}` : `Working on remote ${input.agentLabel} task...`;
  const html = prompt
    ? `<b>Working on</b> ${escapeHTML(prompt)}`
    : `<b>Working on</b> remote ${escapeHTML(input.agentLabel)} task...`;
  await options.runtime.sendMessage(state.context, {
    text: html,
    fallbackText,
    parseMode: "html",
  }).catch(() => {});
  state.workingNoticeKey = input.key;
}

function refreshPeerTyping(options: ChannelPeerMirrorControllerOptions, state: SubscriptionState, sessionKey: string): void {
  const now = Date.now();
  state.typingLastRefreshAt = now;
  if (state.typingLoop && state.typingSessionKey === sessionKey) {
    schedulePeerTypingExpiry(options, state, sessionKey);
    return;
  }
  stopPeerTyping(state);
  state.typingSessionKey = sessionKey;
  state.typingLastRefreshAt = now;
  state.typingLoop = createChannelTypingLoop({
    intervalMs: options.typingIntervalMs,
    sendTyping: () => options.runtime.sendTyping(state.context),
  });
  state.typingLoop.start();
  schedulePeerTypingExpiry(options, state, sessionKey);
}

function schedulePeerTypingExpiry(options: ChannelPeerMirrorControllerOptions, state: SubscriptionState, sessionKey: string): void {
  if (state.typingExpiryTimer) {
    clearTimeout(state.typingExpiryTimer);
    state.typingExpiryTimer = undefined;
  }
  const staleMs = options.typingStaleMs ?? Math.max(options.typingIntervalMs * 4, 15_000);
  state.typingExpiryTimer = setTimeout(() => {
    if (state.typingSessionKey !== sessionKey) {
      return;
    }
    const refreshedAt = state.typingLastRefreshAt ?? 0;
    if (Date.now() - refreshedAt >= staleMs) {
      stopPeerTyping(state);
      state.activeSessionKey = undefined;
      state.activeSessionLabel = undefined;
      state.workingNoticeKey = undefined;
    } else {
      schedulePeerTypingExpiry(options, state, sessionKey);
    }
  }, staleMs);
  state.typingExpiryTimer.unref?.();
}

function stopPeerTyping(state: SubscriptionState): void {
  if (state.typingExpiryTimer) {
    clearTimeout(state.typingExpiryTimer);
    state.typingExpiryTimer = undefined;
  }
  state.typingLoop?.stop();
  state.typingLoop = undefined;
  state.typingSessionKey = undefined;
  state.typingLastRefreshAt = undefined;
}

function clearTextStream(state: SubscriptionState): void {
  if (state.textStream?.flushTimer) {
    clearTimeout(state.textStream.flushTimer);
  }
  state.textStream = undefined;
}

function rememberSnapshot(state: SubscriptionState, snapshot: RelaySnapshot): void {
  const session = snapshot.session;
  state.currentThreadId = session.threadId ?? null;
  state.currentAgentId = session.agentId;
  state.currentAgentLabel = session.agentLabel || session.agentId;
}

function selectPeerActiveSession(state: SubscriptionState, sessions: ActiveSessionDto[]): ActiveSessionDto | undefined {
  if (!sessions.length) {
    return undefined;
  }
  if (state.targetThreadId) {
    return sessions.find((session) =>
      session.threadId === state.targetThreadId &&
      (!state.targetAgentId || !session.agentId || session.agentId === state.targetAgentId)
    );
  }
  if (state.currentThreadId) {
    const byThread = sessions.find((session) =>
      session.threadId === state.currentThreadId &&
      (!state.currentAgentId || !session.agentId || session.agentId === state.currentAgentId)
    );
    if (byThread) {
      return byThread;
    }
    return undefined;
  }
  return sessions.find((session) => session.threadId) ?? sessions[0];
}

function applyTargetPreferences(state: SubscriptionState, preferences: ContextPreferences): void {
  const nextThreadId = preferences.targetThreadId ?? null;
  const nextAgentId = preferences.targetAgentId ?? null;
  if (state.targetThreadId === nextThreadId && state.targetAgentId === nextAgentId) {
    return;
  }
  clearTextStream(state);
  stopPeerTyping(state);
  state.targetThreadId = nextThreadId;
  state.targetAgentId = nextAgentId;
  state.activeSessionKey = undefined;
  state.activeSessionLabel = undefined;
  state.workingNoticeKey = undefined;
  state.statusMessageId = undefined;
  state.lastStatusEditAt = undefined;
  state.seenMessageIds.clear();
  state.mirroredMessageIds.clear();
  state.mirroredMessageTexts.clear();
  state.suppressedTurnKeys.clear();
  state.initializedHistory = false;
}

function eventMatchesSelectedSession(state: SubscriptionState, event: { agentId?: string; threadId?: string | null }): boolean {
  if (state.targetThreadId) {
    if (event.threadId && event.threadId !== state.targetThreadId) return false;
    if (state.targetAgentId && event.agentId && event.agentId !== state.targetAgentId) return false;
    return true;
  }
  if (state.currentThreadId && event.threadId && event.threadId !== state.currentThreadId) return false;
  if (state.currentAgentId && event.agentId && event.agentId !== state.currentAgentId) return false;
  return true;
}

function renderPeerActiveSessionStatus(session: ActiveSessionDto): string {
  const label = session.agentLabel || session.agentId || "Agent";
  const status = session.source === "cli" ? "CLI running" : `${session.source} running`;
  const duration = formatDurationSeconds((activeDurationMs(session) ?? 0) / 1000);
  const tool = session.currentTool || session.lastTool;
  const queue = `${Math.max(0, Number(session.queueLength) || 0)} queued`;
  const prompt = session.prompt ? ` · ${trimLine(session.prompt.replace(/\s+/g, " "), 120)}` : "";
  return [label, status, duration, tool ? `tool ${tool}` : "", queue].filter(Boolean).join(" · ") + prompt;
}

function activeDurationMs(session: ActiveSessionDto): number | null {
  const startedAt = Date.parse(session.startedAt);
  if (Number.isFinite(startedAt)) {
    return Math.max(0, Date.now() - startedAt);
  }
  const duration = Number(session.durationMs);
  return Number.isFinite(duration) ? Math.max(0, duration) : null;
}

function activeSessionKey(session: ActiveSessionDto): string {
  return session.threadId || session.id || session.contextKey;
}

function activeTurnKey(session: ActiveSessionDto): string {
  return session.id || [session.threadId, session.startedAt, session.prompt ?? ""].filter(Boolean).join(":") || session.contextKey;
}

function effectiveMode(options: ChannelPeerMirrorControllerOptions, contextKey: string): ChannelMirrorMode {
  return options.preferencesStore.get(contextKey).mirrorMode ?? options.defaultMirrorMode();
}

function shouldMirrorMessage(options: ChannelPeerMirrorControllerOptions, message: WebChatMessage, mode: ChannelMirrorMode): boolean {
  if (mode === "off" || mode === "status" || message.role === "user") {
    return false;
  }
  if (message.source === options.runtime.id) {
    return false;
  }
  if (mode === "final") {
    return message.role === "agent";
  }
  return message.role === "agent" || message.role === "system" || message.role === "tool";
}

function renderMirroredChatMessage(message: WebChatMessage, peerId: string): string {
  const label = message.role === "agent"
    ? "Remote agent"
    : message.role === "tool"
      ? "Remote tool"
      : "Remote";
  return `<b>${escapeHTML(label)}:</b> ${escapeHTML(message.text)}\n<code>${escapeHTML(peerId)}</code>`;
}

function messageMirrorId(message: WebChatMessage): string {
  return message.id || message.key || [
    message.threadId,
    message.role,
    message.timestamp,
    message.turnId ?? "",
    message.text.slice(0, 160),
  ].join(":");
}

function messageMirrorAliases(message: WebChatMessage): string[] {
  const aliases = [
    messageMirrorId(message),
    message.id ? `message:id:${message.id}` : "",
    message.key ? `message:key:${message.key}` : "",
  ];
  const threadId = message.threadId || "pending";
  if (message.correlationId || message.turnId) {
    aliases.push(turnAlias(threadId, message.correlationId, message.turnId));
  }
  if (message.correlationId) {
    aliases.push(turnAlias(threadId, message.correlationId, undefined));
  }
  if (message.turnId) {
    aliases.push(turnAlias(threadId, undefined, message.turnId));
  }
  return uniqueStrings(aliases);
}

function eventMirrorAliases(state: SubscriptionState, event: { id?: string; correlationId?: string; threadId?: string | null }): string[] {
  const threadId = event.threadId || state.targetThreadId || state.currentThreadId || "pending";
  return uniqueStrings([
    eventTurnKey(state, event),
    turnAlias(threadId, event.correlationId, event.id),
    event.correlationId ? turnAlias(threadId, event.correlationId, undefined) : "",
    event.id ? turnAlias(threadId, undefined, event.id) : "",
  ]);
}

function eventTurnKey(state: SubscriptionState, event: { id?: string; correlationId?: string; threadId?: string | null }): string {
  const threadId = event.threadId || state.targetThreadId || state.currentThreadId || "pending";
  return turnAlias(threadId, event.correlationId, event.id);
}

function turnAlias(threadId: string, correlationId: string | undefined, turnId: string | undefined): string {
  return `turn:${threadId}:${correlationId ?? ""}:${turnId ?? ""}`;
}

function markMessageSeen(state: SubscriptionState, message: WebChatMessage): void {
  const aliases = messageMirrorAliases(message);
  for (const alias of aliases) {
    state.seenMessageIds.add(alias);
    state.mirroredMessageTexts.set(alias, message.text);
  }
  trimMirrorState(state);
}

function getMirroredMessageId(state: SubscriptionState, aliases: string[]): string | undefined {
  for (const alias of aliases) {
    const messageId = state.mirroredMessageIds.get(alias);
    if (messageId) return messageId;
  }
  return undefined;
}

function getMirroredMessageText(state: SubscriptionState, aliases: string[]): string | undefined {
  for (const alias of aliases) {
    const text = state.mirroredMessageTexts.get(alias);
    if (text !== undefined) return text;
  }
  return undefined;
}

function rememberMirroredMessage(state: SubscriptionState, aliases: string[], messageId: string, text: string): void {
  for (const alias of uniqueStrings(aliases)) {
    state.mirroredMessageIds.set(alias, messageId);
    state.mirroredMessageTexts.set(alias, text);
    state.seenMessageIds.add(alias);
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function trimMirrorState(state: SubscriptionState): void {
  trimSet(state.seenMessageIds, 500, 250);
  trimMap(state.mirroredMessageIds, 500, 250);
  trimMap(state.mirroredMessageTexts, 500, 250);
  trimSet(state.suppressedTurnKeys, 200, 100);
}

function trimSet<T>(set: Set<T>, maxSize: number, keepSize: number): void {
  if (set.size <= maxSize) return;
  const keep = [...set].slice(-keepSize);
  set.clear();
  for (const value of keep) set.add(value);
}

function trimMap<K, V>(map: Map<K, V>, maxSize: number, keepSize: number): void {
  if (map.size <= maxSize) return;
  const keep = [...map.entries()].slice(-keepSize);
  map.clear();
  for (const [key, value] of keep) map.set(key, value);
}
