import type { Context, MiddlewareFn } from "grammy";

import { permissionForCallbackData, permissionForCommand, type Permission } from "./access-control.js";
import type { AuditEvent } from "./audit-log.js";
import { extractCommandName } from "./bot-rendering.js";
import { escapeHTML } from "./format.js";
import { safeReply } from "./telegram-output.js";
import { UserStore, type AuthenticatedUser } from "./user-management.js";

type AuditWriter = (event: Omit<AuditEvent, "id" | "timestamp" | "channelId">) => void;

interface TelegramAccessMiddlewareOptions {
  userStore: UserStore;
  contextUsers: WeakMap<Context, AuthenticatedUser>;
  audit: AuditWriter;
}

export function createTelegramAccessMiddleware(options: TelegramAccessMiddlewareOptions): MiddlewareFn<Context> {
  const { userStore, contextUsers, audit } = options;

  return async (ctx, next) => {
    const fromId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;
    const commandName = ctx.message?.text?.startsWith("/") ? extractCommandName(ctx.message.text) : undefined;

    if (commandName === "link") {
      await next();
      return;
    }

    if (!userStore.hasAdminUser()) {
      const message = "NordRelay has no admin user yet. Run `nordrelay user create-admin` on the host.";
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "No admin user configured" }).catch(() => {});
      } else if (ctx.chat) {
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      }
      return;
    }

    const authUser = userStore.resolveTelegramUser(fromId);
    if (!authUser) {
      const message = "Unauthorized. Link this Telegram account to a NordRelay user first.";
      audit({
        action: "permission_denied",
        status: "denied",
        contextKey: typeof chatId === "number" ? String(chatId) : "telegram",
        actor: telegramAuditActor(ctx),
        actorId: fromId,
        description: "Telegram account is not linked",
      });
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Unauthorized" }).catch(() => {});
      } else if (ctx.chat?.type === "private") {
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      }
      return;
    }
    contextUsers.set(ctx, authUser);

    const chatAllowed = userStore.isTelegramChatAllowed(typeof chatId === "number" ? chatId : undefined, chatType, authUser);
    if (!chatAllowed && commandName !== "register_chat") {
      const message = "This Telegram chat is not enabled for NordRelay. An admin can run /register_chat in this chat.";
      audit({
        action: "permission_denied",
        status: "denied",
        contextKey: typeof chatId === "number" ? String(chatId) : "telegram",
        actor: telegramAuditActor(ctx, authUser),
        actorId: authUser.user.id,
        actorRole: getUserRole(contextUsers, ctx),
        description: "Telegram chat is not enabled or outside user scope",
      });
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Chat not enabled" }).catch(() => {});
      } else if (ctx.chat?.type === "private") {
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      }
      return;
    }

    const permission = getRequiredPermission(ctx);
    if (!permission) {
      const message = "Unsupported command or action.";
      audit({
        action: "permission_denied",
        status: "denied",
        contextKey: typeof chatId === "number" ? String(chatId) : "telegram",
        actor: telegramAuditActor(ctx, authUser),
        actorId: authUser.user.id,
        actorRole: getUserRole(contextUsers, ctx),
        description: commandName ? `Unsupported command /${commandName}` : "Unsupported callback",
      });
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: message }).catch(() => {});
      } else {
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      }
      return;
    }

    if (!userStore.hasPermission(authUser, permission)) {
      const message = `Access denied: ${permission} permission required.`;
      audit({
        action: "permission_denied",
        status: "denied",
        contextKey: typeof chatId === "number" ? String(chatId) : "telegram",
        actor: telegramAuditActor(ctx, authUser),
        actorId: authUser.user.id,
        actorRole: getUserRole(contextUsers, ctx),
        description: `${permission} required`,
      });
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: message }).catch(() => {});
      } else {
        await safeReply(ctx, escapeHTML(message), { fallbackText: message });
      }
      return;
    }

    await next();
  };
}

function telegramAuditActor(ctx: Context, authUser?: AuthenticatedUser) {
  return {
    channel: "telegram" as const,
    id: authUser?.user.id ?? (ctx.from?.id !== undefined ? `telegram:${ctx.from.id}` : undefined),
    label: authUser?.user.displayName || authUser?.user.email || ctx.from?.username || (ctx.from?.id !== undefined ? String(ctx.from.id) : undefined),
    username: authUser?.user.email ?? ctx.from?.username,
    channelUserId: ctx.from?.id !== undefined ? String(ctx.from.id) : undefined,
  };
}

function getUserRole(contextUsers: WeakMap<Context, AuthenticatedUser>, ctx: Context): string {
  const authUser = contextUsers.get(ctx);
  return authUser?.groups.map((group) => group.name).join(", ") || "unauthenticated";
}

function getRequiredPermission(ctx: Context): Permission | null {
  if (ctx.callbackQuery?.data) {
    return permissionForCallbackData(ctx.callbackQuery.data);
  }

  if (ctx.message?.voice || ctx.message?.audio || ctx.message?.photo || ctx.message?.document) {
    return "files.write";
  }
  const text = ctx.message?.text?.trim();
  if (!text) {
    return "inspect";
  }
  if (!text.startsWith("/")) {
    return "prompt.send";
  }

  const command = extractCommandName(text);
  if (command === "queue") {
    const argument = text.replace(/^\/queue(?:@\w+)?\s*/i, "").trim();
    return argument ? "queue.write" : "queue.read";
  }
  return permissionForCommand(command);
}
