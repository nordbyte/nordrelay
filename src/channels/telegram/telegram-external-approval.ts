import { Bot, type Context } from "grammy";

import type { ConnectorConfig } from "../../core/config.js";
import { escapeHTML } from "../../core/format.js";
import { respondToExternalApproval } from "../../agents/shared/agent-approval.js";
import type { AgentSessionService } from "../../agents/shared/agent.js";
import type { WebActivityEvent } from "../../web/web-state.js";
import { contextKeyFromCtx, type TelegramContextKey } from "../shared/context-key.js";
import { safeEditMessage } from "./telegram-output.js";

export function registerTelegramExternalApprovalCallbacks(options: {
  bot: Bot;
  config: ConnectorConfig;
  registry: { get(contextKey: string): AgentSessionService | undefined };
  appendActivity: (
    ctx: Context,
    contextKey: TelegramContextKey,
    session: AgentSessionService,
    input: Partial<Omit<WebActivityEvent, "id" | "timestamp" | "source" | "contextKey">> & Pick<WebActivityEvent, "status" | "type"> & { timestamp?: string },
  ) => WebActivityEvent;
}): void {
  options.bot.callbackQuery(/^external_approval_(yes|persist|no):([a-f0-9]+)$/, async (ctx) => {
    const action = ctx.match?.[1] as "yes" | "persist" | "no" | undefined;
    const approvalId = ctx.match?.[2];
    const contextKey = contextKeyFromCtx(ctx);
    if (!action || !approvalId) {
      await ctx.answerCallbackQuery();
      return;
    }
    if (!contextKey) {
      await ctx.answerCallbackQuery({ text: "No chat context." });
      return;
    }
    const session = options.registry.get(contextKey);
    if (!session) {
      await ctx.answerCallbackQuery({ text: "No session for this chat." });
      return;
    }
    const result = respondToExternalApproval(session, options.config, approvalId, action);
    await ctx.answerCallbackQuery({ text: result.message.slice(0, 200), show_alert: !result.ok });
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId && messageId) {
      const status = result.ok ? "Submitted" : "Failed";
      await safeEditMessage(options.bot, chatId, messageId, `${escapeHTML(ctx.callbackQuery.message?.text ?? "Action required")}\n\n<b>${escapeHTML(status)}:</b> ${escapeHTML(result.message)}`, {
        fallbackText: `${status}: ${result.message}`,
      });
    }
    options.appendActivity(ctx, contextKey, session, {
      status: result.ok ? "info" : "failed",
      type: "cli_action_required_response",
      detail: result.message,
    });
  });
}
