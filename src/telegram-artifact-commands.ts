import { InlineKeyboard, type Bot, type Context } from "grammy";

import {
  getArtifactTurnReport,
  listRecentArtifactReports,
  removeArtifactTurn,
  type ArtifactTurnReport,
} from "./artifacts.js";
import {
  buildArtifactActionsKeyboard,
  filterArtifactReports,
} from "./bot-rendering.js";
import { renderArtifactReportsAction } from "./channel-actions.js";
import type { ConnectorConfig } from "./config.js";
import { escapeHTML } from "./format.js";
import { NOOP_PAGE_CALLBACK_DATA } from "./telegram-channel-runtime.js";
import type { GetTelegramContextSession } from "./telegram-command-types.js";
import {
  safeEditMessage,
  safeReply,
  type TelegramChatId,
} from "./telegram-output.js";
import type { WebActivityEvent } from "./web-state.js";

export interface TelegramArtifactCommandOptions {
  bot: Bot<Context>;
  config: ConnectorConfig;
  getContextSession: GetTelegramContextSession;
  deliverArtifactReport: (
    ctx: Context,
    chatId: TelegramChatId,
    report: ArtifactTurnReport,
    messageThreadId?: number,
  ) => Promise<void>;
  deliverArtifactReportZip: (
    ctx: Context,
    chatId: TelegramChatId,
    report: ArtifactTurnReport,
    messageThreadId?: number,
  ) => Promise<void>;
  appendActivity?: (
    ctx: Context,
    input: Partial<Omit<WebActivityEvent, "id" | "timestamp" | "source">> & Pick<WebActivityEvent, "status" | "type"> & { timestamp?: string },
  ) => void;
}

export function registerTelegramArtifactCommands(options: TelegramArtifactCommandOptions): void {
  const { bot, config } = options;

  bot.command("artifacts", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession || !ctx.chat) {
      return;
    }

    const workspace = contextSession.session.getInfo().workspace;
    const rawText = ctx.message?.text ?? "";
    const argument = rawText.replace(/^\/artifacts(?:@\w+)?\s*/i, "").trim();
    const reports = await listRecentArtifactReports(workspace, 10, config.maxFileSize);

    if (reports.length === 0) {
      await safeReply(ctx, escapeHTML("No generated artifacts found for this workspace."), {
        fallbackText: "No generated artifacts found for this workspace.",
      });
      return;
    }

    if (argument) {
      const parts = argument.split(/\s+/).filter(Boolean);
      if (parts[0]?.toLowerCase() === "delete" && parts[1]) {
        const selected = reports.find((report) => report.turnId === parts[1] || report.turnId.startsWith(parts[1]!));
        if (!selected) {
          await safeReply(ctx, escapeHTML(`No artifact turn found for "${parts[1]}".`), {
            fallbackText: `No artifact turn found for "${parts[1]}".`,
          });
          return;
        }
        const removed = await removeArtifactTurn(workspace, selected.turnId);
        const text = removed ? `Deleted artifact turn: ${selected.turnId}` : `Artifact turn not found: ${selected.turnId}`;
        await safeReply(ctx, escapeHTML(text), { fallbackText: text });
        if (removed) {
          options.appendActivity?.(ctx, {
            status: "info",
            type: "artifact_deleted",
            threadId: contextSession.session.getInfo().threadId,
            workspace,
            agentId: contextSession.session.getInfo().agentId,
            detail: selected.turnId,
          });
        }
        return;
      }

      const filtered = filterArtifactReports(reports, argument);
      if (filtered) {
        if (filtered.length === 0) {
          await safeReply(ctx, escapeHTML(`No artifacts matched "${argument}".`), {
            fallbackText: `No artifacts matched "${argument}".`,
          });
          return;
        }
        const rendered = renderArtifactReportsAction(filtered);
        await safeReply(ctx, rendered.html, {
          fallbackText: rendered.plain,
          replyMarkup: buildArtifactActionsKeyboard(filtered),
        });
        return;
      }

      const shouldZip = parts[0]?.toLowerCase() === "zip";
      const requestedTurn = shouldZip ? parts[1] : parts[0];
      const selected =
        !requestedTurn || requestedTurn.toLowerCase() === "latest"
          ? reports[0]
          : reports.find((report) => report.turnId === requestedTurn || report.turnId.startsWith(requestedTurn));

      if (!selected) {
        await safeReply(ctx, escapeHTML(`No artifact turn found for "${argument}".`), {
          fallbackText: `No artifact turn found for "${argument}".`,
        });
        return;
      }

      if (shouldZip) {
        options.appendActivity?.(ctx, {
          status: "info",
          type: "artifact_zip_sent",
          threadId: contextSession.session.getInfo().threadId,
          workspace,
          agentId: contextSession.session.getInfo().agentId,
          detail: selected.turnId,
        });
        await options.deliverArtifactReportZip(ctx, ctx.chat.id, selected, ctx.message?.message_thread_id);
      } else {
        options.appendActivity?.(ctx, {
          status: "info",
          type: "artifacts_sent",
          threadId: contextSession.session.getInfo().threadId,
          workspace,
          agentId: contextSession.session.getInfo().agentId,
          detail: selected.turnId,
        });
        await options.deliverArtifactReport(ctx, ctx.chat.id, selected, ctx.message?.message_thread_id);
      }
      return;
    }

    const { html, plain } = renderArtifactReportsAction(reports);
    await safeReply(ctx, html, {
      fallbackText: plain,
      replyMarkup: buildArtifactActionsKeyboard(reports),
    });
  });

  bot.callbackQuery(/^artifact_(send|zip|delete|delete_confirm):([a-zA-Z0-9._-]+)$/, async (ctx) => {
    const action = ctx.match?.[1];
    const turnId = ctx.match?.[2];
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!action || !turnId || !chatId) {
      await ctx.answerCallbackQuery();
      return;
    }

    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      await ctx.answerCallbackQuery({ text: "No context" });
      return;
    }

    const workspace = contextSession.session.getInfo().workspace;
    if (action === "delete") {
      await ctx.answerCallbackQuery({ text: "Confirm deletion" });
      const keyboard = new InlineKeyboard()
        .text("Delete artifacts", `artifact_delete_confirm:${turnId}`)
        .row()
        .text("Cancel", NOOP_PAGE_CALLBACK_DATA);
      const html = `<b>Delete artifact turn?</b>\n<code>${escapeHTML(turnId)}</code>`;
      const plain = `Delete artifact turn?\n${turnId}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain, replyMarkup: keyboard });
      } else {
        await safeReply(ctx, html, { fallbackText: plain, replyMarkup: keyboard });
      }
      return;
    }

    if (action === "delete_confirm") {
      const removed = await removeArtifactTurn(workspace, turnId);
      await ctx.answerCallbackQuery({ text: removed ? "Deleted" : "Already gone" });
      if (removed) {
        const info = contextSession.session.getInfo();
        options.appendActivity?.(ctx, {
          status: "info",
          type: "artifact_deleted",
          threadId: info.threadId,
          workspace,
          agentId: info.agentId,
          detail: turnId,
        });
      }
      const html = removed
        ? `<b>Deleted artifact turn:</b> <code>${escapeHTML(turnId)}</code>`
        : `<b>Artifact turn not found:</b> <code>${escapeHTML(turnId)}</code>`;
      const plain = removed ? `Deleted artifact turn: ${turnId}` : `Artifact turn not found: ${turnId}`;
      if (messageId) {
        await safeEditMessage(bot, chatId, messageId, html, { fallbackText: plain });
      } else {
        await safeReply(ctx, html, { fallbackText: plain });
      }
      return;
    }

    const report = await getArtifactTurnReport(workspace, turnId, config.maxFileSize);
    if (!report) {
      await ctx.answerCallbackQuery({ text: "Artifact turn not found" });
      return;
    }

    await ctx.answerCallbackQuery({ text: action === "zip" ? "Sending ZIP..." : "Sending artifacts..." });
    const info = contextSession.session.getInfo();
    options.appendActivity?.(ctx, {
      status: "info",
      type: action === "zip" ? "artifact_zip_sent" : "artifacts_sent",
      threadId: info.threadId,
      workspace,
      agentId: info.agentId,
      detail: turnId,
    });
    if (action === "zip") {
      await options.deliverArtifactReportZip(ctx, chatId, report, ctx.callbackQuery.message?.message_thread_id);
    } else {
      await options.deliverArtifactReport(ctx, chatId, report, ctx.callbackQuery.message?.message_thread_id);
    }
  });
}
