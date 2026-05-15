import type { IncomingMessage, ServerResponse } from "node:http";

import { isPermission, type Permission } from "./access-control.js";
import { AGENT_IDS, isAgentId, type AgentId } from "./agent.js";
import type { AuditEvent } from "./audit-log.js";
import type { ConnectorConfig } from "./config.js";
import {
  ensurePeerTlsFiles,
  loadOrCreatePeerIdentity,
} from "./peer-identity.js";
import { pairPeer, RemoteRelayClient } from "./peer-client.js";
import { PeerStore } from "./peer-store.js";
import { publicPeer, type PeerWebProxyPayload } from "./peer-types.js";
import type { WebActivityActor } from "./web-state.js";
import {
  arrayStringField,
  objectRecord,
  optionalBooleanField,
  optionalNumberField,
  optionalStringField,
  readJsonBody,
  sendJson,
} from "./web-dashboard-http.js";

export interface DashboardPeerRouteOptions {
  config: ConnectorConfig;
  home: string;
  activityActor: WebActivityActor;
  auditPeerAction?: (action: AuditEvent["action"], description: string) => void;
}

export async function handleDashboardPeerRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: DashboardPeerRouteOptions,
): Promise<boolean> {
  const store = new PeerStore(options.home);
  const identity = loadOrCreatePeerIdentity(options.home, options.config.peerName);
  const tls = options.config.peerTlsEnabled ? ensurePeerTlsFiles(options.home, identity.public) : null;

  if (req.method === "GET" && url.pathname === "/api/peers") {
    sendJson(res, 200, store.snapshot(identity.public, {
      enabled: options.config.peerEnabled,
      listenUrl: peerListenUrl(options.config),
      requireTls: options.config.peerRequireTls,
    }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/peers/invite") {
    const body = await readJsonBody(req);
    const created = store.createInvitation({
      name: optionalStringField(body, "name"),
      expiresInMs: (optionalNumberField(body, "expiresMinutes") ?? 10) * 60 * 1000,
      scopes: parseScopes(arrayStringField(body, "scopes")),
      allowedAgents: parseAgents(arrayStringField(body, "allowedAgents")),
      allowedWorkspaceRoots: arrayStringField(body, "allowedWorkspaceRoots"),
    });
    const listenUrl = peerListenUrl(options.config);
    const command = `nordrelay peer add ${listenUrl} --code ${created.code}`;
    sendJson(res, 201, {
      invitation: created.invitation,
      code: created.code,
      url: listenUrl,
      fingerprint: identity.public.fingerprint,
      tlsFingerprint: tls?.fingerprint,
      command,
    });
    options.auditPeerAction?.("peer_invite_created", created.invitation.name);
    return true;
  }

  if (req.method === "POST" && (url.pathname === "/api/peers" || url.pathname === "/api/peers/pair")) {
    const body = await readJsonBody(req);
    const result = await pairPeer({
      url: requiredString(body, "url"),
      code: requiredString(body, "code"),
      name: optionalStringField(body, "name"),
      publicUrl: optionalStringField(body, "publicUrl"),
    }, identity, store);
    sendJson(res, 201, { peer: publicPeer(result.peer), tlsFingerprint: result.tlsFingerprint });
    options.auditPeerAction?.("peer_paired", `${result.peer.name} (${result.peer.id})`);
    return true;
  }

  const peerMatch = url.pathname.match(/^\/api\/peers\/([^/]+)$/);
  if (peerMatch?.[1] && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const peer = store.updatePeer(decodeURIComponent(peerMatch[1]), {
      name: optionalStringField(body, "name"),
      url: optionalStringField(body, "url"),
      enabled: optionalBooleanField(body, "enabled"),
      scopes: body.scopes === undefined ? undefined : parseScopes(arrayStringField(body, "scopes")),
      allowedAgents: body.allowedAgents === undefined ? undefined : parseAgents(arrayStringField(body, "allowedAgents")),
      allowedWorkspaceRoots: body.allowedWorkspaceRoots === undefined ? undefined : arrayStringField(body, "allowedWorkspaceRoots"),
    });
    sendJson(res, 200, { peer: publicPeer(peer) });
    options.auditPeerAction?.("peer_updated", `${peer.name} (${peer.id})`);
    return true;
  }

  if (peerMatch?.[1] && req.method === "DELETE") {
    const peerId = decodeURIComponent(peerMatch[1]);
    const removed = store.revokePeer(peerId);
    sendJson(res, 200, { removed });
    if (removed) {
      options.auditPeerAction?.("peer_revoked", peerId);
    }
    return true;
  }

  const proxyMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/proxy$/);
  if (proxyMatch?.[1] && req.method === "POST") {
    const body = await readJsonBody(req);
    const payload = parseProxyPayload(body);
    const data = await new RemoteRelayClient(store).webProxy(decodeURIComponent(proxyMatch[1]), payload, options.activityActor);
    sendJson(res, 200, data);
    return true;
  }

  const eventsMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/events$/);
  if (eventsMatch?.[1] && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    const subscription = new RemoteRelayClient(store).subscribe(decodeURIComponent(eventsMatch[1]), (event) => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }, (error) => {
      if (!res.destroyed && !res.writableEnded) {
        res.write("event: status\n");
        res.write(`data: ${JSON.stringify({ type: "status", level: "error", message: error.message, at: new Date().toISOString() })}\n\n`);
      }
    });
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(": heartbeat\n\n");
    }, 25_000);
    heartbeat.unref?.();
    req.on("close", () => {
      clearInterval(heartbeat);
      subscription.close();
    });
    return true;
  }

  return false;
}

function peerListenUrl(config: ConnectorConfig): string {
  if (config.peerPublicUrl) return config.peerPublicUrl;
  const scheme = config.peerTlsEnabled ? "https" : "http";
  const host = config.peerHost === "0.0.0.0" || config.peerHost === "::" ? "127.0.0.1" : config.peerHost;
  const displayHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${scheme}://${displayHost}:${config.peerPort}`;
}

function parseScopes(values: string[]): Permission[] {
  return values.filter(isPermission);
}

function parseAgents(values: string[]): AgentId[] {
  const parsed = values.filter(isAgentId);
  return parsed.length > 0 ? parsed : [...AGENT_IDS];
}

function parseProxyPayload(body: Record<string, unknown>): PeerWebProxyPayload {
  return {
    method: requiredString(body, "method"),
    path: requiredString(body, "path"),
    query: objectRecord(body.query),
    body: objectRecord(body.body),
  };
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new Error(`${key} is required.`);
  }
  return text;
}
