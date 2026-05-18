import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { PeerRelayQueueSnapshot, PeerRelayRequestEnvelope, PeerRpcRequest, PeerRpcResult } from "./peer-types.js";
import { PeerRelayStore } from "./peer-relay-store.js";

const DEFAULT_HOME = path.join(os.homedir(), ".nordrelay");
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 120_000;
const POLL_SLICE_MS = 500;

interface PendingRelayRequest {
  envelope: PeerRelayRequestEnvelope;
  resolve: (result: PeerRpcResult) => void;
  reject: (error: Error) => void;
  restored?: boolean;
}

export class PeerRelayBroker {
  private readonly pending = new Map<string, PendingRelayRequest[]>();
  private readonly inFlight = new Map<string, PendingRelayRequest>();
  private readonly store: PeerRelayStore;

  constructor(home = process.env.NORDRELAY_HOME || DEFAULT_HOME) {
    this.store = new PeerRelayStore(home);
    this.restorePending();
  }

  enqueue(peerId: string, request: PeerRpcRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<PeerRpcResult> {
    const boundedTimeout = Math.max(1_000, Math.min(timeoutMs, MAX_TIMEOUT_MS));
    const now = Date.now();
    const envelope: PeerRelayRequestEnvelope = {
      id: randomUUID().replace(/-/g, "").slice(0, 16),
      peerId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + boundedTimeout).toISOString(),
      request,
    };
    return new Promise<PeerRpcResult>((resolve, reject) => {
      const queue = this.pending.get(peerId) ?? [];
      queue.push({ envelope, resolve, reject });
      this.pending.set(peerId, queue);
      this.store.addPending(envelope);
      const timer = setTimeout(() => {
        if (this.remove(peerId, envelope.id)) {
          reject(new Error("Peer relay request timed out before the outbound peer picked it up."));
        }
      }, boundedTimeout + 1_000);
      timer.unref?.();
    });
  }

  async poll(peerId: string, timeoutMs = 15_000): Promise<PeerRelayRequestEnvelope | null> {
    const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, MAX_TIMEOUT_MS));
    for (;;) {
      const request = this.shift(peerId);
      if (request) {
        return request.envelope;
      }
      if (Date.now() >= deadline) {
        return null;
      }
      await delay(Math.min(POLL_SLICE_MS, deadline - Date.now()));
    }
  }

  resolve(peerId: string, id: string, result: PeerRpcResult): boolean {
    const key = relayKey(peerId, id);
    const request = this.inFlight.get(key);
    if (!request) {
      return this.store.complete(peerId, id, result);
    }
    this.inFlight.delete(key);
    this.store.complete(peerId, id, result);
    request.resolve(result);
    return true;
  }

  stats(peerId?: string): { pending: number; inFlight: number; completed: number } {
    const stored = this.store.stats(peerId);
    if (peerId) return { ...stored, pending: this.pending.get(peerId)?.length ?? stored.pending, inFlight: [...this.inFlight.keys()].filter((key) => key.startsWith(`${peerId}:`)).length || stored.inFlight };
    let pending = 0;
    for (const queue of this.pending.values()) pending += queue.length;
    return { ...stored, pending: pending || stored.pending, inFlight: this.inFlight.size || stored.inFlight };
  }

  snapshot(peerId?: string): PeerRelayQueueSnapshot {
    return this.store.snapshot(peerId);
  }

  cancel(peerId: string, id: string): boolean {
    const key = relayKey(peerId, id);
    const active = this.inFlight.get(key);
    if (active) {
      this.inFlight.delete(key);
      this.store.remove(peerId, id);
      active.reject(new Error("Peer relay request cancelled."));
      return true;
    }
    const queue = this.pending.get(peerId) ?? [];
    const removed = queue.filter((item) => item.envelope.id === id);
    const next = queue.filter((item) => item.envelope.id !== id);
    if (next.length) this.pending.set(peerId, next);
    else this.pending.delete(peerId);
    for (const item of removed) item.reject(new Error("Peer relay request cancelled."));
    return this.store.remove(peerId, id) || removed.length > 0;
  }

  retry(peerId?: string, id?: string): number {
    let moved = 0;
    for (const envelope of this.store.listInFlight(peerId, id)) {
      if (this.inFlight.has(relayKey(envelope.peerId, envelope.id))) continue;
      const queue = this.pending.get(envelope.peerId) ?? [];
      if (!queue.some((item) => item.envelope.id === envelope.id)) {
        queue.push({ envelope, restored: true, resolve: () => {}, reject: () => {} });
        this.pending.set(envelope.peerId, queue);
      }
      this.store.addPending(envelope);
      moved += 1;
    }
    return moved;
  }

  drainExpired(): { pending: number; inFlight: number } {
    return this.store.cleanupExpired();
  }

  private shift(peerId: string): PendingRelayRequest | null {
    this.store.cleanupExpired();
    const queue = this.pending.get(peerId) ?? [];
    const now = Date.now();
    while (queue.length) {
      const request = queue.shift()!;
      if (Date.parse(request.envelope.expiresAt) > now) {
        if (queue.length) this.pending.set(peerId, queue);
        else this.pending.delete(peerId);
        this.inFlight.set(relayKey(peerId, request.envelope.id), request);
        this.store.markInFlight(request.envelope);
        return request;
      }
      request.reject(new Error("Peer relay request expired."));
    }
    this.pending.delete(peerId);
    return null;
  }

  private remove(peerId: string, id: string): boolean {
    if (this.inFlight.delete(relayKey(peerId, id))) {
      this.store.remove(peerId, id);
      return true;
    }
    const queue = this.pending.get(peerId) ?? [];
    const next = queue.filter((item) => item.envelope.id !== id);
    if (next.length === queue.length) return false;
    if (next.length) this.pending.set(peerId, next);
    else this.pending.delete(peerId);
    this.store.remove(peerId, id);
    return true;
  }

  private restorePending(): void {
    for (const envelope of this.store.listPending()) {
      const queue = this.pending.get(envelope.peerId) ?? [];
      queue.push({
        envelope,
        restored: true,
        resolve: () => {},
        reject: () => {},
      });
      this.pending.set(envelope.peerId, queue);
    }
  }
}

const brokers = new Map<string, PeerRelayBroker>();

export function getPeerRelayBroker(home = process.env.NORDRELAY_HOME || DEFAULT_HOME): PeerRelayBroker {
  const key = path.resolve(home);
  let broker = brokers.get(key);
  if (!broker) {
    broker = new PeerRelayBroker(key);
    brokers.set(key, broker);
  }
  return broker;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function relayKey(peerId: string, id: string): string {
  return `${peerId}:${id}`;
}
