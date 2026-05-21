import type { Bot, Context } from "grammy";

import type { AgentSessionInfo } from "../../agents/shared/agent.js";
import {
  renderWelcomeFirstTime,
  renderWelcomeReturning,
  renderHelpMessage,
} from "./bot-ui.js";
import {
  authHelpText,
  capabilitiesOf,
  labelOf,
} from "../shared/bot-rendering.js";
import type { ChannelActionResponse } from "../shared/channel-actions.js";
import type { ChannelCommandService } from "../shared/channel-command-service.js";
import type { BotPreferencesStore } from "../../state/bot-preferences.js";
import type { ConnectorConfig } from "../../core/config.js";
import type { TelegramContextKey } from "../shared/context-key.js";
import { escapeHTML } from "../../core/format.js";
import { spawnConnectorRestart } from "../../support/operations.js";
import {
  renderLaunchSummaryHTML,
  renderLaunchSummaryPlain,
  renderSessionInfoHTML,
  renderSessionInfoPlain,
} from "../shared/session-format.js";
import type { SessionRegistry } from "../../state/session-registry.js";
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
  commandService: ChannelCommandService;
  preferencesStore: BotPreferencesStore;
  onTargetChanged?: (contextKey: TelegramContextKey) => void;
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
    await options.replyChannelAction(ctx, options.commandService.renderChannels());
  });

  options.bot.command("agents", async (ctx) => {
    await options.replyChannelAction(ctx, options.commandService.renderAgents());
  });

  options.bot.command("peers", async (ctx) => {
    await options.replyChannelAction(ctx, options.commandService.renderPeers());
  });

  options.bot.command("nodes", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) return;
    await options.replyChannelAction(ctx, options.commandService.renderNodeTargets({
      source: "telegram",
      contextKey: contextSession.contextKey,
      argument: "",
      preferencesStore: options.preferencesStore,
    }));
  });

  options.bot.command("target", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) return;
    await options.replyChannelAction(ctx, options.commandService.renderTargetPreference({
      source: "telegram",
      contextKey: contextSession.contextKey,
      argument: ctx.match?.toString() ?? "",
      preferencesStore: options.preferencesStore,
    }));
    options.onTargetChanged?.(contextSession.contextKey);
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
