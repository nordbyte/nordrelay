import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";

import { enabledAgents } from "./agent-factory.js";
import { buildAdapterConformanceMatrix } from "./adapter-conformance.js";
import { listAgentAdapterDescriptors } from "./agent-adapter.js";
import { isAgentId } from "./agent.js";
import { AuditLogStore, type AuditEvent } from "./audit-log.js";
import { listChannelDescriptors } from "./channel-adapter.js";
import { permissionForWebRequest } from "./access-control.js";
import { loadConfig } from "./config.js";
import { friendlyErrorText } from "./error-messages.js";
import { RelayRuntime, type ActiveSessionsDto, type DashboardControlOptions, type RelayEvent, type SessionPageDto, type WebTasksDto } from "./relay-runtime.js";
import { resolveDashboardEnvPath, SettingsService } from "./settings-service.js";
import { mergeSettingsWizardTestSettings, runSettingsWizardTest } from "./settings-wizard-test.js";
import { UserStore, publicUser, type AuthenticatedUser } from "./user-management.js";
import type { WebActivityActor } from "./web-state.js";
import { handleDashboardAccessRoute } from "./web-dashboard-access-routes.js";
import { handleDashboardArtifactRoute } from "./web-dashboard-artifact-routes.js";
import { dashboardCss, dashboardJs } from "./web-dashboard-assets.js";
import {
  objectRecord,
  optionalStringField,
  parseCookies,
  readJsonBody,
  sendJson,
  sendText,
} from "./web-dashboard-http.js";
import { renderDashboardApp, renderFirstRunSetupPage, renderLoginPage } from "./web-dashboard-pages.js";
import { handleDashboardRuntimeRoute } from "./web-dashboard-runtime-routes.js";
import { handleDashboardSessionRoute } from "./web-dashboard-session-routes.js";
import { handleDashboardPeerRoute } from "./web-dashboard-peer-routes.js";

interface DashboardOptions {
  host: string;
  port: number;
  home: string;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
  blockedUntil?: number;
}

const DEFAULT_HOME = path.join(os.homedir(), ".nordrelay");

const options = parseOptions(process.argv.slice(2));
const config = loadConfig();
const runtime = new RelayRuntime(config);
const settings = new SettingsService(resolveDashboardEnvPath(options.home));
const users = new UserStore(options.home);
const auditLog = new AuditLogStore(config.workspace, config.stateBackend, config.auditMaxEvents);
const loginAttempts = new Map<string, RateLimitBucket>();
const firstRunSetupToken = users.hasAdminUser() ? undefined : randomBytes(18).toString("base64url");
const firstRunSetupRequiresToken = !isLoopbackHost(options.host);

if (firstRunSetupToken) {
  console.log(`NordRelay first-run setup token: ${firstRunSetupToken}`);
}

class AccessDeniedError extends Error {}

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    sendJson(res, error instanceof AccessDeniedError ? 403 : 500, { error: friendlyErrorText(error) });
  });
});

await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
console.log(`NordRelay dashboard: http://${options.host}:${options.port}/`);

process.once("SIGINT", () => shutdown());
process.once("SIGTERM", () => shutdown());

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/api/auth" && req.method === "POST") {
    await handleLogin(req, res);
    return;
  }
  if (url.pathname === "/api/setup/admin" && req.method === "POST") {
    await handleFirstRunSetup(req, res);
    return;
  }
  if (url.pathname === "/api/dashboard/logout" && req.method === "POST") {
    handleLogout(req, res);
    return;
  }

  const authenticated = authenticateRequest(req);
  if (url.pathname === "/api/auth/me" && req.method === "GET") {
    if (!authenticated) {
      sendJson(res, 401, { error: "Authentication required", adminConfigured: users.hasAdminUser() });
      return;
    }
    sendJson(res, 200, currentUserDto(authenticated));
    return;
  }

  if (!authenticated) {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (!users.hasAdminUser()) {
        sendText(res, 200, renderFirstRunSetupPage({ tokenRequired: firstRunSetupRequiresToken || !isLoopbackRequest(req) }), "text/html; charset=utf-8");
        return;
      }
      sendText(res, 200, renderLoginPage({ adminConfigured: users.hasAdminUser() }), "text/html; charset=utf-8");
      return;
    }
    sendJson(res, 401, { error: "Authentication required", adminConfigured: users.hasAdminUser() });
    return;
  }

  if (url.pathname === "/healthz") {
    if (!users.hasPermission(authenticated, "inspect")) {
      sendText(res, 403, "access denied\n", "text/plain; charset=utf-8");
      return;
    }
    sendText(res, 200, "ok\n", "text/plain; charset=utf-8");
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    sendText(res, 200, renderDashboardApp(), "text/html; charset=utf-8");
    return;
  }

  if (url.pathname === "/assets/dashboard.css") {
    sendText(res, 200, dashboardCss(), "text/css; charset=utf-8");
    return;
  }

  if (url.pathname === "/assets/dashboard.js") {
    sendText(res, 200, dashboardJs(), "application/javascript; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/events" && req.method === "GET") {
    await handleEvents(req, res);
    return;
  }

  if (!url.pathname.startsWith("/api/")) {
    sendText(res, 404, "not found\n", "text/plain; charset=utf-8");
    return;
  }

  await handleApi(req, res, url, authenticated);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, authUser: AuthenticatedUser): Promise<void> {
  const permission = permissionForWebRequest(req.method, url.pathname);
  if (!permission) {
    audit({
      action: "permission_denied",
      status: "denied",
      channelId: "web",
      contextKey: "web",
      actor: webActivityActor(authUser),
      actorId: authUser.user.id,
      actorRole: authUser.groups.map((group) => group.name).join(", "),
      description: `Denied unknown endpoint ${req.method ?? "GET"} ${url.pathname}`,
    });
    sendJson(res, 403, { error: "Access denied." });
    return;
  }
  if (!users.hasPermission(authUser, permission)) {
    audit({
      action: "permission_denied",
      status: "denied",
      channelId: "web",
      contextKey: "web",
      actor: webActivityActor(authUser),
      actorId: authUser.user.id,
      actorRole: authUser.groups.map((group) => group.name).join(", "),
      description: `${permission} required for ${req.method ?? "GET"} ${url.pathname}`,
    });
    sendJson(res, 403, { error: `Access denied: ${permission} permission required.` });
    return;
  }

  if (await handleDashboardRuntimeRoute(req, res, url, {
    runtime,
    users,
    authUser,
    parseAgentIdRequired,
    assertScopedAgent,
    assertAgentUpdateJobScope,
    assertCurrentSessionScope,
    scopedTasks,
    scopedActiveSessions,
    activityActor: webActivityActor(authUser),
  })) {
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    await assertCurrentSessionScope(authUser);
    sendJson(res, 200, {
      auth: currentUserDto(authUser),
      channels: listChannelDescriptors(),
      agentAdapters: listAgentAdapterDescriptors().filter((adapter) => users.canUseAgent(authUser, adapter.id)),
      adapterConformance: scopedAdapterConformance(authUser),
      enabledAgents: enabledAgents(config).filter((agentId) => users.canUseAgent(authUser, agentId)),
      controls: scopedControlOptions(authUser, await runtime.controlOptions()),
      status: await runtime.bootstrapStatus(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/control-options") {
    const agentId = parseAgentId(url.searchParams.get("agent") ?? undefined);
    assertScopedAgent(authUser, agentId);
    sendJson(res, 200, scopedControlOptions(authUser, await runtime.controlOptions(agentId)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/adapters/conformance") {
    sendJson(res, 200, scopedAdapterConformance(authUser));
    return;
  }

  if (await handleDashboardAccessRoute(req, res, url, {
    users,
    runtime,
    authUser,
    auditUserAction,
  })) {
    return;
  }

  if (await handleDashboardPeerRoute(req, res, url, {
    config,
    home: options.home,
    runtime,
    activityActor: webActivityActor(authUser),
    auditPeerAction: (action, description) => auditUserAction(authUser, action, description),
  })) {
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    sendJson(res, 200, await settings.snapshot(process.env, activeSettingsValues(config)));
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/settings") {
    const body = await readJsonBody(req);
    sendJson(res, 200, await settings.update(objectRecord(body?.settings)));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings/wizard/test") {
    const body = await readJsonBody(req);
    sendJson(res, 200, await runSettingsWizardTest(
      optionalStringField(body, "channel") ?? "",
      mergeSettingsWizardTestSettings(activeSettingsValues(config), objectRecord(body?.settings)),
    ));
    return;
  }

  if (await handleDashboardSessionRoute(req, res, url, {
    runtime,
    authUser,
    parseAgentId,
    assertScopedAgent,
    assertScopedWorkspace,
    assertCurrentSessionScope,
    assertSessionScope,
    assertSessionDetailScope,
    scopedSessionPage,
    filterActivityByScope,
    activityActor: webActivityActor(authUser),
  })) {
    return;
  }

  if (await handleDashboardArtifactRoute(req, res, url, {
    runtime,
    authUser,
    assertCurrentSessionScope,
    activityActor: webActivityActor(authUser),
  })) {
    return;
  }

  sendJson(res, 404, { error: "Unknown endpoint" });
}

async function handleEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const authUser = authenticateRequest(req);
  if (!authUser) {
    sendJson(res, 401, { error: "Authentication required" });
    return;
  }
  if (!users.hasPermission(authUser, "sessions.read")) {
    sendJson(res, 403, { error: "Access denied: sessions.read permission required." });
    return;
  }
  await assertCurrentSessionScope(authUser);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const send = (event: RelayEvent) => {
    void scopeRelayEvent(authUser, event, canUseCurrentSession).then((scopedEvent) => {
      if (!scopedEvent || res.destroyed || res.writableEnded) {
        return;
      }
      res.write(`event: ${scopedEvent.type}\n`);
      res.write(`data: ${JSON.stringify(scopedEvent)}\n\n`);
    }).catch(() => {});
  };
  let currentScopeCache: { allowed: boolean; expiresAt: number } | null = null;
  const canUseCurrentSession = async (): Promise<boolean> => {
    const now = Date.now();
    if (currentScopeCache && currentScopeCache.expiresAt > now) {
      return currentScopeCache.allowed;
    }
    const allowed = await canUseCurrentSessionScope(authUser);
    currentScopeCache = { allowed, expiresAt: now + 1_000 };
    return allowed;
  };
  const unsubscribe = runtime.subscribe(send);
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 25_000);
  heartbeat.unref?.();
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function handleFirstRunSetup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (users.hasAdminUser()) {
    sendJson(res, 409, { error: "Admin user already exists." });
    return;
  }
  const body = await readJsonBody(req);
  const email = optionalStringField(body, "email") ?? "";
  const displayName = optionalStringField(body, "displayName") ?? email;
  const password = optionalStringField(body, "password") ?? "";
  const setupToken = optionalStringField(body, "setupToken") ?? "";
  if ((firstRunSetupRequiresToken || !isLoopbackRequest(req)) && setupToken !== firstRunSetupToken) {
    audit({
      action: "auth_login_failed",
      status: "denied",
      channelId: "web",
      contextKey: "web",
      description: `Rejected remote first-run setup for ${email || "unknown"}`,
    });
    sendJson(res, 403, { error: "Setup token required." });
    return;
  }
  if (setupToken && setupToken !== firstRunSetupToken) {
    sendJson(res, 403, { error: "Invalid setup token." });
    return;
  }
  if (!email || !password || password.length < 12) {
    sendJson(res, 400, { error: "Email and a password with at least 12 characters are required." });
    return;
  }
  const authUser = users.createAdmin({ email, displayName, password });
  const session = users.createWebSession(authUser.user.id);
  audit({
    action: "user_created",
    status: "ok",
    channelId: "web",
    contextKey: "web",
    actor: webActivityActor(authUser),
    actorId: authUser.user.id,
    actorRole: authUser.groups.map((group) => group.name).join(", "),
    description: `First admin created: ${authUser.user.email}`,
  });
  runtime.recordActivity({
    source: "web",
    status: "info",
    type: "first_run_admin_created",
    threadId: null,
    actor: webActivityActor(authUser),
    detail: authUser.user.email,
  });
  setSessionCookie(res, session.token);
  sendJson(res, 201, currentUserDto(authUser));
}

async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const email = optionalStringField(body, "email");
  const password = optionalStringField(body, "password");
  const rateLimitKey = `${req.socket.remoteAddress ?? "unknown"}:${email ?? "-"}`;
  const limited = consumeRateLimit(loginAttempts, rateLimitKey, 5, 15 * 60 * 1000, 15 * 60 * 1000);
  if (limited.limited) {
    audit({
      action: "auth_login_failed",
      status: "denied",
      channelId: "web",
      contextKey: "web",
      description: `Rate limited login attempt for ${email ?? "unknown"}`,
      detail: `${Math.ceil((limited.retryAfterMs ?? 0) / 1000)}s retry-after`,
    });
    sendJson(res, 429, { error: "Too many login attempts. Try again later.", retryAfterMs: limited.retryAfterMs });
    return;
  }
  if (!users.hasAdminUser()) {
    sendJson(res, 503, { error: "No admin user exists. Run nordrelay user create-admin first." });
    return;
  }
  const authUser = email && password ? users.verifyPassword(email, password) : null;
  if (!authUser) {
    audit({
      action: "auth_login_failed",
      status: "failed",
      channelId: "web",
      contextKey: "web",
      description: `Failed login for ${email ?? "unknown"}`,
    });
    sendJson(res, 401, { error: "Invalid credentials" });
    return;
  }
  resetRateLimit(loginAttempts, rateLimitKey);
  const session = users.createWebSession(authUser.user.id);
  audit({
    action: "auth_login",
    status: "ok",
      channelId: "web",
      contextKey: "web",
      actor: webActivityActor(authUser),
      actorId: authUser.user.id,
      actorRole: authUser.groups.map((group) => group.name).join(", "),
      description: `Login ${authUser.user.email}`,
  });
  runtime.recordActivity({
    source: "web",
    status: "info",
    type: "auth_login",
    threadId: null,
    actor: webActivityActor(authUser),
    detail: authUser.user.email,
  });
  setSessionCookie(res, session.token);
  sendJson(res, 200, currentUserDto(authUser));
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address === "localhost";
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function handleLogout(req: IncomingMessage, res: ServerResponse): void {
  const authUser = authenticateRequest(req);
  users.destroyWebSession(parseCookies(req.headers.cookie ?? "").nr_session);
  if (authUser) {
    auditUserAction(authUser, "auth_logout", authUser.user.email);
  }
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
}

function parseOptions(argv: string[]): DashboardOptions {
  let host = process.env.NORDRELAY_DASHBOARD_HOST || "127.0.0.1";
  let port = Number.parseInt(process.env.NORDRELAY_DASHBOARD_PORT || "31878", 10);
  let home = process.env.NORDRELAY_HOME || DEFAULT_HOME;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") host = requireArg(argv, ++index, arg);
    else if (arg === "--port") port = Number.parseInt(requireArg(argv, ++index, arg), 10);
    else if (arg === "--home") home = requireArg(argv, ++index, arg);
  }
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("Dashboard port must be a positive number.");
  }
  return { host, port, home };
}

function authenticateRequest(req: IncomingMessage): AuthenticatedUser | null {
  const cookies = parseCookies(req.headers.cookie ?? "");
  return users.resolveWebSession(cookies.nr_session);
}

function setSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader("set-cookie", `nr_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`);
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader("set-cookie", "nr_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
}

function currentUserDto(authUser: AuthenticatedUser) {
  return {
    user: publicUser(authUser.user),
    groups: authUser.groups,
    permissions: authUser.permissions,
  };
}

function audit(event: Omit<AuditEvent, "id" | "timestamp" | "channelId"> & { channelId?: AuditEvent["channelId"] }): void {
  try {
    auditLog.append(event);
  } catch (error) {
    console.warn("Failed to write audit event:", error instanceof Error ? error.message : String(error));
  }
}

function auditUserAction(authUser: AuthenticatedUser, action: AuditEvent["action"], description: string): void {
  audit({
    action,
    status: "ok",
    channelId: "web",
    contextKey: "web",
    actor: webActivityActor(authUser),
    actorId: authUser.user.id,
    actorRole: authUser.groups.map((group) => group.name).join(", "),
    description,
  });
  runtime.recordActivity({
    source: "web",
    status: "info",
    type: action,
    threadId: null,
    actor: webActivityActor(authUser),
    detail: description,
  });
}

function webActivityActor(authUser: AuthenticatedUser): WebActivityActor {
  return {
    channel: "web",
    id: authUser.user.id,
    label: authUser.user.displayName || authUser.user.email,
    username: authUser.user.email,
  };
}

function scopedControlOptions(authUser: AuthenticatedUser, options: DashboardControlOptions): DashboardControlOptions {
  return {
    ...options,
    workspaces: options.workspaces.filter((workspace) => users.canUseWorkspace(authUser, workspace)),
  };
}

function scopedAdapterConformance(authUser: AuthenticatedUser) {
  const matrix = buildAdapterConformanceMatrix();
  return {
    ...matrix,
    agents: matrix.agents.filter((adapter) => users.canUseAgent(authUser, adapter.id)),
  };
}

function scopedSessionPage(authUser: AuthenticatedUser, page: SessionPageDto): SessionPageDto {
  return {
    ...page,
    sessions: page.sessions.filter((session) => canUseSession(authUser, session)),
  };
}

async function scopedTasks(authUser: AuthenticatedUser, tasks: WebTasksDto): Promise<WebTasksDto> {
  const currentAllowed = await canUseCurrentSessionScope(authUser);
  return {
    ...tasks,
    current: tasks.current && canUseSession(authUser, tasks.current) ? tasks.current : null,
    external: tasks.external && canUseSession(authUser, tasks.external) ? tasks.external : null,
    queue: currentAllowed ? tasks.queue : [],
    recent: filterActivityByScope(authUser, tasks.recent),
  };
}

function scopedActiveSessions(authUser: AuthenticatedUser, active: ActiveSessionsDto): ActiveSessionsDto {
  return {
    ...active,
    sessions: active.sessions.filter((session) => canUseSession(authUser, session)),
  };
}

async function scopeRelayEvent(
  authUser: AuthenticatedUser,
  event: RelayEvent,
  canUseCurrentSession: () => Promise<boolean> = () => canUseCurrentSessionScope(authUser),
): Promise<RelayEvent | null> {
  switch (event.type) {
    case "snapshot":
      return canUseSession(authUser, event.data.session) ? event : null;
    case "session_update":
      return canUseSession(authUser, event.session) ? event : null;
    case "activity_update":
      return { ...event, events: filterActivityByScope(authUser, event.events) };
    case "active_sessions_update":
      return { ...event, active: scopedActiveSessions(authUser, event.active) };
    case "agent_update":
      return users.canUseAgent(authUser, event.job.agentId) ? event : null;
    case "status":
      return event;
    case "chat_history":
    case "queue_update":
    case "turn_start":
    case "text_delta":
    case "tool_start":
    case "tool_update":
    case "tool_end":
    case "todo_update":
    case "turn_complete":
    case "turn_error":
      return await canUseCurrentSession() ? event : null;
  }
}

function filterActivityByScope<T extends { agentId?: string; workspace?: string }>(authUser: AuthenticatedUser, events: T[]): T[] {
  return events.filter((event) => canUseSession(authUser, event));
}

async function canUseCurrentSessionScope(authUser: AuthenticatedUser): Promise<boolean> {
  try {
    await assertCurrentSessionScope(authUser);
    return true;
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return false;
    }
    throw error;
  }
}

function canUseSession(authUser: AuthenticatedUser, session: { agentId?: string; workspace?: string; cwd?: string } | Record<string, unknown>): boolean {
  const agentId = typeof session.agentId === "string" ? session.agentId : undefined;
  const workspace = typeof session.workspace === "string"
    ? session.workspace
    : typeof session.cwd === "string"
      ? session.cwd
      : undefined;
  return users.canUseAgent(authUser, agentId) && users.canUseWorkspace(authUser, workspace);
}

function assertAgentUpdateJobScope(authUser: AuthenticatedUser, id: string): void {
  const job = runtime.agentUpdateJobs().find((candidate) => candidate.id === id);
  if (job) {
    assertScopedAgent(authUser, job.agentId);
  }
}

function assertSessionDetailScope(authUser: AuthenticatedUser, threadId: string, detail: Record<string, unknown>): void {
  const record = objectValue(detail.record);
  if (record) {
    assertSessionScope(authUser, record);
    return;
  }

  const active = objectValue(detail.active);
  if (active && active.threadId === threadId) {
    assertSessionScope(authUser, active);
    return;
  }

  throw new AccessDeniedError("Access denied: session is outside your group scope.");
}

function assertScopedAgent(authUser: AuthenticatedUser, agentId: string | undefined): void {
  if (!users.canUseAgent(authUser, agentId)) {
    throw new AccessDeniedError(`Access denied: agent ${agentId} is outside your group scope.`);
  }
}

function assertScopedWorkspace(authUser: AuthenticatedUser, workspace: string | undefined): void {
  if (!users.canUseWorkspace(authUser, workspace)) {
    throw new AccessDeniedError(`Access denied: workspace ${workspace} is outside your group scope.`);
  }
}

function assertSessionScope(authUser: AuthenticatedUser, session: { agentId?: string; workspace?: string; cwd?: string } | Record<string, unknown>): void {
  const agentId = typeof session.agentId === "string" ? session.agentId : undefined;
  const workspace = typeof session.workspace === "string"
    ? session.workspace
    : typeof session.cwd === "string"
      ? session.cwd
      : undefined;
  assertScopedAgent(authUser, agentId);
  assertScopedWorkspace(authUser, workspace);
}

async function assertCurrentSessionScope(authUser: AuthenticatedUser): Promise<void> {
  const snapshot = await runtime.snapshot();
  assertSessionScope(authUser, snapshot.session);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function consumeRateLimit(
  buckets: Map<string, RateLimitBucket>,
  key: string,
  limit: number,
  windowMs: number,
  blockMs: number,
): { limited: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const existing = buckets.get(key);
  if (existing?.blockedUntil && existing.blockedUntil > now) {
    return { limited: true, retryAfterMs: existing.blockedUntil - now };
  }
  const bucket = !existing || existing.resetAt <= now ? { count: 0, resetAt: now + windowMs } : existing;
  bucket.count += 1;
  if (bucket.count > limit) {
    bucket.blockedUntil = now + blockMs;
    buckets.set(key, bucket);
    return { limited: true, retryAfterMs: blockMs };
  }
  buckets.set(key, bucket);
  return { limited: false };
}

function resetRateLimit(buckets: Map<string, RateLimitBucket>, key: string): void {
  buckets.delete(key);
}

function parseAgentId(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  return parseAgentIdRequired(value);
}

function parseAgentIdRequired(value: string) {
  if (!isAgentId(value)) {
    throw new Error(`Invalid agent: ${value}`);
  }
  return value;
}

function optionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value || undefined;
}

function activeSettingsValues(current: typeof config): Record<string, string | undefined> {
  return {
    TELEGRAM_ENABLED: boolValue(current.telegramEnabled),
    TELEGRAM_BOT_TOKEN: current.telegramBotToken,
    TELEGRAM_TRANSPORT: current.telegramTransport,
    TELEGRAM_WEBHOOK_URL: current.telegramWebhookUrl,
    TELEGRAM_WEBHOOK_HOST: current.telegramWebhookHost,
    TELEGRAM_WEBHOOK_PORT: String(current.telegramWebhookPort),
    TELEGRAM_WEBHOOK_PATH: current.telegramWebhookPath,
    TELEGRAM_WEBHOOK_SECRET: current.telegramWebhookSecret,
    DISCORD_ENABLED: boolValue(current.discordEnabled),
    DISCORD_BOT_TOKEN: current.discordBotToken,
    DISCORD_CLIENT_ID: current.discordClientId,
    DISCORD_GUILD_IDS: current.discordGuildIds.join(","),
    DISCORD_ALLOWED_GUILD_IDS: current.discordAllowedGuildIds.join(","),
    DISCORD_ALLOWED_CHANNEL_IDS: current.discordAllowedChannelIds.join(","),
    DISCORD_MESSAGE_CONTENT_ENABLED: boolValue(current.discordMessageContentEnabled),
    DISCORD_COMMAND_MODE: current.discordCommandMode,
    DISCORD_AUTO_REGISTER_COMMANDS: boolValue(current.discordAutoRegisterCommands),
    DISCORD_CLI_MIRROR_MODE: current.discordMirrorMode === current.mirrorMode ? "" : current.discordMirrorMode,
    DISCORD_CLI_MIRROR_MIN_UPDATE_MS: current.discordMirrorMinUpdateMs === current.mirrorMinUpdateMs ? "" : String(current.discordMirrorMinUpdateMs),
    DISCORD_NOTIFY_MODE: current.discordNotifyMode === current.notifyMode ? "" : current.discordNotifyMode,
    DISCORD_QUIET_HOURS: quietOverrideValue(current.discordQuietHours, current.quietHours),
    DISCORD_AUTO_SEND_ARTIFACTS: current.discordAutoSendArtifacts === current.autoSendArtifacts ? "" : boolValue(current.discordAutoSendArtifacts),
    SLACK_ENABLED: boolValue(current.slackEnabled),
    SLACK_BOT_TOKEN: current.slackBotToken,
    SLACK_APP_TOKEN: current.slackAppToken,
    SLACK_SIGNING_SECRET: current.slackSigningSecret,
    SLACK_SOCKET_MODE: boolValue(current.slackSocketMode),
    SLACK_PORT: String(current.slackPort),
    SLACK_ALLOWED_TEAM_IDS: current.slackAllowedTeamIds.join(","),
    SLACK_ALLOWED_CHANNEL_IDS: current.slackAllowedChannelIds.join(","),
    SLACK_MESSAGE_CONTENT_ENABLED: boolValue(current.slackMessageContentEnabled),
    SLACK_COMMAND: current.slackCommand,
    SLACK_CLI_MIRROR_MODE: current.slackMirrorMode === current.mirrorMode ? "" : current.slackMirrorMode,
    SLACK_CLI_MIRROR_MIN_UPDATE_MS: current.slackMirrorMinUpdateMs === current.mirrorMinUpdateMs ? "" : String(current.slackMirrorMinUpdateMs),
    SLACK_NOTIFY_MODE: current.slackNotifyMode === current.notifyMode ? "" : current.slackNotifyMode,
    SLACK_QUIET_HOURS: quietOverrideValue(current.slackQuietHours, current.quietHours),
    SLACK_AUTO_SEND_ARTIFACTS: current.slackAutoSendArtifacts === current.autoSendArtifacts ? "" : boolValue(current.slackAutoSendArtifacts),
    NORDRELAY_CODEX_ENABLED: boolValue(current.codexEnabled),
    NORDRELAY_PI_ENABLED: boolValue(current.piEnabled),
    NORDRELAY_HERMES_ENABLED: boolValue(current.hermesEnabled),
    NORDRELAY_OPENCLAW_ENABLED: boolValue(current.openClawEnabled),
    NORDRELAY_CLAUDE_CODE_ENABLED: boolValue(current.claudeCodeEnabled),
    NORDRELAY_DEFAULT_AGENT: current.defaultAgent,
    CODEX_API_KEY: current.codexApiKey,
    CODEX_CLI_PATH: optionalEnv("CODEX_CLI_PATH"),
    CODEX_USE_BUNDLED_CLI: process.env.CODEX_USE_BUNDLED_CLI,
    CODEX_MODEL: current.codexModel,
    CODEX_SYNC_INTERVAL_MS: String(current.codexSyncIntervalMs),
    CODEX_EXTERNAL_BUSY_CHECK_MS: String(current.codexExternalBusyCheckMs),
    CODEX_EXTERNAL_BUSY_STALE_MS: String(current.codexExternalBusyStaleMs),
    CODEX_SANDBOX_MODE: current.codexSandboxMode,
    CODEX_APPROVAL_POLICY: current.codexApprovalPolicy,
    CODEX_LAUNCH_PROFILES_JSON: optionalEnv("CODEX_LAUNCH_PROFILES_JSON"),
    CODEX_DEFAULT_LAUNCH_PROFILE: current.defaultLaunchProfileId,
    ENABLE_UNSAFE_LAUNCH_PROFILES: boolValue(current.enableUnsafeLaunchProfiles),
    PI_CLI_PATH: current.piCliPath,
    PI_SESSION_DIR: current.piSessionDir,
    PI_DEFAULT_MODEL: current.piDefaultModel,
    PI_DEFAULT_THINKING: current.piDefaultThinking,
    PI_DEFAULT_PROFILE: current.piDefaultLaunchProfileId,
    HERMES_CLI_PATH: current.hermesCliPath,
    HERMES_HOME: current.hermesHome,
    HERMES_STATE_DB_PATH: current.hermesStateDbPath,
    HERMES_API_BASE_URL: current.hermesApiBaseUrl,
    HERMES_API_KEY: current.hermesApiKey,
    HERMES_DEFAULT_MODEL: current.hermesDefaultModel,
    HERMES_DEFAULT_REASONING: current.hermesDefaultReasoning,
    HERMES_DEFAULT_PROFILE: current.hermesDefaultLaunchProfileId,
    OPENCLAW_GATEWAY_URL: current.openClawGatewayUrl,
    OPENCLAW_CLI_PATH: current.openClawCliPath,
    OPENCLAW_GATEWAY_TOKEN: current.openClawGatewayToken,
    OPENCLAW_GATEWAY_PASSWORD: current.openClawGatewayPassword,
    OPENCLAW_AGENT_ID: current.openClawAgentId,
    OPENCLAW_HOME: current.openClawHome,
    OPENCLAW_STATE_DIR: current.openClawStateDir,
    OPENCLAW_DEFAULT_MODEL: current.openClawDefaultModel,
    OPENCLAW_DEFAULT_THINKING: current.openClawDefaultThinking,
    OPENCLAW_DEFAULT_PROFILE: current.openClawDefaultLaunchProfileId,
    CLAUDE_CODE_CLI_PATH: current.claudeCodeCliPath,
    CLAUDE_CONFIG_DIR: current.claudeCodeConfigDir,
    CLAUDE_CODE_DEFAULT_MODEL: current.claudeCodeDefaultModel,
    CLAUDE_CODE_DEFAULT_EFFORT: current.claudeCodeDefaultEffort,
    CLAUDE_CODE_DEFAULT_PROFILE: current.claudeCodeDefaultLaunchProfileId,
    CLAUDE_CODE_MAX_TURNS: String(current.claudeCodeMaxTurns),
    CONNECTOR_LOG_FORMAT: current.logFormat,
    TOOL_VERBOSITY: current.toolVerbosity,
    SHOW_TURN_TOKEN_USAGE: boolValue(current.showTurnTokenUsage),
    ENABLE_TELEGRAM_LOGIN: boolValue(current.enableTelegramLogin),
    ENABLE_TELEGRAM_REACTIONS: boolValue(current.enableTelegramReactions),
    TELEGRAM_RATE_LIMIT_MIN_INTERVAL_MS: String(current.telegramRateLimitMinIntervalMs),
    TELEGRAM_EDIT_MIN_INTERVAL_MS: String(current.telegramEditMinIntervalMs),
    NORDRELAY_CLI_MIRROR_MODE: current.mirrorMode,
    NORDRELAY_CLI_MIRROR_MIN_UPDATE_MS: String(current.mirrorMinUpdateMs),
    NORDRELAY_WEB_CLI_MIRROR_MODE: current.webMirrorMode === current.mirrorMode ? "" : current.webMirrorMode,
    NORDRELAY_WEB_CLI_MIRROR_MIN_UPDATE_MS: current.webMirrorMinUpdateMs === current.mirrorMinUpdateMs ? "" : String(current.webMirrorMinUpdateMs),
    NORDRELAY_NOTIFY_MODE: current.notifyMode,
    NORDRELAY_QUIET_HOURS: quietValue(current.quietHours),
    NORDRELAY_AUTO_SEND_ARTIFACTS: boolValue(current.autoSendArtifacts),
    TELEGRAM_CLI_MIRROR_MODE: current.telegramMirrorMode === current.mirrorMode ? "" : current.telegramMirrorMode,
    TELEGRAM_CLI_MIRROR_MIN_UPDATE_MS: current.telegramMirrorMinUpdateMs === current.mirrorMinUpdateMs ? "" : String(current.telegramMirrorMinUpdateMs),
    TELEGRAM_NOTIFY_MODE: current.telegramNotifyMode === current.notifyMode ? "" : current.telegramNotifyMode,
    TELEGRAM_QUIET_HOURS: quietOverrideValue(current.telegramQuietHours, current.quietHours),
    TELEGRAM_REDACT_PATTERNS: current.telegramRedactPatterns.join(","),
    NORDRELAY_UPDATE_METHOD: process.env.NORDRELAY_UPDATE_METHOD || "auto",
    MAX_FILE_SIZE: String(current.maxFileSize),
    ARTIFACT_RETENTION_DAYS: String(current.artifactRetentionDays),
    ARTIFACT_MAX_TURNS: String(current.artifactMaxTurnDirs),
    ARTIFACT_MAX_INBOX_DIRS: String(current.artifactMaxInboxDirs),
    ARTIFACT_IGNORE_DIRS: current.artifactIgnoreDirs.join(","),
    ARTIFACT_IGNORE_GLOBS: current.artifactIgnoreGlobs.join(","),
    TELEGRAM_AUTO_SEND_ARTIFACTS: current.telegramAutoSendArtifacts === current.autoSendArtifacts ? "" : boolValue(current.telegramAutoSendArtifacts),
    WORKSPACE_ALLOWED_ROOTS: current.workspaceAllowedRoots.join(","),
    WORKSPACE_WARN_ROOTS: current.workspaceWarnRoots.join(","),
    NORDRELAY_STATE_BACKEND: current.stateBackend,
    NORDRELAY_AUDIT_MAX_EVENTS: String(current.auditMaxEvents),
    NORDRELAY_SESSION_LOCK_TTL_MS: String(current.sessionLockTtlMs),
    NORDRELAY_DASHBOARD_CACHE_TTL_MS: String(current.dashboardCacheTtlMs),
    NORDRELAY_UNIFIED_JOB_MAX_ITEMS: String(current.unifiedJobMaxItems),
    NORDRELAY_VERSION_CACHE_TTL_MS: process.env.NORDRELAY_VERSION_CACHE_TTL_MS,
    NORDRELAY_CLI_VERSION_CACHE_TTL_MS: process.env.NORDRELAY_CLI_VERSION_CACHE_TTL_MS,
    VOICE_PREFERRED_BACKEND: current.voicePreferredBackend,
    VOICE_DEFAULT_LANGUAGE: current.voiceDefaultLanguage,
    VOICE_TRANSCRIBE_ONLY: boolValue(current.voiceTranscribeOnly),
    FASTER_WHISPER_PYTHON: process.env.FASTER_WHISPER_PYTHON,
    FASTER_WHISPER_MODEL: process.env.FASTER_WHISPER_MODEL,
    FASTER_WHISPER_DEVICE: process.env.FASTER_WHISPER_DEVICE,
    FASTER_WHISPER_COMPUTE_TYPE: process.env.FASTER_WHISPER_COMPUTE_TYPE,
    FASTER_WHISPER_LANGUAGE: process.env.FASTER_WHISPER_LANGUAGE,
    FASTER_WHISPER_TIMEOUT_MS: process.env.FASTER_WHISPER_TIMEOUT_MS,
    NORDRELAY_DASHBOARD_HOST: options.host,
    NORDRELAY_DASHBOARD_PORT: String(options.port),
  };
}

function boolValue(value: boolean): string {
  return value ? "true" : "false";
}

function quietValue(value: { startHour: number; endHour: number } | null | undefined): string {
  return value ? `${value.startHour}-${value.endHour}` : "";
}

function quietOverrideValue(
  channelValue: { startHour: number; endHour: number } | null | undefined,
  defaultValue: { startHour: number; endHour: number } | null | undefined,
): string {
  return quietValue(channelValue) === quietValue(defaultValue) ? "" : quietValue(channelValue);
}

function requireArg(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function shutdown(): void {
  runtime.dispose();
  server.close(() => process.exit(0));
}
