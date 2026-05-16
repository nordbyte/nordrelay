import type { ChannelContextKey } from "../channels/shared/context-key.js";
import type { PeerRecord } from "./peer-types.js";

const DEFAULT_SOURCE_CONTEXT: ChannelContextKey = "web:dashboard";

export function peerRuntimeContextKey(peer: Pick<PeerRecord, "id" | "nodeId">, sourceContextKey?: ChannelContextKey): ChannelContextKey {
  const source = sourceContextKey?.trim() || DEFAULT_SOURCE_CONTEXT;
  return `peer:${encodeContextPart(peer.id || peer.nodeId)}:${encodeContextPart(source)}`;
}

export function parsePeerRuntimeContextKey(key: ChannelContextKey): { peerId: string; sourceContextKey: ChannelContextKey } | null {
  const match = /^peer:([^:]+):(.+)$/.exec(key);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    peerId: decodeContextPart(match[1]),
    sourceContextKey: decodeContextPart(match[2]),
  };
}

function encodeContextPart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeContextPart(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}
