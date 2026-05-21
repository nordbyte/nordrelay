import type { ConnectorConfig } from "../../core/config.js";
import type { UserStore } from "../../access/user-management.js";
import { matrixContextKey, parseMatrixContextKey, type ChannelContextKey } from "../shared/context-key.js";
import type { MatrixAttachment, MatrixMessageEvent, MatrixRequest } from "./matrix-types.js";

export interface MatrixRequestContextOptions {
  homeserverName?: string;
  botUserId?: string;
}

export function matrixRequestFromMessage(
  event: MatrixMessageEvent,
  options: MatrixRequestContextOptions,
): MatrixRequest {
  const homeserver = options.homeserverName ?? matrixHomeserverFromUserId(options.botUserId ?? event.sender);
  const userHomeserver = matrixHomeserverFromUserId(event.sender);
  const threadId = matrixThreadId(event);
  return {
    contextKey: matrixContextKey({ homeserver, roomId: event.room_id, threadId }),
    context: { channelId: "matrix", chatId: event.room_id, ...(threadId ? { topicId: threadId } : {}), userId: event.sender, username: event.sender },
    userId: event.sender,
    username: event.sender,
    homeserver,
    userHomeserver,
    roomId: event.room_id,
    roomName: event.room_id,
    isDirectMessage: false,
    source: "message",
  };
}

export function stripMatrixMention(text: string): string {
  return text.replace(/^<@[^>]+>\s*/, "");
}

export function matrixEventText(event: MatrixMessageEvent): string {
  const msgtype = event.content?.msgtype;
  if (msgtype && !["m.text", "m.notice"].includes(msgtype)) {
    return "";
  }
  return typeof event.content?.body === "string" ? event.content.body : "";
}

export function matrixAttachmentsFromEvent(event: MatrixMessageEvent): MatrixAttachment[] {
  const content = event.content ?? {};
  const msgtype = content.msgtype;
  const url = typeof content.url === "string" ? content.url : "";
  if (!url || !["m.file", "m.image", "m.audio", "m.video"].includes(String(msgtype))) {
    return [];
  }
  const name = typeof content.filename === "string"
    ? content.filename
    : typeof content.body === "string" && content.body.trim()
      ? content.body.trim()
      : `${event.event_id}`;
  return [{
    id: event.event_id,
    name,
    mxcUri: url,
    mimeType: content.info?.mimetype,
    size: content.info?.size,
  }];
}

export function matrixThreadId(event: MatrixMessageEvent): string | undefined {
  const relation = event.content?.["m.relates_to"];
  if (relation?.rel_type === "m.thread" && relation.event_id) {
    return relation.event_id;
  }
  return relation?.["m.in_reply_to"]?.event_id;
}

export function matrixHomeserverFromUserId(userId: string): string | undefined {
  const match = userId.match(/^@[^:]+:(.+)$/);
  return match?.[1];
}

export function isMatrixHomeserverAllowed(_config: ConnectorConfig, _homeserver: string | undefined): boolean {
  return true;
}

export function isMatrixRoomAllowedByEnv(config: ConnectorConfig, roomId: string): boolean {
  return config.matrixAllowedRoomIds.length === 0 || config.matrixAllowedRoomIds.includes(roomId);
}

export function canSendSystemMessagesToMatrixContext(userStore: UserStore, contextKey: ChannelContextKey): boolean {
  if (!userStore.hasAdminUser()) {
    return false;
  }
  const parsed = parseMatrixContextKey(contextKey);
  if (!parsed) {
    return false;
  }
  return userStore.snapshot().matrixRooms.some((room) =>
    room.enabled &&
    room.roomId === parsed.roomId &&
    (!room.homeserver || !parsed.homeserver || room.homeserver === parsed.homeserver)
  );
}
