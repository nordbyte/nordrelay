import type { PeerEventEnvelope } from "../../peers/peer-types.js";
import type { BotPreferencesStore, ChannelMirrorMode } from "../../state/bot-preferences.js";
import type { WebChatAction, WebChatMessage } from "../../web/web-state.js";
import type { ChannelActionButton } from "./channel-actions.js";
import type { ChannelContext, ChannelRuntime } from "./channel-adapter.js";
import { escapeHTML } from "../../core/format.js";

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
  pending: Promise<void>;
}

export function createChannelPeerMirrorController(options: ChannelPeerMirrorControllerOptions): ChannelPeerMirrorController {
  const subscriptions = new Map<string, SubscriptionState>();

  const close = (contextKey: string): void => {
    const existing = subscriptions.get(contextKey);
    if (!existing) return;
    existing.close();
    subscriptions.delete(contextKey);
  };

  const ensure = (contextKey: string, context: ChannelContext, peerId: string): void => {
    const currentMode = effectiveMode(options, contextKey);
    if (currentMode === "off") {
      close(contextKey);
      return;
    }
    const existing = subscriptions.get(contextKey);
    if (existing && existing.peerId === peerId) {
      existing.context = context;
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
    const subscription = options.remoteClient.subscribe(peerId, (event) => {
      state.pending = state.pending
        .then(() => handlePeerEvent(options, state, event))
        .catch(() => {});
    }, (error) => {
      state.pending = state.pending.then(() => sendPeerMirrorStatus(options, state, `${options.label} remote mirror stream failed: ${error.message}`, "error")).catch(() => {});
    }, contextKey);
    state.close = subscription.close;
    subscriptions.set(contextKey, state);
  };

  return {
    sync(contextKey, context) {
      const targetPeerId = options.preferencesStore.get(contextKey).targetPeerId ?? undefined;
      if (!targetPeerId) {
        close(contextKey);
        return;
      }
      ensure(contextKey, context, targetPeerId);
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
        if (context) ensure(entry.contextKey, context, entry.preferences.targetPeerId);
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
  if (mode === "off") {
    return;
  }
  if (event.type === "status") {
    await options.runtime.sendTyping(state.context).catch(() => {});
    if (mode === "status" || mode === "full") {
      await sendPeerMirrorStatus(options, state, event.message, event.level);
    }
    return;
  }
  if (event.type === "active_sessions_update" && event.active.sessions.length > 0) {
    await options.runtime.sendTyping(state.context).catch(() => {});
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
  for (const message of messages) {
    const id = messageMirrorId(message);
    if (state.seenMessageIds.has(id)) {
      continue;
    }
    state.seenMessageIds.add(id);
    if (!shouldMirrorMessage(message, mode)) {
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

async function sendPeerMirrorStatus(
  options: ChannelPeerMirrorControllerOptions,
  state: SubscriptionState,
  message: string,
  level: "info" | "warn" | "error",
): Promise<void> {
  const now = Date.now();
  if (state.statusMessageId && state.lastStatusEditAt && now - state.lastStatusEditAt < options.mirrorMinUpdateMs) {
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

function effectiveMode(options: ChannelPeerMirrorControllerOptions, contextKey: string): ChannelMirrorMode {
  return options.preferencesStore.get(contextKey).mirrorMode ?? options.defaultMirrorMode();
}

function shouldMirrorMessage(message: WebChatMessage, mode: ChannelMirrorMode): boolean {
  if (mode === "off" || mode === "status" || message.role === "user" || message.source !== "cli") {
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
