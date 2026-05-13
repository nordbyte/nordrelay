import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";

import type { ChannelActionButton } from "./channel-actions.js";
import {
  TelegramChannelAdapter,
  type ChannelContext,
  type ChannelOutboundFile,
  type ChannelOutboundMessage,
  type ChannelOutboundResult,
  type ChannelRuntime,
} from "./channel-adapter.js";
import { redactText } from "./redaction.js";
import { telegramRateLimiter } from "./telegram-rate-limit.js";
import {
  chatBucket,
  safeEditMessage,
  sendChatActionSafe,
  sendTextMessage,
  type TelegramChatId,
  type TelegramParseMode,
} from "./telegram-output.js";

const KEYBOARD_PAGE_SIZE = 6;

export const NOOP_PAGE_CALLBACK_DATA = "noop_page";

export type KeyboardItem = { label: string; callbackData: string };

export function paginateKeyboard(items: KeyboardItem[], page: number, prefix: string): InlineKeyboard {
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

export function actionKeyboard(rows: ChannelActionButton[][] | undefined): InlineKeyboard | undefined {
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

export function telegramActionData(action: string): string {
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

export class TelegramBotChannelRuntime implements ChannelRuntime {
  readonly id = "telegram" as const;
  readonly label = "Telegram";
  readonly capabilities = new TelegramChannelAdapter().capabilities;

  constructor(private readonly bot: Bot<Context>) {}

  describe() {
    return new TelegramChannelAdapter().describe();
  }

  async sendMessage(context: ChannelContext, message: ChannelOutboundMessage): Promise<ChannelOutboundResult> {
    const sent = await sendTextMessage(this.bot.api, telegramChatIdFromChannelContext(context), message.text, {
      parseMode: telegramParseMode(message.parseMode),
      fallbackText: message.fallbackText,
      replyMarkup: actionKeyboard(message.buttons),
      messageThreadId: telegramThreadIdFromChannelContext(context, message.threadId),
    });
    return { messageId: String(sent.message_id) };
  }

  async editMessage(context: ChannelContext, messageId: string, message: ChannelOutboundMessage): Promise<void> {
    const parsedMessageId = Number.parseInt(messageId, 10);
    if (!Number.isFinite(parsedMessageId)) {
      throw new Error(`Invalid Telegram message id: ${messageId}`);
    }
    await safeEditMessage(this.bot, telegramChatIdFromChannelContext(context), parsedMessageId, message.text, {
      parseMode: telegramParseMode(message.parseMode),
      fallbackText: message.fallbackText,
      replyMarkup: actionKeyboard(message.buttons),
    });
  }

  async sendTyping(context: ChannelContext): Promise<void> {
    await sendChatActionSafe(
      this.bot.api,
      telegramChatIdFromChannelContext(context),
      "typing",
      telegramThreadIdFromChannelContext(context),
    );
  }

  async sendFile(context: ChannelContext, file: ChannelOutboundFile): Promise<ChannelOutboundResult> {
    const chatId = telegramChatIdFromChannelContext(context);
    const sent = await telegramRateLimiter.run(chatBucket(chatId), "sendDocument", () =>
      this.bot.api.sendDocument(chatId, new InputFile(file.localPath, file.name), {
        caption: file.caption ? redactText(file.caption) : undefined,
        message_thread_id: telegramThreadIdFromChannelContext(context, file.threadId),
      })
    );
    return { messageId: String(sent.message_id) };
  }
}

export function telegramChannelContextFromCtx(ctx: Context): ChannelContext | null {
  if (!ctx.chat?.id) {
    return null;
  }
  const topicId = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;
  return {
    channelId: "telegram",
    chatId: String(ctx.chat.id),
    ...(topicId ? { topicId: String(topicId) } : {}),
    ...(ctx.from?.id ? { userId: String(ctx.from.id) } : {}),
    ...(ctx.from?.username ? { username: ctx.from.username } : {}),
  };
}

export function telegramChatIdFromChannelContext(context: ChannelContext): TelegramChatId {
  const numeric = Number(context.chatId);
  return Number.isSafeInteger(numeric) ? numeric : context.chatId;
}

export function telegramThreadIdFromChannelContext(context: ChannelContext, override?: string): number | undefined {
  const value = override ?? context.topicId;
  if (!value) {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : undefined;
}

export function telegramParseMode(parseMode: ChannelOutboundMessage["parseMode"]): TelegramParseMode | undefined {
  return parseMode === "html" ? "HTML" : undefined;
}
