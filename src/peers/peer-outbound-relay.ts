import http from "node:http";
import https from "node:https";
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
  let closed = false;
  const timers = new Set<NodeJS.Timeout>();
  const allowedPeerIds = new Set(config.peerOutboundRelayPeerIds);

  const loop = async (peer: PeerRecord): Promise<void> => {
    if (closed) return;
    try {
      const polled = await signedPeerPost<PeerRelayPollResponse>(peer, "/peer/relay/poll", { timeoutMs: config.peerOutboundRelayPollMs });
      const request = polled.request;
      if (request?.request) {
        const result = await executeRelayRequest(service, peer, request.request).catch((error): PeerRpcResult => ({
          ok: false,
          error: peerError(error),
        }));
        await signedPeerPost(peer, "/peer/relay/result", { id: request.id, result });
      }
      store.markSeen(peer.id, { remoteStatus: "relay-polling" });
    } catch (error) {
      store.markError(peer.id, `Outbound relay poll failed: ${peerError(error)}`);
    } finally {
      schedule(peer);
    }
  };

  const schedule = (peer: PeerRecord): void => {
    if (closed) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      void loop(peer);
    }, Math.max(250, config.peerOutboundRelayPollMs));
    timer.unref?.();
    timers.add(timer);
  };

  for (const peer of store.list()) {
    if (!peer.enabled || !peer.url) continue;
    if (allowedPeerIds.size > 0 && !allowedPeerIds.has(peer.id) && !allowedPeerIds.has(peer.nodeId)) continue;
    schedule(peer);
  }

  console.log(`Peer outbound relay: ${allowedPeerIds.size > 0 ? [...allowedPeerIds].join(", ") : "all outbound peers"}`);
  return {
    close: () => {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
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
