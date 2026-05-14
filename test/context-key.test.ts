import type { Context } from "grammy";

import {
  contextKeyFromCtx,
  contextKeyFromMessage,
  discordContextKey,
  isDiscordContextKey,
  isTelegramContextKey,
  isTopicContextKey,
  parseContextKey,
  parseDiscordContextKey,
} from "../src/context-key.js";

describe("context-key", () => {
  it("uses only chat id for private chats", () => {
    expect(contextKeyFromMessage(12345)).toBe("12345");
  });

  it("uses only chat id for groups without topics", () => {
    expect(contextKeyFromMessage(67890)).toBe("67890");
  });

  it("uses chat id plus thread id for forum topics", () => {
    expect(contextKeyFromMessage(67890, 42)).toBe("67890:42");
  });

  it("derives the key from a grammy context", () => {
    const ctx = {
      chat: { id: 67890 },
      message: { message_thread_id: 42 },
    } as unknown as Context;

    expect(contextKeyFromCtx(ctx)).toBe("67890:42");
  });

  it("extracts context key from callback query message_thread_id", () => {
    const ctx = {
      chat: { id: 67890 },
      message: undefined,
      callbackQuery: { message: { message_thread_id: 99 } },
    } as unknown as Context;

    expect(contextKeyFromCtx(ctx)).toBe("67890:99");
  });

  it("returns null when chat is undefined", () => {
    const ctx = {
      chat: undefined,
      message: undefined,
      callbackQuery: undefined,
    } as unknown as Context;

    expect(contextKeyFromCtx(ctx)).toBeNull();
  });

  it("parses and round-trips context keys", () => {
    const key = contextKeyFromMessage(67890, 42);

    expect(parseContextKey(key)).toEqual({ chatId: 67890, messageThreadId: 42 });
    expect(contextKeyFromMessage(parseContextKey(key).chatId, parseContextKey(key).messageThreadId)).toBe(key);
  });

  it("identifies topic context keys", () => {
    expect(isTopicContextKey("67890:42")).toBe(true);
    expect(isTopicContextKey("12345")).toBe(false);
  });

  it("identifies only real Telegram context keys", () => {
    expect(isTelegramContextKey("12345")).toBe(true);
    expect(isTelegramContextKey("-1003929308812")).toBe(true);
    expect(isTelegramContextKey("-1003929308812:2")).toBe(true);
    expect(isTelegramContextKey("0")).toBe(false);
    expect(isTelegramContextKey("web:dashboard")).toBe(false);
    expect(isTelegramContextKey("123:dashboard")).toBe(false);
    expect(isTelegramContextKey("123:0")).toBe(false);
  });

  it("parses Discord guild, channel, and thread context keys", () => {
    const key = discordContextKey({ guildId: "guild-1", channelId: "channel-1", threadId: "thread-1" });

    expect(key).toBe("discord:guild-1:channel-1:thread-1");
    expect(isDiscordContextKey(key)).toBe(true);
    expect(parseDiscordContextKey(key)).toEqual({
      guildId: "guild-1",
      channelId: "channel-1",
      threadId: "thread-1",
    });
    expect(isTelegramContextKey(key)).toBe(false);
  });
});
