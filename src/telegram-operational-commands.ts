import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { InputFile, type Bot, type Context } from "grammy";

import type { AgentExternalActivity, AgentSessionInfo, AgentSessionService } from "./agent.js";
import { getAgentActivityLog } from "./agent-activity.js";
import type { AuditEvent, AuditLogStore } from "./audit-log.js";
import {
  capabilitiesOf,
  filterActivityEvents,
  formatLocalDateTime,
  formatLockOwner,
  formatTelegramName,
  labelOf,
  parseActivityOptions,
  renderActivityTimeline,
  renderAuditEvents,
  renderProgressHTML,
  renderProgressPlain,
  renderSessionLocks,
} from "./bot-rendering.js";
import type { ConnectorConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";
import { escapeHTML } from "./format.js";
import type { PromptStore } from "./prompt-store.js";
import { renderSessionInfoHTML, renderSessionInfoPlain } from "./session-format.js";
import type { SessionLockStore } from "./session-locks.js";
import { chatBucket, safeReply } from "./telegram-output.js";
import { telegramRateLimiter } from "./telegram-rate-limit.js";
import type { GetTelegramContextSession } from "./telegram-command-types.js";

type BusyStateLike = {
  processing: boolean;
  switching: boolean;
  transcribing: boolean;
  approving: boolean;
  external?: boolean;
};

type TurnProgressLike = {
  status: "running" | "completed" | "failed";
  promptDescription: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  currentTool?: string;
  lastTool?: string;
  toolCounts: Map<string, number>;
  textCharacters: number;
  error?: string;
};

type AuditContextWriter = (
  ctx: Context,
  contextKey: TelegramContextKey,
  session: AgentSessionService,
  patch: Omit<AuditEvent, "id" | "timestamp" | "channelId" | "contextKey" | "actorId" | "actorRole" | "agentId" | "threadId" | "workspace">,
) => void;

export interface TelegramOperationalCommandOptions {
  bot: Bot<Context>;
  config: ConnectorConfig;
  promptStore: PromptStore;
  auditLog: AuditLogStore;
  lockStore: SessionLockStore;
  turnProgress: Map<TelegramContextKey, TurnProgressLike>;
  getContextSession: GetTelegramContextSession;
  getBusyState: (contextKey: TelegramContextKey) => BusyStateLike;
  getExternalActivity: (session: AgentSessionService | undefined) => AgentExternalActivity | null;
  isAdminUser: (ctx: Context) => boolean;
  auditContext: AuditContextWriter;
  updateSessionMetadata: (contextKey: TelegramContextKey, session: AgentSessionService) => void;
}

export function registerTelegramOperationalCommands(options: TelegramOperationalCommandOptions): void {
  const {
    bot,
    config,
    promptStore,
    auditLog,
    lockStore,
    turnProgress,
  } = options;

  bot.command(["tasks", "progress"], async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const progress = turnProgress.get(contextSession.contextKey);
    const queue = promptStore.list(contextSession.contextKey);
    const externalActivity = options.getExternalActivity(contextSession.session);
    const busyState: BusyStateLike = {
      ...options.getBusyState(contextSession.contextKey),
      external: Boolean(externalActivity?.active),
    };
    const info = contextSession.session.getInfo();
    const plain = renderProgressPlain(progress, queue.length, busyState, info);
    const html = renderProgressHTML(progress, queue.length, busyState, info);
    await safeReply(ctx, html, { fallbackText: plain });
  });

  bot.command("activity", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const info = contextSession.session.getInfo();
    if (!capabilitiesOf(info).activityLog) {
      const text = `${labelOf(info)} activity timelines are not available yet.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }

    const threadId = contextSession.session.getActiveThreadId();
    if (!threadId) {
      await safeReply(ctx, escapeHTML("No active thread yet."), { fallbackText: "No active thread yet." });
      return;
    }

    const activityOptions = parseActivityOptions((ctx.message?.text ?? "").replace(/^\/activity(?:@\w+)?\s*/i, "").trim());
    const events = filterActivityEvents(getAgentActivityLog(contextSession.session, config, activityOptions.exportFile ? 200 : activityOptions.limit), activityOptions);
    const rendered = renderActivityTimeline(threadId, events, activityOptions);
    if (activityOptions.exportFile && ctx.chat) {
      const exportPath = path.join(tmpdir(), `nordrelay-activity-${threadId}-${randomUUID().slice(0, 8)}.txt`);
      await writeFile(exportPath, rendered.plain, "utf8");
      try {
        await telegramRateLimiter.run(chatBucket(ctx.chat.id), "sendDocument", () =>
          ctx.api.sendDocument(ctx.chat!.id, new InputFile(exportPath, path.basename(exportPath)), {
            ...(ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}),
          })
        );
      } finally {
        await unlink(exportPath).catch(() => {});
      }
      return;
    }
    await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
  });

  bot.command("audit", async (ctx) => {
    const rawText = ctx.message?.text ?? "";
    const limitArg = rawText.replace(/^\/audit(?:@\w+)?\s*/i, "").trim();
    const limit = /^\d+$/.test(limitArg) ? Number(limitArg) : 20;
    const events = auditLog.list(limit);
    const rendered = renderAuditEvents(events);
    await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
  });

  bot.command("lock", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession || !ctx.from) {
      return;
    }
    const { contextKey, session } = contextSession;
    const existing = lockStore.get(contextKey);
    if (existing && existing.ownerId !== ctx.from.id && !options.isAdminUser(ctx)) {
      const text = `Session is already locked by ${formatLockOwner(existing)}.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }
    const lock = lockStore.set(contextKey, ctx.from.id, formatTelegramName(ctx), config.sessionLockTtlMs);
    options.auditContext(ctx, contextKey, session, {
      action: "lock_updated",
      status: "ok",
      detail: `locked by ${lock.ownerId}`,
    });
    const text = `Session locked by ${formatLockOwner(lock)}${lock.expiresAt ? ` until ${formatLocalDateTime(new Date(lock.expiresAt))}` : ""}.`;
    await safeReply(ctx, escapeHTML(text), { fallbackText: text });
  });

  bot.command("unlock", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { contextKey, session } = contextSession;
    const lock = lockStore.get(contextKey);
    if (lock && lock.ownerId !== ctx.from?.id && !options.isAdminUser(ctx)) {
      const text = `Only ${formatLockOwner(lock)} or an admin can unlock this session.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }
    const removed = lockStore.clear(contextKey);
    options.auditContext(ctx, contextKey, session, {
      action: "lock_updated",
      status: "ok",
      detail: removed ? "unlocked" : "no lock",
    });
    const text = removed ? "Session lock released." : "No active lock for this session.";
    await safeReply(ctx, escapeHTML(text), { fallbackText: text });
  });

  bot.command("locks", async (ctx) => {
    const locks = lockStore.list();
    const rendered = renderSessionLocks(locks);
    await safeReply(ctx, rendered.html, { fallbackText: rendered.plain });
  });

  bot.command("sync", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }

    const sessionInfo: AgentSessionInfo = contextSession.session.getInfo();
    if (!capabilitiesOf(sessionInfo).externalActivity) {
      const plain = [`${labelOf(sessionInfo)} has no external CLI state watcher to sync.`, "", renderSessionInfoPlain(sessionInfo)].join("\n");
      const html = [`<b>${escapeHTML(labelOf(sessionInfo))} has no external CLI state watcher to sync.</b>`, "", renderSessionInfoHTML(sessionInfo)].join("\n");
      await safeReply(ctx, html, { fallbackText: plain });
      return;
    }

    const result = contextSession.session.syncFromAgentState({ reattach: true });
    if (result.changed) {
      options.updateSessionMetadata(contextSession.contextKey, contextSession.session);
    }
    const fields = result.changedFields.length > 0 ? result.changedFields.join(", ") : "none";
    const plain = [
      result.changed ? `Synced from ${labelOf(sessionInfo)} state.` : "Already in sync.",
      `Changed: ${fields}`,
      `Reattached: ${result.reattached ? "yes" : "no"}`,
      "",
      renderSessionInfoPlain(result.info),
    ].join("\n");
    const html = [
      result.changed ? `<b>Synced from ${escapeHTML(labelOf(sessionInfo))} state.</b>` : "<b>Already in sync.</b>",
      `<b>Changed:</b> <code>${escapeHTML(fields)}</code>`,
      `<b>Reattached:</b> <code>${result.reattached ? "yes" : "no"}</code>`,
      "",
      renderSessionInfoHTML(result.info),
    ].join("\n");
    await safeReply(ctx, html, { fallbackText: plain });
  });
}
