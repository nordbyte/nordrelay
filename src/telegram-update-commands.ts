import type { Bot, Context } from "grammy";

import { listAgentAdapterDescriptors } from "./agent-adapter.js";
import { agentLabel, type AgentId } from "./agent.js";
import type { AgentUpdateManager, AgentUpdateOperation } from "./agent-updates.js";
import type { WebActivityEvent } from "./web-state.js";
import {
  parseAgentUpdateId,
  renderAgentUpdateJobAction,
  renderAgentUpdateJobsAction,
  renderAgentUpdateLogAction,
  renderAgentUpdatePickerAction,
  renderSelfUpdateStartedAction,
  type ChannelActionResponse,
} from "./channel-actions.js";
import { escapeHTML } from "./format.js";
import { spawnSelfUpdate } from "./operations.js";
import { safeReply } from "./telegram-output.js";

interface UpdateCommandDeps {
  bot: Bot<Context>;
  agentUpdates: AgentUpdateManager;
  replyChannelAction: (ctx: Context, rendered: ChannelActionResponse) => Promise<void>;
  startTelegramAgentUpdate: (ctx: Context, agentId: AgentId, operation?: AgentUpdateOperation) => Promise<void>;
  appendActivity?: (ctx: Context, input: Omit<WebActivityEvent, "id" | "timestamp" | "source"> & { timestamp?: string }) => void;
}

export function registerTelegramUpdateCommands(deps: UpdateCommandDeps): void {
  const { bot, agentUpdates, replyChannelAction, startTelegramAgentUpdate } = deps;

  bot.command("update", async (ctx) => {
    const rawText = ctx.message?.text ?? "";
    const argument = rawText.replace(/^\/update(?:@\w+)?\s*/i, "").trim();
    const tokens = argument.split(/\s+/).filter(Boolean);
    const subcommand = tokens[0]?.toLowerCase();
    const installTarget = subcommand === "install" ? parseAgentUpdateId(tokens[1]) : null;
    if (installTarget) {
      await startTelegramAgentUpdate(ctx, installTarget, "install");
      return;
    }

    if (subcommand === "agents" || subcommand === "agent") {
      const rendered = renderAgentUpdatePickerAction(listAgentAdapterDescriptors());
      await replyChannelAction(ctx, rendered);
      return;
    }

    if (subcommand === "jobs" || subcommand === "status") {
      const rendered = renderAgentUpdateJobsAction(agentUpdates.list());
      await replyChannelAction(ctx, rendered);
      return;
    }

    if (subcommand === "log" && tokens[1]) {
      const rendered = renderAgentUpdateLogAction(agentUpdates.readLog(tokens[1]));
      await replyChannelAction(ctx, rendered);
      return;
    }

    if (subcommand === "cancel" && tokens[1]) {
      const job = agentUpdates.cancel(tokens[1]);
      deps.appendActivity?.(ctx, {
        status: "aborted",
        type: "agent_update_cancel_requested",
        threadId: null,
        agentId: job.agentId,
        detail: `${job.agentLabel} ${job.operation} cancellation requested.`,
      });
      const rendered = renderAgentUpdateJobAction(job);
      await replyChannelAction(ctx, rendered);
      return;
    }

    if ((subcommand === "input" || subcommand === "send") && tokens[1] && tokens.slice(2).join(" ").trim()) {
      const job = agentUpdates.sendInput(tokens[1], tokens.slice(2).join(" "));
      deps.appendActivity?.(ctx, {
        status: "info",
        type: "agent_update_input_sent",
        threadId: null,
        agentId: job.agentId,
        detail: `Input sent to ${job.agentLabel} ${job.operation}.`,
      });
      const rendered = renderAgentUpdateJobAction(job);
      await replyChannelAction(ctx, rendered);
      return;
    }

    const requestedAgent = parseAgentUpdateId(subcommand);
    if (requestedAgent) {
      await startTelegramAgentUpdate(ctx, requestedAgent);
      return;
    }

    if (subcommand) {
      const usage = "Unknown update target. Use /update, /update agents, /update jobs, /update <agent>, /update install <agent>, /update log <id>, /update cancel <id>, or /update input <id> <text>.";
      await safeReply(ctx, escapeHTML(usage), { fallbackText: usage });
      return;
    }

    const update = spawnSelfUpdate();
    deps.appendActivity?.(ctx, {
      status: "info",
      type: "update_started",
      threadId: null,
      detail: `${update.method}: ${update.summary}`,
    });
    const rendered = renderSelfUpdateStartedAction(update);
    await replyChannelAction(ctx, rendered);
  });

  bot.callbackQuery("upd_jobs", async (ctx) => {
    await ctx.answerCallbackQuery();
    const rendered = renderAgentUpdateJobsAction(agentUpdates.list());
    await replyChannelAction(ctx, rendered);
  });

  bot.callbackQuery(/^upd_agent:(codex|pi|hermes|openclaw|claude-code)$/, async (ctx) => {
    const agentId = ctx.match?.[1] as AgentId | undefined;
    if (!agentId) {
      await ctx.answerCallbackQuery();
      return;
    }
    await ctx.answerCallbackQuery({ text: `Starting ${agentLabel(agentId)} update...` });
    await startTelegramAgentUpdate(ctx, agentId);
  });

  bot.callbackQuery(/^upd_log:(.+)$/, async (ctx) => {
    const id = ctx.match?.[1];
    await ctx.answerCallbackQuery();
    if (!id) {
      return;
    }
    const rendered = renderAgentUpdateLogAction(agentUpdates.readLog(id));
    await replyChannelAction(ctx, rendered);
  });

  bot.callbackQuery(/^upd_cancel:(.+)$/, async (ctx) => {
    const id = ctx.match?.[1];
    await ctx.answerCallbackQuery({ text: "Cancelling update..." });
    if (!id) {
      return;
    }
    const job = agentUpdates.cancel(id);
    deps.appendActivity?.(ctx, {
      status: "aborted",
      type: "agent_update_cancel_requested",
      threadId: null,
      agentId: job.agentId,
      detail: `${job.agentLabel} ${job.operation} cancellation requested.`,
    });
    const rendered = renderAgentUpdateJobAction(job);
    await replyChannelAction(ctx, rendered);
  });
}
