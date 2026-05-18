import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { PeerRelayRequestEnvelope, PeerRpcRequest, PeerRpcResult } from "./peer-types.js";

const DEFAULT_HOME = path.join(os.homedir(), ".nordrelay");
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 120_000;
const POLL_SLICE_MS = 500;

interface PendingRelayRequest {
  envelope: PeerRelayRequestEnvelope;
  resolve: (result: PeerRpcResult) => void;
  reject: (error: Error) => void;
}

export class PeerRelayBroker {
  private readonly pending = new Map<string, PendingRelayRequest[]>();
  private readonly inFlight = new Map<string, PendingRelayRequest>();

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
      return false;
    }
    this.inFlight.delete(key);
    request.resolve(result);
    return true;
  }

  stats(peerId?: string): { pending: number } {
    if (peerId) return { pending: this.pending.get(peerId)?.length ?? 0 };
    let pending = 0;
    for (const queue of this.pending.values()) pending += queue.length;
    return { pending };
  }

  private shift(peerId: string): PendingRelayRequest | null {
    const queue = this.pending.get(peerId) ?? [];
    const now = Date.now();
    while (queue.length) {
      const request = queue.shift()!;
      if (Date.parse(request.envelope.expiresAt) > now) {
        if (queue.length) this.pending.set(peerId, queue);
        else this.pending.delete(peerId);
        this.inFlight.set(relayKey(peerId, request.envelope.id), request);
        return request;
      }
      request.reject(new Error("Peer relay request expired."));
    }
    this.pending.delete(peerId);
    return null;
  }

  private remove(peerId: string, id: string): boolean {
    if (this.inFlight.delete(relayKey(peerId, id))) {
      return true;
    }
    const queue = this.pending.get(peerId) ?? [];
    const next = queue.filter((item) => item.envelope.id !== id);
    if (next.length === queue.length) return false;
    if (next.length) this.pending.set(peerId, next);
    else this.pending.delete(peerId);
    return true;
  }
}

const brokers = new Map<string, PeerRelayBroker>();

export function getPeerRelayBroker(home = process.env.NORDRELAY_HOME || DEFAULT_HOME): PeerRelayBroker {
  const key = path.resolve(home);
  let broker = brokers.get(key);
  if (!broker) {
    broker = new PeerRelayBroker();
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
