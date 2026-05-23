import type { Permission } from "../access/access-control.js";
import type { AuthenticatedUser, UserStore } from "../access/user-management.js";
import { AGENT_IDS, type AgentId } from "../agents/shared/agent.js";
import type { WebActivityActor } from "../web/web-state.js";
import { permissionForWebRequest } from "../access/access-control.js";
import { getPeerRelayBroker } from "./peer-relay-broker.js";
import { checkPeerEndpoint, checkPeerIdentityEndpoint, RemoteRelayClient } from "./peer-client.js";
import { PeerStore } from "./peer-store.js";
import { type PeerHealthSample, type PeerRecord, type PublicPeerRecord, publicPeer } from "./peer-types.js";

export type PeerDiagnosticStatus = "ok" | "warn" | "error" | "skipped";

export type PeerDiagnosticCode =
  | "peer.ok"
  | "peer.disabled"
  | "peer.network.timeout"
  | "peer.network.unreachable"
  | "peer.tls.fingerprint_mismatch"
  | "peer.identity.node_mismatch"
  | "peer.identity.invalid"
  | "peer.auth.signature_invalid"
  | "peer.scope.missing"
  | "peer.user.peer_denied"
  | "peer.agent.denied"
  | "peer.workspace.denied"
  | "peer.protocol.unsupported"
  | "peer.remote.unhealthy"
  | "peer.events.failed"
  | "peer.relay.timeout"
  | "peer.relay.only"
  | "peer.url.missing"
  | "peer.unknown_error";

export interface PeerDiagnosticCheck {
  id: string;
  label: string;
  status: PeerDiagnosticStatus;
  code: PeerDiagnosticCode;
  detail: string;
  remediation?: string;
  latencyMs?: number;
  statusCode?: number;
  tlsFingerprint?: string;
  expectedTlsFingerprint?: string;
  remoteVersion?: string;
  remoteStatus?: string;
  route?: string;
}

export interface PeerAccessCheck {
  id: string;
  label: string;
  requiredPermission?: Permission;
  localAllowed: boolean | null;
  peerAllowed: boolean | null;
  allowed: boolean;
  reason: string;
  fix?: string;
}

export interface PeerEffectiveAccessReport {
  peerId: string;
  peerName: string;
  user?: {
    id: string;
    email?: string;
    displayName?: string;
    groupIds: string[];
  };
  allowed: boolean;
  checks: PeerAccessCheck[];
  summary: string;
}

export interface PeerDebugReport {
  generatedAt: string;
  peer: PublicPeerRecord | null;
  summary: {
    status: PeerDiagnosticStatus;
    ok: number;
    warnings: number;
    errors: number;
    skipped: number;
    primaryIssue?: string;
    remediation?: string;
  };
  access: PeerEffectiveAccessReport | null;
  checks: PeerDiagnosticCheck[];
  healthHistory: PeerHealthSample[];
  repairActions: PeerRepairAction[];
}

export type PeerRepairAction =
  | "repin-tls"
  | "clear-error"
  | "enable"
  | "disable"
  | "retry-relay"
  | "drain-expired"
  | "rotate-pairing";

export interface PeerDebugOptions {
  peerId: string;
  home?: string;
  store?: PeerStore;
  users?: UserStore;
  authUser?: AuthenticatedUser;
  actor?: WebActivityActor;
  runProbes?: boolean;
  timeoutMs?: number;
}

export interface PeerRepairResult {
  action: PeerRepairAction;
  peer: PublicPeerRecord | null;
  result?: unknown;
}

const ROUTE_CHECKS: Array<{ id: string; label: string; permission: Permission; method: string; path: string; query?: Record<string, unknown> }> = [
  { id: "route-bootstrap", label: "Bootstrap API", permission: "inspect", method: "GET", path: "/api/bootstrap" },
  { id: "route-sessions", label: "Sessions API", permission: "sessions.read", method: "GET", path: "/api/sessions", query: { page: 1, limit: 1 } },
  { id: "route-active-sessions", label: "Active sessions API", permission: "sessions.read", method: "GET", path: "/api/active-sessions" },
  { id: "route-diagnostics", label: "Diagnostics API", permission: "diagnostics.read", method: "GET", path: "/api/diagnostics" },
  { id: "route-logs", label: "Logs API", permission: "logs.read", method: "GET", path: "/api/logs", query: { limit: 1 } },
];

const ACCESS_FEATURES: Array<{ id: string; label: string; permission: Permission; fix?: string }> = [
  { id: "local-peer", label: "Select this peer", permission: "peers.connect", fix: "Grant peers.connect to the user's group and include this peer in the group peer scope." },
  { id: "inspect", label: "Inspect remote status", permission: "inspect", fix: "Add inspect to the peer scopes and user permissions." },
  { id: "sessions-read", label: "Read sessions", permission: "sessions.read", fix: "Add sessions.read to the peer scopes and user permissions." },
  { id: "sessions-write", label: "Switch or create sessions", permission: "sessions.write", fix: "Add sessions.write to the peer scopes and user permissions." },
  { id: "prompt-send", label: "Send prompts", permission: "prompt.send", fix: "Add prompt.send to the peer scopes and user permissions." },
  { id: "prompt-abort", label: "Abort prompts", permission: "prompt.abort", fix: "Add prompt.abort to the peer scopes and user permissions." },
  { id: "queue", label: "Read/write queue", permission: "queue.write", fix: "Add queue.write to the peer scopes and user permissions." },
  { id: "files-read", label: "Read artifacts/files", permission: "files.read", fix: "Add files.read to the peer scopes and user permissions." },
  { id: "files-write", label: "Write artifacts/files", permission: "files.write", fix: "Add files.write to the peer scopes and user permissions." },
  { id: "diagnostics", label: "Read diagnostics", permission: "diagnostics.read", fix: "Add diagnostics.read to the peer scopes and user permissions." },
  { id: "logs", label: "Read logs", permission: "logs.read", fix: "Add logs.read to the peer scopes and user permissions." },
  { id: "workflows", label: "Use shared workflows", permission: "workflows.run", fix: "Add workflows.run to the peer scopes and user permissions." },
  { id: "updates", label: "Run remote updates", permission: "updates.run", fix: "Add updates.run to the peer scopes and user permissions." },
  { id: "restart", label: "Restart remote runtime", permission: "system.restart", fix: "Add system.restart to the peer scopes and user permissions." },
];

export function classifyPeerError(error: unknown): Pick<PeerDiagnosticCheck, "code" | "detail" | "remediation"> {
  const detail = error instanceof Error ? error.message : String(error || "Unknown peer error.");
  const text = detail.toLowerCase();
  if (/timed out|timeout|aborted/.test(text)) {
    return { code: "peer.network.timeout", detail, remediation: "Check peer host, port, firewall, public URL, and NORDRELAY_PEER_* settings." };
  }
  if (/fingerprint mismatch|tls certificate fingerprint/.test(text)) {
    return { code: "peer.tls.fingerprint_mismatch", detail, remediation: "Verify the peer identity and use Re-pin TLS only when the peer identity still matches." };
  }
  if (/identity.*match|node.*match|public key|fingerprint.*public key/.test(text)) {
    return { code: "peer.identity.node_mismatch", detail, remediation: "Do not re-pin TLS. Rotate pairing or revoke and add the peer again." };
  }
  if (/permission denied|missing scope|peer permission denied/.test(text)) {
    const permission = detail.match(/(?:denied|missing scope):?\s*([a-z.]+)/i)?.[1];
    return { code: "peer.scope.missing", detail, remediation: permission ? `Add ${permission} to this peer's scopes if this action should be allowed.` : "Add the required peer scope if this action should be allowed." };
  }
  if (/signature|timestamp|replay|auth|unknown peer/.test(text)) {
    return { code: "peer.auth.signature_invalid", detail, remediation: "Rotate pairing or revoke and add the peer again. Also verify both systems have sane clocks." };
  }
  if (/protocol/.test(text)) {
    return { code: "peer.protocol.unsupported", detail, remediation: "Update NordRelay on both nodes so the peer protocol versions match." };
  }
  if (/fetch failed|econnrefused|enotfound|ehostunreach|network|socket|connect/.test(text)) {
    return { code: "peer.network.unreachable", detail, remediation: "Check DNS/IP, port forwarding, LAN routing, firewall rules, and whether the peer server is running." };
  }
  if (/relay.*timed out|relay request timed out/.test(text)) {
    return { code: "peer.relay.timeout", detail, remediation: "Check outbound relay polling on the remote node and retry stale relay requests." };
  }
  return { code: "peer.unknown_error", detail, remediation: "Open Peer Debug and run a fresh probe to collect the current failure context." };
}

export function buildPeerAccessReport(options: {
  peer: PeerRecord | PublicPeerRecord;
  users?: Pick<UserStore, "canUsePeerStrict" | "hasPermission">;
  authUser?: AuthenticatedUser;
}): PeerEffectiveAccessReport {
  const peer = options.peer;
  const authUser = options.authUser;
  const userVisible = options.users && authUser ? options.users.canUsePeerStrict(authUser, peer.id) : true;
  const checks: PeerAccessCheck[] = [];

  if (!userVisible) {
    checks.push({
      id: "user-peer-scope",
      label: "User group peer scope",
      localAllowed: false,
      peerAllowed: null,
      allowed: false,
      reason: "The authenticated user's groups do not include this peer and no group has unrestricted peer access.",
      fix: "Add this peer to one of the user's groups or leave the group's peer scope empty to allow all peers.",
    });
  }

  for (const feature of ACCESS_FEATURES) {
    const localAllowed = options.users && authUser ? options.users.hasPermission(authUser, feature.permission) : null;
    const peerAllowed = feature.permission === "peers.connect" ? true : peer.scopes.includes(feature.permission);
    const allowed = userVisible && localAllowed !== false && peerAllowed !== false;
    checks.push({
      id: feature.id,
      label: feature.label,
      requiredPermission: feature.permission,
      localAllowed,
      peerAllowed,
      allowed,
      reason: allowed
        ? "Allowed by the current user permissions and peer scopes."
        : accessDeniedReason(userVisible, localAllowed, peerAllowed, feature.permission),
      fix: allowed ? undefined : feature.fix,
    });
  }

  const agentsAllowed = peer.allowedAgents.length === 0;
  checks.push({
    id: "agents",
    label: "Agent scope",
    localAllowed: null,
    peerAllowed: agentsAllowed,
    allowed: true,
    reason: agentsAllowed ? "All agents are allowed by this peer." : `Peer is restricted to ${peer.allowedAgents.join(", ")}.`,
    fix: agentsAllowed ? undefined : `Add one of ${AGENT_IDS.join(", ")} to the peer's allowed agents if needed.`,
  });

  const workspacesAllowed = peer.allowedWorkspaceRoots.length === 0;
  checks.push({
    id: "workspaces",
    label: "Workspace scope",
    localAllowed: null,
    peerAllowed: workspacesAllowed,
    allowed: true,
    reason: workspacesAllowed ? "All workspace roots are allowed by this peer." : `Peer is restricted to ${peer.allowedWorkspaceRoots.join(", ")}.`,
    fix: workspacesAllowed ? undefined : "Add the required workspace root to the peer's allowed workspace roots or use a workspace alias.",
  });

  const denied = checks.filter((check) => !check.allowed);
  return {
    peerId: peer.id,
    peerName: peer.name,
    user: authUser ? {
      id: authUser.user.id,
      email: authUser.user.email,
      displayName: authUser.user.displayName,
      groupIds: authUser.groups.map((group) => group.id),
    } : undefined,
    allowed: denied.length === 0,
    checks,
    summary: denied.length === 0 ? "Access checks passed." : `${denied.length} access check(s) need attention.`,
  };
}

export async function buildPeerDebugReport(options: PeerDebugOptions): Promise<PeerDebugReport> {
  const store = options.store ?? new PeerStore(options.home);
  const peer = store.get(options.peerId);
  if (!peer) {
    const checks = [check("peer-exists", "Peer exists", "error", "peer.unknown_error", `Peer not found: ${options.peerId}`, "Verify the peer ID or add the peer again.")];
    return {
      generatedAt: new Date().toISOString(),
      peer: null,
      access: null,
      checks,
      healthHistory: [],
      repairActions: [],
      summary: summarizeChecks(checks),
    };
  }

  const checks: PeerDiagnosticCheck[] = [
    check("configured", "Peer configured", "ok", "peer.ok", `${peer.name} (${peer.id}) is configured.`),
    check(
      "enabled",
      "Peer enabled",
      peer.enabled ? "ok" : "error",
      peer.enabled ? "peer.ok" : "peer.disabled",
      peer.enabled ? "Peer is enabled." : "Peer is disabled.",
      peer.enabled ? undefined : "Enable the peer before trying to use remote sessions.",
    ),
    check(
      "transport",
      "Transport",
      peer.url ? "ok" : "warn",
      peer.url ? "peer.ok" : "peer.relay.only",
      peer.url ? `Direct URL: ${peer.url}` : "No direct URL is registered. This peer can only work through outbound relay polling.",
      peer.url ? undefined : "Set a peer public URL or enable outbound relay on the remote node.",
    ),
    check(
      "tls-pin",
      "TLS pin",
      peer.url?.startsWith("https://") ? (peer.tlsFingerprint ? "ok" : "warn") : "skipped",
      peer.url?.startsWith("https://") ? (peer.tlsFingerprint ? "peer.ok" : "peer.tls.fingerprint_mismatch") : "peer.ok",
      peer.url?.startsWith("https://") ? (peer.tlsFingerprint ? `Pinned TLS fingerprint: ${peer.tlsFingerprint}` : "HTTPS peer has no pinned TLS fingerprint.") : "TLS pin is not needed for this peer URL.",
      peer.url?.startsWith("https://") && !peer.tlsFingerprint ? "Run a peer probe and re-pin TLS after verifying the peer identity." : undefined,
    ),
  ];
  const access = buildPeerAccessReport({ peer, users: options.users, authUser: options.authUser });
  checks.push(check(
    "access-summary",
    "Effective access",
    access.allowed ? "ok" : "error",
    access.allowed ? "peer.ok" : "peer.user.peer_denied",
    access.summary,
    access.allowed ? undefined : "Open the Access tab in Peer Debug to see the denied permission or scope.",
  ));

  if (options.runProbes) {
    checks.push(...await runPeerProbes(peer, store, options));
  }

  return {
    generatedAt: new Date().toISOString(),
    peer: publicPeer(store.get(peer.id) ?? peer),
    access,
    checks,
    healthHistory: store.get(peer.id)?.healthHistory ?? peer.healthHistory ?? [],
    repairActions: repairActionsForPeer(store.get(peer.id) ?? peer),
    summary: summarizeChecks(checks),
  };
}

export async function runPeerRepairAction(options: {
  action: PeerRepairAction;
  peerId: string;
  home?: string;
  store?: PeerStore;
  listenUrl?: string;
}): Promise<PeerRepairResult> {
  const store = options.store ?? new PeerStore(options.home);
  const peer = store.get(options.peerId);
  if (!peer) {
    throw new Error(`Peer not found: ${options.peerId}`);
  }

  if (options.action === "repin-tls") {
    if (!peer.url) {
      throw new Error("Peer URL is required before TLS re-pin.");
    }
    const probe = await checkPeerIdentityEndpoint(peer.url, { timeoutMs: 5_000 });
    if (!probe.ok || !probe.identity) {
      throw new Error(`Peer identity could not be verified: ${probe.detail}`);
    }
    assertPeerIdentityMatches(peer, probe.identity);
    const updated = store.updatePeerTlsFingerprint(peer.id, probe.tlsFingerprint);
    store.markSeen(peer.id, {
      check: "repair.repin-tls",
      code: "peer.ok",
      tlsFingerprint: probe.tlsFingerprint,
      detail: "TLS fingerprint re-pinned after identity verification.",
    });
    return { action: options.action, peer: publicPeer(updated), result: { probe } };
  }

  if (options.action === "clear-error") {
    store.clearError(peer.id);
    return { action: options.action, peer: publicPeer(store.get(peer.id)!) };
  }

  if (options.action === "enable" || options.action === "disable") {
    const updated = store.updatePeer(peer.id, { enabled: options.action === "enable" });
    return { action: options.action, peer: publicPeer(updated) };
  }

  if (options.action === "retry-relay") {
    const moved = getPeerRelayBroker(options.home).retry(peer.id);
    return { action: options.action, peer: publicPeer(peer), result: { moved } };
  }

  if (options.action === "drain-expired") {
    const drained = getPeerRelayBroker(options.home).drainExpired();
    return { action: options.action, peer: publicPeer(peer), result: drained };
  }

  if (options.action === "rotate-pairing") {
    const created = store.createRotationInvitation(peer.id);
    return {
      action: options.action,
      peer: created.peer,
      result: {
        invitation: created.invitation,
        code: created.code,
        command: options.listenUrl ? `nordrelay peer add ${options.listenUrl} --code ${created.code}` : undefined,
      },
    };
  }

  throw new Error(`Unsupported peer repair action: ${options.action}`);
}

function accessDeniedReason(userVisible: boolean, localAllowed: boolean | null, peerAllowed: boolean | null, permission: Permission): string {
  if (!userVisible) return "User group peer scope denies this peer.";
  if (localAllowed === false) return `The authenticated user is missing ${permission}.`;
  if (peerAllowed === false) return `The peer is missing ${permission}.`;
  return "Access denied by the effective user or peer policy.";
}

async function runPeerProbes(peer: PeerRecord, store: PeerStore, options: PeerDebugOptions): Promise<PeerDiagnosticCheck[]> {
  const checks: PeerDiagnosticCheck[] = [];
  const timeoutMs = options.timeoutMs ?? 4_000;
  const client = new RemoteRelayClient(store, options.home);

  if (!peer.url) {
    checks.push(check("endpoint-health", "Peer health endpoint", "skipped", "peer.url.missing", "No direct peer URL is configured.", "Use outbound relay or set a public peer URL."));
    checks.push(check("endpoint-identity", "Peer identity endpoint", "skipped", "peer.url.missing", "No direct peer URL is configured.", "Use outbound relay or set a public peer URL."));
  } else {
    const endpoint = await checkPeerEndpoint(peer.url, { expectedTlsFingerprint: peer.tlsFingerprint, timeoutMs });
    checks.push(checkFromProbe("endpoint-health", "Peer health endpoint", endpoint.ok, endpoint.detail, {
      latencyMs: endpoint.latencyMs,
      statusCode: endpoint.statusCode,
      tlsFingerprint: endpoint.tlsFingerprint,
      expectedTlsFingerprint: peer.tlsFingerprint,
    }));
    recordProbe(store, peer.id, "endpoint-health", endpoint.ok, checks.at(-1)!);

    const identity = await checkPeerIdentityEndpoint(peer.url, { expectedTlsFingerprint: peer.tlsFingerprint, timeoutMs });
    const identityMatch = identity.ok && identity.identity && peerIdentityMatches(peer, identity.identity);
    const identityCheck = identity.ok && identity.identity && !identityMatch
      ? check("endpoint-identity", "Peer identity endpoint", "error", "peer.identity.node_mismatch", "Peer identity endpoint is reachable, but the node identity does not match the stored peer.", "Rotate pairing or revoke and add the peer again.", {
        latencyMs: identity.latencyMs,
        statusCode: identity.statusCode,
        tlsFingerprint: identity.tlsFingerprint,
        expectedTlsFingerprint: peer.tlsFingerprint,
      })
      : checkFromProbe("endpoint-identity", "Peer identity endpoint", Boolean(identity.ok && identity.identity), identity.detail, {
        latencyMs: identity.latencyMs,
        statusCode: identity.statusCode,
        tlsFingerprint: identity.tlsFingerprint,
        expectedTlsFingerprint: peer.tlsFingerprint,
      });
    checks.push(identityCheck);
    recordProbe(store, peer.id, "endpoint-identity", identityCheck.status === "ok", identityCheck);
  }

  checks.push(await rpcCheck("rpc-ping", "Signed RPC ping", () => client.rpc(peer.id, "peer.ping", undefined, options.actor, { timeoutMs }), store, peer.id));

  for (const route of ROUTE_CHECKS) {
    if (!peer.scopes.includes(route.permission)) {
      checks.push(check(route.id, route.label, "error", "peer.scope.missing", `Peer scope ${route.permission} is required for ${route.method} ${route.path}.`, `Add ${route.permission} to this peer's scopes if this route should be available.`, { route: `${route.method} ${route.path}` }));
      continue;
    }
    checks.push(await rpcCheck(
      route.id,
      route.label,
      () => client.webProxy(peer.id, {
        method: route.method,
        path: route.path,
        query: route.query,
        body: {},
        contextKey: "web:peer-debug",
      }, options.actor, "web:peer-debug", { timeoutMs }),
      store,
      peer.id,
      `${route.method} ${route.path}`,
    ));
  }

  if (!peer.url) {
    checks.push(check("events", "Live event stream", "skipped", "peer.relay.only", "Direct SSE events require a peer URL. Relay mode stores and forwards events through relay polling.", "Use a direct peer URL for live event streaming, or rely on outbound relay events."));
  } else if (!peer.scopes.includes("sessions.read")) {
    checks.push(check("events", "Live event stream", "error", "peer.scope.missing", "Live events require sessions.read.", "Add sessions.read to this peer's scopes."));
  } else {
    checks.push(check("events", "Live event stream", "ok", "peer.ok", "Event stream prerequisites are satisfied. The WebUI opens the live stream when this peer is selected."));
  }

  const relay = getPeerRelayBroker(options.home).snapshot();
  const relayPending = relay.pending.filter((item) => item.peerId === peer.id).length;
  const relayInFlight = relay.inFlight.filter((item) => item.peerId === peer.id).length;
  const relayFailed = relay.completed.filter((item) => item.peerId === peer.id && !item.ok).length;
  checks.push(check(
    "relay-queue",
    "Relay queue",
    relayFailed > 0 ? "warn" : "ok",
    relayFailed > 0 ? "peer.relay.timeout" : "peer.ok",
    `${relayPending} pending, ${relayInFlight} in flight, ${relayFailed} failed retained request(s).`,
    relayFailed > 0 ? "Retry stale relay requests or drain expired relay entries." : undefined,
  ));

  return checks;
}

async function rpcCheck(
  id: string,
  label: string,
  action: () => Promise<unknown>,
  store: PeerStore,
  peerId: string,
  route?: string,
): Promise<PeerDiagnosticCheck> {
  const started = Date.now();
  try {
    const data = await action();
    const record = data && typeof data === "object" ? data as { version?: unknown; status?: unknown } : {};
    const result = check(id, label, "ok", "peer.ok", "Request completed successfully.", undefined, {
      latencyMs: Date.now() - started,
      remoteVersion: typeof record.version === "string" ? record.version : undefined,
      remoteStatus: typeof record.status === "string" ? record.status : undefined,
      route,
    });
    store.markSeen(peerId, {
      check: id,
      code: result.code,
      latencyMs: result.latencyMs,
      remoteVersion: result.remoteVersion,
      remoteStatus: result.remoteStatus,
      detail: result.detail,
    });
    return result;
  } catch (error) {
    const classified = classifyPeerError(error);
    const result = check(id, label, "error", classified.code, classified.detail, classified.remediation, {
      latencyMs: Date.now() - started,
      route,
    });
    store.markError(peerId, result.detail, {
      check: id,
      code: result.code,
      detail: result.detail,
      remediation: result.remediation,
    });
    return result;
  }
}

function checkFromProbe(
  id: string,
  label: string,
  ok: boolean,
  detail: string,
  extra: Partial<PeerDiagnosticCheck> = {},
): PeerDiagnosticCheck {
  if (ok) {
    return check(id, label, "ok", "peer.ok", detail, undefined, extra);
  }
  const classified = classifyPeerError(detail);
  return check(id, label, "error", classified.code, classified.detail, classified.remediation, extra);
}

function recordProbe(store: PeerStore, peerId: string, id: string, ok: boolean, result: PeerDiagnosticCheck): void {
  const patch = {
    check: id,
    code: result.code,
    latencyMs: result.latencyMs,
    statusCode: result.statusCode,
    tlsFingerprint: result.tlsFingerprint,
    expectedTlsFingerprint: result.expectedTlsFingerprint,
    detail: result.detail,
    remediation: result.remediation,
  };
  if (ok) {
    store.markSeen(peerId, patch);
  } else {
    store.markError(peerId, result.detail, patch);
  }
}

function repairActionsForPeer(peer: PeerRecord): PeerRepairAction[] {
  return [
    peer.url ? "repin-tls" : null,
    peer.lastError ? "clear-error" : null,
    peer.enabled ? "disable" : "enable",
    "retry-relay",
    "drain-expired",
    "rotate-pairing",
  ].filter((item): item is PeerRepairAction => Boolean(item));
}

function summarizeChecks(checks: PeerDiagnosticCheck[]): PeerDebugReport["summary"] {
  const errors = checks.filter((item) => item.status === "error");
  const warnings = checks.filter((item) => item.status === "warn");
  const skipped = checks.filter((item) => item.status === "skipped");
  const ok = checks.filter((item) => item.status === "ok");
  const primary = errors[0] ?? warnings[0];
  return {
    status: errors.length ? "error" : warnings.length ? "warn" : "ok",
    ok: ok.length,
    warnings: warnings.length,
    errors: errors.length,
    skipped: skipped.length,
    primaryIssue: primary?.detail,
    remediation: primary?.remediation,
  };
}

function check(
  id: string,
  label: string,
  status: PeerDiagnosticStatus,
  code: PeerDiagnosticCode,
  detail: string,
  remediation?: string,
  extra: Partial<PeerDiagnosticCheck> = {},
): PeerDiagnosticCheck {
  return { id, label, status, code, detail, remediation, ...extra };
}

function peerIdentityMatches(peer: Pick<PeerRecord, "nodeId" | "publicKey" | "fingerprint">, identity: { nodeId: string; publicKey: string; fingerprint: string }): boolean {
  return peer.nodeId === identity.nodeId && peer.publicKey === identity.publicKey && peer.fingerprint === identity.fingerprint;
}

function assertPeerIdentityMatches(peer: Pick<PeerRecord, "nodeId" | "publicKey" | "fingerprint">, identity: { nodeId: string; publicKey: string; fingerprint: string }): void {
  if (!peerIdentityMatches(peer, identity)) {
    throw new Error("Peer identity changed. Re-pair this peer instead of re-pinning TLS.");
  }
}

export function permissionForPeerRoute(method: string, path: string): Permission | null {
  return permissionForWebRequest(method, path);
}

export function peerAgentScopeText(agents: AgentId[]): string {
  return agents.length ? agents.join(", ") : "all";
}
