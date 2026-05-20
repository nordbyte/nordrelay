import type {
  ChatInputCommandInteraction,
  Client,
  Message,
  MessageComponentInteraction,
  User,
} from "discord.js";

import type { AuthenticatedUser } from "../../access/user-management.js";
import type { ChannelContext } from "../shared/channel-adapter.js";
import type {
  ChannelBusyReason,
  ChannelBusyState,
  ChannelExternalMirrorState,
  ChannelPickState,
} from "../shared/channel-bridge-state.js";
import type { ChannelContextKey } from "../shared/context-key.js";

export interface DiscordBridge {
  client: Client;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DiscordRequest {
  contextKey: ChannelContextKey;
  context: ChannelContext;
  user: User;
  username?: string;
  guildId?: string;
  channelId: string;
  channelName?: string;
  isDirectMessage: boolean;
  source: "message" | "interaction";
  message?: Message;
  interaction?: ChatInputCommandInteraction | MessageComponentInteraction;
  authUser?: AuthenticatedUser;
}

export type DiscordBusyState = ChannelBusyState;
export type DiscordBusyReason = ChannelBusyReason<{ agentLabel: string }>;
export type DiscordPickState = ChannelPickState<"agent" | "session" | "model" | "reasoning" | "launch" | "queue" | "artifact" | "update">;
export type DiscordExternalMirrorState = ChannelExternalMirrorState<string>;
