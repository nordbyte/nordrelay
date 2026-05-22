import { InlineKeyboard, type Bot, type Context } from "grammy";

import {
  agentLabel,
  type AgentId,
  type AgentSessionInfo,
} from "../../agents/shared/agent.js";
import { enabledAgents } from "../../agents/shared/agent-factory.js";
import {
  capabilitiesOf,
  idOf,
  labelOf,
} from "../shared/bot-rendering.js";
import { withSelectedNodeHeader } from "../shared/channel-node-context.js";
import type { ChannelActionResponse } from "../shared/channel-actions.js";
import { checkAuthStatus } from "../../agents/codex/codex-auth.js";
import type { ConnectorConfig } from "../../core/config.js";
import { contextKeyFromCtx, type TelegramContextKey } from "../shared/context-key.js";
import { friendlyErrorText } from "../../core/error-messages.js";
import { escapeHTML } from "../../core/format.js";
import { redactText } from "../../core/redaction.js";
import {
  renderSessionInfoHTML,
  renderSessionInfoPlain,
} from "../shared/session-format.js";
import type { SessionRegistry } from "../../state/session-registry.js";
import type { GetTelegramContextSession } from "./telegram-command-types.js";
import {
  safeEditMessage,
  safeReply,
} from "./telegram-output.js";
import type { WebActivityEvent } from "../../web/web-state.js";

export interface TelegramAgentCommandOptions {
  bot: Bot<Context>;
  config: ConnectorConfig;
  registry: SessionRegistry;
  pendingAgentPicks: Map<TelegramContextKey, AgentId[]>;
  getContextSession: GetTelegramContextSession;
  isBusy: (contextKey: TelegramContextKey) => boolean;
  checkAgentAuthStatus: (info: AgentSessionInfo) => Promise<{ authenticated: boolean; method: string; detail: string }>;
  checkLoginAuthStatus: (info?: AgentSessionInfo) => Promise<{ authenticated: boolean; method: string; detail: string }>;
  agentIdForAuth: (info?: AgentSessionInfo) => AgentId;
  labelForAuth: (info?: AgentSessionInfo) => string;
  startAgentLogin: (info?: AgentSessionInfo) => Promise<{ success: boolean; message: string }>;
  startAgentLogout: (info?: AgentSessionInfo) => Promise<{ success: boolean; message: string }>;
  hostLoginCommand: (info?: AgentSessionInfo) => string;
  hostLogoutCommand: (info?: AgentSessionInfo) => string;
  selectedNodeLabel?: (contextKey: TelegramContextKey) => string;
  appendActivity?: (
    ctx: Context,
    input: Partial<Omit<WebActivityEvent, "id" | "timestamp" | "source">> & Pick<WebActivityEvent, "status" | "type"> & { timestamp?: string },
  ) => void;
}

export function registerTelegramAgentCommands(options: TelegramAgentCommandOptions): void {
  options.bot.command("agent", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    if (options.isBusy(contextKey)) {
      await safeReply(ctx, escapeHTML("Cannot switch agent while a prompt is running."), {
        fallbackText: "Cannot switch agent while a prompt is running.",
      });
      return;
    }

    const availableAgents = enabledAgents(options.config);
    const currentAgent = idOf(session.getInfo());
    if (availableAgents.length <= 1) {
      const only = agentLabel(availableAgents[0] ?? currentAgent);
      const reply = withNodeHeader(options, contextKey, {
        html: `<b>Current agent:</b> <code>${escapeHTML(only)}</code>\nNo other agents are enabled.`,
        plain: `Current agent: ${only}\nNo other agents are enabled.`,
      });
      await safeReply(ctx, reply.html, {
        fallbackText: reply.plain,
      });
      return;
    }

    options.pendingAgentPicks.set(contextKey, availableAgents);
    const keyboard = new InlineKeyboard();
    for (const availableAgent of availableAgents) {
      keyboard.text(`${agentLabel(availableAgent)}${availableAgent === currentAgent ? " ✓" : ""}`, `agent_${availableAgent}`).row();
    }

    const reply = withNodeHeader(options, contextKey, {
      html: `<b>Current agent:</b> <code>${escapeHTML(agentLabel(currentAgent))}</code>\nSelect agent for this Telegram context:`,
      plain: `Current agent: ${agentLabel(currentAgent)}\nSelect agent for this Telegram context:`,
    });
    await safeReply(ctx, reply.html, {
      fallbackText: reply.plain,
      replyMarkup: keyboard,
    });
  });

  options.bot.command("auth", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    const info = contextSession?.session.getInfo();
    if (info && !capabilitiesOf(info).auth) {
      const text = `${labelOf(info)} uses its local CLI authentication. Run its login flow on the host if needed.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    const authStatus = info ? await options.checkAgentAuthStatus(info) : await checkAuthStatus(options.config.codexApiKey);
    const icon = authStatus.authenticated ? "✅" : "❌";
    const html = [
      `<b>${icon} Auth status:</b> ${authStatus.authenticated ? "authenticated" : "not authenticated"}`,
      `<b>Method:</b> <code>${escapeHTML(authStatus.method)}</code>`,
      `<b>Detail:</b> <code>${escapeHTML(authStatus.detail)}</code>`,
    ].join("\n");
    const plain = [
      `${icon} Auth status: ${authStatus.authenticated ? "authenticated" : "not authenticated"}`,
      `Method: ${authStatus.method}`,
      `Detail: ${authStatus.detail}`,
    ].join("\n");

    await safeReply(ctx, html, { fallbackText: plain });
  });

  options.bot.command("login", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    const info = contextSession?.session.getInfo();
    if (info && !capabilitiesOf(info).login) {
      const text = `${labelOf(info)} login is not managed by NordRelay. Run the CLI login flow on the host.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    const authStatus = await options.checkLoginAuthStatus(info);
    if (options.agentIdForAuth(info) !== "hermes" && authStatus.authenticated) {
      await safeReply(ctx, `<b>✅ Already authenticated</b> via <code>${escapeHTML(authStatus.method)}</code>.`, {
        fallbackText: `✅ Already authenticated via ${authStatus.method}.`,
      });
      return;
    }

    if (!options.config.enableTelegramLogin) {
      await safeReply(
        ctx,
        [
          "<b>Telegram-initiated login is disabled.</b>",
          "",
          `Run <code>${escapeHTML(options.hostLoginCommand(info))}</code> on the host.`,
        ].join("\n"),
        {
          fallbackText: [
            "Telegram-initiated login is disabled.",
            "",
            `Run '${options.hostLoginCommand(info)}' on the host.`,
          ].join("\n"),
        },
      );
      return;
    }

    const result = await options.startAgentLogin(info);
    options.appendActivity?.(ctx, {
      status: result.success ? "info" : "failed",
      type: result.success ? "login_started" : "login_failed",
      threadId: info?.threadId ?? null,
      workspace: info?.workspace,
      agentId: options.agentIdForAuth(info),
      detail: redactText(result.message),
    });
    if (result.success) {
      await safeReply(ctx, `<b>🔑 Login initiated.</b>\n\n<code>${escapeHTML(redactText(result.message))}</code>`, {
        fallbackText: `🔑 Login initiated.\n\n${redactText(result.message)}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ Login failed.</b>\n\n<code>${escapeHTML(redactText(result.message))}</code>`, {
      fallbackText: `❌ Login failed.\n\n${redactText(result.message)}`,
    });
  });

  options.bot.command("logout", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    const info = contextSession?.session.getInfo();
    if (info && !capabilitiesOf(info).logout) {
      const text = `${labelOf(info)} logout is not managed by NordRelay. Run the CLI logout flow on the host.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    const authStatus = await options.checkLoginAuthStatus(info);
    if (authStatus.method === "api-key") {
      await safeReply(
        ctx,
        [
          `<b>Cannot logout via Telegram when ${escapeHTML(options.labelForAuth(info))} uses API-key authentication.</b>`,
          "",
          "Remove the API key from .env to use CLI-based auth instead.",
        ].join("\n"),
        {
          fallbackText: [
            `Cannot logout via Telegram when ${options.labelForAuth(info)} uses API-key authentication.`,
            "",
            "Remove the API key from .env to use CLI-based auth instead.",
          ].join("\n"),
        },
      );
      return;
    }

    if (!options.config.enableTelegramLogin) {
      await safeReply(ctx, [
        "<b>Telegram-initiated auth management is disabled.</b>",
        "",
        `Run <code>${escapeHTML(options.hostLogoutCommand(info))}</code> on the host.`,
      ].join("\n"), {
        fallbackText: [
          "Telegram-initiated auth management is disabled.",
          "",
          `Run '${options.hostLogoutCommand(info)}' on the host.`,
        ].join("\n"),
      });
      return;
    }

    if (options.agentIdForAuth(info) !== "hermes" && !authStatus.authenticated) {
      await safeReply(ctx, escapeHTML("Not currently authenticated."), {
        fallbackText: "Not currently authenticated.",
      });
      return;
    }

    const result = await options.startAgentLogout(info);
    options.appendActivity?.(ctx, {
      status: result.success ? "info" : "failed",
      type: result.success ? "logout_completed" : "logout_failed",
      threadId: info?.threadId ?? null,
      workspace: info?.workspace,
      agentId: options.agentIdForAuth(info),
      detail: redactText(result.message),
    });
    if (result.success) {
      await safeReply(ctx, `<b>🔓 Logged out.</b>\n\n${escapeHTML(redactText(result.message))}`, {
        fallbackText: `🔓 Logged out.\n\n${redactText(result.message)}`,
      });
      return;
    }

    await safeReply(ctx, `<b>❌ Logout failed.</b>\n\n<code>${escapeHTML(redactText(result.message))}</code>`, {
      fallbackText: `❌ Logout failed.\n\n${redactText(result.message)}`,
    });
  });

  options.bot.callbackQuery(/^agent_(codex|pi|hermes|openclaw|claude-code)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    const selectedAgent = ctx.match?.[1] as AgentId | undefined;
    const contextKey = contextKeyFromCtx(ctx);
    if (!chatId || !contextKey || !selectedAgent) {
      await ctx.answerCallbackQuery();
      return;
    }

    const picks = options.pendingAgentPicks.get(contextKey);
    if (!picks?.includes(selectedAgent)) {
      await ctx.answerCallbackQuery({ text: "Expired, run /agent again" });
      return;
    }
    if (options.isBusy(contextKey)) {
      await ctx.answerCallbackQuery({ text: "Wait for the current prompt to finish" });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Switching to ${agentLabel(selectedAgent)}...` });
    options.pendingAgentPicks.delete(contextKey);
    try {
      const session = await options.registry.switchAgent(contextKey, selectedAgent);
      const info = session.getInfo();
      options.appendActivity?.(ctx, {
        status: "info",
        type: "agent_switch",
        contextKey,
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        detail: labelOf(info),
      });
      const response = withNodeHeader(options, contextKey, {
        html: [`<b>Agent switched to ${escapeHTML(labelOf(info))}.</b>`, "", renderSessionInfoHTML(info)].join("\n"),
        plain: [`Agent switched to ${labelOf(info)}.`, "", renderSessionInfoPlain(info)].join("\n"),
      });
      if (messageId) {
        await safeEditMessage(options.bot, chatId, messageId, response.html, { fallbackText: response.plain });
      } else {
        await safeReply(ctx, response.html, { fallbackText: response.plain });
      }
    } catch (error) {
      const html = `<b>Failed:</b> ${escapeHTML(friendlyErrorText(error))}`;
      const plain = `Failed: ${friendlyErrorText(error)}`;
      if (messageId) {
        await safeEditMessage(options.bot, chatId, messageId, html, { fallbackText: plain });
      } else {
        await safeReply(ctx, html, { fallbackText: plain });
      }
    }
  });
}

function withNodeHeader(
  options: Pick<TelegramAgentCommandOptions, "selectedNodeLabel">,
  contextKey: TelegramContextKey,
  response: ChannelActionResponse,
): ChannelActionResponse {
  const label = options.selectedNodeLabel?.(contextKey);
  return label ? withSelectedNodeHeader(response, label) : response;
}
