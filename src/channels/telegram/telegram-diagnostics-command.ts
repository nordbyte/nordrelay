import type { Bot, Context } from "grammy";

import type { AgentSessionInfo, AgentSessionService } from "../../agents/shared/agent.js";
import { getAgentDiagnostics } from "../../agents/shared/agent-activity.js";
import { formatQuietHours, type QuietHours, type TelegramMirrorMode, type TelegramNotifyMode, type VoiceBackendPreference } from "../../state/bot-preferences.js";
import type { ChannelActionResponse } from "../shared/channel-actions.js";
import { cliPathOptions, type ChannelCommandService } from "../shared/channel-command-service.js";
import { checkAuthStatus } from "../../agents/codex/codex-auth.js";
import type { ConnectorConfig } from "../../core/config.js";
import { contextKeyFromCtx, type TelegramContextKey } from "../shared/context-key.js";
import {
  getConnectorHealth,
} from "../../support/operations.js";
import type { PromptStore } from "../../state/prompt-store.js";
import {
  renderAgentDiagnostics,
  renderDiagnosticsHTML,
  renderDiagnosticsPlain,
  renderHealthHTML,
  renderHealthPlain,
  type RuntimeDiagnostics,
  type TurnProgress,
} from "../shared/bot-rendering.js";
import type { SessionRegistry } from "../../state/session-registry.js";
import { getTelegramRateLimitMetrics } from "./telegram-rate-limit.js";
import { safeReply } from "./telegram-output.js";

export interface TelegramDiagnosticsCommandOptions {
  bot: Bot<Context>;
  config: ConnectorConfig;
  registry: SessionRegistry;
  promptStore: PromptStore;
  turnProgress: Map<TelegramContextKey, TurnProgress>;
  externalMirrors: { size: number };
  externalQueueTimers: { size: number };
  queueStatusMessages: { size: number };
  getContextSession: (ctx: Context, options?: { deferThreadStart?: boolean }) => Promise<{ contextKey: TelegramContextKey; session: AgentSessionService } | null>;
  checkAgentAuthStatus: (info: AgentSessionInfo) => Promise<{ authenticated: boolean }>;
  getUserRole: (ctx: Context) => string;
  getEffectiveMirrorMode: (contextKey: TelegramContextKey) => TelegramMirrorMode;
  getEffectiveNotifyMode: (contextKey: TelegramContextKey) => TelegramNotifyMode;
  getEffectiveQuietHours: (contextKey: TelegramContextKey) => QuietHours | null | undefined;
  getEffectiveVoiceBackend: (contextKey: TelegramContextKey) => VoiceBackendPreference;
  getEffectiveVoiceLanguage: (contextKey: TelegramContextKey) => string | null | undefined;
  isVoiceTranscribeOnly: (contextKey: TelegramContextKey) => boolean;
  replyChannelAction: (ctx: Context, rendered: ChannelActionResponse) => Promise<void>;
  commandService: ChannelCommandService;
}

export function registerTelegramDiagnosticsCommands(options: TelegramDiagnosticsCommandOptions): void {
  options.bot.command(["status", "health"], async (ctx) => {
    const health = await getConnectorHealth(cliPathOptions(options.config));
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    const authStatus = contextSession
      ? await options.checkAgentAuthStatus(contextSession.session.getInfo())
      : await checkAuthStatus(options.config.codexApiKey);
    const html = renderHealthHTML(health, authStatus.authenticated, options.getUserRole(ctx));
    const plain = renderHealthPlain(health, authStatus.authenticated, options.getUserRole(ctx));
    await safeReply(ctx, html, { fallbackText: plain });
  });

  options.bot.command("version", async (ctx) => {
    await options.replyChannelAction(ctx, await options.commandService.renderVersion());
  });

  options.bot.command("diagnostics", async (ctx) => {
    const health = await getConnectorHealth(cliPathOptions(options.config));
    const contextKey = contextKeyFromCtx(ctx);
    const queueLength = contextKey ? options.promptStore.list(contextKey).length : 0;
    const progress = contextKey ? options.turnProgress.get(contextKey) : undefined;
    const contextSession = contextKey ? await options.getContextSession(ctx, { deferThreadStart: true }) : null;
    const authStatus = contextSession
      ? await options.checkAgentAuthStatus(contextSession.session.getInfo())
      : await checkAuthStatus(options.config.codexApiKey);
    const agentDiagnostics = contextSession
      ? renderAgentDiagnostics(getAgentDiagnostics(contextSession.session, options.config))
      : { plain: "Agent state: no context", html: "<b>Agent state:</b> <code>no context</code>" };
    const runtime: RuntimeDiagnostics = {
      rateLimit: getTelegramRateLimitMetrics(),
      externalMirrors: options.externalMirrors.size,
      externalQueueTimers: options.externalQueueTimers.size,
      queueStatusMessages: options.queueStatusMessages.size,
      mirrorMode: contextKey ? options.getEffectiveMirrorMode(contextKey) : options.config.telegramMirrorMode,
      notifyMode: contextKey ? options.getEffectiveNotifyMode(contextKey) : options.config.telegramNotifyMode,
      quietHours: formatQuietHours(contextKey ? options.getEffectiveQuietHours(contextKey) : options.config.telegramQuietHours),
      voiceBackend: contextKey ? options.getEffectiveVoiceBackend(contextKey) : options.config.voicePreferredBackend,
      voiceLanguage: contextKey ? options.getEffectiveVoiceLanguage(contextKey) ?? "auto" : options.config.voiceDefaultLanguage ?? "auto",
      voiceTranscribeOnly: contextKey ? options.isVoiceTranscribeOnly(contextKey) : options.config.voiceTranscribeOnly,
    };
    const plain = `${renderDiagnosticsPlain(options.config, options.registry, health, authStatus.authenticated, options.getUserRole(ctx), queueLength, progress, runtime)}\n${agentDiagnostics.plain}`;
    const html = `${renderDiagnosticsHTML(options.config, options.registry, health, authStatus.authenticated, options.getUserRole(ctx), queueLength, progress, runtime)}\n${agentDiagnostics.html}`;
    await safeReply(ctx, html, { fallbackText: plain });
  });

  options.bot.command("logs", async (ctx) => {
    const rawText = ctx.message?.text ?? "";
    const argument = rawText.replace(/^\/logs(?:@\w+)?\s*/i, "").trim();
    await options.replyChannelAction(ctx, await options.commandService.renderLogs(argument));
  });
}
