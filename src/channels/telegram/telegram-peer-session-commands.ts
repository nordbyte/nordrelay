import type { Bot, Context } from "grammy";

import type { WebActivityActor } from "../../web/web-state.js";
import type { BotPreferencesStore } from "../../state/bot-preferences.js";
import { friendlyErrorText } from "../../core/error-messages.js";
import { escapeHTML } from "../../core/format.js";
import { formatRelativeTime } from "../shared/bot-rendering.js";
import { renderSessionInfoHTML, renderSessionInfoPlain } from "../shared/session-format.js";
import {
  listTargetPeerSessions,
  parseRemoteSessionChoice,
  remoteSessionChoiceValue,
  renderTargetPeerSession,
  selectedTargetPeerId,
  switchTargetPeerSession,
  type RemotePeerWebClient,
} from "../shared/channel-peer-sessions.js";
import type { TelegramContextKey } from "../shared/context-key.js";
import { formatSessionLabel } from "./bot-ui.js";
import { paginateKeyboard, type KeyboardItem } from "./telegram-channel-runtime.js";
import { safeEditMessage, safeReply, type TelegramChatId } from "./telegram-output.js";

export async function replyTargetPeerSession(options: {
  ctx: Context;
  contextKey: TelegramContextKey;
  preferencesStore: BotPreferencesStore;
  remoteClient: RemotePeerWebClient;
  actor: WebActivityActor;
}): Promise<boolean> {
  const remoteRendered = await renderTargetPeerSession(options).catch(async (error) => {
    const text = `Remote session failed: ${friendlyErrorText(error)}`;
    await safeReply(options.ctx, `<b>Failed:</b> ${escapeHTML(text)}`, { fallbackText: text });
    return null;
  });
  if (!remoteRendered) return false;
  await safeReply(options.ctx, remoteRendered.html, { fallbackText: remoteRendered.plain });
  return true;
}

export async function handleTargetPeerSessionsCommand(options: {
  ctx: Context;
  contextKey: TelegramContextKey;
  rawText: string;
  preferencesStore: BotPreferencesStore;
  remoteClient: RemotePeerWebClient;
  actor: WebActivityActor;
  pendingSessionPicks: Map<TelegramContextKey, string[]>;
  pendingSessionButtons: Map<TelegramContextKey, KeyboardItem[]>;
  syncPeerMirror(contextKey: TelegramContextKey): void;
}): Promise<boolean> {
  if (!selectedTargetPeerId(options.preferencesStore, options.contextKey)) return false;
  const query = options.rawText.replace(/^\/(?:sessions|switch)(?:@\w+)?\s*/, "").trim();
  const commandName = options.rawText.match(/^\/([a-z0-9_]+)/i)?.[1]?.toLowerCase() ?? "sessions";
  if (query && commandName === "switch") {
    await switchAndReply(options, query);
    return true;
  }
  const remote = await listTargetPeerSessions({
    contextKey: options.contextKey,
    preferencesStore: options.preferencesStore,
    remoteClient: options.remoteClient,
    actor: options.actor,
    query,
    limit: 50,
  }).catch(async (error) => {
    await safeReply(options.ctx, `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`, {
      fallbackText: `Failed: ${friendlyErrorText(error)}`,
    });
    return null;
  });
  if (!remote) return true;
  if (remote.sessions.length === 0) {
    const message = query ? `No remote threads found matching "${query}".` : "No remote threads found.";
    await safeReply(options.ctx, escapeHTML(message), { fallbackText: message });
    return true;
  }
  options.pendingSessionPicks.set(options.contextKey, remote.sessions.map((session) => remoteSessionChoiceValue(remote.peerId, session.id)));
  const sessionButtons = remote.sessions.map((session, index) => ({
    label: formatSessionLabel({
      workspace: session.cwd,
      title: session.title || session.firstUserMessage || "",
      relativeTime: formatRelativeTime(session.updatedAt),
      model: session.model || undefined,
      isActive: session.id === remote.activeThreadId,
      isPinned: false,
    }),
    callbackData: `sess_${index}`,
  }));
  options.pendingSessionButtons.set(options.contextKey, sessionButtons);
  await safeReply(options.ctx, `<b>${escapeHTML(`Remote threads on ${remote.peerLabel} (${remote.sessions.length})`)}</b>:\nTap to switch.`, {
    fallbackText: `Remote threads on ${remote.peerLabel} (${remote.sessions.length}):\nTap to switch.`,
    replyMarkup: paginateKeyboard(sessionButtons, 0, "sess"),
  });
  return true;
}

export async function handleTargetPeerSessionCallback(options: {
  ctx: Context;
  bot: Bot<Context>;
  chatId: TelegramChatId;
  messageId?: number;
  contextKey: TelegramContextKey;
  threadChoice: string;
  preferencesStore: BotPreferencesStore;
  remoteClient: RemotePeerWebClient;
  actor: WebActivityActor;
  syncPeerMirror(contextKey: TelegramContextKey): void;
}): Promise<boolean> {
  const remoteChoice = parseRemoteSessionChoice(options.threadChoice);
  if (!remoteChoice) return false;
  options.preferencesStore.update(options.contextKey, { targetPeerId: remoteChoice.peerId });
  await options.ctx.answerCallbackQuery({ text: "Switching remote..." });
  await switchAndReply(options, remoteChoice.threadId, options.messageId);
  return true;
}

async function switchAndReply(options: {
  ctx: Context;
  bot?: Bot<Context>;
  chatId?: TelegramChatId;
  messageId?: number;
  contextKey: TelegramContextKey;
  preferencesStore: BotPreferencesStore;
  remoteClient: RemotePeerWebClient;
  actor: WebActivityActor;
  syncPeerMirror(contextKey: TelegramContextKey): void;
}, threadId: string, messageId?: number): Promise<void> {
  const editMessageId = messageId ?? options.messageId;
  const switched = await switchTargetPeerSession({
    contextKey: options.contextKey,
    preferencesStore: options.preferencesStore,
    remoteClient: options.remoteClient,
    actor: options.actor,
    threadId,
  }).catch(async (error) => {
    const errHtml = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
    const errPlain = `Failed: ${friendlyErrorText(error)}`;
    if (options.bot && options.chatId && editMessageId) {
      await safeEditMessage(options.bot, options.chatId, editMessageId, errHtml, { fallbackText: errPlain });
    } else {
      await safeReply(options.ctx, errHtml, { fallbackText: errPlain });
    }
    return null;
  });
  if (!switched) return;
  options.syncPeerMirror(options.contextKey);
  const plain = ["Switched remote session.", `Peer: ${switched.peerLabel}`, "", renderSessionInfoPlain(switched.info)].join("\n");
  const html = ["<b>Switched remote session.</b>", `<b>Peer:</b> <code>${escapeHTML(switched.peerLabel)}</code>`, "", renderSessionInfoHTML(switched.info)].join("\n");
  if (options.bot && options.chatId && editMessageId) {
    await safeEditMessage(options.bot, options.chatId, editMessageId, html, { fallbackText: plain });
  } else {
    await safeReply(options.ctx, html, { fallbackText: plain });
  }
}
