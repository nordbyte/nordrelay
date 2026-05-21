import type { ConnectorConfig } from "../../core/config.js";
import type { UserStore } from "../../access/user-management.js";
import { parseSlackContextKey, slackContextKey, type ChannelContextKey } from "../shared/context-key.js";
import type { SlackActionBody, SlackRequest, SlackSlashCommandPayload } from "./slack-types.js";

export interface SlackFile {
  id?: string;
  name?: string;
  size?: number | string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
}

export interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  team?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  username?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  files?: SlackFile[];
}

export function slackRequestFromMessage(event: SlackMessageEvent): SlackRequest {
  const threadTs = event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : undefined;
  return {
    contextKey: slackContextKey({ teamId: event.team, channelId: event.channel, threadTs }),
    context: { channelId: "slack", chatId: event.channel, ...(threadTs ? { topicId: threadTs } : {}), userId: event.user, username: event.username },
    userId: event.user ?? "unknown",
    username: event.username,
    teamId: event.team,
    channelId: event.channel,
    channelName: event.channel,
    isDirectMessage: event.channel_type === "im" || event.channel.startsWith("D"),
    source: "message",
  };
}

export function slackRequestFromSlashCommand(
  command: SlackSlashCommandPayload,
  respond?: (message: unknown) => Promise<unknown>,
): SlackRequest {
  return {
    contextKey: slackContextKey({ teamId: command.team_id, channelId: command.channel_id }),
    context: { channelId: "slack", chatId: command.channel_id, userId: command.user_id, username: command.user_name },
    userId: command.user_id,
    username: command.user_name,
    teamId: command.team_id,
    channelId: command.channel_id,
    channelName: command.channel_name,
    isDirectMessage: command.channel_name === "directmessage" || command.channel_id.startsWith("D"),
    source: "slash",
    respond,
  };
}

export function slackRequestFromAction(
  body: SlackActionBody,
  respond?: (message: unknown) => Promise<unknown>,
): SlackRequest {
  const channelId = body.channel?.id ?? "";
  const teamId = body.team?.id;
  const threadTs = body.message?.thread_ts && body.message.thread_ts !== body.message?.ts ? body.message.thread_ts : undefined;
  return {
    contextKey: slackContextKey({ teamId, channelId, threadTs }),
    context: { channelId: "slack", chatId: channelId, ...(threadTs ? { topicId: threadTs } : {}), userId: body.user?.id, username: body.user?.username },
    userId: body.user?.id ?? "unknown",
    username: body.user?.username,
    teamId,
    channelId,
    channelName: body.channel?.name,
    isDirectMessage: channelId.startsWith("D"),
    source: "action",
    respond,
  };
}

export function stripSlackMention(text: string): string {
  return text.replace(/^<@[^>]+>\s*/, "");
}

export function isSlackTeamAllowed(config: ConnectorConfig, teamId: string | undefined): boolean {
  return !teamId || config.slackAllowedTeamIds.length === 0 || config.slackAllowedTeamIds.includes(teamId);
}

export function isSlackChannelAllowedByEnv(config: ConnectorConfig, channelId: string): boolean {
  return config.slackAllowedChannelIds.length === 0 || config.slackAllowedChannelIds.includes(channelId);
}

export function canSendSystemMessagesToSlackContext(userStore: UserStore, contextKey: ChannelContextKey): boolean {
  if (!userStore.hasAdminUser()) {
    return false;
  }
  const parsed = parseSlackContextKey(contextKey);
  if (!parsed) {
    return false;
  }
  return userStore.snapshot().slackChannels.some((channel) =>
    channel.enabled &&
    channel.channelId === parsed.channelId &&
    (channel.teamId ?? "") === (parsed.teamId ?? "")
  );
}
