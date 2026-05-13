import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Bot, InlineKeyboard, type Context } from "grammy";

import { formatTelegramHTML } from "./format.js";
import { redactText } from "./redaction.js";
import { telegramRateLimiter } from "./telegram-rate-limit.js";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const FORMATTED_CHUNK_TARGET = 3000;
const MAX_AUDIO_FILE_SIZE = 25 * 1024 * 1024;

export type TelegramChatId = number | string;
export type TelegramParseMode = "HTML";

export interface TextOptions {
  parseMode?: TelegramParseMode;
  fallbackText?: string;
  replyMarkup?: InlineKeyboard;
  messageThreadId?: number;
}

export interface RenderedText {
  text: string;
  fallbackText: string;
  parseMode?: TelegramParseMode;
}

export type RenderedChunk = RenderedText & {
  sourceText: string;
};

export async function safeReply(ctx: Context, text: string, options: TextOptions = {}): Promise<void> {
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

export async function sendTextMessage(
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

export async function safeEditMessage(
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

export async function safeEditReplyMarkup(
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

export async function sendChatActionSafe(
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

export function chatBucket(chatId: TelegramChatId): string {
  return `chat:${String(chatId)}`;
}

export async function downloadTelegramFile(
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

export function splitMarkdownForTelegram(markdown: string): RenderedChunk[] {
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

export function renderMarkdownChunkWithinLimit(markdown: string): RenderedChunk {
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

export function isMessageNotModifiedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("message is not modified");
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
