import { createReadStream } from "node:fs";

import type { WebClient } from "@slack/web-api";

import type { ChannelActionButton } from "./channel-actions.js";
import {
  SlackChannelAdapter,
  type ChannelContext,
  type ChannelOutboundFile,
  type ChannelOutboundMessage,
  type ChannelOutboundResult,
  type ChannelRuntime,
} from "./channel-adapter.js";
import { redactText } from "./redaction.js";
import { slackRateLimiter } from "./slack-rate-limit.js";

const SLACK_TEXT_LIMIT = 40000;
const SLACK_SAFE_TEXT_LIMIT = 3500;
export const SLACK_ACTION_PREFIX = "nr:";

export class SlackBotChannelRuntime implements ChannelRuntime {
  readonly id = "slack" as const;
  readonly label = "Slack";
  readonly capabilities = new SlackChannelAdapter().capabilities;

  constructor(private readonly client: WebClient) {}

  describe() {
    return new SlackChannelAdapter().describe();
  }

  async sendMessage(context: ChannelContext, message: ChannelOutboundMessage): Promise<ChannelOutboundResult> {
    const chunks = splitSlackMessage(slackMessageText(message));
    let firstTs = "";
    for (const [index, chunk] of chunks.entries()) {
      const result = await slackRateLimiter.run(slackBucket(context), "sendMessage", () =>
        this.client.chat.postMessage({
          channel: context.chatId,
          thread_ts: message.threadId ?? context.topicId,
          text: chunk,
          mrkdwn: true,
          blocks: slackBlocks({ ...message, fallbackText: chunk, text: chunk }, index === chunks.length - 1),
          unfurl_links: false,
          unfurl_media: false,
        } as never),
      ) as { ts?: string };
      firstTs ||= result.ts ?? "";
    }
    return { messageId: firstTs };
  }

  async editMessage(context: ChannelContext, messageId: string, message: ChannelOutboundMessage): Promise<void> {
    const text = trimSlackMessage(slackMessageText(message));
    await slackRateLimiter.run(slackBucket(context), "editMessage", () =>
      this.client.chat.update({
        channel: context.chatId,
        ts: messageId,
        text,
        blocks: slackBlocks({ ...message, fallbackText: text, text }, true),
        unfurl_links: false,
        unfurl_media: false,
      } as never),
    ).catch(async () => {
      await this.sendMessage(context, message);
    });
  }

  async sendTyping(context: ChannelContext): Promise<void> {
    await slackRateLimiter.run(slackBucket(context), "typing", async () => {
      await (this.client as unknown as {
        assistant?: { threads?: { setStatus?: (input: { channel_id: string; thread_ts?: string; status: string }) => Promise<unknown> } };
      }).assistant?.threads?.setStatus?.({
        channel_id: context.chatId,
        thread_ts: context.topicId,
        status: "Working...",
      });
    }).catch(() => {});
  }

  async sendFile(context: ChannelContext, file: ChannelOutboundFile): Promise<ChannelOutboundResult> {
    const result = await slackRateLimiter.run(slackBucket(context), "sendFile", () =>
      (this.client.files as unknown as {
        uploadV2(input: {
          channel_id: string;
          thread_ts?: string;
          file: NodeJS.ReadableStream;
          filename?: string;
          title?: string;
          initial_comment?: string;
        }): Promise<{ files?: Array<{ id?: string }> }>;
      }).uploadV2({
        channel_id: context.chatId,
        thread_ts: file.threadId ?? context.topicId,
        file: createReadStream(file.localPath),
        filename: file.name,
        title: file.name,
        initial_comment: file.caption ? trimSlackMessage(redactText(file.caption)) : undefined,
      }),
    );
    return { messageId: result.files?.[0]?.id ?? "" };
  }
}

export function slackMessageText(message: ChannelOutboundMessage): string {
  const text = message.fallbackText?.trim() || stripHtml(message.text).trim() || ".";
  return text.length <= SLACK_TEXT_LIMIT ? text : `${text.slice(0, SLACK_TEXT_LIMIT - 1)}…`;
}

export function slackActionId(action: string): string {
  const raw = `${SLACK_ACTION_PREFIX}${action}`;
  return raw.length <= 255 ? raw : `${SLACK_ACTION_PREFIX}${action.slice(0, 255 - SLACK_ACTION_PREFIX.length)}`;
}

export function actionFromSlackActionId(actionId: string): string | null {
  return actionId.startsWith(SLACK_ACTION_PREFIX) ? actionId.slice(SLACK_ACTION_PREFIX.length) : null;
}

export function splitSlackMessage(text: string): string[] {
  const normalized = text || ".";
  if (normalized.length <= SLACK_SAFE_TEXT_LIMIT) {
    return [normalized];
  }
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > 0) {
    const slice = remaining.slice(0, SLACK_SAFE_TEXT_LIMIT);
    const breakAt = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    const length = breakAt > 400 ? breakAt : SLACK_SAFE_TEXT_LIMIT;
    chunks.push(remaining.slice(0, length).trimEnd() || ".");
    remaining = remaining.slice(length).trimStart();
  }
  return chunks;
}

export function trimSlackMessage(text: string): string {
  return text.length <= SLACK_SAFE_TEXT_LIMIT ? text : `${text.slice(0, SLACK_SAFE_TEXT_LIMIT - 1)}…`;
}

export function slackBlocks(message: ChannelOutboundMessage, includeButtons = true): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: trimSlackMessage(slackMessageText(message)),
      },
    },
  ];
  if (includeButtons && message.buttons?.length) {
    blocks.push(...message.buttons.slice(0, 5).map((row) => ({
      type: "actions",
      elements: row.slice(0, 5).map((button) => slackButton(button)),
    })));
  }
  return blocks;
}

function slackButton(button: ChannelActionButton): Record<string, unknown> {
  return {
    type: "button",
    text: {
      type: "plain_text",
      text: trimButtonLabel(button.label),
      emoji: true,
    },
    action_id: slackActionId(button.action),
    value: button.action.slice(0, 2000),
  };
}

function slackBucket(context: ChannelContext): string {
  return context.topicId ?? context.chatId;
}

function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function trimButtonLabel(label: string): string {
  const trimmed = label.trim() || "Action";
  return trimmed.length <= 75 ? trimmed : trimmed.slice(0, 75);
}
