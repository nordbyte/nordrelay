import {
  type ChatInputCommandInteraction,
  type Message,
  type MessageComponentInteraction,
} from "discord.js";

import type { ConnectorConfig } from "../../core/config.js";
import type { UserStore } from "../../access/user-management.js";
import { discordContextKey, parseDiscordContextKey, type ChannelContextKey } from "../shared/context-key.js";
import type { DiscordRequest } from "./discord-types.js";

export function discordRequestFromMessage(message: Message): DiscordRequest {
  const threadId = message.channel.isThread() ? message.channel.id : undefined;
  const parentId = message.channel.isThread() ? message.channel.parentId ?? message.channel.id : message.channel.id;
  const channelName = "name" in message.channel && typeof message.channel.name === "string" ? message.channel.name : undefined;
  const guildKey = message.guildId ?? `dm-${message.author.id}`;
  return {
    contextKey: discordContextKey({ guildId: guildKey, channelId: parentId, threadId }),
    context: {
      channelId: "discord",
      chatId: threadId ?? parentId,
      ...(threadId ? { topicId: threadId } : {}),
      userId: message.author.id,
      username: message.author.username,
    },
    user: message.author,
    username: message.author.username,
    guildId: message.guildId ?? undefined,
    channelId: parentId,
    channelName,
    isDirectMessage: !message.guildId,
    source: "message",
    message,
  };
}

export function discordRequestFromInteraction(
  interaction: ChatInputCommandInteraction | MessageComponentInteraction,
): DiscordRequest {
  const channel = interaction.channel;
  const threadId = channel?.isThread() ? channel.id : undefined;
  const parentId = channel?.isThread() ? channel.parentId ?? channel.id : interaction.channelId;
  const channelName = channel && "name" in channel && typeof channel.name === "string" ? channel.name : undefined;
  const guildKey = interaction.guildId ?? `dm-${interaction.user.id}`;
  return {
    contextKey: discordContextKey({ guildId: guildKey, channelId: parentId, threadId }),
    context: {
      channelId: "discord",
      chatId: threadId ?? parentId,
      ...(threadId ? { topicId: threadId } : {}),
      userId: interaction.user.id,
      username: interaction.user.username,
    },
    user: interaction.user,
    username: interaction.user.username,
    guildId: interaction.guildId ?? undefined,
    channelId: parentId,
    channelName,
    isDirectMessage: !interaction.guildId,
    source: "interaction",
    interaction,
  };
}

export function isDiscordGuildAllowed(config: ConnectorConfig, guildId: string | undefined): boolean {
  return !guildId || config.discordAllowedGuildIds.length === 0 || config.discordAllowedGuildIds.includes(guildId);
}

export function isDiscordChannelAllowedByEnv(config: ConnectorConfig, channelId: string): boolean {
  return config.discordAllowedChannelIds.length === 0 || config.discordAllowedChannelIds.includes(channelId);
}

export function canSendSystemMessagesToDiscordContext(userStore: UserStore, contextKey: ChannelContextKey): boolean {
  if (!userStore.hasAdminUser()) {
    return false;
  }
  const parsed = parseDiscordContextKey(contextKey);
  if (!parsed) {
    return false;
  }
  if (!parsed.guildId || parsed.guildId.startsWith("dm-")) {
    const userId = parsed.guildId?.startsWith("dm-") ? parsed.guildId.slice(3) : undefined;
    return Boolean(userId && userStore.resolveDiscordUser(userId));
  }
  return userStore.snapshot().discordChannels.some((channel) =>
    channel.enabled &&
    channel.channelId === parsed.channelId &&
    (channel.guildId ?? "") === (parsed.guildId ?? "")
  );
}
