import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  type BaseMessageOptions,
  type Message,
  type MessageCreateOptions,
} from "discord.js";

import type { ChannelActionButton } from "./channel-actions.js";
import {
  DiscordChannelAdapter,
  type ChannelContext,
  type ChannelOutboundFile,
  type ChannelOutboundMessage,
  type ChannelOutboundResult,
  type ChannelRuntime,
} from "./channel-adapter.js";
import { discordRateLimiter } from "./discord-rate-limit.js";
import { redactText } from "./redaction.js";

const DISCORD_MESSAGE_LIMIT = 2000;
const DISCORD_SAFE_MESSAGE_LIMIT = 1900;
export const DISCORD_ACTION_PREFIX = "nr:";

export class DiscordBotChannelRuntime implements ChannelRuntime {
  readonly id = "discord" as const;
  readonly label = "Discord";
  readonly capabilities = new DiscordChannelAdapter().capabilities;

  constructor(private readonly client: Client) {}

  describe() {
    return new DiscordChannelAdapter().describe();
  }

  async sendMessage(context: ChannelContext, message: ChannelOutboundMessage): Promise<ChannelOutboundResult> {
    const channel = await this.resolveChannel(context, message.threadId);
    const content = discordMessageText(message);
    const chunks = splitDiscordMessage(content);
    let first: Message | null = null;
    for (const [index, chunk] of chunks.entries()) {
      const sent = await discordRateLimiter.run(discordBucket(context), "sendMessage", () =>
        channel.send({
          content: chunk,
          components: index === chunks.length - 1 ? discordActionRows(message.buttons) : [],
          allowedMentions: { parse: [] },
        })
      );
      first ??= sent;
    }
    return { messageId: first?.id ?? "" };
  }

  async editMessage(context: ChannelContext, messageId: string, message: ChannelOutboundMessage): Promise<void> {
    const channel = await this.resolveChannel(context, message.threadId);
    const existing = await channel.messages.fetch(messageId).catch(() => null);
    if (!existing) {
      await this.sendMessage(context, message);
      return;
    }
    await discordRateLimiter.run(discordBucket(context), "editMessage", () =>
      existing.edit({
        content: trimDiscordMessage(discordMessageText(message)),
        components: discordActionRows(message.buttons),
        allowedMentions: { parse: [] },
      })
    );
  }

  async sendTyping(context: ChannelContext): Promise<void> {
    const channel = await this.resolveChannel(context);
    await discordRateLimiter.run(discordBucket(context), "typing", () => channel.sendTyping());
  }

  async sendFile(context: ChannelContext, file: ChannelOutboundFile): Promise<ChannelOutboundResult> {
    const channel = await this.resolveChannel(context, file.threadId);
    const sent = await discordRateLimiter.run(discordBucket(context), "sendFile", () =>
      channel.send({
        content: file.caption ? trimDiscordMessage(redactText(file.caption)) : undefined,
        files: [new AttachmentBuilder(file.localPath, { name: file.name })],
        allowedMentions: { parse: [] },
      })
    );
    return { messageId: sent.id };
  }

  private async resolveChannel(context: ChannelContext, overrideThreadId?: string): Promise<DiscordSendableChannel> {
    const id = overrideThreadId ?? context.topicId ?? context.chatId;
    const channel = await this.client.channels.fetch(id);
    if (!channel?.isTextBased() || !("send" in channel) || !("messages" in channel)) {
      throw new Error(`Discord channel is not text-capable: ${id}`);
    }
    return channel as DiscordSendableChannel;
  }
}

function discordBucket(context: ChannelContext): string {
  return context.topicId ?? context.chatId;
}

export function discordMessageText(message: ChannelOutboundMessage): string {
  return message.fallbackText?.trim() || stripTelegramHtml(message.text).trim() || ".";
}

type DiscordSendableChannel = {
  send(options: MessageCreateOptions): Promise<Message>;
  sendTyping(): Promise<void>;
  messages: {
    fetch(id: string): Promise<Message>;
  };
};

export function discordActionRows(rows: ChannelActionButton[][] | undefined): ReturnType<ActionRowBuilder<ButtonBuilder>["toJSON"]>[] {
  if (!rows?.length) {
    return [];
  }
  return rows.slice(0, 5).map((row) =>
    new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        row.slice(0, 5).map((button) =>
          new ButtonBuilder()
            .setCustomId(discordActionId(button.action))
            .setLabel(trimButtonLabel(button.label))
            .setStyle(ButtonStyle.Secondary)
        ),
      )
      .toJSON(),
  );
}

export function discordActionId(action: string): string {
  const raw = `${DISCORD_ACTION_PREFIX}${action}`;
  return raw.length <= 100 ? raw : `${DISCORD_ACTION_PREFIX}${action.slice(0, 97 - DISCORD_ACTION_PREFIX.length)}`;
}

export function actionFromDiscordCustomId(customId: string): string | null {
  return customId.startsWith(DISCORD_ACTION_PREFIX) ? customId.slice(DISCORD_ACTION_PREFIX.length) : null;
}

export function splitDiscordMessage(text: string): string[] {
  const normalized = text || ".";
  if (normalized.length <= DISCORD_SAFE_MESSAGE_LIMIT) {
    return [normalized];
  }
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > 0) {
    const slice = remaining.slice(0, DISCORD_SAFE_MESSAGE_LIMIT);
    const breakAt = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    const length = breakAt > 400 ? breakAt : DISCORD_SAFE_MESSAGE_LIMIT;
    chunks.push(remaining.slice(0, length).trimEnd() || ".");
    remaining = remaining.slice(length).trimStart();
  }
  return chunks;
}

export function trimDiscordMessage(text: string): string {
  return text.length <= DISCORD_MESSAGE_LIMIT ? text : `${text.slice(0, DISCORD_MESSAGE_LIMIT - 1)}…`;
}

export function discordMessageOptions(message: ChannelOutboundMessage): MessageCreateOptions & BaseMessageOptions {
  return {
    content: trimDiscordMessage(discordMessageText(message)),
    components: discordActionRows(message.buttons),
    allowedMentions: { parse: [] },
  };
}

function stripTelegramHtml(text: string): string {
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
  return trimmed.length <= 80 ? trimmed : trimmed.slice(0, 80);
}
