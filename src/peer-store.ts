import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ALL_PERMISSIONS, type Permission } from "./access-control.js";
import { AGENT_IDS, isAgentId, type AgentId } from "./agent.js";
import { readJsonFileWithBackup, writeJsonFileAtomic } from "./persistence.js";
import {
  DEFAULT_PEER_SCOPES,
  publicInvitation,
  publicPeer,
  type PeerInvitationRecord,
  type PeerRecord,
  type PeerSnapshot,
  type PeerStorePayload,
  type PublicPeerInvitationRecord,
  type PublicPeerRecord,
} from "./peer-types.js";

const DEFAULT_HOME = path.join(os.homedir(), ".nordrelay");
const INVITE_CODE_BYTES = 18;
const MAX_INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface PeerInviteOptions {
  name?: string;
  expiresInMs?: number;
  scopes?: Permission[];
  allowedAgents?: AgentId[];
  allowedWorkspaceRoots?: string[];
  workspaceAliases?: Record<string, string>;
}

export interface PeerUpsertInput {
  id?: string;
  name: string;
  url?: string;
  nodeId: string;
  publicKey: string;
  fingerprint: string;
  tlsFingerprint?: string;
  secret: string;
  enabled?: boolean;
  direction?: PeerRecord["direction"];
  scopes?: Permission[];
  allowedAgents?: AgentId[];
  allowedWorkspaceRoots?: string[];
  workspaceAliases?: Record<string, string>;
}

export interface PeerHealthPatch {
  latencyMs?: number;
  remoteVersion?: string;
  remoteStatus?: string;
}

export class PeerStore {
  readonly filePath: string;

  constructor(home = process.env.NORDRELAY_HOME || DEFAULT_HOME) {
    this.filePath = path.join(home, "peers.json");
  }

  snapshot(identity: PeerSnapshot["identity"], options: { enabled: boolean; listenUrl: string; requireTls: boolean }): PeerSnapshot {
    const payload = this.readPayload();
    return {
      identity,
      enabled: options.enabled,
      listenUrl: options.listenUrl,
      requireTls: options.requireTls,
      peers: payload.peers.map(publicPeer),
      invitations: payload.invitations.map(publicInvitation),
    };
  }

  list(): PeerRecord[] {
    return this.readPayload().peers;
  }

  listPublic(): PublicPeerRecord[] {
    return this.list().map(publicPeer);
  }

  get(id: string): PeerRecord | null {
    return this.readPayload().peers.find((peer) => peer.id === id || peer.nodeId === id) ?? null;
  }

  createInvitation(options: PeerInviteOptions = {}): { invitation: PublicPeerInvitationRecord; code: string } {
    const code = randomBytes(INVITE_CODE_BYTES).toString("base64url");
    const now = new Date();
    const requestedTtl = options.expiresInMs ?? 10 * 60 * 1000;
    const ttl = Math.max(1_000, Math.min(requestedTtl, MAX_INVITATION_TTL_MS));
    const expiresAt = new Date(now.getTime() + ttl);
    const invitation: PeerInvitationRecord = {
      id: randomUUID().replace(/-/g, "").slice(0, 12),
      name: options.name?.trim() || "NordRelay peer",
      codeHash: hashSecret(code),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      scopes: normalizeScopes(options.scopes ?? DEFAULT_PEER_SCOPES),
      allowedAgents: normalizeAgents(options.allowedAgents ?? [...AGENT_IDS]),
      allowedWorkspaceRoots: normalizeWorkspaceRoots(options.allowedWorkspaceRoots ?? []),
      workspaceAliases: normalizeWorkspaceAliases(options.workspaceAliases ?? {}),
    };
    this.mutatePayload((payload) => {
      payload.invitations = payload.invitations.filter((item) => !item.usedAt && Date.parse(item.expiresAt) > Date.now());
      payload.invitations.push(invitation);
    });
    return { invitation: publicInvitation(invitation), code };
  }

  consumeInvitation(code: string, usedByNodeId: string): PeerInvitationRecord {
    const trimmed = code.trim();
    if (!trimmed) {
      throw new Error("Pairing code is required.");
    }
    let consumed: PeerInvitationRecord | null = null;
    this.mutatePayload((payload) => {
      const invitation = payload.invitations.find((item) => !item.usedAt && verifySecret(trimmed, item.codeHash));
      if (!invitation) {
        throw new Error("Invalid or already used pairing code.");
      }
      if (Date.parse(invitation.expiresAt) <= Date.now()) {
        throw new Error("Pairing code has expired.");
      }
      invitation.usedAt = new Date().toISOString();
      invitation.usedByNodeId = usedByNodeId;
      consumed = { ...invitation, scopes: [...invitation.scopes], allowedAgents: [...invitation.allowedAgents], allowedWorkspaceRoots: [...invitation.allowedWorkspaceRoots] };
    });
    if (!consumed) {
      throw new Error("Pairing code could not be consumed.");
    }
    return consumed;
  }

  upsertPeer(input: PeerUpsertInput): PeerRecord {
    const now = new Date().toISOString();
    let next: PeerRecord | null = null;
    this.mutatePayload((payload) => {
      const existing = payload.peers.find((peer) => peer.nodeId === input.nodeId || (input.id && peer.id === input.id));
      if (existing) {
        existing.name = input.name.trim() || existing.name;
        existing.url = input.url ?? existing.url;
        existing.publicKey = input.publicKey;
        existing.fingerprint = input.fingerprint;
        existing.tlsFingerprint = input.tlsFingerprint ?? existing.tlsFingerprint;
        existing.secret = input.secret;
        existing.enabled = input.enabled ?? existing.enabled;
        existing.direction = mergeDirection(existing.direction, input.direction ?? existing.direction);
        existing.scopes = normalizeScopes(input.scopes ?? existing.scopes);
        existing.allowedAgents = normalizeAgents(input.allowedAgents ?? existing.allowedAgents);
        existing.allowedWorkspaceRoots = normalizeWorkspaceRoots(input.allowedWorkspaceRoots ?? existing.allowedWorkspaceRoots);
        existing.workspaceAliases = normalizeWorkspaceAliases(input.workspaceAliases ?? existing.workspaceAliases ?? {});
        existing.updatedAt = now;
        delete existing.lastError;
        next = clonePeer(existing);
        return;
      }
      const record: PeerRecord = {
        id: input.id ?? randomUUID().replace(/-/g, "").slice(0, 12),
        name: input.name.trim() || "NordRelay peer",
        url: input.url,
        nodeId: input.nodeId,
        publicKey: input.publicKey,
        fingerprint: input.fingerprint,
        tlsFingerprint: input.tlsFingerprint,
        secret: input.secret,
        enabled: input.enabled ?? true,
        direction: input.direction ?? "outbound",
        scopes: normalizeScopes(input.scopes ?? DEFAULT_PEER_SCOPES),
        allowedAgents: normalizeAgents(input.allowedAgents ?? [...AGENT_IDS]),
        allowedWorkspaceRoots: normalizeWorkspaceRoots(input.allowedWorkspaceRoots ?? []),
        workspaceAliases: normalizeWorkspaceAliases(input.workspaceAliases ?? {}),
        createdAt: now,
        updatedAt: now,
      };
      payload.peers.push(record);
      next = clonePeer(record);
    });
    if (!next) {
      throw new Error("Peer could not be saved.");
    }
    return next;
  }

  updatePeer(id: string, patch: Partial<Pick<PeerRecord, "name" | "url" | "enabled" | "scopes" | "allowedAgents" | "allowedWorkspaceRoots" | "workspaceAliases">>): PeerRecord {
    let next: PeerRecord | null = null;
    this.mutatePayload((payload) => {
      const peer = payload.peers.find((candidate) => candidate.id === id || candidate.nodeId === id);
      if (!peer) {
        throw new Error("Peer not found.");
      }
      if (patch.name !== undefined) peer.name = patch.name.trim() || peer.name;
      if (patch.url !== undefined) peer.url = patch.url.trim() || undefined;
      if (patch.enabled !== undefined) peer.enabled = patch.enabled;
      if (patch.scopes !== undefined) peer.scopes = normalizeScopes(patch.scopes);
      if (patch.allowedAgents !== undefined) peer.allowedAgents = normalizeAgents(patch.allowedAgents);
      if (patch.allowedWorkspaceRoots !== undefined) peer.allowedWorkspaceRoots = normalizeWorkspaceRoots(patch.allowedWorkspaceRoots);
      if (patch.workspaceAliases !== undefined) peer.workspaceAliases = normalizeWorkspaceAliases(patch.workspaceAliases);
      peer.updatedAt = new Date().toISOString();
      next = clonePeer(peer);
    });
    if (!next) {
      throw new Error("Peer not found.");
    }
    return next;
  }

  markSeen(id: string, patch: PeerHealthPatch = {}): void {
    this.patchPeer(id, {
      lastSeenAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
      lastLatencyMs: patch.latencyMs,
      remoteVersion: patch.remoteVersion,
      remoteStatus: patch.remoteStatus ?? "online",
      lastError: undefined,
    });
  }

  markError(id: string, error: string): void {
    this.patchPeer(id, { lastError: error, remoteStatus: "offline", lastCheckedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }

  revokePeer(id: string): boolean {
    let removed = false;
    this.mutatePayload((payload) => {
      const before = payload.peers.length;
      payload.peers = payload.peers.filter((peer) => peer.id !== id && peer.nodeId !== id);
      removed = payload.peers.length !== before;
    });
    return removed;
  }

  deleteInvitation(id: string): PublicPeerInvitationRecord | null {
    let removed: PeerInvitationRecord | null = null;
    this.mutatePayload((payload) => {
      const index = payload.invitations.findIndex((invitation) => invitation.id === id);
      if (index < 0) {
        return;
      }
      const [invitation] = payload.invitations.splice(index, 1);
      removed = invitation;
    });
    return removed ? publicInvitation(removed) : null;
  }

  private patchPeer(id: string, patch: Partial<PeerRecord>): void {
    this.mutatePayload((payload) => {
      const peer = payload.peers.find((candidate) => candidate.id === id || candidate.nodeId === id);
      if (!peer) return;
      Object.assign(peer, patch);
    });
  }

  private mutatePayload<T>(mutator: (payload: PeerStorePayload) => T): T {
    const payload = this.readPayload();
    const result = mutator(payload);
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeJsonFileAtomic(this.filePath, payload);
    return result;
  }

  private readPayload(): PeerStorePayload {
    const payload = readJsonFileWithBackup<PeerStorePayload>(this.filePath).value;
    if (!payload || payload.version !== 1 || !Array.isArray(payload.peers) || !Array.isArray(payload.invitations)) {
      return { version: 1, peers: [], invitations: [] };
    }
    return {
      version: 1,
      peers: payload.peers.filter(isPeerRecord).map((peer) => ({
        ...peer,
        scopes: normalizeScopes(peer.scopes),
        allowedAgents: normalizeAgents(peer.allowedAgents),
        allowedWorkspaceRoots: normalizeWorkspaceRoots(peer.allowedWorkspaceRoots),
        workspaceAliases: normalizeWorkspaceAliases(peer.workspaceAliases ?? {}),
      })),
      invitations: payload.invitations.filter(isInvitationRecord).map((invitation) => ({
        ...invitation,
        scopes: normalizeScopes(invitation.scopes),
        allowedAgents: normalizeAgents(invitation.allowedAgents),
        allowedWorkspaceRoots: normalizeWorkspaceRoots(invitation.allowedWorkspaceRoots),
        workspaceAliases: normalizeWorkspaceAliases(invitation.workspaceAliases ?? {}),
      })),
    };
  }
}

export function hashSecret(value: string): string {
  const salt = randomBytes(16).toString("hex");
  const digest = createHash("sha256").update(`${salt}:${value}`).digest("hex");
  return `${salt}:${digest}`;
}

export function verifySecret(value: string, stored: string): boolean {
  const [salt, digest] = stored.split(":");
  if (!salt || !digest) {
    return false;
  }
  const next = createHash("sha256").update(`${salt}:${value}`).digest();
  const previous = Buffer.from(digest, "hex");
  return previous.length === next.length && timingSafeEqual(previous, next);
}

function normalizeScopes(values: readonly string[]): Permission[] {
  const allowed = new Set(ALL_PERMISSIONS);
  return [...new Set(values.filter((value): value is Permission => allowed.has(value as Permission)))];
}

function normalizeAgents(values: readonly string[]): AgentId[] {
  return [...new Set(values.filter(isAgentId))];
}

function normalizeWorkspaceRoots(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeWorkspaceAliases(value: Record<string, string>): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const aliases: Record<string, string> = {};
  for (const [rawAlias, rawWorkspace] of Object.entries(value ?? {})) {
    const alias = rawAlias.trim();
    const workspace = String(rawWorkspace ?? "").trim();
    if (!alias || !workspace || /[,\s]/.test(alias)) continue;
    aliases[alias] = workspace;
  }
  return aliases;
}

function clonePeer(peer: PeerRecord): PeerRecord {
  return {
    ...peer,
    scopes: [...peer.scopes],
    allowedAgents: [...peer.allowedAgents],
    allowedWorkspaceRoots: [...peer.allowedWorkspaceRoots],
    workspaceAliases: { ...peer.workspaceAliases },
  };
}

function mergeDirection(left: PeerRecord["direction"], right: PeerRecord["direction"]): PeerRecord["direction"] {
  if (left === right) return left;
  return "bidirectional";
}

function isPeerRecord(value: unknown): value is PeerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as PeerRecord;
  return typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.nodeId === "string" &&
    typeof record.publicKey === "string" &&
    typeof record.fingerprint === "string" &&
    typeof record.secret === "string" &&
    typeof record.enabled === "boolean";
}

function isInvitationRecord(value: unknown): value is PeerInvitationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as PeerInvitationRecord;
  return typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.codeHash === "string" &&
    typeof record.expiresAt === "string";
}
