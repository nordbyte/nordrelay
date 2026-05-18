import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFileWithBackup, writeJsonFileAtomic } from "../state/persistence.js";
import type { PeerRelayRequestEnvelope, PeerRpcResult } from "./peer-types.js";

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

  cleanupExpired(): void {
    const now = Date.now();
    this.mutate((payload) => {
      payload.pending = payload.pending.filter((item) => Date.parse(item.expiresAt) > now);
      payload.inFlight = payload.inFlight.filter((item) => Date.parse(item.expiresAt) > now);
      payload.completed = payload.completed.slice(0, MAX_COMPLETED_RESULTS);
    });
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
