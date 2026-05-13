import type { Bot, Context } from "grammy";

import type { AuditEvent } from "./audit-log.js";
import { consumeRateLimit, resetRateLimit } from "./bot-rendering.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML } from "./format.js";
import { safeReply } from "./telegram-output.js";
import type { UserStore, AuthenticatedUser } from "./user-management.js";

interface RateLimitBucket {
  count: number;
  resetAt: number;
  blockedUntil?: number;
}

interface AccessCommandDeps {
  bot: Bot<Context>;
  userStore: UserStore;
  contextUsers: WeakMap<Context, AuthenticatedUser>;
  linkAttempts: Map<string, RateLimitBucket>;
  audit: (event: Omit<AuditEvent, "id" | "timestamp" | "channelId">) => void;
  getUserRole: (ctx: Context) => string;
}

export function registerTelegramAccessCommands(deps: AccessCommandDeps): void {
  const { bot, userStore, contextUsers, linkAttempts, audit, getUserRole } = deps;

  bot.command("link", async (ctx) => {
    if (ctx.chat?.type !== "private") {
      await safeReply(ctx, escapeHTML("Use /link in a private chat with the bot."), {
        fallbackText: "Use /link in a private chat with the bot.",
      });
      return;
    }
    const code = (ctx.message?.text ?? "").replace(/^\/link(?:@\w+)?\s*/i, "").trim();
    if (!code) {
      await safeReply(ctx, escapeHTML("Send /link <code> after creating a Telegram link code in the WebUI or CLI."), {
        fallbackText: "Send /link <code> after creating a Telegram link code in the WebUI or CLI.",
      });
      return;
    }
    if (!ctx.from?.id) {
      return;
    }
    const limitKey = String(ctx.from.id);
    const limited = consumeRateLimit(linkAttempts, limitKey, 5, 15 * 60 * 1000, 15 * 60 * 1000);
    if (limited.limited) {
      const seconds = Math.ceil((limited.retryAfterMs ?? 0) / 1000);
      audit({
        action: "auth_login_failed",
        status: "denied",
        contextKey: String(ctx.chat.id),
        actorId: ctx.from.id,
        description: "Telegram link rate limited",
        detail: `${seconds}s retry-after`,
      });
      await safeReply(ctx, escapeHTML(`Too many link attempts. Try again in ${seconds}s.`), {
        fallbackText: `Too many link attempts. Try again in ${seconds}s.`,
      });
      return;
    }
    try {
      const linked = userStore.consumeTelegramLinkCode(code, {
        telegramUserId: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
      });
      resetRateLimit(linkAttempts, limitKey);
      contextUsers.set(ctx, linked);
      audit({
        action: "telegram_linked",
        status: "ok",
        contextKey: String(ctx.chat.id),
        actorId: ctx.from.id,
        actorRole: linked.groups.map((group) => group.name).join(", "),
        description: `Linked ${linked.user.email}`,
      });
      await safeReply(ctx, escapeHTML(`Linked Telegram account to ${linked.user.email}.`), {
        fallbackText: `Linked Telegram account to ${linked.user.email}.`,
      });
    } catch (error) {
      const message = friendlyErrorText(error);
      audit({
        action: "auth_login_failed",
        status: "failed",
        contextKey: String(ctx.chat.id),
        actorId: ctx.from.id,
        description: "Telegram link failed",
        detail: message,
      });
      await safeReply(ctx, `<b>Link failed:</b> ${escapeHTML(message)}`, { fallbackText: `Link failed: ${message}` });
    }
  });

  bot.command("whoami", async (ctx) => {
    const authUser = contextUsers.get(ctx);
    if (!authUser) {
      await safeReply(ctx, escapeHTML("Not linked."), { fallbackText: "Not linked." });
      return;
    }
    const text = [
      `User: ${authUser.user.displayName} <${authUser.user.email}>`,
      `Groups: ${authUser.groups.map((group) => group.name).join(", ") || "-"}`,
      `Permissions: ${authUser.permissions.join(", ") || "-"}`,
    ].join("\n");
    await safeReply(ctx, `<b>User:</b> ${escapeHTML(authUser.user.displayName)}\n<b>Email:</b> <code>${escapeHTML(authUser.user.email)}</code>\n<b>Groups:</b> <code>${escapeHTML(authUser.groups.map((group) => group.name).join(", ") || "-")}</code>`, {
      fallbackText: text,
    });
  });

  bot.command("register_chat", async (ctx) => {
    const authUser = contextUsers.get(ctx);
    if (!authUser || !userStore.hasPermission(authUser, "users.write")) {
      await safeReply(ctx, escapeHTML("Access denied: users.write permission required."), {
        fallbackText: "Access denied: users.write permission required.",
      });
      return;
    }
    if (!ctx.chat?.id || ctx.chat.type === "private") {
      await safeReply(ctx, escapeHTML("Run /register_chat inside a Telegram group or supergroup."), {
        fallbackText: "Run /register_chat inside a Telegram group or supergroup.",
      });
      return;
    }
    const chat = userStore.registerTelegramChat({
      chatId: ctx.chat.id,
      title: "title" in ctx.chat ? ctx.chat.title : undefined,
      type: ctx.chat.type,
      enabled: true,
      allowedGroupIds: [],
    });
    audit({
      action: "telegram_chat_updated",
      status: "ok",
      contextKey: String(ctx.chat.id),
      actorId: ctx.from?.id,
      actorRole: getUserRole(ctx),
      description: `Registered Telegram chat ${chat.chatId}`,
    });
    await safeReply(ctx, escapeHTML(`Telegram chat enabled for NordRelay.\nChat ID: ${chat.chatId}`), {
      fallbackText: `Telegram chat enabled for NordRelay.\nChat ID: ${chat.chatId}`,
    });
  });
}
