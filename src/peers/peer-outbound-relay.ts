import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { TLSSocket } from "node:tls";

import type { ConnectorConfig } from "../core/config.js";
import type { RelayRuntime } from "../runtime/relay-runtime.js";
import { signPeerRequest } from "./peer-auth.js";
import { PeerRuntimeService, peerError } from "./peer-runtime-service.js";
import { PeerStore } from "./peer-store.js";
import type { PeerRecord, PeerRelayPollResponse, PeerRpcRequest, PeerRpcResult } from "./peer-types.js";

export interface PeerOutboundRelayHandle {
  close(): void;
}

export interface PeerOutboundRelayPeerSnapshot {
  peerId: string;
  peerName?: string;
  enabled: boolean;
  allowed: boolean;
  failures: number;
  idlePolls: number;
  nextPollAt?: string;
  lastPollAt?: string;
  lastRequestAt?: string;
  lastCompletedAt?: string;
  lastError?: string;
  completedRequests: number;
}

export interface PeerOutboundRelaySnapshot {
  enabled: boolean;
  allowedPeerIds: string[];
  peers: PeerOutboundRelayPeerSnapshot[];
  updatedAt: string;
}

const DEFAULT_HOME = path.join(os.homedir(), ".nordrelay");
const outboundRelaySnapshots = new Map<string, PeerOutboundRelaySnapshot>();

export function startPeerOutboundRelay(options: {
  config: ConnectorConfig;
  runtime: RelayRuntime;
  home?: string;
}): PeerOutboundRelayHandle | null {
  const { config, runtime, home } = options;
  if (!config.peerOutboundRelayEnabled) {
    return null;
  }
  const store = new PeerStore(home);
  const service = new PeerRuntimeService(config, runtime);
  const homeKey = path.resolve(home || process.env.NORDRELAY_HOME || DEFAULT_HOME);
  let closed = false;
  const timers = new Map<string, NodeJS.Timeout>();
  const peerState = new Map<string, PeerOutboundRelayPeerSnapshot>();
  const allowedPeerIds = new Set(config.peerOutboundRelayPeerIds);

  const loop = async (peerId: string): Promise<void> => {
    if (closed) return;
    const peer = store.get(peerId);
    if (!peer || !isRelayPeerAllowed(peer, allowedPeerIds)) {
      return;
    }
    const state = relayPeerState(peerState, peer.id);
    Object.assign(state, { peerName: peer.name, enabled: peer.enabled, allowed: true, lastPollAt: new Date().toISOString() });
    writeOutboundSnapshot(homeKey, config, peerState);
    try {
      const polled = await signedPeerPost<PeerRelayPollResponse>(peer, "/peer/relay/poll", { timeoutMs: config.peerOutboundRelayPollMs });
      const request = polled.request;
      if (request?.request) {
        state.lastRequestAt = new Date().toISOString();
        const result = await executeRelayRequest(service, peer, request.request).catch((error): PeerRpcResult => ({
          ok: false,
          error: peerError(error),
        }));
        await signedPeerPost(peer, "/peer/relay/result", { id: request.id, result });
        state.idlePolls = 0;
        state.failures = 0;
        state.lastCompletedAt = new Date().toISOString();
        state.completedRequests += 1;
        state.lastError = result.ok ? undefined : result.error;
      } else {
        state.idlePolls = Math.min(state.idlePolls + 1, 8);
        state.failures = 0;
        state.lastError = undefined;
      }
      store.markSeen(peer.id, { remoteStatus: "relay-polling" });
    } catch (error) {
      state.failures = Math.min(state.failures + 1, 8);
      state.idlePolls = 0;
      state.lastError = peerError(error);
      store.markError(peer.id, `Outbound relay poll failed: ${state.lastError}`);
    } finally {
      schedule(peer.id, nextDelayMs(config.peerOutboundRelayPollMs, state));
      writeOutboundSnapshot(homeKey, config, peerState);
    }
  };

  const schedule = (peerId: string, delayMs = config.peerOutboundRelayPollMs): void => {
    if (closed) return;
    if (timers.has(peerId)) return;
    const state = relayPeerState(peerState, peerId);
    state.nextPollAt = new Date(Date.now() + Math.max(250, delayMs)).toISOString();
    writeOutboundSnapshot(homeKey, config, peerState);
    const timer = setTimeout(() => {
      timers.delete(peerId);
      void loop(peerId);
    }, Math.max(250, delayMs));
    timer.unref?.();
    timers.set(peerId, timer);
  };

  const scheduleKnownPeers = () => {
    for (const peer of store.list()) {
      if (isRelayPeerAllowed(peer, allowedPeerIds)) schedule(peer.id, 250);
    }
  };

  scheduleKnownPeers();
  const refreshTimer = setInterval(scheduleKnownPeers, Math.max(30_000, config.peerOutboundRelayPollMs * 5));
  refreshTimer.unref?.();

  console.log(`Peer outbound relay: ${allowedPeerIds.size > 0 ? [...allowedPeerIds].join(", ") : "all outbound peers"}`);
  return {
    close: () => {
      closed = true;
      clearInterval(refreshTimer);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      outboundRelaySnapshots.set(homeKey, {
        enabled: false,
        allowedPeerIds: [...allowedPeerIds],
        peers: [...peerState.values()].map((peer) => ({ ...peer, enabled: false })),
        updatedAt: new Date().toISOString(),
      });
    },
  };
}

function isRelayPeerAllowed(peer: PeerRecord, allowedPeerIds: Set<string>): boolean {
  if (!peer.enabled || !peer.url) return false;
  return allowedPeerIds.size === 0 || allowedPeerIds.has(peer.id) || allowedPeerIds.has(peer.nodeId);
}

export function getPeerOutboundRelaySnapshot(home = process.env.NORDRELAY_HOME || DEFAULT_HOME): PeerOutboundRelaySnapshot {
  return outboundRelaySnapshots.get(path.resolve(home)) ?? {
    enabled: false,
    allowedPeerIds: [],
    peers: [],
    updatedAt: new Date().toISOString(),
  };
}

function relayPeerState(states: Map<string, PeerOutboundRelayPeerSnapshot>, peerId: string): PeerOutboundRelayPeerSnapshot {
  const state = states.get(peerId) ?? { peerId, enabled: true, allowed: true, failures: 0, idlePolls: 0, completedRequests: 0 };
  states.set(peerId, state);
  return state;
}

function nextDelayMs(baseMs: number, state: { failures: number; idlePolls: number }): number {
  const base = Math.max(250, baseMs);
  if (state.failures > 0) {
    return withJitter(Math.min(base * 2 ** state.failures, 5 * 60_000));
  }
  if (state.idlePolls > 0) {
    return withJitter(Math.min(base * (state.idlePolls + 1), 60_000));
  }
  return 250;
}

function writeOutboundSnapshot(homeKey: string, config: ConnectorConfig, states: Map<string, PeerOutboundRelayPeerSnapshot>): void {
  outboundRelaySnapshots.set(homeKey, {
    enabled: config.peerOutboundRelayEnabled,
    allowedPeerIds: [...config.peerOutboundRelayPeerIds],
    peers: [...states.values()].map((peer) => ({ ...peer })),
    updatedAt: new Date().toISOString(),
  });
}

function withJitter(ms: number): number {
  const jitter = Math.floor(ms * 0.2 * Math.random());
  return ms + jitter;
}

async function executeRelayRequest(service: PeerRuntimeService, peer: PeerRecord, request: PeerRpcRequest): Promise<PeerRpcResult> {
  const data = await service.handle(peer, request);
  return { ok: true, data };
}

async function signedPeerPost<T>(peer: PeerRecord, route: string, body: unknown): Promise<T> {
  const bodyText = JSON.stringify(body);
  const signed = signPeerRequest(peer, "POST", route, bodyText);
  return await requestJson<T>({
    url: joinPeerUrl(requiredPeerUrl(peer), route),
    bodyText,
    headers: signed.headers,
    expectedTlsFingerprint: peer.tlsFingerprint,
  });
}

async function requestJson<T>(options: {
  url: string;
  bodyText: string;
  headers: Record<string, string>;
  expectedTlsFingerprint?: string;
}): Promise<T> {
  const url = new URL(options.url);
  const transport = url.protocol === "https:" ? https : http;
  return await new Promise((resolve, reject) => {
    const req = transport.request({
      method: "POST",
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(options.bodyText),
        ...options.headers,
      },
      rejectUnauthorized: false,
    } as https.RequestOptions, (res) => {
      try {
        assertTlsFingerprint(res.socket as TLSSocket, options.expectedTlsFingerprint);
      } catch (error) {
        reject(error);
        req.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data: unknown = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          reject(new Error(`Peer relay returned invalid JSON: ${text.slice(0, 200)}`));
          return;
        }
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(data && typeof data === "object" && "error" in data ? String((data as { error?: unknown }).error) : `HTTP ${res.statusCode}`));
          return;
        }
        resolve(data as T);
      });
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("Peer outbound relay request timed out.")));
    req.write(options.bodyText);
    req.end();
  });
}

function assertTlsFingerprint(socket: TLSSocket, expected?: string): void {
  if (!expected || !socket.encrypted) return;
  const actual = socket.getPeerCertificate()?.fingerprint256?.trim().toLowerCase();
  if (actual !== expected.trim().toLowerCase()) {
    throw new Error("Peer TLS certificate fingerprint mismatch.");
  }
}

function requiredPeerUrl(peer: PeerRecord): string {
  if (!peer.url) throw new Error(`Peer ${peer.name} has no URL.`);
  return peer.url;
}

function joinPeerUrl(base: string, route: string): string {
  const url = new URL(base);
  url.pathname = route;
  url.search = "";
  url.hash = "";
  return url.toString();
}
