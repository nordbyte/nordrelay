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
import { getPeerRelayBroker } from "./peer-relay-broker.js";
import { PeerStore } from "./peer-store.js";
import {
  PEER_PROTOCOL_VERSION,
  type PeerEventEnvelope,
  type PeerEndpointProbeResult,
  type PeerNodeIdentity,
  type PeerPairRequest,
  type PeerPairResponse,
  type PeerRecord,
  type PeerRpcRequest,
  type PeerRpcResult,
  type PeerWebProxyPayload,
} from "./peer-types.js";
import type { WebActivityActor } from "../web/web-state.js";

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

export interface PeerRequestOptions {
  timeoutMs?: number;
}

export async function checkPeerEndpoint(url: string, options: { expectedTlsFingerprint?: string; timeoutMs?: number } = {}): Promise<PeerEndpointProbeResult> {
  const target = joinPeerUrl(url, "/peer/healthz");
  const startedAt = Date.now();
  try {
    const result = await requestJson<{ ok?: unknown; protocolVersion?: unknown }>({
      url: target,
      method: "GET",
      expectedTlsFingerprint: options.expectedTlsFingerprint,
      allowSelfSigned: true,
      timeoutMs: options.timeoutMs ?? 4_000,
    });
    return {
      ok: true,
      status: "reachable",
      url: target,
      latencyMs: Date.now() - startedAt,
      statusCode: result.statusCode,
      tlsFingerprint: result.tlsFingerprint,
      detail: result.data?.ok === true ? "Peer health endpoint is reachable." : "Endpoint responded, but did not return the expected peer health payload.",
    };
  } catch (error) {
    return {
      ok: false,
      status: "unreachable",
      url: target,
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface PeerIdentityProbeResult extends PeerEndpointProbeResult {
  identity?: PeerNodeIdentity;
}

export async function checkPeerIdentityEndpoint(url: string, options: { expectedTlsFingerprint?: string; timeoutMs?: number } = {}): Promise<PeerIdentityProbeResult> {
  const target = joinPeerUrl(url, "/peer/identity");
  const startedAt = Date.now();
  try {
    const result = await requestJson<{ protocolVersion?: unknown; identity?: unknown }>({
      url: target,
      method: "GET",
      expectedTlsFingerprint: options.expectedTlsFingerprint,
      allowSelfSigned: true,
      timeoutMs: options.timeoutMs ?? 4_000,
    });
    const identity = parsePeerIdentity(result.data?.identity);
    const protocolVersion = result.data?.protocolVersion;
    return {
      ok: Boolean(identity) && protocolVersion === PEER_PROTOCOL_VERSION,
      status: "reachable",
      url: target,
      latencyMs: Date.now() - startedAt,
      statusCode: result.statusCode,
      tlsFingerprint: result.tlsFingerprint,
      identity,
      detail: identity && protocolVersion === PEER_PROTOCOL_VERSION
        ? "Peer identity endpoint is reachable."
        : "Endpoint responded, but did not return the expected peer identity payload.",
    };
  } catch (error) {
    return {
      ok: false,
      status: "unreachable",
      url: target,
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
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
    tlsFingerprint: result.tlsFingerprint ?? null,
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
  constructor(private readonly store = new PeerStore(), private readonly home?: string) {}

  async rpc(peerId: string, type: string, payload?: unknown, actor?: WebActivityActor, options: PeerRequestOptions = {}): Promise<unknown> {
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
      if (!peer.url) {
        const result = await getPeerRelayBroker(this.home).enqueue(peer.id, body, options.timeoutMs);
        this.store.markSeen(peer.id, healthPatchFromRpc(type, result.ok ? result.data : null, Date.now() - startedAt));
        if (!result.ok) {
          throw new Error(result.error);
        }
        return result.data;
      }
      const result = await requestJson<PeerRpcResult>({
        url: joinPeerUrl(requiredPeerUrl(peer), "/peer/rpc"),
        method: "POST",
        bodyText,
        headers: signed.headers,
        expectedTlsFingerprint: peer.tlsFingerprint,
        allowSelfSigned: Boolean(peer.tlsFingerprint),
        timeoutMs: options.timeoutMs,
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

  async webProxy(peerId: string, payload: PeerWebProxyPayload, actor?: WebActivityActor, sourceContextKey?: string, options: PeerRequestOptions = {}): Promise<unknown> {
    return this.rpc(peerId, "web.proxy", sourceContextKey ? { ...payload, contextKey: sourceContextKey } : payload, actor, options);
  }

  subscribe(peerId: string, onEvent: (event: PeerEventEnvelope) => void, onError?: (error: Error) => void, sourceContextKey?: string): { close: () => void } {
    const peer = this.requiredPeer(peerId);
    const url = new URL(joinPeerUrl(requiredPeerUrl(peer), "/peer/events"));
    if (sourceContextKey) {
      url.searchParams.set("contextKey", sourceContextKey);
    }
    const signed = signPeerRequest(peer, "GET", `${url.pathname}${url.search}`, "");
    const transport = url.protocol === "https:" ? https : http;
    let closed = false;
    const req = transport.request({
      method: "GET",
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: signed.headers,
      agent: false,
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
      if (closed) {
        return;
      }
      this.store.markError(peer.id, error.message);
      onError?.(error);
    });
    req.end();
    return {
      close: () => {
        closed = true;
        req.destroy();
      },
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
    return { check: type, code: "peer.ok", latencyMs, remoteStatus: "online" };
  }
  const record = data as { version?: unknown; status?: unknown };
  return {
    latencyMs,
    check: type,
    code: "peer.ok",
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
  timeoutMs?: number;
}

async function requestJson<T>(options: JsonRequestOptions): Promise<{ data: T; statusCode?: number; tlsFingerprint?: string }> {
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
      agent: false,
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
        resolve({ data: data as T, statusCode: res.statusCode, tlsFingerprint });
      });
    });
    req.on("error", reject);
    req.setTimeout(options.timeoutMs ?? 15_000, () => req.destroy(new Error(`Peer request timed out after ${options.timeoutMs ?? 15_000}ms.`)));
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

function parsePeerIdentity(value: unknown): PeerNodeIdentity | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.nodeId !== "string" ||
    typeof record.name !== "string" ||
    typeof record.publicKey !== "string" ||
    typeof record.fingerprint !== "string" ||
    typeof record.createdAt !== "string"
  ) {
    return undefined;
  }
  return {
    nodeId: record.nodeId,
    name: record.name,
    publicKey: record.publicKey,
    fingerprint: record.fingerprint,
    createdAt: record.createdAt,
  };
}
