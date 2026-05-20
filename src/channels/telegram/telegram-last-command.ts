import type { Bot, Context } from "grammy";

import type { ConnectorConfig } from "../../core/config.js";
import { escapeHTML } from "../../core/format.js";
import { getLastAgentMessageText, parseLastAgentMessageOptions } from "../shared/last-agent-message.js";
import type { GetTelegramContextSession } from "./telegram-command-types.js";
import { safeReply, sendTextMessage, splitMarkdownForTelegram } from "./telegram-output.js";

export interface TelegramLastCommandOptions {
  bot: Bot<Context>;
  config: ConnectorConfig;
  getContextSession: GetTelegramContextSession;
}

export function registerTelegramLastCommand(options: TelegramLastCommandOptions): void {
  options.bot.command("last", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const message = ctx.message;
    const text = message && "text" in message ? String(message.text ?? "") : "";
    const argument = text.replace(/^\/last(?:@\w+)?\s*/i, "").trim();
    const result = getLastAgentMessageText(
      contextSession.session,
      options.config,
      parseLastAgentMessageOptions(argument),
    );
    if (!result.ok) {
      await safeReply(ctx, escapeHTML(result.text), { fallbackText: result.text });
      return;
    }

    const messageThreadId = message && "message_thread_id" in message ? message.message_thread_id : undefined;
    for (const chunk of splitMarkdownForTelegram(result.text)) {
      await sendTextMessage(options.bot.api, chatId, chunk.text, {
        parseMode: chunk.parseMode,
        fallbackText: chunk.fallbackText,
        messageThreadId,
      });
    }
  });
}
