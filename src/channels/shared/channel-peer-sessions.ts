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
  canUsePeer?: (peerId: string) => boolean;
}

export interface TargetPeerSessionList {
  peerId: string;
  peerLabel: string;
  sessions: AgentThreadRecord[];
  activeThreadId?: string | null;
  agentId?: AgentSessionInfo["agentId"];
  agentLabel?: string;
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

export function selectedTargetNodeLabel(preferencesStore: BotPreferencesStore, contextKey: string): string {
  const peerId = selectedTargetPeerId(preferencesStore, contextKey);
  return peerId ? selectedTargetPeerLabel(peerId) : "Local node";
}

export async function renderTargetPeerSession(options: TargetPeerCommandOptions): Promise<ChannelActionResponse | null> {
  const targetPeerId = selectedTargetPeerId(options.preferencesStore, options.contextKey);
  if (!targetPeerId) {
    return null;
  }
  assertTargetPeerAllowed(options, targetPeerId);
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
  assertTargetPeerAllowed(options, targetPeerId);
  const snapshot = await targetPeerSnapshot(options, targetPeerId);
  const page = await peerProxy(options, targetPeerId, {
    method: "GET",
    path: "/api/sessions",
    query: {
      page: 1,
      limit: options.limit ?? 50,
      query: options.query ?? "",
      agent: snapshot.session.agentId,
    },
  });
  return {
    peerId: targetPeerId,
    peerLabel: selectedTargetPeerLabel(targetPeerId),
    sessions: parseSessionPage(page),
    activeThreadId: snapshot.session.threadId,
    agentId: snapshot.session.agentId,
    agentLabel: snapshot.session.agentLabel,
  };
}

export async function switchTargetPeerSession(
  options: TargetPeerCommandOptions & { threadId: string },
): Promise<TargetPeerSwitchResult | null> {
  const targetPeerId = selectedTargetPeerId(options.preferencesStore, options.contextKey);
  if (!targetPeerId) {
    return null;
  }
  assertTargetPeerAllowed(options, targetPeerId);
  const result = await peerProxy(options, targetPeerId, {
    method: "POST",
    path: "/api/sessions/switch",
    body: { threadId: options.threadId },
  });
  const info = parseSessionInfoResult(result);
  options.preferencesStore.update(options.contextKey, {
    targetPeerId,
    targetThreadId: info.threadId ?? options.threadId,
    targetAgentId: info.agentId ?? null,
  });
  return {
    peerId: targetPeerId,
    peerLabel: selectedTargetPeerLabel(targetPeerId),
    info,
  };
}

export async function renderTargetPeerMirrorPreference(
  options: TargetPeerCommandOptions & { source: string; argument: string },
): Promise<({ mode: ChannelMirrorMode; response: ChannelActionResponse; peerId: string; peerLabel: string }) | null> {
  const targetPeerId = selectedTargetPeerId(options.preferencesStore, options.contextKey);
  if (!targetPeerId) {
    return null;
  }
  assertTargetPeerAllowed(options, targetPeerId);
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
  assertTargetPeerAllowed(options, peerId);
  const client = options.remoteClient ?? new RemoteRelayClient();
  return client.webProxy(peerId, payload, options.actor, options.contextKey);
}

function assertTargetPeerAllowed(options: Pick<TargetPeerCommandOptions, "canUsePeer">, peerId: string): void {
  if (options.canUsePeer && !options.canUsePeer(peerId)) {
    throw new Error(`Access denied for peer target: ${selectedTargetPeerLabel(peerId)}.`);
  }
}

function parseSessionPage(value: unknown): AgentThreadRecord[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const sessions = (value as { sessions?: unknown }).sessions;
  return Array.isArray(sessions) ? sessions.filter(isAgentThreadRecord).map(normalizeAgentThreadRecord) : [];
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

function normalizeAgentThreadRecord(record: AgentThreadRecord): AgentThreadRecord {
  const updatedAt = normalizeDate((record as { updatedAt?: unknown }).updatedAt) ?? new Date(0);
  const createdAt = normalizeDate((record as { createdAt?: unknown }).createdAt) ?? updatedAt;
  return {
    ...record,
    createdAt,
    updatedAt,
  };
}

function normalizeDate(value: unknown): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}
