import type { PeerEventEnvelope } from "../../peers/peer-types.js";
import type { BotPreferencesStore, ChannelMirrorMode, ContextPreferences } from "../../state/bot-preferences.js";
import type { WebChatAction, WebChatMessage } from "../../web/web-state.js";
import type { ActiveSessionDto, RelaySnapshot } from "../../runtime/relay-runtime-types.js";
import type { ChannelActionButton } from "./channel-actions.js";
import type { ChannelContext, ChannelRuntime } from "./channel-adapter.js";
import { formatDurationSeconds, trimLine } from "./bot-rendering.js";
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
  actionForWebAction?(peerId: string, action: WebChatAction): ChannelActionButton | null;
}

interface SubscriptionState {
  contextKey: string;
  context: ChannelContext;
  peerId: string;
  close: () => void;
  seenMessageIds: Set<string>;
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
  pending: Promise<void>;
}

export function createChannelPeerMirrorController(options: ChannelPeerMirrorControllerOptions): ChannelPeerMirrorController {
  const subscriptions = new Map<string, SubscriptionState>();

  const close = (contextKey: string): void => {
    const existing = subscriptions.get(contextKey);
    if (!existing) return;
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
    const currentMode = effectiveMode(options, contextKey);
    if (currentMode === "off") {
      close(contextKey);
      return;
    }
    const existing = subscriptions.get(contextKey);
    if (existing && existing.peerId === peerId) {
      existing.context = context;
      applyTargetPreferences(existing, preferences);
      return;
    }
    close(contextKey);
    const state: SubscriptionState = {
      contextKey,
      context,
      peerId,
      close: () => {},
      seenMessageIds: new Set(),
      initializedHistory: false,
      pending: Promise.resolve(),
    };
    applyTargetPreferences(state, preferences);
    const subscription = options.remoteClient.subscribe(peerId, (event) => {
      state.pending = state.pending
        .then(() => handlePeerEvent(options, state, event))
        .catch(() => {});
    }, (error) => {
      stopPeerTyping(state);
      state.pending = state.pending.then(() => sendPeerMirrorStatus(options, state, `${options.label} remote mirror stream failed: ${error.message}`, "error")).catch(() => {});
    }, contextKey);
    state.close = subscription.close;
    subscriptions.set(contextKey, state);
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

async function handlePeerEvent(
  options: ChannelPeerMirrorControllerOptions,
  state: SubscriptionState,
  event: PeerEventEnvelope,
): Promise<void> {
  const mode = effectiveMode(options, state.contextKey);
  applyTargetPreferences(state, options.preferencesStore.get(state.contextKey));
  if (mode === "off") {
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
      state.seenMessageIds.add(messageMirrorId(message));
    }
    state.initializedHistory = true;
    return;
  }
  const selectedThreadId = state.targetThreadId || state.currentThreadId;
  for (const message of messages) {
    const id = messageMirrorId(message);
    if (state.seenMessageIds.has(id)) {
      continue;
    }
    state.seenMessageIds.add(id);
    if (selectedThreadId && message.threadId && message.threadId !== selectedThreadId) {
      continue;
    }
    if (!shouldMirrorMessage(options, message, mode)) {
      continue;
    }
    const buttons = message.actions
      ?.map((action) => options.actionForWebAction?.(state.peerId, action))
      .filter((action): action is ChannelActionButton => Boolean(action));
    await options.runtime.sendMessage(state.context, {
      text: renderMirroredChatMessage(message, state.peerId),
      fallbackText: `[remote ${state.peerId}] ${message.text}`,
      parseMode: "html",
      buttons: buttons?.length ? [buttons] : undefined,
    }).catch(() => {});
  }
  if (state.seenMessageIds.size > 500) {
    state.seenMessageIds = new Set([...state.seenMessageIds].slice(-250));
  }
}

async function handlePeerTurnStart(
  options: ChannelPeerMirrorControllerOptions,
  state: SubscriptionState,
  event: Extract<PeerEventEnvelope, { type: "turn_start" }>,
  mode: ChannelMirrorMode,
): Promise<void> {
  if (mode !== "final" && mode !== "full") {
    return;
  }
  if (event.source === options.runtime.id) {
    return;
  }
  await sendPeerWorkingNotice(options, state, {
    key: `turn:${event.id}:${event.correlationId ?? ""}`,
    prompt: event.text || event.prompt,
    agentLabel: state.currentAgentLabel || "Remote",
  });
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
    startPeerTyping(options, state, key);
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

function startPeerTyping(options: ChannelPeerMirrorControllerOptions, state: SubscriptionState, sessionKey: string): void {
  if (state.typingLoop && state.typingSessionKey === sessionKey) {
    return;
  }
  stopPeerTyping(state);
  state.typingSessionKey = sessionKey;
  state.typingLoop = createChannelTypingLoop({
    intervalMs: options.typingIntervalMs,
    sendTyping: () => options.runtime.sendTyping(state.context),
  });
  state.typingLoop.start();
}

function stopPeerTyping(state: SubscriptionState): void {
  state.typingLoop?.stop();
  state.typingLoop = undefined;
  state.typingSessionKey = undefined;
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
  stopPeerTyping(state);
  state.targetThreadId = nextThreadId;
  state.targetAgentId = nextAgentId;
  state.activeSessionKey = undefined;
  state.activeSessionLabel = undefined;
  state.workingNoticeKey = undefined;
  state.statusMessageId = undefined;
  state.lastStatusEditAt = undefined;
  state.seenMessageIds.clear();
  state.initializedHistory = false;
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
