import { InlineKeyboard, type Bot, type Context } from "grammy";

import type { AgentPromptInput, AgentSessionService } from "./agent.js";
import type { AuditEvent } from "./audit-log.js";
import {
  renderQueueListAction,
  renderQueuedPromptDetailAction,
} from "./channel-actions.js";
import type { TelegramContextKey } from "./context-key.js";
import { contextKeyFromCtx } from "./context-key.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML } from "./format.js";
import { PromptStore, toPromptEnvelope, type PromptEnvelope, type QueuedPrompt } from "./prompt-store.js";
import { formatLocalDateTime } from "./bot-rendering.js";
import type { GetTelegramContextSession } from "./telegram-command-types.js";
import {
  safeEditMessage,
  safeReply,
  type TelegramChatId,
} from "./telegram-output.js";

type BusyReasonLike =
  | { busy: false; kind: string }
  | { busy: true; kind: "connector" | "external" | string };

type AuditContextWriter = (
  ctx: Context,
  contextKey: TelegramContextKey,
  session: AgentSessionService,
  patch: Omit<AuditEvent, "id" | "timestamp" | "channelId" | "contextKey" | "actorId" | "actorRole" | "agentId" | "threadId" | "workspace">,
) => void;

export interface TelegramQueueCommandOptions {
  bot: Bot<Context>;
  promptStore: PromptStore;
  getContextSession: GetTelegramContextSession;
  getBusyReason: (contextKey: TelegramContextKey) => BusyReasonLike;
  getSession: (contextKey: TelegramContextKey) => AgentSessionService | undefined;
  updateQueueStatusMessage: (contextKey: TelegramContextKey, text: string) => Promise<void>;
  scheduleExternalQueueDrain: (ctx: Context, contextKey: TelegramContextKey, chatId: TelegramChatId, session: AgentSessionService) => void;
  drainQueuedPrompts: (ctx: Context, contextKey: TelegramContextKey, chatId: TelegramChatId, session: AgentSessionService) => Promise<void>;
  handleUserPrompt: (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: TelegramChatId,
    session: AgentSessionService,
    prompt: AgentPromptInput | PromptEnvelope,
    options?: { fromQueue?: boolean; approved?: boolean },
  ) => Promise<void>;
  auditContext: AuditContextWriter;
}

export function queueCancelCallbackData(
  action: "cancel" | "remove" | "top" | "up" | "down" | "run",
  contextKey: TelegramContextKey,
  queueId: string,
): string {
  return `queue_${action}:${contextKey}:${queueId}`;
}

export function createQueuedPromptCancelKeyboard(
  contextKey: TelegramContextKey,
  queueId: string,
  label = "Cancel queued message",
): InlineKeyboard {
  return new InlineKeyboard().text(label, queueCancelCallbackData("cancel", contextKey, queueId));
}

export function renderQueueList(
  promptStore: PromptStore,
  contextKey: TelegramContextKey,
  queue: QueuedPrompt[],
): { plain: string; html: string; keyboard?: InlineKeyboard } {
  const paused = promptStore.isPaused(contextKey);
  const rendered = renderQueueListAction(queue, paused);
  if (queue.length === 0) {
    return rendered;
  }

  const keyboard = new InlineKeyboard();
  queue.forEach((item, index) => {
    keyboard
      .text(`Run ${index + 1}`, queueCancelCallbackData("run", contextKey, item.id))
      .text("Top", queueCancelCallbackData("top", contextKey, item.id))
      .text("Cancel", queueCancelCallbackData("remove", contextKey, item.id))
      .row();
    keyboard
      .text("Up", queueCancelCallbackData("up", contextKey, item.id))
      .text("Down", queueCancelCallbackData("down", contextKey, item.id))
      .row();
  });
  return { ...rendered, keyboard };
}

export function registerTelegramQueueCommands(options: TelegramQueueCommandOptions): void {
  const { bot, promptStore } = options;

  bot.command("queue", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const chatId = ctx.chat?.id;
    const { contextKey, session } = contextSession;
    const rawText = ctx.message?.text ?? "";
    const argument = rawText.replace(/^\/queue(?:@\w+)?\s*/i, "").trim();

    const laterMatch = argument.match(/^later\s+(\d+)(?:m|min|minutes?)?\s+([\s\S]+)$/i);
    if (laterMatch) {
      const minutes = Math.min(7 * 24 * 60, Math.max(1, Number(laterMatch[1])));
      const text = laterMatch[2]!.trim();
      const notBefore = Date.now() + minutes * 60 * 1000;
      const item = promptStore.enqueue(contextKey, toPromptEnvelope(text), { notBefore });
      const message = `Queued prompt ${item.id} for ${formatLocalDateTime(new Date(notBefore))}.`;
      await safeReply(ctx, escapeHTML(message), {
        fallbackText: message,
        replyMarkup: createQueuedPromptCancelKeyboard(contextKey, item.id),
      });
      options.auditContext(ctx, contextKey, session, {
        action: "prompt_queued",
        status: "ok",
        promptId: item.id,
        description: item.description,
        detail: "scheduled",
      });
      return;
    }

    const inspectMatch = argument.match(/^inspect\s+([a-z0-9]+)$/i);
    if (inspectMatch) {
      const item = promptStore.get(contextKey, inspectMatch[1]!);
      if (!item) {
        await safeReply(ctx, escapeHTML(`No queued prompt found with id ${inspectMatch[1]}.`), {
          fallbackText: `No queued prompt found with id ${inspectMatch[1]}.`,
        });
        return;
      }
      const rendered = renderQueuedPromptDetailAction(item);
      await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
      return;
    }

    if (/^pause$/i.test(argument)) {
      promptStore.pause(contextKey);
      const message = `Queue paused. ${promptStore.list(contextKey).length} queued.`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      await options.updateQueueStatusMessage(contextKey, message);
      return;
    }

    if (/^resume$/i.test(argument)) {
      promptStore.resume(contextKey);
      const message = `Queue resumed. ${promptStore.list(contextKey).length} queued.`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      if (chatId) {
        void options.drainQueuedPrompts(ctx, contextKey, chatId, session).catch((error) => {
          console.error("Failed to drain queue after resume:", error);
        });
      }
      return;
    }

    const moveMatch = argument.match(/^move\s+([a-z0-9]+)\s+(top|up|down)$/i);
    if (moveMatch) {
      const direction = moveMatch[2]!.toLowerCase();
      const item = direction === "top"
        ? promptStore.moveToTop(contextKey, moveMatch[1]!)
        : direction === "up"
          ? promptStore.moveUp(contextKey, moveMatch[1]!)
          : promptStore.moveDown(contextKey, moveMatch[1]!);
      if (!item) {
        await safeReply(ctx, escapeHTML(`No queued prompt found with id ${moveMatch[1]}.`), {
          fallbackText: `No queued prompt found with id ${moveMatch[1]}.`,
        });
        return;
      }
      const message = `Moved queued prompt ${item.id} ${direction}.`;
      await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      return;
    }

    const runMatch = argument.match(/^run\s+([a-z0-9]+)$/i);
    if (runMatch) {
      const item = promptStore.remove(contextKey, runMatch[1]!);
      if (!item) {
        await safeReply(ctx, escapeHTML(`No queued prompt found with id ${runMatch[1]}.`), {
          fallbackText: `No queued prompt found with id ${runMatch[1]}.`,
        });
        return;
      }

      promptStore.enqueueFront(contextKey, item);
      promptStore.resume(contextKey);
      if (!chatId) {
        return;
      }
      const busy = options.getBusyReason(contextKey);
      if (busy.busy) {
        const message = `Queued prompt ${item.id} moved to top and will run when the current task finishes.`;
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
        if (busy.kind === "external") {
          options.scheduleExternalQueueDrain(ctx, contextKey, chatId, session);
        }
        return;
      }

      const next = promptStore.dequeue(contextKey);
      if (next) {
        await options.handleUserPrompt(ctx, contextKey, chatId, session, next, { fromQueue: true });
      }
      return;
    }

    if (argument) {
      await safeReply(ctx, escapeHTML("Usage: /queue, /queue pause, /queue resume, /queue later <minutes> <prompt>, /queue inspect <id>, /queue move <id> top|up|down, /queue run <id>"), {
        fallbackText: "Usage: /queue, /queue pause, /queue resume, /queue later <minutes> <prompt>, /queue inspect <id>, /queue move <id> top|up|down, /queue run <id>",
      });
      return;
    }

    const queue = promptStore.list(contextKey);
    const rendered = renderQueueList(promptStore, contextKey, queue);
    await safeReply(ctx, rendered.html, {
      fallbackText: rendered.plain,
      replyMarkup: rendered.keyboard,
    });
  });

  bot.command("clearqueue", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const count = promptStore.clear(contextSession.contextKey);
    const message = `Cleared ${count} queued prompt${count === 1 ? "" : "s"}.`;
    await safeReply(ctx, escapeHTML(message), { fallbackText: message });
  });

  bot.command("cancel", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const rawText = ctx.message?.text ?? "";
    const id = rawText.replace(/^\/cancel(?:@\w+)?\s*/i, "").trim();
    if (!id) {
      await safeReply(ctx, escapeHTML("Usage: /cancel <queue-id>"), {
        fallbackText: "Usage: /cancel <queue-id>",
      });
      return;
    }

    const removed = promptStore.remove(contextSession.contextKey, id);
    if (!removed) {
      await safeReply(ctx, escapeHTML(`No queued prompt found with id ${id}.`), {
        fallbackText: `No queued prompt found with id ${id}.`,
      });
      return;
    }

    await safeReply(ctx, escapeHTML(`Cancelled queued prompt ${removed.id}.`), {
      fallbackText: `Cancelled queued prompt ${removed.id}.`,
    });
  });

  bot.callbackQuery(/^queue_(cancel|remove|top|up|down|run):(-?\d+(?::\d+)?):([a-z0-9]+)$/, async (ctx) => {
    const action = ctx.match?.[1] as "cancel" | "remove" | "top" | "up" | "down" | "run" | undefined;
    const contextKey = ctx.match?.[2];
    const queueId = ctx.match?.[3];
    if (!action || !contextKey || !queueId) {
      await ctx.answerCallbackQuery();
      return;
    }

    const currentContextKey = contextKeyFromCtx(ctx);
    if (currentContextKey && currentContextKey !== contextKey) {
      await ctx.answerCallbackQuery({ text: "This queue button belongs to another chat or topic." });
      return;
    }

    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;

    if (action === "top" || action === "up" || action === "down") {
      const item = action === "top"
        ? promptStore.moveToTop(contextKey, queueId)
        : action === "up"
          ? promptStore.moveUp(contextKey, queueId)
          : promptStore.moveDown(contextKey, queueId);
      await ctx.answerCallbackQuery({ text: item ? `Moved ${queueId} ${action}.` : "Queued prompt not found." });
      if (chatId && messageId) {
        const rendered = renderQueueList(promptStore, contextKey, promptStore.list(contextKey));
        await safeEditMessage(bot, chatId, messageId, rendered.html, {
          fallbackText: rendered.plain,
          replyMarkup: rendered.keyboard,
        });
      }
      return;
    }

    if (action === "run") {
      const item = promptStore.remove(contextKey, queueId);
      if (!item) {
        await ctx.answerCallbackQuery({ text: "Queued prompt already started or was cancelled." });
        return;
      }
      promptStore.enqueueFront(contextKey, item);
      promptStore.resume(contextKey);
      await ctx.answerCallbackQuery({ text: `Queued prompt ${queueId} moved to next.` });
      if (chatId && messageId) {
        const rendered = renderQueueList(promptStore, contextKey, promptStore.list(contextKey));
        await safeEditMessage(bot, chatId, messageId, rendered.html, {
          fallbackText: rendered.plain,
          replyMarkup: rendered.keyboard,
        });
      }
      const session = options.getSession(contextKey);
      if (chatId && session && !options.getBusyReason(contextKey).busy) {
        void options.drainQueuedPrompts(ctx, contextKey, chatId, session).catch((error) => {
          console.error("Failed to drain queue after run-now callback:", error);
        });
      }
      return;
    }

    const removed = promptStore.remove(contextKey, queueId);

    if (!removed) {
      await ctx.answerCallbackQuery({ text: "Queued prompt already started or was cancelled." });
      if (chatId && messageId) {
        if (action === "remove") {
          const rendered = renderQueueList(promptStore, contextKey, promptStore.list(contextKey));
          await safeEditMessage(bot, chatId, messageId, rendered.html, {
            fallbackText: rendered.plain,
            replyMarkup: rendered.keyboard,
          });
        } else {
          const message = `Queued prompt ${queueId} is no longer queued.`;
          await safeEditMessage(bot, chatId, messageId, escapeHTML(message), { fallbackText: message });
        }
      }
      return;
    }

    const message = `Cancelled queued prompt ${removed.id}.`;
    await ctx.answerCallbackQuery({ text: message });
    if (!chatId || !messageId) {
      return;
    }

    if (action === "remove") {
      const rendered = renderQueueList(promptStore, contextKey, promptStore.list(contextKey));
      await safeEditMessage(bot, chatId, messageId, rendered.html, {
        fallbackText: rendered.plain,
        replyMarkup: rendered.keyboard,
      });
      return;
    }

    await safeEditMessage(bot, chatId, messageId, escapeHTML(message), { fallbackText: message });
  });
}
