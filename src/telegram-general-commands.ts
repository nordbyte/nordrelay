import type { Bot, Context } from "grammy";

import { listAgentAdapterDescriptors } from "./agent-adapter.js";
import type { AgentSessionInfo } from "./agent.js";
import { enabledAgents } from "./agent-factory.js";
import {
  renderWelcomeFirstTime,
  renderWelcomeReturning,
  renderHelpMessage,
} from "./bot-ui.js";
import {
  authHelpText,
  capabilitiesOf,
  labelOf,
} from "./bot-rendering.js";
import {
  renderAgentsAction,
  renderChannelsAction,
  type ChannelActionResponse,
} from "./channel-actions.js";
import { listChannelDescriptors } from "./channel-adapter.js";
import type { ConnectorConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";
import { escapeHTML } from "./format.js";
import { spawnConnectorRestart } from "./operations.js";
import {
  renderLaunchSummaryHTML,
  renderLaunchSummaryPlain,
  renderSessionInfoHTML,
  renderSessionInfoPlain,
} from "./session-format.js";
import type { SessionRegistry } from "./session-registry.js";
import type { GetTelegramContextSession } from "./telegram-command-types.js";
import { safeReply } from "./telegram-output.js";

export interface TelegramGeneralCommandOptions {
  bot: Bot<Context>;
  config: ConnectorConfig;
  registry: SessionRegistry;
  getContextSession: GetTelegramContextSession;
  checkAgentAuthStatus: (info: AgentSessionInfo) => Promise<{ authenticated: boolean; detail: string }>;
  isTopicContext: (contextKey: TelegramContextKey) => boolean;
  replyChannelAction: (ctx: Context, rendered: ChannelActionResponse) => Promise<void>;
}

export function registerTelegramGeneralCommands(options: TelegramGeneralCommandOptions): void {
  options.bot.command("start", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const { contextKey, session } = contextSession;
    const info = session.getInfo();
    const authStatus = capabilitiesOf(info).auth ? await options.checkAgentAuthStatus(info) : null;
    const authWarning = authStatus && !authStatus.authenticated
      ? [`${labelOf(info)} is not authenticated.`, authStatus.detail, authHelpText(info)].filter(Boolean).join(" ")
      : undefined;
    const isReturning = options.registry.hasMetadata(contextKey);

    if (isReturning) {
      const welcome = renderWelcomeReturning(
        renderSessionInfoHTML(info),
        renderSessionInfoPlain(info),
        options.isTopicContext(contextKey),
        authWarning,
      );
      await safeReply(ctx, welcome.html, { fallbackText: welcome.plain });
      return;
    }

    const welcome = renderWelcomeFirstTime(authWarning);
    await safeReply(ctx, [welcome.html, "", renderLaunchSummaryHTML(info)].join("\n"), {
      fallbackText: [welcome.plain, "", renderLaunchSummaryPlain(info)].join("\n"),
    });
  });

  options.bot.command("help", async (ctx) => {
    const help = renderHelpMessage();
    await safeReply(ctx, help.html, { fallbackText: help.plain });
  });

  options.bot.command("channels", async (ctx) => {
    await options.replyChannelAction(ctx, renderChannelsAction(listChannelDescriptors()));
  });

  options.bot.command("agents", async (ctx) => {
    await options.replyChannelAction(ctx, renderAgentsAction(listAgentAdapterDescriptors(), enabledAgents(options.config)));
  });

  options.bot.command("restart", async (ctx) => {
    await safeReply(ctx, escapeHTML("Restarting connector..."), {
      fallbackText: "Restarting connector...",
    });
    setTimeout(() => {
      spawnConnectorRestart();
    }, 300);
  });
}
