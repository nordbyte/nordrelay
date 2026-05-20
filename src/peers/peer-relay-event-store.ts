import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { readJsonFileWithBackup, writeJsonFileAtomic } from "../state/persistence.js";
import type { PeerEventEnvelope, PeerRelayEventEnvelope } from "./peer-types.js";

const DEFAULT_HOME = path.join(os.homedir(), ".nordrelay");
const MAX_EVENTS_PER_PEER = 500;

interface PeerRelayEventStoreDocument {
  version: 1;
  events: PeerRelayEventEnvelope[];
}

export class PeerRelayEventStore {
  readonly filePath: string;

  constructor(home = process.env.NORDRELAY_HOME || DEFAULT_HOME) {
    this.filePath = path.join(home, "peer-relay-events.json");
  }

  append(peerId: string, events: PeerEventEnvelope[]): PeerRelayEventEnvelope[] {
    if (!events.length) return [];
    const receivedAt = new Date().toISOString();
    const envelopes = events.map((event) => ({
      peerId,
      id: randomUUID().replace(/-/g, "").slice(0, 16),
      receivedAt,
      event,
    }));
    this.mutate((payload) => {
      const retainedForOtherPeers = payload.events.filter((item) => item.peerId !== peerId);
      const retainedForPeer = payload.events.filter((item) => item.peerId === peerId).concat(envelopes).slice(-MAX_EVENTS_PER_PEER);
      payload.events = [...retainedForOtherPeers, ...retainedForPeer].sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt));
    });
    return envelopes;
  }

  list(peerId: string, afterId?: string): PeerRelayEventEnvelope[] {
    const events = this.readPayload().events.filter((event) => event.peerId === peerId);
    if (!afterId) return events.slice(-MAX_EVENTS_PER_PEER);
    const index = events.findIndex((event) => event.id === afterId);
    return index >= 0 ? events.slice(index + 1) : events.slice(-100);
  }

  private mutate(mutator: (payload: PeerRelayEventStoreDocument) => void): void {
    const payload = this.readPayload();
    mutator(payload);
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeJsonFileAtomic(this.filePath, payload);
  }

  private readPayload(): PeerRelayEventStoreDocument {
    const payload = readJsonFileWithBackup<PeerRelayEventStoreDocument>(this.filePath).value;
    if (!payload || payload.version !== 1 || !Array.isArray(payload.events)) {
      return { version: 1, events: [] };
    }
    return { version: 1, events: payload.events.filter(isEventEnvelope).slice(-MAX_EVENTS_PER_PEER * 20) };
  }
}

function isEventEnvelope(value: unknown): value is PeerRelayEventEnvelope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.peerId === "string" &&
    typeof record.id === "string" &&
    typeof record.receivedAt === "string" &&
    Boolean(record.event);
}
