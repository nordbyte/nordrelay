import type { Bot, Context } from "grammy";

import type { ConnectorConfig } from "../../core/config.js";
import { friendlyErrorText } from "../../core/error-messages.js";
import { escapeHTML } from "../../core/format.js";
import { getLastAgentMessageText, parseLastAgentMessageOptions } from "../shared/last-agent-message.js";
import { getTargetPeerLastAgentMessageText, type RemotePeerWebClient } from "../shared/channel-peer-sessions.js";
import { contextKeyFromCtx } from "../shared/context-key.js";
import type { GetTelegramContextSession } from "./telegram-command-types.js";
import { safeReply, sendTextMessage, splitMarkdownForTelegram } from "./telegram-output.js";
import type { BotPreferencesStore } from "../../state/bot-preferences.js";
import type { WebActivityActor } from "../../web/web-state.js";

export interface TelegramLastCommandOptions {
  bot: Bot<Context>;
  config: ConnectorConfig;
  getContextSession: GetTelegramContextSession;
  preferencesStore?: BotPreferencesStore;
  remoteClient?: RemotePeerWebClient;
  actor?: (ctx: Context) => WebActivityActor;
  canUsePeer?: (ctx: Context, peerId: string) => boolean;
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
    const lastOptions = parseLastAgentMessageOptions(argument);
    const contextKey = contextKeyFromCtx(ctx);
    if (contextKey && options.preferencesStore && options.remoteClient) {
      try {
        const remote = await getTargetPeerLastAgentMessageText({
          contextKey,
          preferencesStore: options.preferencesStore,
          remoteClient: options.remoteClient,
          actor: options.actor?.(ctx),
          canUsePeer: (peerId) => options.canUsePeer?.(ctx, peerId) ?? true,
          lastOptions,
        });
        if (remote) {
          if (!remote.ok) {
            await safeReply(ctx, escapeHTML(remote.text), { fallbackText: remote.text });
            return;
          }
          await sendLastAgentMessageChunks(options.bot, chatId, remote.text, message && "message_thread_id" in message ? message.message_thread_id : undefined);
          return;
        }
      } catch (error) {
        const errorText = `Remote /last failed: ${friendlyErrorText(error)}`;
        await safeReply(ctx, `<b>Failed:</b> ${escapeHTML(errorText)}`, { fallbackText: errorText });
        return;
      }
    }
    const result = getLastAgentMessageText(
      contextSession.session,
      options.config,
      lastOptions,
    );
    if (!result.ok) {
      await safeReply(ctx, escapeHTML(result.text), { fallbackText: result.text });
      return;
    }

    const messageThreadId = message && "message_thread_id" in message ? message.message_thread_id : undefined;
    await sendLastAgentMessageChunks(options.bot, chatId, result.text, messageThreadId);
  });
}

async function sendLastAgentMessageChunks(
  bot: Bot<Context>,
  chatId: number,
  text: string,
  messageThreadId?: number,
): Promise<void> {
  for (const chunk of splitMarkdownForTelegram(text)) {
    await sendTextMessage(bot.api, chatId, chunk.text, {
      parseMode: chunk.parseMode,
      fallbackText: chunk.fallbackText,
      messageThreadId,
    });
  }
}
