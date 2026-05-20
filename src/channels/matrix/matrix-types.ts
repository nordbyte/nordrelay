import type { AuthenticatedUser } from "../../access/user-management.js";
import type { ChannelContext } from "../shared/channel-adapter.js";
import type {
  ChannelBusyReason,
  ChannelBusyState,
  ChannelExternalMirrorState,
  ChannelPickState,
} from "../shared/channel-bridge-state.js";
import type { ChannelContextKey } from "../shared/context-key.js";
import type { MatrixClient, MatrixEvent } from "./matrix-client.js";

export interface MatrixBridge {
  client: MatrixClient;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface MatrixRequest {
  contextKey: ChannelContextKey;
  context: ChannelContext;
  userId: string;
  username?: string;
  homeserver?: string;
  userHomeserver?: string;
  roomId: string;
  roomName?: string;
  isDirectMessage: boolean;
  source: "message" | "action" | "system";
  respond?: (message: unknown) => Promise<unknown>;
  authUser?: AuthenticatedUser;
}

export type MatrixBusyState = ChannelBusyState;
export type MatrixBusyReason = ChannelBusyReason<{ agentLabel: string }>;
export type MatrixPickState = ChannelPickState<"agent" | "session" | "model" | "reasoning" | "launch">;
export type MatrixExternalMirrorState = ChannelExternalMirrorState<string>;

export interface MatrixMessageEvent extends MatrixEvent {
  type: "m.room.message";
  event_id: string;
  room_id: string;
  sender: string;
  content: {
    msgtype?: string;
    body?: string;
    formatted_body?: string;
    url?: string;
    filename?: string;
    info?: {
      mimetype?: string;
      size?: number;
    };
    "m.relates_to"?: MatrixRelation;
  };
}

export interface MatrixRelation {
  rel_type?: string;
  event_id?: string;
  "m.in_reply_to"?: {
    event_id?: string;
  };
}

export interface MatrixAttachment {
  id: string;
  name: string;
  mxcUri: string;
  mimeType?: string;
  size?: number;
}
