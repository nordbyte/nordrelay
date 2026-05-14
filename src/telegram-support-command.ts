import { InputFile, type Bot, type Context } from "grammy";

import type { AgentUpdateManager } from "./agent-updates.js";
import type { AuditEvent, AuditLogStore } from "./audit-log.js";
import type { ConnectorConfig } from "./config.js";
import { contextKeyFromCtx } from "./context-key.js";
import { getConnectorHealth, getVersionChecks } from "./operations.js";
import { formatLocalDateTime } from "./bot-rendering.js";
import { createSupportBundle } from "./support-bundle.js";
import { chatBucket } from "./telegram-output.js";
import { telegramRateLimiter } from "./telegram-rate-limit.js";

export interface TelegramSupportCommandOptions {
  bot: Bot<Context>;
  config: ConnectorConfig;
  auditLog: AuditLogStore;
  agentUpdates: AgentUpdateManager;
  getUserRole: (ctx: Context) => string;
  audit: (event: Omit<AuditEvent, "id" | "timestamp" | "channelId">) => void;
}

export function registerTelegramSupportCommands(options: TelegramSupportCommandOptions): void {
  options.bot.command(["support", "diagnostics_bundle"], async (ctx) => {
    if (!ctx.chat) {
      return;
    }
    const health = await getConnectorHealth(cliPathOptions(options.config));
    const versionChecks = await getVersionChecks(cliPathOptions(options.config));
    const bundle = await createSupportBundle({
      config: options.config,
      health,
      versionChecks,
      auditEvents: options.auditLog.list(100),
      agentUpdateJobs: options.agentUpdates.list(),
      source: "telegram",
    });
    const contextKey = contextKeyFromCtx(ctx);
    if (contextKey) {
      options.audit({
        action: "command",
        status: "ok",
        contextKey,
        actor: {
          channel: "telegram",
          id: ctx.from?.id !== undefined ? `telegram:${ctx.from.id}` : undefined,
          label: ctx.from?.username || ctx.from?.first_name || (ctx.from?.id !== undefined ? String(ctx.from.id) : undefined),
          username: ctx.from?.username,
          channelUserId: ctx.from?.id !== undefined ? String(ctx.from.id) : undefined,
        },
        actorId: ctx.from?.id,
        actorRole: options.getUserRole(ctx),
        description: "export diagnostics bundle",
        detail: bundle.path,
      });
    }
    await telegramRateLimiter.run(chatBucket(ctx.chat.id), "sendDocument", () =>
      ctx.api.sendDocument(ctx.chat!.id, new InputFile(bundle.path, bundle.name), {
        caption: [
          "Diagnostics bundle exported.",
          `Created: ${formatLocalDateTime(new Date(bundle.createdAt))}`,
          `Files: ${bundle.includedFiles.length}`,
          `Size: ${bundle.sizeBytes} bytes`,
        ].join("\n"),
        ...(ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}),
      })
    );
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
