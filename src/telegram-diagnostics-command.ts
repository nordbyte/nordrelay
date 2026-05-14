import type { Bot, Context } from "grammy";

import type { AgentSessionInfo, AgentSessionService } from "./agent.js";
import { getAgentDiagnostics } from "./agent-activity.js";
import { formatQuietHours, type QuietHours, type TelegramMirrorMode, type TelegramNotifyMode, type VoiceBackendPreference } from "./bot-preferences.js";
import {
  logTailRequests,
  parseLogsCommand,
  renderLogTailsAction,
  type ChannelActionResponse,
} from "./channel-actions.js";
import { checkAuthStatus } from "./codex-auth.js";
import type { ConnectorConfig } from "./config.js";
import { contextKeyFromCtx, type TelegramContextKey } from "./context-key.js";
import { escapeHTML } from "./format.js";
import {
  getConnectorHealth,
  getVersionChecks,
  readConnectorState,
  readFormattedLogTail,
} from "./operations.js";
import type { PromptStore } from "./prompt-store.js";
import {
  formatCliPathHTML,
  formatCliPathPlain,
  renderAgentDiagnostics,
  renderDiagnosticsHTML,
  renderDiagnosticsPlain,
  renderHealthHTML,
  renderHealthPlain,
  renderVersionCheckHTML,
  renderVersionCheckPlain,
  type RuntimeDiagnostics,
  type TurnProgress,
} from "./bot-rendering.js";
import type { SessionRegistry } from "./session-registry.js";
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
    const health = await getConnectorHealth(cliPathOptions(options.config));
    const state = await readConnectorState();
    const versions = await getVersionChecks(cliPathOptions(options.config));
    const plain = [
      renderVersionCheckPlain(versions.nordrelay),
      `Runtime status: ${state.status ?? "unknown"}`,
      formatCliPathPlain("Codex CLI", health.codexCliPath, health.codexCli),
      renderVersionCheckPlain(versions.codex),
      formatCliPathPlain("Pi CLI", health.piCliPath, health.piCli),
      renderVersionCheckPlain(versions.pi),
      formatCliPathPlain("Hermes CLI", health.hermesCliPath, health.hermesCli),
      renderVersionCheckPlain(versions.hermes),
      formatCliPathPlain("OpenClaw CLI", health.openClawCliPath, health.openClawCli),
      renderVersionCheckPlain(versions.openclaw),
      formatCliPathPlain("Claude Code CLI", health.claudeCodeCliPath, health.claudeCodeCli),
      renderVersionCheckPlain(versions.claudeCode),
    ].join("\n");
    const html = [
      renderVersionCheckHTML(versions.nordrelay),
      `<b>Runtime status:</b> <code>${escapeHTML(state.status ?? "unknown")}</code>`,
      formatCliPathHTML("Codex CLI", health.codexCliPath, health.codexCli),
      renderVersionCheckHTML(versions.codex),
      formatCliPathHTML("Pi CLI", health.piCliPath, health.piCli),
      renderVersionCheckHTML(versions.pi),
      formatCliPathHTML("Hermes CLI", health.hermesCliPath, health.hermesCli),
      renderVersionCheckHTML(versions.hermes),
      formatCliPathHTML("OpenClaw CLI", health.openClawCliPath, health.openClawCli),
      renderVersionCheckHTML(versions.openclaw),
      formatCliPathHTML("Claude Code CLI", health.claudeCodeCliPath, health.claudeCodeCli),
      renderVersionCheckHTML(versions.claudeCode),
    ].join("\n");
    await safeReply(ctx, html, { fallbackText: plain });
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
    const logRequest = parseLogsCommand(argument);
    const logs = await Promise.all(logTailRequests(logRequest.target).map(async (request) => ({
      title: request.title,
      tail: await readFormattedLogTail(logRequest.lines, request.path),
    })));
    await options.replyChannelAction(ctx, renderLogTailsAction(logs));
  });
}

function cliPathOptions(config: ConnectorConfig): { piCliPath?: string; hermesCliPath?: string; openClawCliPath?: string; claudeCodeCliPath?: string } {
  return {
    piCliPath: config.piCliPath,
    hermesCliPath: config.hermesCliPath,
    openClawCliPath: config.openClawCliPath,
    claudeCodeCliPath: config.claudeCodeCliPath,
  };
}
