import http from "node:http";
import https from "node:https";
import type { TLSSocket } from "node:tls";

import type { LoadedPeerIdentity } from "./peer-identity.js";
import {
  createPairingSignaturePayload,
  signPeerPayload,
  fingerprintForPublicKey,
} from "./peer-identity.js";
import { signPeerRequest } from "./peer-auth.js";
import { PeerStore } from "./peer-store.js";
import {
  PEER_PROTOCOL_VERSION,
  type PeerEventEnvelope,
  type PeerPairRequest,
  type PeerPairResponse,
  type PeerRecord,
  type PeerRpcRequest,
  type PeerRpcResult,
  type PeerWebProxyPayload,
} from "./peer-types.js";
import type { WebActivityActor } from "./web-state.js";

export interface PairPeerOptions {
  url: string;
  code: string;
  name?: string;
  publicUrl?: string;
}

export interface PairPeerResult {
  peer: PeerRecord;
  tlsFingerprint?: string;
}

export async function pairPeer(options: PairPeerOptions, identity: LoadedPeerIdentity, store = new PeerStore()): Promise<PairPeerResult> {
  const timestamp = new Date().toISOString();
  const payload = createPairingSignaturePayload(identity.public.nodeId, timestamp, options.code);
  const body: PeerPairRequest = {
    code: options.code,
    name: options.name,
    publicUrl: options.publicUrl,
    identity: identity.public,
    timestamp,
    signature: signPeerPayload(identity.privateKey, payload),
  };
  const result = await requestJson<PeerPairResponse>({
    url: joinPeerUrl(options.url, "/peer/pair"),
    method: "POST",
    body,
    allowSelfSigned: true,
  });
  if (result.data.protocolVersion !== PEER_PROTOCOL_VERSION) {
    throw new Error(`Unsupported peer protocol version: ${result.data.protocolVersion}`);
  }
  if (fingerprintForPublicKey(result.data.identity.publicKey) !== result.data.identity.fingerprint) {
    throw new Error("Remote peer identity fingerprint does not match its public key.");
  }
  const peer = store.upsertPeer({
    id: result.data.peerId,
    name: result.data.identity.name,
    url: normalizePeerUrl(options.url),
    nodeId: result.data.identity.nodeId,
    publicKey: result.data.identity.publicKey,
    fingerprint: result.data.identity.fingerprint,
    tlsFingerprint: result.tlsFingerprint,
    secret: result.data.secret,
    enabled: true,
    direction: "outbound",
    scopes: result.data.scopes,
    allowedAgents: result.data.allowedAgents,
    allowedWorkspaceRoots: result.data.allowedWorkspaceRoots,
    workspaceAliases: result.data.workspaceAliases,
  });
  return { peer, tlsFingerprint: result.tlsFingerprint };
}

export class RemoteRelayClient {
  constructor(private readonly store = new PeerStore()) {}

  async rpc(peerId: string, type: string, payload?: unknown, actor?: WebActivityActor): Promise<unknown> {
    const peer = this.requiredPeer(peerId);
    const body: PeerRpcRequest = {
      protocolVersion: PEER_PROTOCOL_VERSION,
      type,
      payload,
      actor,
    };
    const bodyText = JSON.stringify(body);
    const signed = signPeerRequest(peer, "POST", "/peer/rpc", bodyText);
    try {
      const startedAt = Date.now();
      const result = await requestJson<PeerRpcResult>({
        url: joinPeerUrl(requiredPeerUrl(peer), "/peer/rpc"),
        method: "POST",
        bodyText,
        headers: signed.headers,
        expectedTlsFingerprint: peer.tlsFingerprint,
        allowSelfSigned: Boolean(peer.tlsFingerprint),
      });
      this.store.markSeen(peer.id, healthPatchFromRpc(type, result.data.ok ? result.data.data : null, Date.now() - startedAt));
      if (!result.data.ok) {
        throw new Error(result.data.error);
      }
      return result.data.data;
    } catch (error) {
      this.store.markError(peer.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async webProxy(peerId: string, payload: PeerWebProxyPayload, actor?: WebActivityActor, sourceContextKey?: string): Promise<unknown> {
    return this.rpc(peerId, "web.proxy", sourceContextKey ? { ...payload, contextKey: sourceContextKey } : payload, actor);
  }

  subscribe(peerId: string, onEvent: (event: PeerEventEnvelope) => void, onError?: (error: Error) => void, sourceContextKey?: string): { close: () => void } {
    const peer = this.requiredPeer(peerId);
    const url = new URL(joinPeerUrl(requiredPeerUrl(peer), "/peer/events"));
    if (sourceContextKey) {
      url.searchParams.set("contextKey", sourceContextKey);
    }
    const signed = signPeerRequest(peer, "GET", `${url.pathname}${url.search}`, "");
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request({
      method: "GET",
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: signed.headers,
      rejectUnauthorized: false,
    } as https.RequestOptions, (res) => {
      try {
        assertTlsFingerprint(res.socket as TLSSocket, peer.tlsFingerprint);
      } catch (error) {
        req.destroy(error as Error);
        return;
      }
      if ((res.statusCode ?? 500) >= 400) {
        req.destroy(new Error(`Peer events failed with HTTP ${res.statusCode}`));
        return;
      }
      this.store.markSeen(peer.id, { remoteStatus: "online" });
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const data = frame.split(/\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
          if (data) {
            try {
              onEvent(JSON.parse(data) as PeerEventEnvelope);
            } catch {
              // Ignore malformed event frames from a broken peer.
            }
          }
          separator = buffer.indexOf("\n\n");
        }
      });
    });
    req.on("error", (error) => {
      this.store.markError(peer.id, error.message);
      onError?.(error);
    });
    req.end();
    return {
      close: () => req.destroy(),
    };
  }

  private requiredPeer(peerId: string): PeerRecord {
    const peer = this.store.get(peerId);
    if (!peer) {
      throw new Error("Peer not found.");
    }
    if (!peer.enabled) {
      throw new Error("Peer is disabled.");
    }
    return peer;
  }
}

function healthPatchFromRpc(type: string, data: unknown, latencyMs: number): Parameters<PeerStore["markSeen"]>[1] {
  if (type !== "peer.ping" || !data || typeof data !== "object") {
    return { latencyMs, remoteStatus: "online" };
  }
  const record = data as { version?: unknown; status?: unknown };
  return {
    latencyMs,
    remoteVersion: typeof record.version === "string" ? record.version : undefined,
    remoteStatus: typeof record.status === "string" ? record.status : "online",
  };
}

interface JsonRequestOptions {
  url: string;
  method: "GET" | "POST";
  body?: unknown;
  bodyText?: string;
  headers?: Record<string, string>;
  expectedTlsFingerprint?: string;
  allowSelfSigned?: boolean;
}

async function requestJson<T>(options: JsonRequestOptions): Promise<{ data: T; tlsFingerprint?: string }> {
  const url = new URL(options.url);
  const bodyText = options.bodyText ?? (options.body === undefined ? "" : JSON.stringify(options.body));
  const transport = url.protocol === "https:" ? https : http;
  return await new Promise((resolve, reject) => {
    const req = transport.request({
      method: options.method,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(bodyText),
        ...(options.headers ?? {}),
      },
      rejectUnauthorized: options.allowSelfSigned ? false : undefined,
    } as https.RequestOptions, (res) => {
      let tlsFingerprint: string | undefined;
      try {
        tlsFingerprint = assertTlsFingerprint(res.socket as TLSSocket, options.expectedTlsFingerprint);
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
          reject(new Error(`Peer returned invalid JSON: ${text.slice(0, 200)}`));
          return;
        }
        if ((res.statusCode ?? 500) >= 400) {
          const message = data && typeof data === "object" && "error" in data ? String((data as { error?: unknown }).error) : `HTTP ${res.statusCode}`;
          reject(new Error(message));
          return;
        }
        resolve({ data: data as T, tlsFingerprint });
      });
    });
    req.on("error", reject);
    if (bodyText) req.write(bodyText);
    req.end();
  });
}

function assertTlsFingerprint(socket: TLSSocket, expected?: string): string | undefined {
  if (!socket.encrypted) {
    if (expected) {
      throw new Error("Expected a TLS peer connection, but the peer used plaintext HTTP.");
    }
    return undefined;
  }
  const certificate = socket.getPeerCertificate();
  const actual = normalizeFingerprint(certificate?.fingerprint256);
  if (expected && actual !== normalizeFingerprint(expected)) {
    throw new Error("Peer TLS certificate fingerprint mismatch.");
  }
  return actual;
}

function requiredPeerUrl(peer: PeerRecord): string {
  if (!peer.url) {
    throw new Error(`Peer ${peer.name} has no URL.`);
  }
  return peer.url;
}

function joinPeerUrl(base: string, route: string): string {
  const url = new URL(normalizePeerUrl(base));
  url.pathname = route;
  url.search = "";
  return url.toString();
}

function normalizePeerUrl(value: string): string {
  const url = new URL(value);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizeFingerprint(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}
