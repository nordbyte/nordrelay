import type { IncomingMessage, ServerResponse } from "node:http";

import { ALL_PERMISSIONS, isPermission, permissionForWebRequest, type Permission } from "../access/access-control.js";
import { AGENT_IDS, isAgentId, type AgentId } from "../agents/shared/agent.js";
import type { AuditEvent } from "../access/audit-log.js";
import type { AuthenticatedUser, UserStore } from "../access/user-management.js";
import type { ConnectorConfig } from "../core/config.js";
import {
  exportPeerIdentityBackup,
  ensurePeerTlsFiles,
  loadOrCreatePeerIdentity,
  restorePeerIdentityBackup,
} from "../peers/peer-identity.js";
import { getPeerOutboundRelaySnapshot, type PeerOutboundRelaySnapshot } from "../peers/peer-outbound-relay.js";
import { getPeerRelayBroker } from "../peers/peer-relay-broker.js";
import { PeerRelayEventStore } from "../peers/peer-relay-event-store.js";
import { checkPeerEndpoint, checkPeerIdentityEndpoint, pairPeer, RemoteRelayClient } from "../peers/peer-client.js";
import { buildPeerAccessReport, buildPeerDebugReport, runPeerRepairAction, type PeerRepairAction } from "../peers/peer-diagnostics.js";
import type { PeerDiscoveryJobManager } from "../peers/peer-discovery-jobs.js";
import { buildPeerReadiness, peerListenUrl } from "../peers/peer-readiness.js";
import { discoverLanPeers } from "../peers/peer-discovery.js";
import { PeerStore } from "../peers/peer-store.js";
import {
  publicPeer,
  type PeerIdentityBackup,
  type PeerRelayQueueSnapshot,
  type PeerReadiness,
  type PeerSnapshot,
  type PeerSyncCandidate,
  type PeerSyncResultItem,
  type PeerWebProxyPayload,
  type PublicPeerRecord,
} from "../peers/peer-types.js";
import type { RelayRuntime } from "../runtime/relay-runtime.js";
import { mergeSessionDetailMessages } from "../runtime/relay-runtime-session-detail.js";
import { getObservabilityRegistry } from "../observability/observability-registry.js";
import type { WebActivityActor, WebChatMessage } from "./web-state.js";
import {
  arrayStringField,
  objectRecord,
  optionalBooleanField,
  optionalNumberField,
  optionalStringField,
  readJsonBody,
  sendJson,
  WebAccessDeniedError,
} from "./web-dashboard-http.js";

export interface DashboardPeerRouteOptions {
  config: ConnectorConfig;
  home: string;
  runtime?: RelayRuntime;
  discoveryJobs?: PeerDiscoveryJobManager;
  users: UserStore;
  authUser: AuthenticatedUser;
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
    sendJson(res, 200, scopedPeerSnapshot(options, store.snapshot(identity.public, {
      enabled: options.config.peerEnabled,
      listenUrl: readiness.listenUrl,
      requireTls: options.config.peerRequireTls,
      readiness,
    })));
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
      assertPeerAccess(options, peerId);
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
      sendJson(res, 200, peerRelayStatus(options, store, broker));
      return true;
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const action = requiredString(body, "action");
      let result: unknown = {};
      if (action === "cancel") {
        const peerId = requiredString(body, "peerId");
        assertPeerAccess(options, peerId);
        const id = requiredString(body, "id");
        result = { removed: broker.cancel(peerId, id) };
        options.auditPeerAction?.("peer_relay_cancelled", `${peerId}/${id}`);
      } else if (action === "retry") {
        const peerId = optionalStringField(body, "peerId");
        const id = optionalStringField(body, "id");
        if (peerId) {
          assertPeerAccess(options, peerId);
          result = { moved: broker.retry(peerId, id) };
        } else {
          const peerIds = visiblePeerIds(options, store);
          result = { moved: peerIds.reduce((count, visiblePeerId) => count + broker.retry(visiblePeerId, id), 0) };
        }
        options.auditPeerAction?.("peer_relay_retried", [peerId, id].filter(Boolean).join("/") || "all stale requests");
      } else if (action === "drain-expired") {
        result = broker.drainExpired();
        options.auditPeerAction?.("peer_relay_expired_drained", "Expired relay requests removed");
      } else {
        throw new Error(`Unsupported peer relay action: ${action}`);
      }
      sendJson(res, 200, { ...peerRelayStatus(options, store, broker), result });
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

  const syncCandidatesMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/sync-candidates$/);
  if (syncCandidatesMatch?.[1] && req.method === "GET") {
    const sourcePeerId = decodeURIComponent(syncCandidatesMatch[1]);
    assertPeerAccess(options, sourcePeerId);
    assertLocalPermission(options, "peers.connect");
    const sourcePeer = store.get(sourcePeerId);
    if (!sourcePeer) {
      throw new Error("Source peer not found.");
    }
    const remoteSnapshot = await loadRemotePeerSnapshot(options, store, sourcePeer.id);
    sendJson(res, 200, {
      sourcePeer: publicPeer(sourcePeer),
      candidates: peerSyncCandidates(store, identity.public.nodeId, remoteSnapshot.peers),
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/peers/sync") {
    const body = await readJsonBody(req);
    const sourcePeerId = requiredString(body, "sourcePeerId");
    const candidateNodeIds = arrayStringField(body, "candidateNodeIds");
    if (!candidateNodeIds.length) {
      throw new Error("Select at least one peer to sync.");
    }
    assertPeerAccess(options, sourcePeerId);
    assertLocalPermission(options, "peers.connect");
    const sourcePeer = store.get(sourcePeerId);
    if (!sourcePeer) {
      throw new Error("Source peer not found.");
    }
    const remoteSnapshot = await loadRemotePeerSnapshot(options, store, sourcePeer.id);
    const candidates = peerSyncCandidates(store, identity.public.nodeId, remoteSnapshot.peers);
    const byNodeId = new Map(candidates.map((candidate) => [candidate.peer.nodeId, candidate]));
    const readiness = await buildPeerReadiness(options.config, options.home);
    const publicUrl = pairingPublicUrl(readiness);
    const client = new RemoteRelayClient(store, options.home);
    const expiresMinutes = Math.min(Math.max(optionalNumberField(body, "expiresMinutes") ?? 10, 1), 60);
    const results: PeerSyncResultItem[] = [];
    for (const nodeId of [...new Set(candidateNodeIds)]) {
      const candidate = byNodeId.get(nodeId);
      if (!candidate) {
        results.push({ nodeId, name: nodeId, status: "skipped", reason: "Peer candidate was not found on the source peer." });
        continue;
      }
      if (!candidate.importable || !candidate.peer.url) {
        results.push({ nodeId, name: candidate.peer.name, status: "skipped", reason: candidate.reason || "Peer cannot be synced automatically." });
        continue;
      }
      try {
        const invite = objectRecord(await client.webProxy(sourcePeer.id, {
          method: "POST",
          path: `/api/peers/${encodeURIComponent(candidate.peer.id)}/sync-invite`,
          body: { expiresMinutes },
          contextKey: "web:peer-sync",
        }, options.activityActor, "web:peer-sync", { timeoutMs: 20_000 }));
        const code = requiredString(invite, "code");
        const paired = await pairPeer({
          url: candidate.peer.url,
          code,
          name: candidate.peer.name,
          publicUrl,
        }, identity, store);
        const updated = candidate.peer.group
          ? store.updatePeer(paired.peer.id, { group: candidate.peer.group })
          : paired.peer;
        results.push({ nodeId, name: candidate.peer.name, status: "created", peer: publicPeer(updated) });
        options.auditPeerAction?.("peer_synced", `${candidate.peer.name} via ${sourcePeer.name}`);
      } catch (error) {
        results.push({ nodeId, name: candidate.peer.name, status: "failed", reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const created = results.filter((item) => item.status === "created").length;
    const skipped = results.filter((item) => item.status === "skipped").length;
    const failed = results.filter((item) => item.status === "failed").length;
    sendJson(res, 200, { sourcePeer: publicPeer(sourcePeer), results, created, skipped, failed });
    return true;
  }

  const peerMatch = url.pathname.match(/^\/api\/peers\/([^/]+)$/);
  if (peerMatch?.[1] && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const peerId = decodeURIComponent(peerMatch[1]);
    assertPeerAccess(options, peerId);
    const peer = store.updatePeer(peerId, {
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
    assertPeerAccess(options, peerId);
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
    assertPeerAccess(options, decodeURIComponent(rotateMatch[1]));
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
    const peers = store.listPublic().filter((peer) => canUsePeer(options, peer.id) && peer.enabled && (peer.url || peer.direction === "inbound"));
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
    assertPeerAccess(options, peerId);
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
    const client = new RemoteRelayClient(store, options.home);
    const peerId = decodeURIComponent(proxyMatch[1]);
    assertPeerAccess(options, peerId);
    assertPeerProxyTargetPermission(options, payload);
    const data = await client.webProxy(
      peerId,
      payload,
      options.activityActor,
      payload.contextKey,
      peerProxyTimeoutOptions(payload),
    );
    sendJson(res, 200, await hydratePeerProxyResponse(
      client,
      peerId,
      payload,
      data,
      options.activityActor,
      payload.contextKey,
    ));
    return true;
  }

  const healthMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/health$/);
  if (healthMatch?.[1] && req.method === "GET") {
    const peerId = decodeURIComponent(healthMatch[1]);
    assertPeerAccess(options, peerId);
    const data = await new RemoteRelayClient(store, options.home).rpc(peerId, "peer.ping", undefined, options.activityActor, { timeoutMs: PEER_HEALTH_TIMEOUT_MS });
    sendJson(res, 200, { data, peer: publicPeer(store.get(peerId)!) });
    options.auditPeerAction?.("peer_health_checked", peerId);
    return true;
  }

  const debugMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/debug$/);
  if (debugMatch?.[1] && req.method === "GET") {
    const peerId = decodeURIComponent(debugMatch[1]);
    assertPeerAccess(options, peerId);
    const report = await buildPeerDebugReport({
      peerId,
      home: options.home,
      store,
      users: options.users,
      authUser: options.authUser,
      actor: options.activityActor,
      runProbes: url.searchParams.get("probe") === "true",
      timeoutMs: PEER_HEALTH_TIMEOUT_MS,
    });
    sendJson(res, 200, report);
    return true;
  }

  const debugProbeMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/debug\/probe$/);
  if (debugProbeMatch?.[1] && req.method === "POST") {
    const peerId = decodeURIComponent(debugProbeMatch[1]);
    assertPeerAccess(options, peerId);
    const report = await buildPeerDebugReport({
      peerId,
      home: options.home,
      store,
      users: options.users,
      authUser: options.authUser,
      actor: options.activityActor,
      runProbes: true,
      timeoutMs: PEER_HEALTH_TIMEOUT_MS,
    });
    sendJson(res, 200, report);
    options.auditPeerAction?.("peer_debug_checked", peerId);
    return true;
  }

  const accessMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/effective-access$/);
  if (accessMatch?.[1] && req.method === "GET") {
    const peerId = decodeURIComponent(accessMatch[1]);
    assertPeerAccess(options, peerId);
    const peer = store.get(peerId);
    if (!peer) throw new Error("Peer not found.");
    sendJson(res, 200, buildPeerAccessReport({ peer, users: options.users, authUser: options.authUser }));
    return true;
  }

  const historyMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/health-history$/);
  if (historyMatch?.[1] && req.method === "GET") {
    const peerId = decodeURIComponent(historyMatch[1]);
    assertPeerAccess(options, peerId);
    const peer = store.get(peerId);
    if (!peer) throw new Error("Peer not found.");
    sendJson(res, 200, { peer: publicPeer(peer), history: peer.healthHistory ?? [] });
    return true;
  }

  const repairMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/repair$/);
  if (repairMatch?.[1] && req.method === "POST") {
    const body = await readJsonBody(req);
    const peerId = decodeURIComponent(repairMatch[1]);
    assertPeerAccess(options, peerId);
    const readiness = await buildPeerReadiness(options.config, options.home);
    const result = await runPeerRepairAction({
      peerId,
      home: options.home,
      store,
      action: parsePeerRepairAction(requiredString(body, "action")),
      listenUrl: readiness.listenUrl,
    });
    sendJson(res, 200, {
      ...result,
      report: await buildPeerDebugReport({
        peerId,
        home: options.home,
        store,
        users: options.users,
        authUser: options.authUser,
        actor: options.activityActor,
        runProbes: false,
      }),
    });
    options.auditPeerAction?.("peer_repair_applied", `${peerId}/${result.action}`);
    return true;
  }

  const eventsMatch = url.pathname.match(/^\/api\/peers\/([^/]+)\/events$/);
  if (eventsMatch?.[1] && req.method === "GET") {
    const peerId = decodeURIComponent(eventsMatch[1]);
    assertPeerAccess(options, peerId);
    const peer = store.get(peerId);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    const sse = getObservabilityRegistry().openSseConnection({
      route: "/api/peers/:id/events",
      target: peerId,
      peerId,
      user: options.authUser.user.email,
    });
    if (!peer?.url) {
      const statusFrame = `event: status\ndata: ${JSON.stringify({ type: "status", level: "info", message: "Peer uses outbound relay mode. Waiting for relayed live events.", at: new Date().toISOString() })}\n\n`;
      sse.event(Buffer.byteLength(statusFrame));
      res.write(statusFrame);
      const eventStore = new PeerRelayEventStore(options.home);
      let lastId: string | undefined = eventStore.list(peerId).at(-1)?.id;
      const flush = () => {
        for (const envelope of eventStore.list(peerId, lastId)) {
          lastId = envelope.id;
          if (res.destroyed || res.writableEnded) return;
          const frame = `event: ${envelope.event.type}\ndata: ${JSON.stringify(envelope.event)}\n\n`;
          sse.event(Buffer.byteLength(frame));
          res.write(frame);
        }
      };
      flush();
      const relayEventsPoller = getObservabilityRegistry().registerPoller({
        id: `peer-events:${peerId}:${sse.id}`,
        owner: "peers",
        kind: "relay-events",
        intervalMs: 2_000,
        currentDelayMs: 2_000,
        nextRunAt: Date.now() + 2_000,
      });
      const poll = setInterval(() => {
        relayEventsPoller.update({ nextRunAt: Date.now() + 2_000 });
        const finish = relayEventsPoller.start();
        try {
          flush();
          finish();
        } catch (error) {
          finish(error);
        }
      }, 2_000);
      poll.unref?.();
      const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) {
          const frame = ": heartbeat\n\n";
          sse.heartbeat(Buffer.byteLength(frame));
          res.write(frame);
        }
      }, 25_000);
      heartbeat.unref?.();
      req.on("close", () => {
        clearInterval(poll);
        clearInterval(heartbeat);
        relayEventsPoller.close();
        sse.close();
      });
      return true;
    }
    const sourceContextKey = url.searchParams.get("contextKey") || undefined;
    const subscription = new RemoteRelayClient(store, options.home).subscribe(peerId, (event) => {
      if (res.destroyed || res.writableEnded) return;
      const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      sse.event(Buffer.byteLength(frame));
      res.write(frame);
    }, (error) => {
      if (!res.destroyed && !res.writableEnded) {
        const frame = `event: status\ndata: ${JSON.stringify({ type: "status", level: "error", message: error.message, at: new Date().toISOString() })}\n\n`;
        sse.event(Buffer.byteLength(frame));
        res.write(frame);
      }
    }, sourceContextKey);
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) {
        const frame = ": heartbeat\n\n";
        sse.heartbeat(Buffer.byteLength(frame));
        res.write(frame);
      }
    }, 25_000);
    heartbeat.unref?.();
    req.on("close", () => {
      clearInterval(heartbeat);
      sse.close();
      subscription.close();
    });
    return true;
  }

  return false;
}

function peerRelayStatus(options: DashboardPeerRouteOptions, store: PeerStore, broker: ReturnType<typeof getPeerRelayBroker>) {
  const visible = new Set(visiblePeerIds(options, store));
  return {
    enabled: options.config.peerOutboundRelayEnabled,
    allowedPeerIds: [...options.config.peerOutboundRelayPeerIds].filter((peerId) => canUsePeer(options, peerId)),
    queue: filterPeerRelaySnapshot(broker.snapshot(), visible),
    outbound: filterOutboundRelaySnapshot(getPeerOutboundRelaySnapshot(options.home), visible),
    updatedAt: new Date().toISOString(),
  };
}

function filterOutboundRelaySnapshot(snapshot: PeerOutboundRelaySnapshot, visible: Set<string>): PeerOutboundRelaySnapshot {
  return {
    ...snapshot,
    allowedPeerIds: snapshot.allowedPeerIds.filter((peerId) => visible.has(peerId)),
    peers: snapshot.peers.filter((peer) => visible.has(peer.peerId)),
  };
}

function scopedPeerSnapshot(options: DashboardPeerRouteOptions, snapshot: ReturnType<PeerStore["snapshot"]>) {
  const peers = snapshot.peers.filter((peer) => canUsePeer(options, peer.id));
  return {
    ...snapshot,
    scopeOptions: ALL_PERMISSIONS,
    peers,
    groups: [...new Set(peers.map((peer) => peer.group).filter((group): group is string => Boolean(group)))].sort(),
  };
}

async function loadRemotePeerSnapshot(options: DashboardPeerRouteOptions, store: PeerStore, sourcePeerId: string): Promise<PeerSnapshot> {
  const client = new RemoteRelayClient(store, options.home);
  const data = objectRecord(await client.webProxy(sourcePeerId, {
    method: "GET",
    path: "/api/peers",
    body: {},
    contextKey: "web:peer-sync",
  }, options.activityActor, "web:peer-sync", { timeoutMs: 12_000 }));
  return {
    ...data,
    peers: Array.isArray(data.peers) ? data.peers as PublicPeerRecord[] : [],
    invitations: Array.isArray(data.invitations) ? data.invitations as PeerSnapshot["invitations"] : [],
  } as PeerSnapshot;
}

function peerSyncCandidates(store: PeerStore, selfNodeId: string, remotePeers: PublicPeerRecord[]): PeerSyncCandidate[] {
  const localPeers = store.listPublic();
  const localNodeIds = new Set(localPeers.map((peer) => peer.nodeId));
  const localIds = new Set(localPeers.map((peer) => peer.id));
  return remotePeers.map((peer) => {
    const isSelf = peer.nodeId === selfNodeId;
    const alreadyExists = localNodeIds.has(peer.nodeId) || localIds.has(peer.id);
    const reason = peerSyncBlockReason(peer, isSelf, alreadyExists);
    return {
      peer,
      alreadyExists,
      isSelf,
      importable: !reason,
      canAutoPair: !reason,
      reason,
    };
  }).sort((a, b) => Number(a.alreadyExists || a.isSelf) - Number(b.alreadyExists || b.isSelf) || a.peer.name.localeCompare(b.peer.name));
}

function peerSyncBlockReason(peer: PublicPeerRecord, isSelf: boolean, alreadyExists: boolean): string | undefined {
  if (isSelf) return "This is the local node.";
  if (alreadyExists) return "Already added locally.";
  if (!peer.url) return "No direct peer URL is available.";
  if (!peer.enabled) return "Peer is disabled on the source node.";
  if (peer.trustStatus === "error") return peer.lastError || "Peer trust status is error.";
  return undefined;
}

function pairingPublicUrl(readiness: PeerReadiness): string | undefined {
  return readiness.enabled && readiness.localListening && !readiness.loopbackOnly ? readiness.listenUrl : undefined;
}

function canUsePeer(options: Pick<DashboardPeerRouteOptions, "users" | "authUser">, peerId: string): boolean {
  return options.users.canUsePeerStrict(options.authUser, peerId);
}

function assertPeerAccess(options: Pick<DashboardPeerRouteOptions, "users" | "authUser">, peerId: string): void {
  if (!canUsePeer(options, peerId)) {
    throw new WebAccessDeniedError(`Access denied: peer ${peerId} is outside your group scope.`);
  }
}

function assertLocalPermission(options: Pick<DashboardPeerRouteOptions, "users" | "authUser">, permission: Permission): void {
  if (!options.users.hasPermission(options.authUser, permission)) {
    throw new WebAccessDeniedError(`Access denied: ${permission} permission required.`);
  }
}

export function assertPeerProxyTargetPermission(
  options: Pick<DashboardPeerRouteOptions, "users" | "authUser">,
  payload: Pick<PeerWebProxyPayload, "method" | "path">,
): Permission {
  const method = payload.method.trim().toUpperCase();
  const routePath = payload.path.trim();
  const permission = permissionForWebRequest(method, routePath);
  if (!permission) {
    throw new WebAccessDeniedError(`Access denied: peer proxy target ${method} ${routePath} is not an allowed WebUI route.`);
  }
  if (!options.users.hasPermission(options.authUser, permission)) {
    throw new WebAccessDeniedError(`Access denied: ${permission} permission required for proxied ${method} ${routePath}.`);
  }
  return permission;
}

function visiblePeerIds(options: Pick<DashboardPeerRouteOptions, "users" | "authUser">, store = new PeerStore()): string[] {
  return store.listPublic().filter((peer) => canUsePeer(options, peer.id)).map((peer) => peer.id);
}

function filterPeerRelaySnapshot(snapshot: PeerRelayQueueSnapshot, visible: Set<string>): PeerRelayQueueSnapshot {
  return {
    pending: snapshot.pending.filter((item) => visible.has(item.peerId)),
    inFlight: snapshot.inFlight.filter((item) => visible.has(item.peerId)),
    completed: snapshot.completed.filter((item) => visible.has(item.peerId)),
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

function parsePeerRepairAction(value: string): PeerRepairAction {
  const action = value.trim();
  if (["repin-tls", "clear-error", "enable", "disable", "retry-relay", "drain-expired", "rotate-pairing"].includes(action)) {
    return action as PeerRepairAction;
  }
  throw new Error(`Unsupported peer repair action: ${value}`);
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

async function hydratePeerProxyResponse(
  client: RemoteRelayClient,
  peerId: string,
  payload: PeerWebProxyPayload,
  data: unknown,
  actor: WebActivityActor,
  sourceContextKey?: string,
): Promise<unknown> {
  if (!isChatHistoryPayload(payload)) {
    return data;
  }
  const messages = webChatMessagesFromResponse(data);
  try {
    const bootstrap = await client.webProxy(peerId, {
      method: "GET",
      path: "/api/bootstrap",
      query: {},
      body: {},
      contextKey: payload.contextKey,
    }, actor, sourceContextKey, { timeoutMs: 8_000 });
    const session = objectRecord((bootstrap as { session?: unknown })?.session);
    const threadId = optionalStringField(session, "threadId");
    if (!threadId) {
      return data;
    }
    const detail = await client.webProxy(peerId, {
      method: "GET",
      path: "/api/sessions/detail",
      query: { threadId, agent: optionalStringField(session, "agentId") },
      body: {},
      contextKey: payload.contextKey,
    }, actor, sourceContextKey, { timeoutMs: 8_000 });
    const detailMessages = webChatMessagesFromResponse({ messages: (detail as { messages?: unknown })?.messages });
    return {
      ...(data && typeof data === "object" ? data as Record<string, unknown> : {}),
      messages: mergeSessionDetailMessages(messages, detailMessages, numberFromUnknown(payload.query?.limit, 200)),
    };
  } catch {
    return data;
  }
}

function isChatHistoryPayload(payload: PeerWebProxyPayload): boolean {
  return payload.method.trim().toUpperCase() === "GET" && payload.path.trim() === "/api/chat/history";
}

function webChatMessagesFromResponse(value: unknown): WebChatMessage[] {
  const record = objectRecord(value);
  return Array.isArray(record.messages) ? record.messages.filter(isWebChatMessage) : [];
}

function isWebChatMessage(value: unknown): value is WebChatMessage {
  const record = objectRecord(value);
  return typeof record.id === "string"
    && typeof record.role === "string"
    && typeof record.text === "string"
    && typeof record.timestamp === "string";
}

function numberFromUnknown(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
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
