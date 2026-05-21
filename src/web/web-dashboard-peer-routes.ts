import type { IncomingMessage, ServerResponse } from "node:http";

import { isPermission, type Permission } from "../access/access-control.js";
import { AGENT_IDS, isAgentId, type AgentId } from "../agents/shared/agent.js";
import type { AuditEvent } from "../access/audit-log.js";
import type { ConnectorConfig } from "../core/config.js";
import {
  exportPeerIdentityBackup,
  ensurePeerTlsFiles,
  loadOrCreatePeerIdentity,
  restorePeerIdentityBackup,
} from "../peers/peer-identity.js";
import { getPeerOutboundRelaySnapshot } from "../peers/peer-outbound-relay.js";
import { getPeerRelayBroker } from "../peers/peer-relay-broker.js";
import { PeerRelayEventStore } from "../peers/peer-relay-event-store.js";
import { checkPeerEndpoint, checkPeerIdentityEndpoint, pairPeer, RemoteRelayClient } from "../peers/peer-client.js";
import type { PeerDiscoveryJobManager } from "../peers/peer-discovery-jobs.js";
import { buildPeerReadiness, peerListenUrl } from "../peers/peer-readiness.js";
import { discoverLanPeers } from "../peers/peer-discovery.js";
import { PeerStore } from "../peers/peer-store.js";
import { publicPeer, type PeerIdentityBackup, type PeerWebProxyPayload } from "../peers/peer-types.js";
import type { RelayRuntime } from "../runtime/relay-runtime.js";
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
  runtime?: RelayRuntime;
  discoveryJobs?: PeerDiscoveryJobManager;
  activityActor: WebActivityActor;
  auditPeerAction?: (action: AuditEvent["action"], description: string) => void;
}

const PEER_ACTIVE_SESSIONS_TIMEOUT_MS = 3_000;
const PEER_HEALTH_TIMEOUT_MS = 4_000;

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
    const readiness = await buildPeerReadiness(options.config, options.home);
    sendJson(res, 200, store.snapshot(identity.public, {
      enabled: options.config.peerEnabled,
      listenUrl: readiness.listenUrl,
      requireTls: options.config.peerRequireTls,
      readiness,
    }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/peers/invite") {
    const body = await readJsonBody(req);
    const readiness = await buildPeerReadiness(options.config, options.home);
    const created = store.createInvitation({
      name: optionalStringField(body, "name"),
      group: optionalStringField(body, "group"),
      expiresInMs: (optionalNumberField(body, "expiresMinutes") ?? 10) * 60 * 1000,
      scopes: parseScopes(arrayStringField(body, "scopes")),
      allowedAgents: parseAgents(arrayStringField(body, "allowedAgents")),
      allowedWorkspaceRoots: arrayStringField(body, "allowedWorkspaceRoots"),
      workspaceAliases: parseWorkspaceAliases(body.workspaceAliases),
    });
    const listenUrl = readiness.listenUrl;
    const command = `nordrelay peer add ${listenUrl} --code ${created.code}`;
    sendJson(res, 201, {
      invitation: created.invitation,
      code: created.code,
      url: listenUrl,
      fingerprint: identity.public.fingerprint,
      tlsFingerprint: tls?.fingerprint,
      command,
      readiness,
      warnings: readiness.warnings,
    });
    options.auditPeerAction?.("peer_invite_created", created.invitation.name);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/peers/probe") {
    const body = await readJsonBody(req);
    const readiness = await buildPeerReadiness(options.config, options.home);
    const peerId = optionalStringField(body, "peerId");
    if (peerId) {
      const probe = await new RemoteRelayClient(store, options.home).rpc(peerId, "peer.probe", {}, options.activityActor, { timeoutMs: PEER_HEALTH_TIMEOUT_MS });
      sendJson(res, 200, { type: "remote", peerId, readiness, probe });
      options.auditPeerAction?.("peer_probe", peerId);
      return true;
    }
    const expectedTlsFingerprint = options.config.peerPublicUrl ? undefined : tls?.fingerprint;
    const probe = await checkPeerEndpoint(readiness.listenUrl, { expectedTlsFingerprint });
    sendJson(res, 200, { type: "local", readiness, probe });
    options.auditPeerAction?.("peer_probe", readiness.listenUrl);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/peers/discover") {
    const result = await discoverLanPeers(options.config, discoveryOptionsFromQuery(url));
    sendJson(res, 200, result);
    options.auditPeerAction?.("peer_discovery_started", `sync scan ${result.scanned} targets`);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/peers/discovery-jobs") {
    sendJson(res, 200, { jobs: options.discoveryJobs?.list() ?? [] });
    return true;
  }

  if (url.pathname === "/api/peers/relay") {
    const broker = getPeerRelayBroker(options.home);
    if (req.method === "GET") {
      sendJson(res, 200, peerRelayStatus(options, broker));
      return true;
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const action = requiredString(body, "action");
      let result: unknown = {};
      if (action === "cancel") {
        const peerId = requiredString(body, "peerId");
        const id = requiredString(body, "id");
        result = { removed: broker.cancel(peerId, id) };
        options.auditPeerAction?.("peer_relay_cancelled", `${peerId}/${id}`);
      } else if (action === "retry") {
        const peerId = optionalStringField(body, "peerId");
        const id = optionalStringField(body, "id");
        result = { moved: broker.retry(peerId, id) };
        options.auditPeerAction?.("peer_relay_retried", [peerId, id].filter(Boolean).join("/") || "all stale requests");
      } else if (action === "drain-expired") {
        result = broker.drainExpired();
        options.auditPeerAction?.("peer_relay_expired_drained", "Expired relay requests removed");
      } else {
        throw new Error(`Unsupported peer relay action: ${action}`);
      }
      sendJson(res, 200, { ...peerRelayStatus(options, broker), result });
      return true;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/peers/discovery-jobs") {
    const body = await readJsonBody(req);
    const job = await options.discoveryJobs!.start(discoveryOptionsFromBody(body));
    sendJson(res, 202, { job });
    options.auditPeerAction?.("peer_discovery_started", job.id);
    return true;
  }

  const discoveryJobMatch = url.pathname.match(/^\/api\/peers\/discovery-jobs\/([^/]+)(?:\/(cancel|log))?$/);
  if (discoveryJobMatch?.[1]) {
    const id = decodeURIComponent(discoveryJobMatch[1]);
    const action = discoveryJobMatch[2];
    if (req.method === "GET" && action === "log") {
      sendJson(res, 200, { id, plain: options.discoveryJobs?.log(id) ?? "" });
      return true;
    }
    if (req.method === "POST" && action === "cancel") {
      const job = options.discoveryJobs?.cancel(id);
      sendJson(res, 200, { job });
      options.auditPeerAction?.("peer_discovery_cancelled", id);
      return true;
    }
    if (req.method === "GET" && !action) {
      sendJson(res, 200, { job: options.discoveryJobs?.get(id) ?? null });
      return true;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/peers/identity/backup") {
    const backup = exportPeerIdentityBackup(options.home, options.config.peerName);
    sendJson(res, 200, { backup });
    options.auditPeerAction?.("peer_identity_backup_exported", backup.identity.nodeId);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/peers/identity/restore") {
    const body = await readJsonBody(req);
    const backup = objectRecord(body.backup) as unknown as PeerIdentityBackup;
    const restored = restorePeerIdentityBackup(backup, options.home);
    sendJson(res, 200, { identity: restored.public });
    options.auditPeerAction?.("peer_identity_restored", restored.public.nodeId);
    return true;
  }

  const invitationMatch = url.pathname.match(/^\/api\/peers\/invitations\/([^/]+)$/);
  if (invitationMatch?.[1] && req.method === "DELETE") {
    const invitation = store.deleteInvitation(decodeURIComponent(invitationMatch[1]));
    sendJson(res, 200, { removed: Boolean(invitation), invitation });
    if (invitation) {
      options.auditPeerAction?.("peer_invite_deleted", `${invitation.name} (${invitation.id})`);
    }
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
      group: optionalStringField(body, "group"),
      url: optionalStringField(body, "url"),
      enabled: optionalBooleanField(body, "enabled"),
      scopes: body.scopes === undefined ? undefined : parseScopes(arrayStringField(body, "scopes")),
      allowedAgents: body.allowedAgents === undefined ? undefined : parseAgents(arrayStringField(body, "allowedAgents")),
      allowedWorkspaceRoots: body.allowedWorkspaceRoots === undefined ? undefined : arrayStringField(body, "allowedWorkspaceRoots"),
      workspaceAliases: body.workspaceAliases === undefined ? undefined : parseWorkspaceAliases(body.workspaceAliases),
    });
    sendJson(res, 200, { peer: publicPeer(peer) });
    options.auditPeerAction?.("peer_updated", `${peer.name} (${peer.id})`);
    return true;
  }

  const repinMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/repin$/);
  if (repinMatch?.[1] && req.method === "POST") {
    const peerId = decodeURIComponent(repinMatch[1]);
    const peer = store.get(peerId);
    if (!peer?.url) {
      throw new Error("Peer URL is required before TLS re-pin.");
    }
    const probe = await checkPeerIdentityEndpoint(peer.url, { timeoutMs: options.config.peerDiscoveryTimeoutMs });
    if (!probe.ok || !probe.identity) {
      throw new Error(`Peer identity could not be verified: ${probe.detail}`);
    }
    if (probe.identity.nodeId !== peer.nodeId || probe.identity.publicKey !== peer.publicKey || probe.identity.fingerprint !== peer.fingerprint) {
      throw new Error("Peer identity changed. Re-pair this peer instead of re-pinning TLS.");
    }
    const updated = store.updatePeerTlsFingerprint(peer.id, probe.tlsFingerprint);
    sendJson(res, 200, { peer: publicPeer(updated), probe });
    options.auditPeerAction?.("peer_tls_repinned", `${updated.name} (${updated.id})`);
    return true;
  }

  const rotateMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/rotate$/);
  if (rotateMatch?.[1] && req.method === "POST") {
    const body = await readJsonBody(req);
    const readiness = await buildPeerReadiness(options.config, options.home);
    const created = store.createRotationInvitation(decodeURIComponent(rotateMatch[1]), {
      expiresInMs: (optionalNumberField(body, "expiresMinutes") ?? 10) * 60 * 1000,
    });
    const command = `nordrelay peer add ${readiness.listenUrl} --code ${created.code}`;
    sendJson(res, 201, {
      peer: created.peer,
      invitation: created.invitation,
      code: created.code,
      command,
      readiness,
      warnings: readiness.warnings,
    });
    options.auditPeerAction?.("peer_rotation_invite_created", `${created.peer.name} (${created.peer.id})`);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/peers/global-sessions") {
    const query = optionalStringField(Object.fromEntries(url.searchParams), "query") ?? "";
    const agent = parseAgent(optionalStringField(Object.fromEntries(url.searchParams), "agent"));
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 50);
    const client = new RemoteRelayClient(store, options.home);
    const targets = [];
    if (options.runtime) {
      targets.push({
        peerId: "local",
        peerName: "Local",
        ok: true,
        data: await options.runtime.listSessionsPage(1, limit, query, agent),
      });
    }
    const peers = store.listPublic().filter((peer) => peer.enabled && (peer.url || peer.direction === "inbound"));
    const remoteTargets = await Promise.all(peers.map(async (peer) => {
      try {
        const data = await client.webProxy(peer.id, {
          method: "GET",
          path: "/api/sessions",
          query: { query, page: 1, limit, agent },
          body: {},
          contextKey: "web:dashboard",
        }, options.activityActor, "web:dashboard");
        return { peerId: peer.id, peerName: peer.name, ok: true, data };
      } catch (error) {
        return { peerId: peer.id, peerName: peer.name, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    sendJson(res, 200, { targets: [...targets, ...remoteTargets] });
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
    const data = await new RemoteRelayClient(store, options.home).webProxy(
      decodeURIComponent(proxyMatch[1]),
      payload,
      options.activityActor,
      payload.contextKey,
      peerProxyTimeoutOptions(payload),
    );
    sendJson(res, 200, data);
    return true;
  }

  const healthMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/health$/);
  if (healthMatch?.[1] && req.method === "GET") {
    const peerId = decodeURIComponent(healthMatch[1]);
    const data = await new RemoteRelayClient(store, options.home).rpc(peerId, "peer.ping", undefined, options.activityActor, { timeoutMs: PEER_HEALTH_TIMEOUT_MS });
    sendJson(res, 200, { data, peer: publicPeer(store.get(peerId)!) });
    options.auditPeerAction?.("peer_health_checked", peerId);
    return true;
  }

  const eventsMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/events$/);
  if (eventsMatch?.[1] && req.method === "GET") {
    const peerId = decodeURIComponent(eventsMatch[1]);
    const peer = store.get(peerId);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    if (!peer?.url) {
      res.write("event: status\n");
      res.write(`data: ${JSON.stringify({ type: "status", level: "info", message: "Peer uses outbound relay mode. Waiting for relayed live events.", at: new Date().toISOString() })}\n\n`);
      const eventStore = new PeerRelayEventStore(options.home);
      let lastId: string | undefined = eventStore.list(peerId).at(-1)?.id;
      const flush = () => {
        for (const envelope of eventStore.list(peerId, lastId)) {
          lastId = envelope.id;
          if (res.destroyed || res.writableEnded) return;
          res.write(`event: ${envelope.event.type}\n`);
          res.write(`data: ${JSON.stringify(envelope.event)}\n\n`);
        }
      };
      flush();
      const poll = setInterval(flush, 2_000);
      poll.unref?.();
      const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(": heartbeat\n\n");
      }, 25_000);
      heartbeat.unref?.();
      req.on("close", () => {
        clearInterval(poll);
        clearInterval(heartbeat);
      });
      return true;
    }
    const sourceContextKey = url.searchParams.get("contextKey") || undefined;
    const subscription = new RemoteRelayClient(store, options.home).subscribe(peerId, (event) => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }, (error) => {
      if (!res.destroyed && !res.writableEnded) {
        res.write("event: status\n");
        res.write(`data: ${JSON.stringify({ type: "status", level: "error", message: error.message, at: new Date().toISOString() })}\n\n`);
      }
    }, sourceContextKey);
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

function peerRelayStatus(options: DashboardPeerRouteOptions, broker: ReturnType<typeof getPeerRelayBroker>) {
  return {
    enabled: options.config.peerOutboundRelayEnabled,
    allowedPeerIds: [...options.config.peerOutboundRelayPeerIds],
    queue: broker.snapshot(),
    outbound: getPeerOutboundRelaySnapshot(options.home),
    updatedAt: new Date().toISOString(),
  };
}

function parseScopes(values: string[]): Permission[] {
  return values.filter(isPermission);
}

function discoveryOptionsFromQuery(url: URL) {
  return {
    targets: url.searchParams.getAll("target").concat((url.searchParams.get("targets") ?? "").split(/[\n,]/)).map((value) => value.trim()).filter(Boolean),
    timeoutMs: optionalPositiveNumber(url.searchParams.get("timeoutMs")),
    concurrency: optionalPositiveNumber(url.searchParams.get("concurrency")),
    maxHosts: optionalPositiveNumber(url.searchParams.get("maxHosts")),
  };
}

function discoveryOptionsFromBody(body: Record<string, unknown>) {
  return {
    targets: arrayStringField(body, "targets"),
    timeoutMs: optionalNumberField(body, "timeoutMs"),
    concurrency: optionalNumberField(body, "concurrency"),
    maxHosts: optionalNumberField(body, "maxHosts"),
  };
}

function optionalPositiveNumber(value: string | null): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseAgents(values: string[]): AgentId[] {
  const parsed = values.filter(isAgentId);
  return parsed.length > 0 ? parsed : [...AGENT_IDS];
}

function parseAgent(value: string | undefined): AgentId | undefined {
  return value && isAgentId(value) ? value : undefined;
}

function parseProxyPayload(body: Record<string, unknown>): PeerWebProxyPayload {
  return {
    method: requiredString(body, "method"),
    path: requiredString(body, "path"),
    query: objectRecord(body.query),
    body: objectRecord(body.body),
    contextKey: optionalStringField(body, "contextKey"),
  };
}

function peerProxyTimeoutOptions(payload: PeerWebProxyPayload): { timeoutMs?: number } {
  const method = payload.method.trim().toUpperCase();
  const path = payload.path.trim();
  if (method === "GET" && path === "/api/active-sessions") {
    return { timeoutMs: PEER_ACTIVE_SESSIONS_TIMEOUT_MS };
  }
  return {};
}

function parseWorkspaceAliases(value: unknown): Record<string, string> {
  if (typeof value === "string") {
    return Object.fromEntries(value.split(",").map((item) => {
      const [alias, workspace] = item.split("=", 2);
      return [alias?.trim() ?? "", workspace?.trim() ?? ""];
    }).filter(([alias, workspace]) => alias && workspace));
  }
  const record = objectRecord(value);
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string" && entry[0].trim().length > 0 && entry[1].trim().length > 0
  ));
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new Error(`${key} is required.`);
  }
  return text;
}
