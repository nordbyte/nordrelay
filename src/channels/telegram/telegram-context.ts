import type { Bot, Context } from "grammy";

import type { UserStore } from "../../access/user-management.js";
import type { ChannelContext } from "../shared/channel-adapter.js";
import { parseContextKey, type TelegramContextKey } from "../shared/context-key.js";

export function telegramSystemContext(bot: Bot<Context>, contextKey: TelegramContextKey): Context {
  const parsed = parseContextKey(contextKey);
  return {
    api: bot.api,
    chat: { id: parsed.chatId, type: "private" },
    message: parsed.messageThreadId ? { message_thread_id: parsed.messageThreadId } : undefined,
  } as unknown as Context;
}

export function canSendSystemMessagesToTelegramContext(userStore: UserStore, contextKey: TelegramContextKey): boolean {
  if (!userStore.hasAdminUser()) {
    return false;
  }
  const parsed = parseContextKey(contextKey);
  if (parsed.chatId > 0) {
    return Boolean(userStore.resolveTelegramUser(parsed.chatId));
  }
  return userStore.snapshot().telegramChats.some((chat) => chat.chatId === parsed.chatId && chat.enabled);
}

export function telegramChannelContextFromKey(contextKey: TelegramContextKey): ChannelContext {
  const parsed = parseContextKey(contextKey);
  return {
    channelId: "telegram",
    chatId: String(parsed.chatId),
    ...(parsed.messageThreadId ? { topicId: String(parsed.messageThreadId) } : {}),
  };
}
