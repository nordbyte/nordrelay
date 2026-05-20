import type { App } from "@slack/bolt";

import type { AuthenticatedUser } from "../../access/user-management.js";
import type { ChannelContext } from "../shared/channel-adapter.js";
import type {
  ChannelBusyReason,
  ChannelBusyState,
  ChannelExternalMirrorState,
  ChannelPickState,
} from "../shared/channel-bridge-state.js";
import type { ChannelContextKey } from "../shared/context-key.js";

export interface SlackBridge {
  app: App;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SlackRequest {
  contextKey: ChannelContextKey;
  context: ChannelContext;
  userId: string;
  username?: string;
  teamId?: string;
  channelId: string;
  channelName?: string;
  isDirectMessage: boolean;
  source: "message" | "slash" | "action" | "system";
  respond?: (message: unknown) => Promise<unknown>;
  authUser?: AuthenticatedUser;
}

export type SlackBusyState = ChannelBusyState;
export type SlackBusyReason = ChannelBusyReason<{ agentLabel: string }>;
export type SlackPickState = ChannelPickState<"agent" | "session" | "model" | "reasoning" | "launch">;
export type SlackExternalMirrorState = ChannelExternalMirrorState<string>;

export interface SlackSlashCommandPayload {
  team_id?: string;
  channel_id: string;
  channel_name?: string;
  user_id: string;
  user_name?: string;
  text?: string;
}

export interface SlackActionBody {
  team?: { id?: string };
  user?: { id?: string; username?: string };
  channel?: { id?: string; name?: string };
  message?: { ts?: string; thread_ts?: string };
}

export interface SlackBoltApp {
  event(name: string, handler: (args: { event: unknown }) => Promise<void>): void;
  command(name: string, handler: (args: { command: unknown; ack: () => Promise<void>; respond: (message: unknown) => Promise<unknown> }) => Promise<void>): void;
  action(pattern: RegExp, handler: (args: { action: { action_id?: string }; body: unknown; ack: () => Promise<void>; respond: (message: unknown) => Promise<unknown> }) => Promise<void>): void;
}
