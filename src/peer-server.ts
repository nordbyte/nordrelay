import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { URL } from "node:url";

import type { ConnectorConfig } from "./config.js";
import { friendlyErrorText } from "./error-messages.js";
import {
  createPairingSignaturePayload,
  createSharedSecret,
  ensurePeerTlsFiles,
  fingerprintForPublicKey,
  loadOrCreatePeerIdentity,
  verifyPeerPayload,
} from "./peer-identity.js";
import { header, PeerNonceCache, verifyPeerRequest } from "./peer-auth.js";
import { PeerStore } from "./peer-store.js";
import { PeerRuntimeService, peerError } from "./peer-runtime-service.js";
import {
  PEER_PROTOCOL_VERSION,
  type PeerPairRequest,
  type PeerPairResponse,
  type PeerRpcRequest,
  type PeerRpcResult,
} from "./peer-types.js";
import type { RelayRuntime } from "./relay-runtime.js";

export interface PeerServerHandle {
  close(): Promise<void>;
  url: string;
  tlsFingerprint?: string;
}

export async function startPeerServer(options: {
  config: ConnectorConfig;
  runtime: RelayRuntime;
  home?: string;
}): Promise<PeerServerHandle | null> {
  const { config, runtime } = options;
  if (!config.peerEnabled) {
    return null;
  }
  const home = options.home ?? process.env.NORDRELAY_HOME;
  const identity = loadOrCreatePeerIdentity(home, config.peerName);
  const store = new PeerStore(home);
  const nonces = new PeerNonceCache();
  const service = new PeerRuntimeService(config, runtime);
  const useTls = config.peerTlsEnabled;
  const tls = useTls ? ensurePeerTlsFiles(home, identity.public) : null;
  if (!useTls && config.peerRequireTls && !isLoopbackHost(config.peerHost)) {
    throw new Error("Peer server refuses plaintext on non-loopback hosts. Set NORDRELAY_PEER_TLS_ENABLED=true or bind to 127.0.0.1.");
  }

  const server = useTls
    ? createHttpsServer({ cert: tls!.cert, key: tls!.key }, handleRequest)
    : createHttpServer(handleRequest);

  await new Promise<void>((resolve) => server.listen(config.peerPort, config.peerHost, resolve));
  const scheme = useTls ? "https" : "http";
  const host = config.peerHost === "0.0.0.0" || config.peerHost === "::" ? "127.0.0.1" : config.peerHost;
  const displayHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const url = config.peerPublicUrl || `${scheme}://${displayHost}:${config.peerPort}`;
  console.log(`Peer server: ${url} (${useTls ? `TLS ${tls!.fingerprint}` : "plaintext loopback"})`);

  return {
    url,
    tlsFingerprint: tls?.fingerprint,
    close: () => closeServer(server),
  };

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/peer/healthz") {
        sendJson(res, 200, { ok: true, protocolVersion: PEER_PROTOCOL_VERSION });
        return;
      }
      if (req.method === "GET" && url.pathname === "/peer/identity") {
        sendJson(res, 200, {
          protocolVersion: PEER_PROTOCOL_VERSION,
          identity: identity.public,
          tlsFingerprint: tls?.fingerprint,
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/peer/pair") {
        const bodyText = await readBody(req);
        const body = parseJson<PeerPairRequest>(bodyText);
        const response = handlePair(body);
        sendJson(res, 201, response);
        return;
      }
      if (req.method === "POST" && url.pathname === "/peer/rpc") {
        const bodyText = await readBody(req);
        const peer = authenticate(req, "POST", "/peer/rpc", bodyText);
        const body = parseJson<PeerRpcRequest>(bodyText);
        const data = await service.handle(peer, body);
        const result: PeerRpcResult = { ok: true, data };
        sendJson(res, 200, result);
        return;
      }
      if (req.method === "GET" && url.pathname === "/peer/events") {
        const peer = authenticate(req, "GET", "/peer/events", "");
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        const unsubscribe = service.subscribe(peer, (event) => {
          if (res.destroyed || res.writableEnded) return;
          res.write(`event: ${event.type}\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        const heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(": heartbeat\n\n");
        }, 25_000);
        heartbeat.unref?.();
        req.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      const status = isAuthError(error) ? 403 : 500;
      sendJson(res, status, { error: friendlyErrorText(error) });
    }
  }

  function handlePair(body: PeerPairRequest): PeerPairResponse {
    if (!body?.identity?.nodeId || !body.identity.publicKey || !body.code || !body.signature || !body.timestamp) {
      throw new Error("Invalid peer pairing request.");
    }
    if (fingerprintForPublicKey(body.identity.publicKey) !== body.identity.fingerprint) {
      throw new Error("Pairing identity fingerprint mismatch.");
    }
    if (Math.abs(Date.now() - Date.parse(body.timestamp)) > 5 * 60 * 1000) {
      throw new Error("Pairing request timestamp is outside the allowed clock skew.");
    }
    const signaturePayload = createPairingSignaturePayload(body.identity.nodeId, body.timestamp, body.code);
    if (!verifyPeerPayload(body.identity.publicKey, signaturePayload, body.signature)) {
      throw new Error("Invalid peer pairing signature.");
    }
    const invitation = store.consumeInvitation(body.code, body.identity.nodeId);
    const secret = createSharedSecret();
    const peer = store.upsertPeer({
      name: body.name?.trim() || body.identity.name || invitation.name,
      url: body.publicUrl,
      nodeId: body.identity.nodeId,
      publicKey: body.identity.publicKey,
      fingerprint: body.identity.fingerprint,
      secret,
      enabled: true,
      direction: body.publicUrl ? "bidirectional" : "inbound",
      scopes: invitation.scopes,
      allowedAgents: invitation.allowedAgents,
      allowedWorkspaceRoots: invitation.allowedWorkspaceRoots,
    });
    return {
      protocolVersion: PEER_PROTOCOL_VERSION,
      identity: identity.public,
      peerId: peer.id,
      secret,
      scopes: peer.scopes,
      allowedAgents: peer.allowedAgents,
      allowedWorkspaceRoots: peer.allowedWorkspaceRoots,
    };
  }

  function authenticate(req: IncomingMessage, method: string, pathname: string, body: string) {
    const peerId = header(req, "x-nordrelay-peer-id");
    const peer = peerId ? store.get(peerId) : null;
    if (!peer) {
      throw new Error("Unknown peer.");
    }
    if (!peer.enabled) {
      throw new Error("Peer is disabled.");
    }
    verifyPeerRequest({ req, peer, method, pathname, body, nonces });
    store.markSeen(peer.id);
    return peer;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text || "{}") as T;
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(`${JSON.stringify(value)}\n`);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isAuthError(error: unknown): boolean {
  const message = peerError(error).toLowerCase();
  return /peer|signature|timestamp|replay|permission|denied|auth|disabled/.test(message);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
