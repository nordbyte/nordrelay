import type { AgentSessionInfo, AgentThreadRecord } from "../../agents/shared/agent.js";
import { escapeHTML } from "../../core/format.js";
import { RemoteRelayClient } from "../../peers/peer-client.js";
import { PeerStore } from "../../peers/peer-store.js";
import type { PeerWebProxyPayload } from "../../peers/peer-types.js";
import type { BotPreferencesStore, ChannelMirrorMode } from "../../state/bot-preferences.js";
import type { WebActivityActor } from "../../web/web-state.js";
import type { ChannelActionResponse } from "./channel-actions.js";
import { renderSessionInfoHTML, renderSessionInfoPlain } from "./session-format.js";

export interface RemotePeerWebClient {
  webProxy(peerId: string, payload: PeerWebProxyPayload, actor?: WebActivityActor, sourceContextKey?: string): Promise<unknown>;
}

export interface TargetPeerCommandOptions {
  contextKey: string;
  preferencesStore: BotPreferencesStore;
  remoteClient?: RemotePeerWebClient;
  actor?: WebActivityActor;
}

export interface TargetPeerSessionList {
  peerId: string;
  peerLabel: string;
  sessions: AgentThreadRecord[];
  activeThreadId?: string | null;
}

export interface TargetPeerSwitchResult {
  peerId: string;
  peerLabel: string;
  info: AgentSessionInfo;
}

export function selectedTargetPeerId(preferencesStore: BotPreferencesStore, contextKey: string): string | undefined {
  const targetPeerId = preferencesStore.get(contextKey).targetPeerId ?? undefined;
  return targetPeerId || undefined;
}

export function selectedTargetPeerLabel(peerId: string): string {
  const peer = new PeerStore().get(peerId);
  return peer ? `${peer.name} (${peer.id})` : peerId;
}

export async function renderTargetPeerSession(options: TargetPeerCommandOptions): Promise<ChannelActionResponse | null> {
  const targetPeerId = selectedTargetPeerId(options.preferencesStore, options.contextKey);
  if (!targetPeerId) {
    return null;
  }
  const snapshot = await targetPeerSnapshot(options, targetPeerId);
  const info = snapshot.session;
  return {
    plain: [`Remote peer session: ${selectedTargetPeerLabel(targetPeerId)}`, renderSessionInfoPlain(info)].join("\n"),
    html: [
      `<b>Remote peer session:</b> <code>${escapeHTML(selectedTargetPeerLabel(targetPeerId))}</code>`,
      renderSessionInfoHTML(info),
    ].join("\n"),
  };
}

export async function listTargetPeerSessions(
  options: TargetPeerCommandOptions & { query?: string; limit?: number },
): Promise<TargetPeerSessionList | null> {
  const targetPeerId = selectedTargetPeerId(options.preferencesStore, options.contextKey);
  if (!targetPeerId) {
    return null;
  }
  const [snapshot, page] = await Promise.all([
    targetPeerSnapshot(options, targetPeerId),
    peerProxy(options, targetPeerId, {
      method: "GET",
      path: "/api/sessions",
      query: {
        page: 1,
        limit: options.limit ?? 50,
        query: options.query ?? "",
      },
    }),
  ]);
  return {
    peerId: targetPeerId,
    peerLabel: selectedTargetPeerLabel(targetPeerId),
    sessions: parseSessionPage(page),
    activeThreadId: snapshot.session.threadId,
  };
}

export async function switchTargetPeerSession(
  options: TargetPeerCommandOptions & { threadId: string },
): Promise<TargetPeerSwitchResult | null> {
  const targetPeerId = selectedTargetPeerId(options.preferencesStore, options.contextKey);
  if (!targetPeerId) {
    return null;
  }
  const result = await peerProxy(options, targetPeerId, {
    method: "POST",
    path: "/api/sessions/switch",
    body: { threadId: options.threadId },
  });
  return {
    peerId: targetPeerId,
    peerLabel: selectedTargetPeerLabel(targetPeerId),
    info: parseSessionInfoResult(result),
  };
}

export async function renderTargetPeerMirrorPreference(
  options: TargetPeerCommandOptions & { source: string; argument: string },
): Promise<({ mode: ChannelMirrorMode; response: ChannelActionResponse; peerId: string; peerLabel: string }) | null> {
  const targetPeerId = selectedTargetPeerId(options.preferencesStore, options.contextKey);
  if (!targetPeerId) {
    return null;
  }
  const argument = options.argument.trim();
  const result = await peerProxy(options, targetPeerId, {
    method: argument ? "POST" : "GET",
    path: "/api/chat/mirror",
    body: argument ? { argument } : undefined,
  });
  const parsed = parseMirrorResult(result);
  const peerLabel = selectedTargetPeerLabel(targetPeerId);
  options.preferencesStore.update(options.contextKey, { mirrorMode: parsed.mode });
  return {
    mode: parsed.mode,
    peerId: targetPeerId,
    peerLabel,
    response: {
      plain: [`Remote peer: ${peerLabel}`, parsed.response.plain].join("\n"),
      html: [`<b>Remote peer:</b> <code>${escapeHTML(peerLabel)}</code>`, parsed.response.html].join("\n"),
    },
  };
}

export function remoteSessionChoiceValue(peerId: string, threadId: string): string {
  return `peer:${peerId}:${threadId}`;
}

export function parseRemoteSessionChoice(value: string): { peerId: string; threadId: string } | null {
  const match = /^peer:([^:]+):(.+)$/.exec(value);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    peerId: match[1],
    threadId: match[2],
  };
}

async function targetPeerSnapshot(options: TargetPeerCommandOptions, peerId: string): Promise<{ session: AgentSessionInfo }> {
  const snapshot = await peerProxy(options, peerId, { method: "GET", path: "/api/snapshot" });
  if (!snapshot || typeof snapshot !== "object" || !("session" in snapshot)) {
    throw new Error("Remote peer did not return a session snapshot.");
  }
  const session = (snapshot as { session?: unknown }).session;
  if (!session || typeof session !== "object") {
    throw new Error("Remote peer returned an invalid session snapshot.");
  }
  return { session: session as AgentSessionInfo };
}

async function peerProxy(options: TargetPeerCommandOptions, peerId: string, payload: PeerWebProxyPayload): Promise<unknown> {
  const client = options.remoteClient ?? new RemoteRelayClient();
  return client.webProxy(peerId, payload, options.actor, options.contextKey);
}

function parseSessionPage(value: unknown): AgentThreadRecord[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const sessions = (value as { sessions?: unknown }).sessions;
  return Array.isArray(sessions) ? sessions.filter(isAgentThreadRecord) : [];
}

function parseSessionInfoResult(value: unknown): AgentSessionInfo {
  if (!value || typeof value !== "object") {
    throw new Error("Remote peer returned an invalid session response.");
  }
  const session = (value as { session?: unknown }).session;
  if (!session || typeof session !== "object") {
    throw new Error("Remote peer returned an invalid session response.");
  }
  return session as AgentSessionInfo;
}

function parseMirrorResult(value: unknown): { mode: ChannelMirrorMode; minInterval: number; response: ChannelActionResponse } {
  if (!value || typeof value !== "object") {
    throw new Error("Remote peer returned an invalid mirror response.");
  }
  const record = value as { mode?: unknown; minInterval?: unknown; response?: { plain?: unknown; html?: unknown } };
  if (record.mode !== "off" && record.mode !== "status" && record.mode !== "final" && record.mode !== "full") {
    throw new Error("Remote peer returned an invalid mirror mode.");
  }
  return {
    mode: record.mode,
    minInterval: typeof record.minInterval === "number" ? record.minInterval : 0,
    response: {
      plain: typeof record.response?.plain === "string" ? record.response.plain : `CLI mirroring: ${record.mode}`,
      html: typeof record.response?.html === "string" ? record.response.html : `<b>CLI mirroring:</b> <code>${escapeHTML(record.mode)}</code>`,
    },
  };
}

function isAgentThreadRecord(value: unknown): value is AgentThreadRecord {
  return Boolean(value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string");
}
