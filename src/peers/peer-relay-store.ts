import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFileWithBackup, writeJsonFileAtomic } from "../state/persistence.js";
import type { PeerRelayQueueSnapshot, PeerRelayRequestEnvelope, PeerRpcResult, PublicPeerRelayRequest } from "./peer-types.js";

const DEFAULT_HOME = path.join(os.homedir(), ".nordrelay");
const MAX_COMPLETED_RESULTS = 200;

interface StoredRelayResult {
  peerId: string;
  id: string;
  result: PeerRpcResult;
  resolvedAt: string;
}

interface PeerRelayStoreDocument {
  version: 1;
  pending: PeerRelayRequestEnvelope[];
  inFlight: PeerRelayRequestEnvelope[];
  completed: StoredRelayResult[];
}

export class PeerRelayStore {
  readonly filePath: string;

  constructor(home = process.env.NORDRELAY_HOME || DEFAULT_HOME) {
    this.filePath = path.join(home, "peer-relay-queue.json");
  }

  listPending(): PeerRelayRequestEnvelope[] {
    const payload = this.readPayload();
    return [...payload.pending, ...payload.inFlight].filter((item) => Date.parse(item.expiresAt) > Date.now());
  }

  listInFlight(peerId?: string, id?: string): PeerRelayRequestEnvelope[] {
    const payload = this.readPayload();
    return payload.inFlight.filter((item) => matchesRelay(item, peerId, id));
  }

  snapshot(peerId?: string): PeerRelayQueueSnapshot {
    const payload = this.readPayload();
    const matches = (item: { peerId: string }) => !peerId || item.peerId === peerId;
    return {
      pending: payload.pending.filter(matches).map((item) => publicRelayRequest(item, "pending")),
      inFlight: payload.inFlight.filter(matches).map((item) => publicRelayRequest(item, "in-flight")),
      completed: payload.completed.filter(matches).map((item) => ({
        id: item.id,
        peerId: item.peerId,
        resolvedAt: item.resolvedAt,
        ok: item.result.ok,
        error: item.result.ok ? undefined : item.result.error,
      })),
    };
  }

  addPending(envelope: PeerRelayRequestEnvelope): void {
    this.mutate((payload) => {
      payload.pending = upsertEnvelope(payload.pending, envelope);
      payload.inFlight = payload.inFlight.filter((item) => !sameEnvelope(item, envelope));
    });
  }

  markInFlight(envelope: PeerRelayRequestEnvelope): void {
    this.mutate((payload) => {
      payload.pending = payload.pending.filter((item) => !sameEnvelope(item, envelope));
      payload.inFlight = upsertEnvelope(payload.inFlight, envelope);
    });
  }

  remove(peerId: string, id: string): boolean {
    let removed = false;
    this.mutate((payload) => {
      const pendingBefore = payload.pending.length;
      const inFlightBefore = payload.inFlight.length;
      payload.pending = payload.pending.filter((item) => item.peerId !== peerId || item.id !== id);
      payload.inFlight = payload.inFlight.filter((item) => item.peerId !== peerId || item.id !== id);
      removed = pendingBefore !== payload.pending.length || inFlightBefore !== payload.inFlight.length;
    });
    return removed;
  }

  complete(peerId: string, id: string, result: PeerRpcResult): boolean {
    let found = false;
    this.mutate((payload) => {
      const before = payload.inFlight.length + payload.pending.length;
      payload.pending = payload.pending.filter((item) => item.peerId !== peerId || item.id !== id);
      payload.inFlight = payload.inFlight.filter((item) => item.peerId !== peerId || item.id !== id);
      found = before !== payload.pending.length + payload.inFlight.length;
      payload.completed = [
        { peerId, id, result, resolvedAt: new Date().toISOString() },
        ...payload.completed.filter((item) => item.peerId !== peerId || item.id !== id),
      ].slice(0, MAX_COMPLETED_RESULTS);
    });
    return found;
  }

  cleanupExpired(): { pending: number; inFlight: number } {
    const now = Date.now();
    let removed = { pending: 0, inFlight: 0 };
    this.mutate((payload) => {
      const pendingBefore = payload.pending.length;
      const inFlightBefore = payload.inFlight.length;
      payload.pending = payload.pending.filter((item) => Date.parse(item.expiresAt) > now);
      payload.inFlight = payload.inFlight.filter((item) => Date.parse(item.expiresAt) > now);
      payload.completed = payload.completed.slice(0, MAX_COMPLETED_RESULTS);
      removed = {
        pending: pendingBefore - payload.pending.length,
        inFlight: inFlightBefore - payload.inFlight.length,
      };
    });
    return removed;
  }

  stats(peerId?: string): { pending: number; inFlight: number; completed: number } {
    const payload = this.readPayload();
    const matches = (item: { peerId: string }) => !peerId || item.peerId === peerId;
    return {
      pending: payload.pending.filter(matches).length,
      inFlight: payload.inFlight.filter(matches).length,
      completed: payload.completed.filter(matches).length,
    };
  }

  private mutate(mutator: (payload: PeerRelayStoreDocument) => void): void {
    const payload = this.readPayload();
    mutator(payload);
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeJsonFileAtomic(this.filePath, payload);
  }

  private readPayload(): PeerRelayStoreDocument {
    const payload = readJsonFileWithBackup<PeerRelayStoreDocument>(this.filePath).value;
    if (!payload || payload.version !== 1 || !Array.isArray(payload.pending) || !Array.isArray(payload.inFlight) || !Array.isArray(payload.completed)) {
      return { version: 1, pending: [], inFlight: [], completed: [] };
    }
    return {
      version: 1,
      pending: payload.pending.filter(isEnvelope),
      inFlight: payload.inFlight.filter(isEnvelope),
      completed: payload.completed.filter(isStoredResult),
    };
  }
}

function matchesRelay(item: PeerRelayRequestEnvelope, peerId?: string, id?: string): boolean {
  return (!peerId || item.peerId === peerId) && (!id || item.id === id);
}

function publicRelayRequest(envelope: PeerRelayRequestEnvelope, state: PublicPeerRelayRequest["state"]): PublicPeerRelayRequest {
  const request = envelope.request;
  const payload = request.payload && typeof request.payload === "object" ? request.payload as Record<string, unknown> : {};
  const now = Date.now();
  return {
    id: envelope.id,
    peerId: envelope.peerId,
    state,
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
    ageMs: Math.max(0, now - Date.parse(envelope.createdAt)),
    expiresInMs: Date.parse(envelope.expiresAt) - now,
    requestType: request.type,
    path: typeof payload.path === "string" ? payload.path : undefined,
    contextKey: typeof payload.contextKey === "string" ? payload.contextKey : undefined,
    actorLabel: request.actor?.label ?? request.actor?.username ?? request.actor?.id,
  };
}

function upsertEnvelope(items: PeerRelayRequestEnvelope[], envelope: PeerRelayRequestEnvelope): PeerRelayRequestEnvelope[] {
  return [envelope, ...items.filter((item) => !sameEnvelope(item, envelope))];
}

function sameEnvelope(left: PeerRelayRequestEnvelope, right: PeerRelayRequestEnvelope): boolean {
  return left.peerId === right.peerId && left.id === right.id;
}

function isEnvelope(value: unknown): value is PeerRelayRequestEnvelope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" &&
    typeof record.peerId === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.expiresAt === "string" &&
    Boolean(record.request);
}

function isStoredResult(value: unknown): value is StoredRelayResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.peerId === "string" &&
    typeof record.id === "string" &&
    typeof record.resolvedAt === "string" &&
    Boolean(record.result);
}
