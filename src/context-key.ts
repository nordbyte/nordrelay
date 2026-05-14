import type { Context } from "grammy";

export type TelegramContextKey = string;

export function contextKeyFromMessage(chatId: number, messageThreadId?: number): TelegramContextKey {
  if (messageThreadId !== undefined) {
    return `${chatId}:${messageThreadId}`;
  }
  return `${chatId}`;
}

export function contextKeyFromCtx(ctx: Context): TelegramContextKey | null {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    return null;
  }
  const threadId = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;
  return contextKeyFromMessage(chatId, threadId);
}

export function parseContextKey(key: TelegramContextKey): { chatId: number; messageThreadId?: number } {
  const parts = key.split(":");
  const chatId = Number(parts[0]);
  const messageThreadId = parts[1] ? Number(parts[1]) : undefined;
  return { chatId, messageThreadId };
}

export function isTopicContextKey(key: TelegramContextKey): boolean {
  return key.includes(":");
}

export function isTelegramContextKey(key: TelegramContextKey): boolean {
  const parts = key.split(":");
  if (parts.length < 1 || parts.length > 2) {
    return false;
  }

  const chatIdText = parts[0];
  if (!chatIdText || !/^-?\d+$/.test(chatIdText)) {
    return false;
  }

  const chatId = Number(chatIdText);
  if (!Number.isSafeInteger(chatId) || chatId === 0) {
    return false;
  }

  const threadIdText = parts[1];
  if (threadIdText === undefined) {
    return true;
  }

  if (!/^\d+$/.test(threadIdText)) {
    return false;
  }

  const threadId = Number(threadIdText);
  return Number.isSafeInteger(threadId) && threadId > 0;
}

export function discordContextKey(input: { guildId?: string | null; channelId: string; threadId?: string | null }): TelegramContextKey {
  const guildId = input.guildId || "dm";
  const topic = input.threadId && input.threadId !== input.channelId ? `:${input.threadId}` : "";
  return `discord:${guildId}:${input.channelId}${topic}`;
}

export function isDiscordContextKey(key: TelegramContextKey): boolean {
  return /^discord:[^:]+:[^:]+(?::[^:]+)?$/.test(key);
}

export function parseDiscordContextKey(key: TelegramContextKey): { guildId?: string; channelId: string; threadId?: string } | null {
  if (!isDiscordContextKey(key)) {
    return null;
  }
  const [, guild, channelId, threadId] = key.split(":");
  if (!channelId) {
    return null;
  }
  return {
    guildId: guild === "dm" ? undefined : guild,
    channelId,
    threadId,
  };
}
