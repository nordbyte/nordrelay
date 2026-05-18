import type { Permission } from "../access/access-control.js";
import type { AgentId } from "../agents/shared/agent.js";
import type { RelayEvent } from "../runtime/relay-runtime-types.js";
import type { WebActivityActor } from "../web/web-state.js";

export const PEER_PROTOCOL_VERSION = 1;

export type PeerDirection = "outbound" | "inbound" | "bidirectional";
export type PeerTrustStatus = "trusted" | "tls-unpinned" | "error" | "disabled";

export interface PeerNodeIdentity {
  nodeId: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
}

export interface PeerHealthSample {
  checkedAt: string;
  status: "online" | "offline";
  latencyMs?: number;
  remoteVersion?: string;
  remoteStatus?: string;
  error?: string;
}

export interface PeerRecord {
  id: string;
  name: string;
  group?: string;
  url?: string;
  nodeId: string;
  publicKey: string;
  fingerprint: string;
  tlsFingerprint?: string;
  secret: string;
  enabled: boolean;
  direction: PeerDirection;
  scopes: Permission[];
  allowedAgents: AgentId[];
  allowedWorkspaceRoots: string[];
  workspaceAliases: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  lastCheckedAt?: string;
  lastLatencyMs?: number;
  remoteVersion?: string;
  remoteStatus?: string;
  lastError?: string;
  healthHistory?: PeerHealthSample[];
}

export interface PeerInvitationRecord {
  id: string;
  name: string;
  group?: string;
  codeHash: string;
  expiresAt: string;
  createdAt: string;
  scopes: Permission[];
  allowedAgents: AgentId[];
  allowedWorkspaceRoots: string[];
  workspaceAliases: Record<string, string>;
  usedAt?: string;
  usedByNodeId?: string;
}

export interface PeerStorePayload {
  version: 1;
  peers: PeerRecord[];
  invitations: PeerInvitationRecord[];
}

export interface PublicPeerRecord {
  id: string;
  name: string;
  group?: string;
  url?: string;
  nodeId: string;
  fingerprint: string;
  tlsFingerprint?: string;
  enabled: boolean;
  direction: PeerDirection;
  scopes: Permission[];
  allowedAgents: AgentId[];
  allowedWorkspaceRoots: string[];
  workspaceAliases: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  lastCheckedAt?: string;
  lastLatencyMs?: number;
  remoteVersion?: string;
  remoteStatus?: string;
  lastError?: string;
  healthHistory?: PeerHealthSample[];
  trustStatus: PeerTrustStatus;
  trustWarnings: string[];
  effectiveAccess?: {
    scopes: Permission[];
    allowedAgents: AgentId[];
    allowedWorkspaceRoots: string[];
    workspaceAliases: Record<string, string>;
  };
}

export interface PublicPeerInvitationRecord {
  id: string;
  name: string;
  group?: string;
  expiresAt: string;
  createdAt: string;
  scopes: Permission[];
  allowedAgents: AgentId[];
  allowedWorkspaceRoots: string[];
  workspaceAliases: Record<string, string>;
  usedAt?: string;
  usedByNodeId?: string;
}

export interface PeerSnapshot {
  identity: PeerNodeIdentity;
  enabled: boolean;
  listenUrl: string;
  requireTls: boolean;
  readiness?: PeerReadiness;
  groups: string[];
  peers: PublicPeerRecord[];
  invitations: PublicPeerInvitationRecord[];
}

export interface PeerReadiness {
  enabled: boolean;
  listenUrl: string;
  bindHost: string;
  port: number;
  tlsEnabled: boolean;
  requireTls: boolean;
  localListening: boolean;
  loopbackOnly: boolean;
  bindLoopbackOnly: boolean;
  manualCheckCommand: string;
  warnings: string[];
}

export interface PeerEndpointProbeResult {
  ok: boolean;
  status: "reachable" | "unreachable";
  url: string;
  latencyMs?: number;
  statusCode?: number;
  tlsFingerprint?: string;
  detail: string;
}

export interface PeerDiscoveryCandidate {
  url: string;
  host: string;
  port: number;
  scheme: "http" | "https";
  nodeId: string;
  name: string;
  fingerprint: string;
  tlsFingerprint?: string;
  latencyMs?: number;
}

export interface PeerDiscoveryResult {
  scanned: number;
  candidates: PeerDiscoveryCandidate[];
  warnings: string[];
}

export type PeerDiscoveryJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface PeerDiscoveryJobSnapshot {
  id: string;
  status: PeerDiscoveryJobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  scanned: number;
  total: number;
  candidates: PeerDiscoveryCandidate[];
  warnings: string[];
  log: string[];
  error?: string;
  options: {
    targets: string[];
    timeoutMs: number;
    concurrency: number;
    maxHosts: number;
  };
}

export interface PeerIdentityBackup {
  version: 1;
  exportedAt: string;
  identity: PeerNodeIdentity;
  privateKey: string;
  tlsFingerprint?: string;
}

export interface PeerInviteResult {
  invitation: PublicPeerInvitationRecord;
  code: string;
  url: string;
  fingerprint: string;
  command: string;
}

export interface PeerPairRequest {
  code: string;
  name?: string;
  publicUrl?: string;
  identity: PeerNodeIdentity;
  timestamp: string;
  signature: string;
}

export interface PeerPairResponse {
  protocolVersion: number;
  identity: PeerNodeIdentity;
  peerId: string;
  secret: string;
  scopes: Permission[];
  allowedAgents: AgentId[];
  allowedWorkspaceRoots: string[];
  workspaceAliases: Record<string, string>;
}

export interface PeerRpcRequest {
  protocolVersion: number;
  type: string;
  payload?: unknown;
  actor?: WebActivityActor;
}

export interface PeerRpcResponse {
  ok: true;
  data: unknown;
}

export interface PeerRpcError {
  ok: false;
  error: string;
}

export type PeerRpcResult = PeerRpcResponse | PeerRpcError;

export interface PeerRelayRequestEnvelope {
  id: string;
  peerId: string;
  createdAt: string;
  expiresAt: string;
  request: PeerRpcRequest;
}

export interface PublicPeerRelayRequest {
  id: string;
  peerId: string;
  state: "pending" | "in-flight";
  createdAt: string;
  expiresAt: string;
  ageMs: number;
  expiresInMs: number;
  requestType: string;
  path?: string;
  contextKey?: string;
  actorLabel?: string;
}

export interface PublicPeerRelayResult {
  id: string;
  peerId: string;
  resolvedAt: string;
  ok: boolean;
  error?: string;
}

export interface PeerRelayQueueSnapshot {
  pending: PublicPeerRelayRequest[];
  inFlight: PublicPeerRelayRequest[];
  completed: PublicPeerRelayResult[];
}

export interface PeerRelayPollRequest {
  timeoutMs?: number;
}

export interface PeerRelayPollResponse {
  request: PeerRelayRequestEnvelope | null;
}

export interface PeerRelayResultRequest {
  id: string;
  result: PeerRpcResult;
}

export interface PeerWebProxyPayload {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  contextKey?: string;
}

export type PeerEventEnvelope = RelayEvent;

export const DEFAULT_PEER_SCOPES: Permission[] = [
  "inspect",
  "sessions.read",
  "sessions.write",
  "prompt.send",
  "prompt.abort",
  "queue.read",
  "queue.write",
  "queue.plan.read",
  "queue.plan.write",
  "queue.plan.approve",
  "files.read",
  "files.write",
  "diagnostics.read",
  "logs.read",
];

export function publicPeer(record: PeerRecord): PublicPeerRecord {
  const trust = peerTrust(record);
  return {
    id: record.id,
    name: record.name,
    group: record.group,
    url: record.url,
    nodeId: record.nodeId,
    fingerprint: record.fingerprint,
    tlsFingerprint: record.tlsFingerprint,
    enabled: record.enabled,
    direction: record.direction,
    scopes: [...record.scopes],
    allowedAgents: [...record.allowedAgents],
    allowedWorkspaceRoots: [...record.allowedWorkspaceRoots],
    workspaceAliases: { ...record.workspaceAliases },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastSeenAt: record.lastSeenAt,
    lastCheckedAt: record.lastCheckedAt,
    lastLatencyMs: record.lastLatencyMs,
    remoteVersion: record.remoteVersion,
    remoteStatus: record.remoteStatus,
    lastError: record.lastError,
    healthHistory: record.healthHistory?.map((sample) => ({ ...sample })),
    trustStatus: trust.status,
    trustWarnings: trust.warnings,
    effectiveAccess: {
      scopes: [...record.scopes],
      allowedAgents: [...record.allowedAgents],
      allowedWorkspaceRoots: [...record.allowedWorkspaceRoots],
      workspaceAliases: { ...record.workspaceAliases },
    },
  };
}

function peerTrust(record: PeerRecord): { status: PeerTrustStatus; warnings: string[] } {
  const warnings: string[] = [];
  if (!record.enabled) {
    warnings.push("Peer is disabled.");
    return { status: "disabled", warnings };
  }
  if (record.lastError) {
    warnings.push(record.lastError);
    return { status: "error", warnings };
  }
  if (record.url?.startsWith("https://") && !record.tlsFingerprint) {
    warnings.push("TLS fingerprint is not pinned yet. Probe or re-pin this peer before using it over untrusted networks.");
    return { status: "tls-unpinned", warnings };
  }
  return { status: "trusted", warnings };
}

export function publicInvitation(record: PeerInvitationRecord): PublicPeerInvitationRecord {
  return {
    id: record.id,
    name: record.name,
    group: record.group,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    scopes: [...record.scopes],
    allowedAgents: [...record.allowedAgents],
    allowedWorkspaceRoots: [...record.allowedWorkspaceRoots],
    workspaceAliases: { ...record.workspaceAliases },
    usedAt: record.usedAt,
    usedByNodeId: record.usedByNodeId,
  };
}
