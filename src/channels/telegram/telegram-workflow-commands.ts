import type { Bot, Context } from "grammy";

import type { AgentSessionService } from "../../agents/shared/agent.js";
import type { ConnectorConfig } from "../../core/config.js";
import { escapeHTML } from "../../core/format.js";
import { toPromptEnvelope, type PromptEnvelope, type PromptStore } from "../../state/prompt-store.js";
import type { TelegramContextKey } from "../shared/context-key.js";
import {
  channelTemplatePrompt,
  channelWorkflowPrompts,
  parseChannelWorkflowArgument,
  renderChannelTemplateList,
  renderChannelWorkflowList,
} from "../shared/channel-workflow-commands.js";
import type { GetTelegramContextSession } from "./telegram-command-types.js";
import { safeReply } from "./telegram-output.js";

export interface TelegramWorkflowCommandOptions {
  bot: Bot<Context>;
  config: ConnectorConfig;
  promptStore: PromptStore;
  getContextSession: GetTelegramContextSession;
  handleUserPrompt: (
    ctx: Context,
    contextKey: TelegramContextKey,
    chatId: number | string,
    session: AgentSessionService,
    envelope: PromptEnvelope,
  ) => Promise<void>;
}

export function registerTelegramWorkflowCommands(options: TelegramWorkflowCommandOptions): void {
  options.bot.command("templates", async (ctx) => {
    await safeReply(ctx, escapeHTML(renderChannelTemplateList(options.config)));
  });

  options.bot.command("workflows", async (ctx) => {
    await safeReply(ctx, escapeHTML(renderChannelWorkflowList(options.config)));
  });

  options.bot.command("template", async (ctx) => {
    const session = await options.getContextSession(ctx, { deferThreadStart: true });
    const argument = commandArgument(ctx, "template");
    if (!session || !ctx.chat?.id) return;
    if (!argument) {
      await safeReply(ctx, escapeHTML("Usage: /template <template-id> {\"variable\":\"value\"}"));
      return;
    }
    const { id, variables } = parseChannelWorkflowArgument(argument);
    const template = channelTemplatePrompt(options.config, id, variables);
    await options.handleUserPrompt(ctx, session.contextKey, ctx.chat.id, session.session, toPromptEnvelope(template.prompt));
  });

  options.bot.command("workflow", async (ctx) => {
    const session = await options.getContextSession(ctx, { deferThreadStart: true });
    const argument = commandArgument(ctx, "workflow");
    if (!session || !ctx.chat?.id) return;
    if (!argument) {
      await safeReply(ctx, escapeHTML("Usage: /workflow <workflow-id> {\"variable\":\"value\"}"));
      return;
    }
    const { id, variables } = parseChannelWorkflowArgument(argument);
    const prompts = channelWorkflowPrompts(options.config, id, variables);
    const [first, ...rest] = prompts;
    if (!first) {
      await safeReply(ctx, escapeHTML("Workflow has no runnable steps."));
      return;
    }
    for (const item of rest) {
      options.promptStore.enqueue(session.contextKey, toPromptEnvelope(item.prompt));
    }
    await safeReply(ctx, escapeHTML(`Workflow queued with ${prompts.length} step(s).`));
    await options.handleUserPrompt(ctx, session.contextKey, ctx.chat.id, session.session, toPromptEnvelope(first.prompt));
  });
}

function commandArgument(ctx: Context, command: string): string {
  const text = ctx.message && "text" in ctx.message ? String(ctx.message.text ?? "") : "";
  return text.replace(new RegExp(`^/${command}(?:@\\w+)?\\s*`, "i"), "").trim();
}
