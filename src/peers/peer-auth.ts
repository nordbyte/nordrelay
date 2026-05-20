import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { PeerRecord } from "./peer-types.js";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;

export interface SignedPeerRequest {
  headers: Record<string, string>;
  timestamp: string;
  nonce: string;
  bodyHash: string;
}

export class PeerNonceCache {
  private readonly seen = new Map<string, number>();

  consume(peerId: string, nonce: string): boolean {
    const now = Date.now();
    for (const [key, expiresAt] of this.seen.entries()) {
      if (expiresAt <= now) {
        this.seen.delete(key);
      }
    }
    const key = `${peerId}:${nonce}`;
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.set(key, now + NONCE_TTL_MS);
    return true;
  }
}

export function signPeerRequest(peer: PeerRecord, method: string, pathname: string, body = ""): SignedPeerRequest {
  const timestamp = new Date().toISOString();
  const nonce = randomBytes(16).toString("base64url");
  const bodyHash = hashBody(body);
  const signature = createSignature(peer.secret, canonicalRequest(method, pathname, timestamp, nonce, bodyHash));
  return {
    timestamp,
    nonce,
    bodyHash,
    headers: {
      "x-nordrelay-peer-id": peer.id,
      "x-nordrelay-peer-timestamp": timestamp,
      "x-nordrelay-peer-nonce": nonce,
      "x-nordrelay-peer-body-sha256": bodyHash,
      "x-nordrelay-peer-signature": signature,
    },
  };
}

export function verifyPeerRequest(options: {
  req: IncomingMessage;
  peer: PeerRecord;
  method: string;
  pathname: string;
  body: string;
  nonces: PeerNonceCache;
}): void {
  const timestamp = header(options.req, "x-nordrelay-peer-timestamp");
  const nonce = header(options.req, "x-nordrelay-peer-nonce");
  const bodyHash = header(options.req, "x-nordrelay-peer-body-sha256");
  const signature = header(options.req, "x-nordrelay-peer-signature");
  if (!timestamp || !nonce || !bodyHash || !signature) {
    throw new Error("Missing peer authentication headers.");
  }
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time) || Math.abs(Date.now() - time) > MAX_CLOCK_SKEW_MS) {
    throw new Error("Peer request timestamp is outside the allowed clock skew.");
  }
  if (hashBody(options.body) !== bodyHash) {
    throw new Error("Peer request body hash mismatch.");
  }
  if (!options.nonces.consume(options.peer.id, nonce)) {
    throw new Error("Replay detected for peer request.");
  }
  const expected = createSignature(options.peer.secret, canonicalRequest(options.method, options.pathname, timestamp, nonce, bodyHash));
  if (!safeEqual(signature, expected)) {
    throw new Error("Invalid peer request signature.");
  }
}

export function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function canonicalRequest(method: string, pathname: string, timestamp: string, nonce: string, bodyHash: string): string {
  return [
    method.toUpperCase(),
    pathname,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");
}

function createSignature(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
