import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";

import { enabledAgents } from "../agents/shared/agent-factory.js";
import { buildAdapterConformanceMatrix } from "../agents/shared/adapter-conformance.js";
import { listAgentAdapterDescriptors } from "../agents/shared/agent-adapter.js";
import { isAgentId } from "../agents/shared/agent.js";
import { AuditLogStore, type AuditEvent } from "../access/audit-log.js";
import { listChannelDescriptors } from "../channels/shared/channel-adapter.js";
import { permissionForWebRequest } from "../access/access-control.js";
import { loadConfig, loadEnvFile } from "../core/config.js";
import { friendlyErrorText } from "../core/error-messages.js";
import { RelayRuntime, type ActiveSessionsDto, type DashboardControlOptions, type RelayEvent, type SessionPageDto, type WebTasksDto } from "../runtime/relay-runtime.js";
import { resolveDashboardEnvPath, SettingsService } from "../core/settings-service.js";
import { mergeSettingsWizardTestSettings, runSettingsWizardTest } from "../core/settings-wizard-test.js";
import { UserStore, publicUser, type AuthenticatedUser } from "../access/user-management.js";
import type { WebActivityActor } from "./web-state.js";
import { handleDashboardAccessRoute } from "./web-dashboard-access-routes.js";
import { handleDashboardArtifactRoute } from "./web-dashboard-artifact-routes.js";
import { dashboardAssetVersion, dashboardBundleAsset, dashboardCss, dashboardJs, dashboardStaticAsset } from "./web-dashboard-assets.js";
import {
  objectRecord,
  optionalStringField,
  parseCookies,
  readJsonBody,
  sendJson,
  sendText,
  sendStaticFile,
  isRequestBodyTooLargeError,
  registerWebResponseRequest,
} from "./web-dashboard-http.js";
import { renderDashboardApp, renderFirstRunSetupPage, renderLoginPage } from "./web-dashboard-pages.js";
import { handleDashboardRuntimeRoute } from "./web-dashboard-runtime-routes.js";
import { handleDashboardSessionRoute } from "./web-dashboard-session-routes.js";
import { handleDashboardPeerRoute } from "./web-dashboard-peer-routes.js";
import { handleDashboardProfileRoute } from "./web-dashboard-profile-routes.js";
import { handleDashboardWorkflowRoute } from "./web-dashboard-workflow-routes.js";
import { activeSettingsValues } from "./web-dashboard-settings-values.js";
import { PeerDiscoveryJobManager } from "../peers/peer-discovery-jobs.js";
import { applyAutostartSettings } from "../support/autostart.js";
import { recordWebApiMetric } from "./web-performance.js";
import { createCspNonce, isMutatingWebApiRequest, requiresWebCsrf } from "./web-dashboard-security.js";
import { consumeRateLimit, resetRateLimit, type RateLimitBucket } from "./web-rate-limit.js";

interface DashboardOptions {
  host: string;
  port: number;
  home: string;
}

const DEFAULT_HOME = path.join(os.homedir(), ".nordrelay");
const WEB_API_MUTATION_LIMIT = 240;
const WEB_API_MUTATION_WINDOW_MS = 60_000;
const WEB_API_MUTATION_BLOCK_MS = 60_000;

const options = parseOptions(process.argv.slice(2));
loadEnvFile(resolveDashboardEnvPath(options.home));
const config = loadConfig();
if (!config.webuiEnabled) {
  throw new Error("WebUI is disabled by NORDRELAY_WEBUI_ENABLED=false.");
}
const runtime = new RelayRuntime(config, { backgroundServices: false });
const settings = new SettingsService(resolveDashboardEnvPath(options.home));
const users = new UserStore(options.home);
const auditLog = new AuditLogStore(config.workspace, config.stateBackend, config.auditMaxEvents);
const peerDiscoveryJobs = new PeerDiscoveryJobManager(config, options.home);
const loginAttempts = new Map<string, RateLimitBucket>();
const apiMutationAttempts = new Map<string, RateLimitBucket>();
const firstRunSetupToken = users.hasAdminUser() ? undefined : randomBytes(18).toString("base64url");
const firstRunSetupRequiresToken = !isLoopbackHost(options.host);
const csrfSecret = randomBytes(32).toString("base64url");

if (firstRunSetupToken) {
  console.log(`NordRelay first-run setup token: ${firstRunSetupToken}`);
}

class AccessDeniedError extends Error {}

const server = createServer((req, res) => {
  registerWebResponseRequest(req, res);
  const startedAt = Date.now();
  const pathName = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
  res.on("finish", () => {
    recordWebApiMetric({
      method: req.method ?? "GET",
      path: pathName,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });
  void handleRequest(req, res).catch((error) => {
    const status = error instanceof AccessDeniedError ? 403 : isRequestBodyTooLargeError(error) ? 413 : 500;
    sendJson(res, status, { error: friendlyErrorText(error) });
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

  if (servePublicDashboardAsset(url.pathname, res)) {
    return;
  }

  const workflowTriggerMatch = url.pathname.match(/^\/api\/workflow-triggers\/([^/]+)\/run$/);
  if (req.method === "POST" && workflowTriggerMatch?.[1]) {
    await handleWorkflowTriggerRun(req, res, decodeURIComponent(workflowTriggerMatch[1]));
    return;
  }

  const authenticated = authenticateRequest(req);
  if (url.pathname === "/api/auth/me" && req.method === "GET") {
    if (!authenticated) {
      sendJson(res, 401, { error: "Authentication required", adminConfigured: users.hasAdminUser() });
      return;
    }
    sendJson(res, 200, currentUserDto(authenticated, req));
    return;
  }

  if (!authenticated) {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const cspNonce = createCspNonce();
      if (!users.hasAdminUser()) {
        sendText(
          res,
          200,
          renderFirstRunSetupPage({ tokenRequired: firstRunSetupRequiresToken || !isLoopbackRequest(req), cspNonce }),
          "text/html; charset=utf-8",
          { cspNonce },
        );
        return;
      }
      sendText(res, 200, renderLoginPage({ adminConfigured: users.hasAdminUser(), cspNonce }), "text/html; charset=utf-8", { cspNonce });
      return;
    }
    sendJson(res, 401, { error: "Authentication required", adminConfigured: users.hasAdminUser() });
    return;
  }

  if (isMutatingWebApiRequest(req.method, url.pathname)) {
    const limited = consumeRateLimit(
      apiMutationAttempts,
      `${req.socket.remoteAddress ?? "unknown"}:${authenticated.user.id}`,
      WEB_API_MUTATION_LIMIT,
      WEB_API_MUTATION_WINDOW_MS,
      WEB_API_MUTATION_BLOCK_MS,
    );
    if (limited.limited) {
      sendJson(res, 429, { error: "Too many API changes. Try again later.", retryAfterMs: limited.retryAfterMs });
      return;
    }
  }

  if (requiresCsrf(req, url) && !verifyCsrf(req)) {
    audit({
      action: "permission_denied",
      status: "denied",
      channelId: "web",
      contextKey: "web",
      actor: webActivityActor(authenticated),
      actorId: authenticated.user.id,
      actorRole: authenticated.groups.map((group) => group.name).join(", "),
      description: `Invalid CSRF token for ${req.method ?? "GET"} ${url.pathname}`,
    });
    sendJson(res, 403, { error: "Invalid CSRF token." });
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
    const cspNonce = createCspNonce();
    sendText(res, 200, renderDashboardApp({ cspNonce, assetVersion: dashboardAssetVersion() }), "text/html; charset=utf-8", { cspNonce });
    return;
  }

  if (url.pathname === "/assets/dashboard.css") {
    sendDashboardBundle(res, "dashboard.css", dashboardCss);
    return;
  }

  if (url.pathname === "/assets/dashboard.js") {
    sendDashboardBundle(res, "dashboard.js", dashboardJs);
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

function servePublicDashboardAsset(pathname: string, res: ServerResponse): boolean {
  const assetName = pathname === "/favicon.ico"
    ? "favicon.ico"
    : pathname === "/manifest.webmanifest"
      ? "manifest.webmanifest"
      : pathname === "/service-worker.js"
        ? "service-worker.js"
    : pathname === "/assets/favicon.png"
      ? "favicon.png"
      : pathname === "/assets/logo.png"
        ? "logo.png"
        : null;
  if (!assetName) {
    return false;
  }
  const asset = dashboardStaticAsset(assetName);
  if (!asset) {
    sendText(res, 404, "not found\n", "text/plain; charset=utf-8");
    return true;
  }
  sendStaticFile(res, asset.filePath, asset.contentType);
  return true;
}

function sendDashboardBundle(res: ServerResponse, assetName: "dashboard.css" | "dashboard.js", fallback: () => string): void {
  const asset = dashboardBundleAsset(assetName);
  const cacheControl = "private, max-age=31536000, immutable";
  if (asset) {
    sendStaticFile(res, asset.filePath, asset.contentType, {
      brotliPath: asset.brotliPath,
      cacheControl,
      gzipPath: asset.gzipPath,
    });
    return;
  }
  const contentType = assetName === "dashboard.css" ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8";
  sendText(res, 200, fallback(), contentType, { cacheControl });
}

async function handleWorkflowTriggerRun(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  const limited = consumeRateLimit(
    apiMutationAttempts,
    `workflow-trigger:${req.socket.remoteAddress ?? "unknown"}`,
    60,
    WEB_API_MUTATION_WINDOW_MS,
    WEB_API_MUTATION_BLOCK_MS,
  );
  if (limited.limited) {
    sendJson(res, 429, { error: "Too many workflow trigger requests. Try again later.", retryAfterMs: limited.retryAfterMs });
    return;
  }
  const body = await readJsonBody(req).catch((): Record<string, unknown> => ({}));
  const variables = Object.fromEntries(
    Object.entries(objectRecord(body?.variables)).map(([key, value]) => [key, String(value ?? "")]),
  );
  const run = await runtime.workflowService.runWorkflowTriggerToken(token, variables);
  sendJson(res, 202, { run });
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

  if (await handleDashboardProfileRoute(req, res, url, {
    users,
    authUser,
    sessionToken: parseCookies(req.headers.cookie ?? "").nr_session,
    auditUserAction,
  })) {
    return;
  }

  if (await handleDashboardRuntimeRoute(req, res, url, {
    runtime,
    users,
    home: options.home,
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
      auth: currentUserDto(authUser, req),
      channels: listChannelDescriptors(config),
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
    discoveryJobs: peerDiscoveryJobs,
    activityActor: webActivityActor(authUser),
    auditPeerAction: (action, description) => auditUserAction(authUser, action, description),
  })) {
    return;
  }

  if (await handleDashboardWorkflowRoute(req, res, url, {
    runtime,
    authUser,
    activityActor: webActivityActor(authUser),
  })) {
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    sendJson(res, 200, await settings.snapshot(process.env, activeSettingsValues(config, options)));
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/settings") {
    const body = await readJsonBody(req);
    const patch = objectRecord(body?.settings);
    const result = await settings.update(patch);
    if (result.errors.length === 0) {
      result.errors.push(...await applyAutostartSettings(patch, result.changedKeys, { home: options.home, runtimeRoot: process.env.NORDRELAY_SOURCE_ROOT }));
    }
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings/wizard/test") {
    const body = await readJsonBody(req);
    sendJson(res, 200, await runSettingsWizardTest(
      optionalStringField(body, "channel") ?? "",
      mergeSettingsWizardTestSettings(activeSettingsValues(config, options), objectRecord(body?.settings)),
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
  setSessionCookie(res, session.token, req);
  sendJson(res, 201, currentUserDto(authUser, undefined, session.token));
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
  setSessionCookie(res, session.token, req);
  sendJson(res, 200, currentUserDto(authUser, undefined, session.token));
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
  if (authUser && !verifyCsrf(req)) {
    sendJson(res, 403, { error: "Invalid CSRF token." });
    return;
  }
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

function setSessionCookie(res: ServerResponse, token: string, req?: IncomingMessage): void {
  const secure = req && isHttpsRequest(req) ? "; Secure" : "";
  res.setHeader("set-cookie", `nr_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/${secure}`);
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader("set-cookie", "nr_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
}

function isHttpsRequest(req: IncomingMessage): boolean {
  return Boolean((req.socket as { encrypted?: boolean }).encrypted) ||
    String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim().toLowerCase() === "https";
}

function currentUserDto(authUser: AuthenticatedUser, req?: IncomingMessage, sessionToken?: string) {
  const token = sessionToken ?? (req ? parseCookies(req.headers.cookie ?? "").nr_session : undefined);
  return {
    user: publicUser(authUser.user),
    groups: authUser.groups,
    permissions: authUser.permissions,
    csrfToken: token ? csrfTokenForSession(token) : undefined,
  };
}

function requiresCsrf(req: IncomingMessage, url: URL): boolean {
  return requiresWebCsrf(req.method, url.pathname);
}

function verifyCsrf(req: IncomingMessage): boolean {
  const sessionToken = parseCookies(req.headers.cookie ?? "").nr_session;
  const supplied = headerValue(req, "x-nordrelay-csrf");
  if (!sessionToken || !supplied) {
    return false;
  }
  return safeEqualString(supplied, csrfTokenForSession(sessionToken));
}

function csrfTokenForSession(sessionToken: string): string {
  return createHmac("sha256", csrfSecret).update(sessionToken).digest("base64url");
}

function headerValue(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function safeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
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
  const matrix = buildAdapterConformanceMatrix({ channels: listChannelDescriptors(config) });
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
