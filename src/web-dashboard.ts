import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";

import { enabledAgents } from "./agent-factory.js";
import { listAgentAdapterDescriptors } from "./agent-adapter.js";
import { isAgentId } from "./agent.js";
import { listChannelDescriptors } from "./channel-adapter.js";
import { loadConfig } from "./config.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML } from "./format.js";
import { RelayRuntime, type RelayEvent } from "./relay-runtime.js";
import { resolveDashboardEnvPath, SettingsService } from "./settings-service.js";

interface DashboardOptions {
  host: string;
  port: number;
  home: string;
}

interface DashboardAuth {
  required: boolean;
  publicBind: boolean;
  token?: string;
  user?: string;
  password?: string;
}

const DEFAULT_HOME = path.join(os.homedir(), ".nordrelay");
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const options = parseOptions(process.argv.slice(2));
const auth = resolveDashboardAuth(options.host);
if (auth.publicBind && !auth.token && !(auth.user && auth.password)) {
  throw new Error(
    "Dashboard bound to 0.0.0.0 requires NORDRELAY_DASHBOARD_TOKEN or NORDRELAY_DASHBOARD_USER/PASSWORD.",
  );
}

const config = loadConfig();
const runtime = new RelayRuntime(config);
const settings = new SettingsService(resolveDashboardEnvPath(options.home));

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    sendJson(res, 500, { error: friendlyErrorText(error) });
  });
});

await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
console.log(`NordRelay dashboard: http://${options.host}:${options.port}/`);

process.once("SIGINT", () => shutdown());
process.once("SIGTERM", () => shutdown());

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const queryToken = url.searchParams.get("token");
  if (queryToken && isAuthorizedToken(queryToken) && !url.pathname.startsWith("/api/")) {
    setAuthCookie(res, queryToken);
    res.writeHead(302, { location: url.pathname || "/" });
    res.end();
    return;
  }

  if (url.pathname === "/api/auth" && req.method === "POST") {
    await handleLogin(req, res);
    return;
  }

  if (auth.required && !isAuthorizedRequest(req) && !isAuthorizedToken(queryToken ?? "")) {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      sendText(res, 200, renderLoginPage(auth), "text/html; charset=utf-8");
      return;
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") {
      sendJson(res, 401, { error: "Authentication required" });
      return;
    }
    sendText(res, 401, "Authentication required\n", "text/plain; charset=utf-8");
    return;
  }

  if (url.pathname === "/healthz") {
    sendText(res, 200, "ok\n", "text/plain; charset=utf-8");
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    sendText(res, 200, renderDashboardApp({ authRequired: auth.required }), "text/html; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/events" && req.method === "GET") {
    handleEvents(req, res);
    return;
  }

  if (!url.pathname.startsWith("/api/")) {
    sendText(res, 404, "not found\n", "text/plain; charset=utf-8");
    return;
  }

  await handleApi(req, res, url);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    sendJson(res, 200, {
      auth: { required: auth.required, publicBind: auth.publicBind },
      channels: listChannelDescriptors(),
      agentAdapters: listAgentAdapterDescriptors(),
      enabledAgents: enabledAgents(config),
      controls: await runtime.controlOptions(),
      status: await runtime.status(),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/control-options") {
    sendJson(res, 200, await runtime.controlOptions(parseAgentId(url.searchParams.get("agent") ?? undefined)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, await runtime.status());
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

  if (req.method === "GET" && url.pathname === "/api/snapshot") {
    sendJson(res, 200, await runtime.snapshot());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    sendJson(
      res,
      200,
      await runtime.listSessionsPage(
        numberParam(url, "page", 1),
        numberParam(url, "limit", 50),
        url.searchParams.get("query") ?? "",
      ),
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent") {
    const body = await readJsonBody(req);
    const agentId = stringField(body, "agentId");
    if (!isAgentId(agentId)) {
      throw new Error(`Invalid agent: ${agentId}`);
    }
    sendJson(res, 200, { session: await runtime.setAgent(agentId) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/new") {
    const body = await readJsonBody(req);
    sendJson(res, 200, {
      session: await runtime.newSession({
        agentId: parseAgentId(optionalStringField(body, "agentId")),
        workspace: optionalStringField(body, "workspace"),
        model: optionalStringField(body, "model"),
        reasoningEffort: optionalStringField(body, "reasoningEffort"),
        launchProfileId: optionalStringField(body, "launchProfileId"),
        fastMode: optionalBooleanField(body, "fastMode"),
      }),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/switch") {
    const body = await readJsonBody(req);
    sendJson(res, 200, { session: await runtime.switchSession(stringField(body, "threadId")) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/attach") {
    const body = await readJsonBody(req);
    sendJson(res, 200, { session: await runtime.attachSession(stringField(body, "threadId")) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/models") {
    sendJson(res, 200, { models: await runtime.listModels() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session/model") {
    const body = await readJsonBody(req);
    sendJson(res, 200, { session: await runtime.setModel(stringField(body, "model")) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session/reasoning") {
    const body = await readJsonBody(req);
    sendJson(res, 200, { session: await runtime.setReasoningEffort(stringField(body, "reasoning")) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session/fast") {
    const body = await readJsonBody(req);
    sendJson(res, 200, { session: await runtime.setFastMode(Boolean(body?.enabled)) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session/launch") {
    const body = await readJsonBody(req);
    sendJson(res, 200, { session: await runtime.setLaunchProfile(stringField(body, "profileId")) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/prompt") {
    const body = await readJsonBody(req);
    sendJson(res, 202, await runtime.sendPrompt(stringField(body, "text")));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/prompt/upload") {
    const body = await readJsonBody(req);
    sendJson(res, 202, await runtime.sendUploadPrompt({
      text: optionalStringField(body, "text"),
      files: parseUploadFiles(body.files),
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/abort") {
    await runtime.abort();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/handback") {
    sendJson(res, 200, await runtime.handback());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/queue") {
    sendJson(res, 200, { queue: runtime.queue(), paused: runtime.queuePaused() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/queue") {
    const body = await readJsonBody(req);
    sendJson(res, 200, { queue: runtime.queueAction(stringField(body, "action") as never, optionalStringField(body, "id")), paused: runtime.queuePaused() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/chat/history") {
    sendJson(res, 200, { messages: await runtime.chatHistory(numberParam(url, "limit", 200)) });
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/chat/history") {
    sendJson(res, 200, await runtime.clearChatHistory());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/activity") {
    sendJson(res, 200, {
      events: runtime.activity({
        limit: numberParam(url, "limit", 100),
        source: (url.searchParams.get("source") || "all") as never,
        status: (url.searchParams.get("status") || "all") as never,
      }),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/artifacts") {
    sendJson(res, 200, { reports: await runtime.artifacts() });
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/artifacts") {
    sendJson(res, 200, { removed: await runtime.deleteArtifact(requiredSearch(url, "turnId")) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/artifacts/zip") {
    const bundle = await runtime.createArtifactZip(requiredSearch(url, "turnId"));
    if (!bundle) {
      sendJson(res, 404, { error: "Artifact turn not found or ZIP could not be created" });
      return;
    }
    sendFile(res, bundle.path, bundle.name);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/artifacts/file") {
    const turnId = requiredSearch(url, "turnId");
    const relativePath = requiredSearch(url, "path");
    const report = await runtime.artifact(turnId);
    const artifact = report?.artifacts.find((candidate) => candidate.relativePath === relativePath);
    if (!artifact) {
      sendJson(res, 404, { error: "Artifact not found" });
      return;
    }
    sendFile(res, artifact.localPath, artifact.name);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/artifacts/preview") {
    const preview = await runtime.artifactPreview(requiredSearch(url, "turnId"), requiredSearch(url, "path"));
    if (!preview) {
      sendJson(res, 404, { error: "Artifact not found" });
      return;
    }
    sendJson(res, 200, preview);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/logs") {
    sendJson(res, 200, await runtime.logs((url.searchParams.get("target") as "connector" | "update") || "connector", numberParam(url, "lines", 120)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/diagnostics") {
    sendJson(res, 200, await runtime.diagnostics());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/runtime/restart") {
    sendJson(res, 202, runtime.restartConnector());
    return;
  }

  sendJson(res, 404, { error: "Unknown endpoint" });
}

function handleEvents(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const token = url.searchParams.get("token");
  if (auth.required && !(isAuthorizedRequest(req) || (token && isAuthorizedToken(token)))) {
    sendJson(res, 401, { error: "Authentication required" });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const send = (event: RelayEvent) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
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

async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const token = optionalStringField(body, "token");
  const user = optionalStringField(body, "user");
  const password = optionalStringField(body, "password");
  if (token && isAuthorizedToken(token)) {
    setAuthCookie(res, token);
    sendJson(res, 200, { ok: true, mode: "token" });
    return;
  }
  if (user && password && isAuthorizedBasic(user, password)) {
    setBasicCookie(res, user, password);
    sendJson(res, 200, { ok: true, mode: "basic" });
    return;
  }
  sendJson(res, 401, { error: "Invalid dashboard credentials" });
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

function resolveDashboardAuth(host: string): DashboardAuth {
  const token = optionalEnv("NORDRELAY_DASHBOARD_TOKEN");
  const user = optionalEnv("NORDRELAY_DASHBOARD_USER");
  const password = optionalEnv("NORDRELAY_DASHBOARD_PASSWORD");
  const publicBind = isPublicBindHost(host);
  return {
    required: publicBind || Boolean(token || (user && password)),
    publicBind,
    token,
    user,
    password,
  };
}

function isPublicBindHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "";
}

function isAuthorizedRequest(req: IncomingMessage): boolean {
  if (!auth.required) {
    return true;
  }
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ") && isAuthorizedToken(header.slice("Bearer ".length).trim())) {
    return true;
  }
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const [user, ...passwordParts] = decoded.split(":");
    if (isAuthorizedBasic(user ?? "", passwordParts.join(":"))) {
      return true;
    }
  }
  const cookies = parseCookies(req.headers.cookie ?? "");
  if (cookies.nrdash && isAuthorizedToken(cookies.nrdash)) {
    return true;
  }
  if (cookies.nrdash_basic) {
    const decoded = Buffer.from(cookies.nrdash_basic, "base64").toString("utf8");
    const [user, ...passwordParts] = decoded.split(":");
    if (isAuthorizedBasic(user ?? "", passwordParts.join(":"))) {
      return true;
    }
  }
  return false;
}

function isAuthorizedToken(token: string): boolean {
  return Boolean(auth.token && constantTimeEqual(token, auth.token));
}

function isAuthorizedBasic(user: string, password: string): boolean {
  return Boolean(auth.user && auth.password && constantTimeEqual(user, auth.user) && constantTimeEqual(password, auth.password));
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return cryptoTimingSafeEqual(leftBuffer, rightBuffer);
}

function cryptoTimingSafeEqual(left: Buffer, right: Buffer): boolean {
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index]! ^ right[index]!;
  }
  return diff === 0;
}

function setAuthCookie(res: ServerResponse, token: string): void {
  res.setHeader("set-cookie", `nrdash=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`);
}

function setBasicCookie(res: ServerResponse, user: string, password: string): void {
  const value = Buffer.from(`${user}:${password}`).toString("base64");
  res.setHeader("set-cookie", `nrdash_basic=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/`);
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key) cookies[key] = decodeURIComponent(valueParts.join("=") ?? "");
  }
  return cookies;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(`${JSON.stringify(value)}\n`);
}

function sendText(res: ServerResponse, status: number, text: string, contentType: string): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(text);
}

function sendFile(res: ServerResponse, filePath: string, filename: string): void {
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
  });
  createReadStream(filePath).pipe(res);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) {
    throw new Error(`${key} is required`);
  }
  return field.trim();
}

function optionalStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function optionalBooleanField(value: Record<string, unknown>, key: string): boolean | undefined {
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

function parseAgentId(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  if (!isAgentId(value)) {
    throw new Error(`Invalid agent: ${value}`);
  }
  return value;
}

function objectRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, string>;
}

function parseUploadFiles(value: unknown): Array<{ name: string; mimeType?: string; data: Buffer }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`files[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : `upload-${index + 1}`;
    const mimeType = typeof record.mimeType === "string" ? record.mimeType.trim() : undefined;
    const dataBase64 = typeof record.dataBase64 === "string" ? record.dataBase64 : "";
    if (!dataBase64) {
      throw new Error(`files[${index}].dataBase64 is required`);
    }
    return { name, mimeType, data: Buffer.from(stripDataUrlPrefix(dataBase64), "base64") };
  });
}

function stripDataUrlPrefix(value: string): string {
  const comma = value.indexOf(",");
  return value.startsWith("data:") && comma !== -1 ? value.slice(comma + 1) : value;
}

function numberParam(url: URL, key: string, fallback: number): number {
  const value = Number(url.searchParams.get(key));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function requiredSearch(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function optionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value || undefined;
}

function activeSettingsValues(current: typeof config): Record<string, string | undefined> {
  return {
    TELEGRAM_ALLOW_ANY_CHAT: boolValue(current.telegramAllowAnyChat),
    TELEGRAM_TRANSPORT: current.telegramTransport,
    TELEGRAM_WEBHOOK_HOST: current.telegramWebhookHost,
    TELEGRAM_WEBHOOK_PORT: String(current.telegramWebhookPort),
    TELEGRAM_WEBHOOK_PATH: current.telegramWebhookPath,
    NORDRELAY_CODEX_ENABLED: boolValue(current.codexEnabled),
    NORDRELAY_PI_ENABLED: boolValue(current.piEnabled),
    NORDRELAY_HERMES_ENABLED: boolValue(current.hermesEnabled),
    NORDRELAY_OPENCLAW_ENABLED: boolValue(current.openClawEnabled),
    NORDRELAY_CLAUDE_CODE_ENABLED: boolValue(current.claudeCodeEnabled),
    NORDRELAY_DEFAULT_AGENT: current.defaultAgent,
    CODEX_USE_BUNDLED_CLI: process.env.CODEX_USE_BUNDLED_CLI,
    CODEX_MODEL: current.codexModel,
    CODEX_SYNC_INTERVAL_MS: String(current.codexSyncIntervalMs),
    CODEX_EXTERNAL_BUSY_CHECK_MS: String(current.codexExternalBusyCheckMs),
    CODEX_EXTERNAL_BUSY_STALE_MS: String(current.codexExternalBusyStaleMs),
    CODEX_SANDBOX_MODE: current.codexSandboxMode,
    CODEX_APPROVAL_POLICY: current.codexApprovalPolicy,
    CODEX_DEFAULT_LAUNCH_PROFILE: current.defaultLaunchProfileId,
    ENABLE_UNSAFE_LAUNCH_PROFILES: boolValue(current.enableUnsafeLaunchProfiles),
    PI_DEFAULT_MODEL: current.piDefaultModel,
    PI_DEFAULT_THINKING: current.piDefaultThinking,
    PI_DEFAULT_PROFILE: current.piDefaultLaunchProfileId,
    HERMES_API_BASE_URL: current.hermesApiBaseUrl,
    HERMES_DEFAULT_MODEL: current.hermesDefaultModel,
    HERMES_DEFAULT_REASONING: current.hermesDefaultReasoning,
    HERMES_DEFAULT_PROFILE: current.hermesDefaultLaunchProfileId,
    OPENCLAW_GATEWAY_URL: current.openClawGatewayUrl,
    OPENCLAW_CLI_PATH: current.openClawCliPath,
    OPENCLAW_AGENT_ID: current.openClawAgentId,
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
    TELEGRAM_CLI_MIRROR_MODE: current.telegramMirrorMode,
    TELEGRAM_CLI_MIRROR_MIN_UPDATE_MS: String(current.telegramMirrorMinUpdateMs),
    TELEGRAM_NOTIFY_MODE: current.telegramNotifyMode,
    TELEGRAM_QUIET_HOURS: current.telegramQuietHours ? `${current.telegramQuietHours.startHour}-${current.telegramQuietHours.endHour}` : "",
    TELEGRAM_REDACT_PATTERNS: current.telegramRedactPatterns.join(","),
    NORDRELAY_UPDATE_METHOD: process.env.NORDRELAY_UPDATE_METHOD || "auto",
    MAX_FILE_SIZE: String(current.maxFileSize),
    ARTIFACT_RETENTION_DAYS: String(current.artifactRetentionDays),
    ARTIFACT_MAX_TURNS: String(current.artifactMaxTurnDirs),
    ARTIFACT_MAX_INBOX_DIRS: String(current.artifactMaxInboxDirs),
    ARTIFACT_IGNORE_DIRS: current.artifactIgnoreDirs.join(","),
    ARTIFACT_IGNORE_GLOBS: current.artifactIgnoreGlobs.join(","),
    TELEGRAM_AUTO_SEND_ARTIFACTS: boolValue(current.telegramAutoSendArtifacts),
    WORKSPACE_ALLOWED_ROOTS: current.workspaceAllowedRoots.join(","),
    WORKSPACE_WARN_ROOTS: current.workspaceWarnRoots.join(","),
    NORDRELAY_STATE_BACKEND: current.stateBackend,
    NORDRELAY_AUDIT_MAX_EVENTS: String(current.auditMaxEvents),
    NORDRELAY_SESSION_LOCK_TTL_MS: String(current.sessionLockTtlMs),
    NORDRELAY_VERSION_CACHE_TTL_MS: process.env.NORDRELAY_VERSION_CACHE_TTL_MS,
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

function renderLoginPage(currentAuth: DashboardAuth): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NordRelay Login</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f2;color:#181c19;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif}
    form{width:min(420px,calc(100vw - 32px));background:white;border:1px solid #dfe3dc;border-radius:8px;padding:24px;box-shadow:0 20px 60px rgba(20,30,24,.08)}
    h1{font-size:24px;margin:0 0 8px}
    p{color:#5d665d;margin:0 0 18px}
    label{display:block;font-size:13px;color:#4b544d;margin:14px 0 6px}
    input{box-sizing:border-box;width:100%;height:40px;border:1px solid #cfd6ce;border-radius:6px;padding:0 10px;font:inherit}
    button{margin-top:18px;width:100%;height:42px;border:0;border-radius:6px;background:#205c43;color:white;font-weight:650;cursor:pointer}
    .error{color:#9b1c1c;min-height:22px;margin-top:12px}
  </style>
</head>
<body>
  <form id="login">
    <h1>NordRelay Dashboard</h1>
    <p>${currentAuth.publicBind ? "Remote dashboard access requires authentication." : "Authentication required."}</p>
    ${currentAuth.token ? '<label>Token</label><input id="token" name="token" type="password" autocomplete="current-password">' : ""}
    ${currentAuth.user ? '<label>User</label><input id="user" name="user" autocomplete="username"><label>Password</label><input id="password" name="password" type="password" autocomplete="current-password">' : ""}
    <button>Sign in</button>
    <div class="error" id="error"></div>
  </form>
  <script>
    document.getElementById('login').addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = {
        token: document.getElementById('token')?.value || undefined,
        user: document.getElementById('user')?.value || undefined,
        password: document.getElementById('password')?.value || undefined,
      };
      const res = await fetch('/api/auth', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
      if (!res.ok) {
        document.getElementById('error').textContent = 'Invalid credentials';
        return;
      }
      if (payload.token) localStorage.setItem('nordrelayDashboardToken', payload.token);
      location.href = '/';
    });
  </script>
</body>
</html>`;
}

function renderDashboardApp(options: { authRequired: boolean }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NordRelay Dashboard</title>
  <script>document.documentElement.dataset.theme = localStorage.getItem('nordrelayTheme') || 'light';</script>
  <style>${dashboardCss()}</style>
</head>
<body>
  <div class="app">
    <aside class="sidebar" id="sidebar">
      <div class="brand"><span class="mark">NR</span><div><strong>NordRelay</strong><small>Remote control</small></div></div>
      <nav>
        <button data-page="overview" class="active">Overview</button>
        <button data-page="chat">Chat</button>
        <button data-page="sessions">Sessions</button>
        <button data-page="queue">Queue</button>
        <button data-page="activity">Activity</button>
        <button data-page="artifacts">Artifacts</button>
        <button data-page="settings">Settings</button>
        <button data-page="logs">Logs</button>
        <button data-page="diagnostics">Diagnostics</button>
      </nav>
    </aside>
    <main>
      <header>
        <button class="menu" id="menuBtn">Menu</button>
        <div>
          <h1 id="pageTitle">Overview</h1>
          <p id="sessionLine">Loading session...</p>
        </div>
        <div class="header-actions">
          <select id="agentSelect"></select>
          <button id="themeBtn" class="secondary" title="Toggle dark theme">Dark</button>
          <button id="refreshBtn">Refresh</button>
        </div>
      </header>

      <section class="page active" id="page-overview">
        <div class="metrics" id="metrics"></div>
        <div class="stack">
          <div class="panel"><h2>Current Session</h2><pre id="sessionText"></pre></div>
          <div class="panel"><h2>Adapters</h2><div id="adapters"></div></div>
        </div>
      </section>

      <section class="page" id="page-chat">
        <div class="chat-layout">
          <div class="panel chat-panel">
            <div class="chat-toolbar">
              <button id="newSessionBtn">New session</button>
              <button id="clearChatBtn" class="secondary">Clear history</button>
              <button id="abortBtn">Abort</button>
              <button id="handbackBtn">Handback</button>
            </div>
            <div class="control-grid" id="sessionControls"></div>
            <div id="messages" class="messages"></div>
            <form id="promptForm" class="composer">
              <div class="composer-fields">
                <textarea id="promptInput" placeholder="Send a message to the active coding agent..." rows="3"></textarea>
                <div class="attachment-row">
                  <label class="file-button" for="fileInput">Attach files</label>
                  <input id="fileInput" type="file" multiple>
                  <span id="fileSummary">No files selected</span>
                  <button type="button" id="clearFilesBtn" class="secondary">Clear</button>
                </div>
              </div>
              <button>Send</button>
            </form>
          </div>
          <div class="panel side-panel"><h2>Tools / Plan</h2><div id="toolStream" class="tool-stream"></div></div>
        </div>
      </section>

      <section class="page" id="page-sessions">
        <div class="panel">
          <div class="sessions-toolbar">
            <div class="row search-row"><input id="sessionSearch" placeholder="Search sessions"><button id="sessionSearchBtn">Search</button></div>
            <div class="row attach-row"><input id="attachInput" placeholder="Thread ID to attach/switch"><button id="attachBtn">Attach</button></div>
          </div>
          <div id="sessionsList" class="list"></div>
          <div id="sessionsPager" class="pager"></div>
        </div>
      </section>

      <section class="page" id="page-queue">
        <div class="panel">
          <div class="row"><button data-queue="pause">Pause</button><button data-queue="resume">Resume</button><button data-queue="clear" class="danger">Clear</button><span id="queueStatus"></span></div>
          <div id="queueList" class="list"></div>
        </div>
      </section>

      <section class="page" id="page-activity">
        <div class="panel">
          <div class="row"><select id="activitySource"><option value="all">All sources</option><option value="web">Web</option><option value="cli">CLI</option></select><select id="activityStatus"><option value="all">All statuses</option><option value="queued">Queued</option><option value="running">Running</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="aborted">Aborted</option><option value="info">Info</option></select><input id="activityLimit" type="number" value="100" min="1" max="500"><button id="loadActivityBtn">Load activity</button></div>
          <div id="activityList" class="list"></div>
        </div>
      </section>

      <section class="page" id="page-artifacts">
        <div class="panel">
          <div class="row"><button id="reloadArtifactsBtn">Reload artifacts</button></div>
          <div id="artifactList" class="list"></div>
          <div id="artifactPreview" class="preview"></div>
        </div>
      </section>

      <section class="page" id="page-settings">
        <div class="panel">
          <div class="row"><button id="saveSettingsBtn">Save settings</button><button id="restartBtn" class="secondary">Restart NordRelay</button><span id="settingsStatus"></span></div>
          <div id="settingsTabs" class="tabs"></div>
          <div id="settingsForm" class="settings-grid"></div>
        </div>
      </section>

      <section class="page" id="page-logs">
        <div class="panel">
          <div class="row"><select id="logTarget"><option value="connector">Connector</option><option value="update">Update</option></select><select id="logLevel"><option value="all">All levels</option><option value="ERROR">Error</option><option value="WARN">Warn</option><option value="INFO">Info</option></select><input id="logSearch" placeholder="Search logs"><input id="logLines" type="number" value="120" min="1" max="300"><label class="checkbox"><input id="logAutoRefresh" type="checkbox"> Auto</label><button id="loadLogsBtn">Load logs</button><button id="downloadLogsBtn" class="secondary">Download</button></div>
          <pre id="logs"></pre>
        </div>
      </section>

      <section class="page" id="page-diagnostics">
        <div class="panel"><div id="diagnostics" class="list"></div></div>
      </section>

      <footer>
        <span id="footerVersion">NordRelay</span>
        <span id="footerHealth">Health: loading</span>
        <span>Dashboard bind: ${escapeHTML(options.authRequired ? "authenticated" : "local")}</span>
      </footer>
    </main>
  </div>
  <dialog id="newSessionDialog">
    <form method="dialog" id="newSessionForm">
      <h2>New Session</h2>
      <div class="form-grid">
        <label>Agent<select id="newAgent"></select></label>
        <label>Workspace<input id="newWorkspace" list="workspaceOptions" placeholder="Current workspace"></label>
        <label>Model<select id="newModel"></select></label>
        <label id="newReasoningWrap">Reasoning<select id="newReasoning"></select></label>
        <label id="newLaunchWrap">Launch profile<select id="newLaunch"></select></label>
        <label id="newFastWrap" class="checkbox"><input id="newFast" type="checkbox"> Fast mode</label>
      </div>
      <datalist id="workspaceOptions"></datalist>
      <div class="row dialog-actions"><button type="button" id="cancelSessionBtn" class="secondary">Cancel</button><button id="createSessionBtn" value="default">Create session</button></div>
    </form>
  </dialog>
  <div id="toast"></div>
  <script>${dashboardJs()}</script>
</body>
</html>`;
}

function dashboardCss(): string {
  return `
:root{color-scheme:light;--bg:#f4f6f2;--surface:#ffffff;--surface-soft:#fbfcf8;--text:#18201b;--muted:#5d675f;--border:#dce3d9;--border-soft:#e7ede4;--sidebar:#17251d;--sidebar-text:#f4f8f2;--sidebar-muted:#aebcaf;--accent:#235c42;--accent-strong:#17452f;--accent-soft:#dff5e8;--warn:#fff7da;--danger:#9b1c1c;--pre:#111812;--pre-text:#f3f7ef;--shadow:0 8px 24px rgba(24,32,27,.04);--link:#1d6a4c}
:root[data-theme="dark"]{color-scheme:dark;--bg:#101411;--surface:#171d19;--surface-soft:#1d251f;--text:#edf4ee;--muted:#a7b3aa;--border:#2d3830;--border-soft:#263128;--sidebar:#0c120f;--sidebar-text:#edf7ef;--sidebar-muted:#8da091;--accent:#4fa876;--accent-strong:#64bd89;--accent-soft:#173d2a;--warn:#3b3216;--danger:#cc4b4b;--pre:#070a08;--pre-text:#e8f1ea;--shadow:0 10px 28px rgba(0,0,0,.22);--link:#75c99a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif}.app{min-height:100vh;display:grid;grid-template-columns:260px 1fr}.sidebar{background:var(--sidebar);color:var(--sidebar-text);padding:18px;display:flex;flex-direction:column;gap:22px}.brand{display:flex;align-items:center;gap:12px}.mark{display:grid;place-items:center;width:38px;height:38px;border-radius:8px;background:#d7ffe5;color:#173d29;font-weight:800}.brand small{display:block;color:var(--sidebar-muted)}nav{display:flex;flex-direction:column;gap:6px}nav button,.menu{border:0;border-radius:6px;padding:10px 12px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}nav button.active,nav button:hover{background:color-mix(in srgb,var(--accent) 35%,transparent)}main{min-width:0;display:flex;flex-direction:column}header{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;gap:16px;align-items:center;padding:16px 22px;background:color-mix(in srgb,var(--surface) 92%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--border)}h1{font-size:24px;margin:0}h2{font-size:16px;margin:0 0 12px}p{margin:4px 0 0;color:var(--muted)}a{color:var(--link)}.header-actions,.row,.chat-toolbar,.attachment-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.menu{display:none;background:var(--surface-soft);color:var(--text)}.page{display:none;padding:22px}.page.active{display:block}.stack{display:flex;flex-direction:column;gap:16px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}.metric,.panel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;box-shadow:var(--shadow)}.metric .label{font-size:12px;text-transform:uppercase;color:var(--muted)}.metric .value{font-size:22px;font-weight:750;margin-top:4px;overflow:hidden;text-overflow:ellipsis}button,select,input,textarea{border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font:inherit}button{height:36px;padding:0 12px;background:var(--accent);color:white;border-color:var(--accent);cursor:pointer}button:hover{background:var(--accent-strong)}button.secondary{background:var(--surface);color:var(--text)}input,select{height:36px;padding:0 10px}textarea{width:100%;padding:10px;resize:vertical}.chat-layout{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:16px;align-items:start}.chat-panel{height:calc(100vh - 170px);min-height:520px;display:flex;flex-direction:column}.control-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:12px 0}.control-grid label,.form-grid label{display:grid;gap:5px;font-size:12px;color:var(--muted)}.messages{flex:1;min-height:0;overflow:auto;border:1px solid var(--border-soft);border-radius:8px;padding:12px;background:var(--surface-soft)}.message{margin:0 0 12px;padding:10px 12px;border-radius:8px;max-width:92%;white-space:pre-wrap;word-break:break-word}.message.user{margin-left:auto;background:var(--accent-soft)}.message.agent{background:color-mix(in srgb,var(--surface-soft) 80%,var(--border))}.message.system{background:var(--warn)}.composer{display:grid;grid-template-columns:1fr auto;gap:10px;margin-top:12px}.composer-fields{min-width:0}.composer button{height:auto;min-width:90px}.attachment-row{margin-top:8px;color:var(--muted);font-size:13px}.file-button{display:inline-flex;align-items:center;height:34px;padding:0 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);cursor:pointer}input[type=file]{display:none}.sessions-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.sessions-toolbar .search-row{flex:1 1 320px}.sessions-toolbar .attach-row{flex:1 1 360px;justify-content:flex-end;margin-left:auto}.sessions-toolbar input{min-width:220px}.copy-id{height:auto;padding:0;border:0;background:transparent;color:var(--link);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}.copy-id:hover{background:transparent;text-decoration:underline}.side-panel{max-height:calc(100vh - 126px);display:flex;flex-direction:column}.tool-stream{display:flex;flex-direction:column;gap:8px;overflow:auto;max-height:calc(100vh - 190px);padding-right:4px}.tool{border:1px solid var(--border-soft);border-radius:6px;padding:8px;background:var(--surface-soft);white-space:pre-wrap;word-break:break-word}.list{display:flex;flex-direction:column;gap:8px;margin-top:12px}.item{border:1px solid var(--border-soft);border-radius:8px;padding:12px;background:var(--surface-soft)}.item strong{display:block;overflow-wrap:anywhere}.item small{display:block;color:var(--muted);overflow-wrap:anywhere}.queue-item{cursor:grab}.queue-item.dragging{opacity:.55}.badge,.adapter-status{display:inline-flex;align-items:center;border:1px solid var(--border);border-radius:999px;padding:2px 8px;color:var(--muted);font-size:12px}.adapter-status{margin-left:6px;text-transform:capitalize}.adapter-status.enabled,.adapter-status.available{color:#1e754e;border-color:#8ed0aa;background:color-mix(in srgb,var(--accent-soft) 55%,transparent)}.adapter-status.disabled{color:var(--muted)}.adapter-status.planned{color:#8a6a12;border-color:#d9c27a;background:var(--warn)}.preview{margin-top:12px}.preview img{max-width:100%;border:1px solid var(--border);border-radius:8px;background:var(--surface)}.settings-grid{display:block}.setting{border:1px solid var(--border-soft);border-radius:8px;padding:12px;margin-bottom:10px;background:var(--surface-soft)}.setting label{display:block;font-size:13px;font-weight:700;margin-bottom:6px}.setting small{display:block;color:var(--muted);margin-top:6px}.setting input,.setting textarea,.setting select{width:100%}.setting-error{color:var(--danger);font-size:12px;margin-top:6px}.checkbox{display:inline-flex!important;grid-template-columns:auto 1fr!important;align-items:center;gap:8px}.checkbox input{height:auto;width:auto}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.tabs button{background:var(--surface);color:var(--text);border-color:var(--border);height:34px}.tabs button.active{background:var(--accent);color:white;border-color:var(--accent)}.pager{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px;color:var(--muted)}.pager-actions{display:flex;gap:8px}.pager button:disabled{opacity:.45;cursor:not-allowed}pre{white-space:pre-wrap;word-break:break-word;background:var(--pre);color:var(--pre-text);border-radius:8px;padding:14px;overflow:auto}footer{margin-top:auto;display:flex;gap:18px;flex-wrap:wrap;padding:14px 22px;border-top:1px solid var(--border);color:var(--muted);background:var(--surface)}dialog{border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);width:min(720px,calc(100vw - 28px));padding:18px;box-shadow:0 18px 70px rgba(0,0,0,.22)}dialog::backdrop{background:rgba(0,0,0,.35)}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.dialog-actions{justify-content:flex-end;margin-top:16px}#toast{position:fixed;right:18px;bottom:18px;display:none;background:var(--accent);color:white;border-radius:8px;padding:12px 14px;max-width:360px}.danger{background:var(--danger);border-color:var(--danger);color:white}@media(max-width:860px){.app{display:block}.sidebar{position:fixed;inset:0 auto 0 0;width:270px;transform:translateX(-100%);transition:.18s transform;z-index:20}.sidebar.open{transform:translateX(0)}.menu{display:inline-block}.header-actions{justify-content:flex-end}.page{padding:14px}.chat-layout{grid-template-columns:1fr}.chat-panel{height:auto;min-height:0}.messages{max-height:55vh;min-height:300px}.composer{grid-template-columns:1fr}.composer button{height:40px}.side-panel{order:-1;max-height:360px}.tool-stream{max-height:300px}header{align-items:flex-start}.metrics{grid-template-columns:1fr 1fr}}@media(max-width:560px){.metrics{grid-template-columns:1fr}.row{align-items:stretch}.row>*{width:100%}header{display:grid;grid-template-columns:auto 1fr}.header-actions{grid-column:1/3}.message{max-width:100%}.pager{align-items:stretch}.pager-actions,.pager button{width:100%}.attachment-row>*,.sessions-toolbar,.sessions-toolbar .row,.sessions-toolbar input,.sessions-toolbar button{width:100%}.sessions-toolbar .attach-row{margin-left:0;justify-content:stretch}}
`;
}

function dashboardJs(): string {
  return `
const token = localStorage.getItem('nordrelayDashboardToken') || '';
const state = { snapshot:null, controls:null, newSessionControls:null, enabledAgents:[], settings:[], currentPage:'overview', settingsGroup:null, logsPlain:'', logTimer:null, toastTimer:null, cliStatusActive:false };
const authHeaders = () => token ? { authorization: 'Bearer ' + token } : {};
async function api(path, options={}) {
  const headers = { ...(options.body ? {'content-type':'application/json'} : {}), ...authHeaders(), ...(options.headers||{}) };
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) { location.reload(); return; }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
function toast(msg,options={}){const el=document.getElementById('toast');el.textContent=msg;el.style.display='block';if(state.toastTimer)clearTimeout(state.toastTimer);state.toastTimer=null;if(!options.sticky){state.toastTimer=setTimeout(()=>{el.style.display='none';state.toastTimer=null},options.duration||3500)}}
function esc(s){return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function attr(s){return esc(s).replace(/"/g,'&quot;')}
function cssEscape(s){return window.CSS&&CSS.escape?CSS.escape(s):String(s).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&')}
function short(s,max=250){const text=String(s??'');return text.length>max?text.slice(0,max-1)+'...':text}
async function copyText(text){if(!text)return;try{await navigator.clipboard.writeText(text)}catch{const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();document.execCommand('copy');area.remove()}toast('Thread ID copied')}
function fmtDate(s){return s?new Date(s).toLocaleString(): '-'}
function fmtDuration(ms){if(!ms&&ms!==0)return '-';const sec=Math.round(ms/1000);if(sec<60)return sec+'s';return Math.floor(sec/60)+'m '+(sec%60)+'s'}
function fmtBytes(n){if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1).replace(/\\.0$/,'')+' KB';return (n/1048576).toFixed(1).replace(/\\.0$/,'')+' MB'}
function compactNum(n){if(!n)return'';if(n>=1000000000)return Math.round(n/100000000)/10+'B';if(n>=1000000)return Math.round(n/100000)/10+'M';if(n>=1000)return Math.round(n/100)/10+'K';return String(n)}
function modelLabel(m){const meta=[m.contextWindow?compactNum(m.contextWindow):'',m.supportsImages===true?'img':m.supportsImages===false?'text':'',m.supportsThinking===true?'think':''].filter(Boolean).join(' ');return (m.displayName||m.slug)+(meta?' · '+meta:'')}
function fmtAge(ms){const sec=Math.max(0,Math.floor(ms/1000));if(sec<60)return sec+'s ago';const min=Math.floor(sec/60);if(min<60)return min+'m ago';return Math.floor(min/60)+'h ago'}
function isCliRunningStatus(msg){return / CLI running\\b/.test(String(msg||''))}
function isCliDoneStatus(msg){return / CLI task\\b/.test(String(msg||''))}
function applyTheme(theme){document.documentElement.dataset.theme=theme;localStorage.setItem('nordrelayTheme',theme);document.getElementById('themeBtn').textContent=theme==='dark'?'Light':'Dark'}
function toggleTheme(){applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark')}
function page(name){state.currentPage=name;document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===name));document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+name));document.getElementById('pageTitle').textContent=name[0].toUpperCase()+name.slice(1);document.getElementById('sidebar').classList.remove('open'); if(name==='sessions') loadSessions(); if(name==='settings') loadSettings(); if(name==='logs') loadLogs(); if(name==='diagnostics') loadDiagnostics(); if(name==='artifacts') loadArtifacts(); if(name==='activity') loadActivity();}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>page(b.dataset.page));
document.getElementById('menuBtn').onclick=()=>document.getElementById('sidebar').classList.toggle('open');
document.getElementById('refreshBtn').onclick=()=>loadBootstrap();
document.getElementById('themeBtn').onclick=toggleTheme;
applyTheme(localStorage.getItem('nordrelayTheme') || 'light');

function createPaginator(containerId, onChange, pageSize=50){
  const container=document.getElementById(containerId);
  return {
    page:1,
    pageSize,
    reset(){this.page=1},
    render(meta={}){
      const hasPrevious=Boolean(meta.hasPrevious);
      const hasNext=Boolean(meta.hasNext);
      container.innerHTML='<span>Page '+this.page+' / '+this.pageSize+' per page</span><div class="pager-actions"><button data-page-action="prev" '+(!hasPrevious?'disabled':'')+'>Previous</button><button data-page-action="next" '+(!hasNext?'disabled':'')+'>Next</button></div>';
      const prev=container.querySelector('[data-page-action="prev"]');
      const next=container.querySelector('[data-page-action="next"]');
      prev.onclick=()=>{if(hasPrevious){this.page-=1;onChange()}};
      next.onclick=()=>{if(hasNext){this.page+=1;onChange()}};
    }
  };
}
const sessionsPager=createPaginator('sessionsPager',()=>loadSessions(false),50);

async function loadBootstrap(){
  const data = await api('/api/bootstrap');
  state.snapshot = data.status.snapshot;
  state.controls = data.controls;
  state.enabledAgents = data.enabledAgents || [];
  renderSnapshot(state.snapshot);
  renderSessionControls();
  populateNewSessionForm(data.enabledAgents);
  renderAdapters(data.channels, data.agentAdapters);
  document.getElementById('footerVersion').textContent='NordRelay '+(data.status.health?.version || '');
  document.getElementById('footerHealth').textContent='Health: '+(data.status.health?.state?.status || 'unknown');
  const agentSelect=document.getElementById('agentSelect');
  agentSelect.innerHTML=data.enabledAgents.map(a=>'<option value="'+a+'">'+a+'</option>').join('');
  agentSelect.value=state.snapshot.session.agentId;
  agentSelect.onchange=()=>safe(async()=>{await api('/api/agent',{method:'POST',body:JSON.stringify({agentId:agentSelect.value})});toast('Agent switched');await loadBootstrap();await loadChatHistory()});
}
function renderSnapshot(s){
  document.getElementById('sessionLine').textContent=(s.session.agentLabel||'Agent')+' / '+(s.session.model||'default')+' / '+(s.session.threadId||'not started');
  document.getElementById('sessionText').textContent=s.sessionText||'';
  document.getElementById('metrics').innerHTML=[
    ['Status',s.processing?'working':'idle'],['Agent',s.session.agentLabel],['Queue',s.queue.length],['Workspace',s.session.workspace],['Thread',s.session.threadId||'not started'],['Reasoning',s.session.reasoningEffort||'default'],['Fast',s.session.capabilities&&s.session.capabilities.fastMode?(s.session.fastMode?'on':'off'):'n/a']
  ].map(([k,v])=>'<div class="metric"><div class="label">'+esc(k)+'</div><div class="value">'+esc(v)+'</div></div>').join('');
  renderQueue(s.queue,s.queuePaused);
}
function renderSessionControls(){
  const c=state.controls||{};const s=state.snapshot?.session||{};const caps=c.capabilities||{};
  const modelOptions=['<option value="">Default</option>'].concat((c.models||[]).map(m=>'<option value="'+attr(m.slug)+'" '+(m.slug===s.model?'selected':'')+'>'+esc(modelLabel(m))+'</option>')).join('');
  const reasoningOptions=(c.reasoningOptions||[]).map(v=>'<option value="'+attr(v)+'" '+(v===s.reasoningEffort?'selected':'')+'>'+esc(v)+'</option>').join('');
  const launchOptions=(c.launchProfiles||[]).map(p=>'<option value="'+attr(p.id)+'" '+(p.id===(s.nextLaunchProfileId||s.launchProfileId)?'selected':'')+'>'+esc(p.label+' - '+p.behavior+(p.unsafe?' - unsafe':''))+'</option>').join('');
  document.getElementById('sessionControls').innerHTML=[
    caps.modelSelection?'<label>Model<select id="controlModel">'+modelOptions+'</select></label>':'',
    caps.reasoningSelection?'<label>'+esc(c.reasoningLabel||'Reasoning')+'<select id="controlReasoning">'+reasoningOptions+'</select></label>':'',
    caps.launchProfiles?'<label>Launch<select id="controlLaunch">'+launchOptions+'</select></label>':'',
    caps.fastMode?'<label class="checkbox"><input id="controlFast" type="checkbox" '+(s.fastMode?'checked':'')+'> Fast mode</label>':''
  ].join('');
  const model=document.getElementById('controlModel'); if(model) model.onchange=()=>safe(async()=>{if(model.value){await api('/api/session/model',{method:'POST',body:JSON.stringify({model:model.value})});toast('Model updated');loadBootstrap()}});
  const reasoning=document.getElementById('controlReasoning'); if(reasoning) reasoning.onchange=()=>safe(async()=>{await api('/api/session/reasoning',{method:'POST',body:JSON.stringify({reasoning:reasoning.value})});toast((c.reasoningLabel||'Reasoning')+' updated');loadBootstrap()});
  const launch=document.getElementById('controlLaunch'); if(launch) launch.onchange=()=>safe(async()=>{await api('/api/session/launch',{method:'POST',body:JSON.stringify({profileId:launch.value})});toast('Launch profile updated');loadBootstrap()});
  const fast=document.getElementById('controlFast'); if(fast) fast.onchange=()=>safe(async()=>{await api('/api/session/fast',{method:'POST',body:JSON.stringify({enabled:fast.checked})});toast('Fast mode updated');loadBootstrap()});
}
function renderAdapters(channels, agents){
  const implementedAgents=new Set(['codex','pi','hermes','openclaw','claude-code']);
  const channelCards=(channels||[]).map(c=>adapterCard(c.label,c.status,c.capabilities.join(', ')));
  const agentCards=(agents||[]).map(a=>{const integrated=implementedAgents.has(a.id);const status=integrated?(state.enabledAgents.includes(a.id)?'enabled':'disabled'):(a.status||'planned');return adapterCard(a.label,status,a.notes||a.envFlag||'available')});
  document.getElementById('adapters').innerHTML='<div class="list">'+channelCards.concat(agentCards).join('')+'</div>';
}
function adapterCard(label,status,detail){return '<div class="item"><strong>'+esc(label)+' <span class="adapter-status '+esc(status)+'">'+esc(status)+'</span></strong><small>'+esc(detail||'')+'</small></div>'}
function appendMessage(cls,text){const box=document.getElementById('messages');const div=document.createElement('div');div.className='message '+cls;div.textContent=text;box.appendChild(div);box.scrollTop=box.scrollHeight;return div}
function renderChatMessages(messages){const box=document.getElementById('messages');box.innerHTML=(messages||[]).map(m=>'<div class="message '+esc(m.role)+'"><small>'+esc((m.source||'web')+' / '+fmtDate(m.timestamp))+'</small>\\n'+esc(m.text)+'</div>').join('');box.scrollTop=box.scrollHeight}
async function loadChatHistory(){const data=await api('/api/chat/history');renderChatMessages(data.messages||[])}
let currentAgentMessage=null;
function connectEvents(){
  const qs = token ? '?token='+encodeURIComponent(token) : '';
  const events = new EventSource('/api/events'+qs);
  events.addEventListener('snapshot', e=>{const d=JSON.parse(e.data).data;state.snapshot=d;renderSnapshot(d);renderSessionControls()});
  events.addEventListener('chat_history', e=>renderChatMessages(JSON.parse(e.data).messages||[]));
  events.addEventListener('activity_update', e=>renderActivity(JSON.parse(e.data).events||[]));
  events.addEventListener('session_update', e=>{loadBootstrap();loadChatHistory()});
  events.addEventListener('queue_update', e=>{const d=JSON.parse(e.data);renderQueue(d.queue,d.paused)});
  events.addEventListener('turn_start', e=>{const d=JSON.parse(e.data);appendMessage('user',d.prompt);currentAgentMessage=appendMessage('agent','')});
  events.addEventListener('text_delta', e=>{const d=JSON.parse(e.data);if(!currentAgentMessage)currentAgentMessage=appendMessage('agent','');currentAgentMessage.textContent+=d.delta;currentAgentMessage.scrollIntoView({block:'end'})});
  events.addEventListener('tool_start', e=>{const d=JSON.parse(e.data);tool('tool','Started '+d.toolName)});
  events.addEventListener('tool_update', e=>{const d=JSON.parse(e.data);if(d.partialResult)tool('tool',d.partialResult.slice(-600))});
  events.addEventListener('tool_end', e=>{const d=JSON.parse(e.data);tool(d.isError?'danger':'tool','Finished '+d.toolCallId+(d.isError?' with error':''))});
  events.addEventListener('todo_update', e=>{const d=JSON.parse(e.data);tool('tool','Plan:\\n'+d.items.map(i=>(i.completed?'[x] ':'[ ] ')+i.text).join('\\n'))});
  events.addEventListener('turn_error', e=>{const d=JSON.parse(e.data);appendMessage('system','Error: '+d.error);currentAgentMessage=null});
  events.addEventListener('turn_complete', ()=>{currentAgentMessage=null;loadBootstrap()});
  events.addEventListener('status', e=>{const d=JSON.parse(e.data);const msg=d.message||'';if(isCliRunningStatus(msg)){state.cliStatusActive=true;toast(msg,{sticky:true});return}if(isCliDoneStatus(msg))state.cliStatusActive=false;toast(msg)});
  events.onerror=()=>{};
}
function updateToolAgeTitles(){document.querySelectorAll('.tool[data-created-at]').forEach(el=>{const created=Number(el.dataset.createdAt||Date.now());el.title='Updated '+fmtAge(Date.now()-created)})}
function tool(cls,text){const div=document.createElement('div');div.className='tool '+(cls==='danger'?'danger':'');div.dataset.createdAt=String(Date.now());div.textContent=text;document.getElementById('toolStream').prepend(div);updateToolAgeTitles()}
setInterval(updateToolAgeTitles,30000);
let selectedFiles=[];
function renderSelectedFiles(){const summary=document.getElementById('fileSummary');if(selectedFiles.length===0){summary.textContent='No files selected';return}const names=selectedFiles.slice(0,3).map(f=>f.name || 'file').join(', ');const more=selectedFiles.length>3?' +'+(selectedFiles.length-3)+' more':'';const bytes=selectedFiles.reduce((sum,file)=>sum+file.size,0);summary.textContent=names+more+' ('+fmtBytes(bytes)+')'}
async function filePayload(file){return {name:file.name || 'upload',mimeType:file.type || 'application/octet-stream',dataBase64:await fileToBase64(file)}}
async function fileToBase64(file){const buffer=await file.arrayBuffer();const bytes=new Uint8Array(buffer);let binary='';const chunk=0x8000;for(let i=0;i<bytes.length;i+=chunk){binary+=String.fromCharCode(...bytes.subarray(i,i+chunk))}return btoa(binary)}
document.getElementById('fileInput').onchange=e=>{selectedFiles=Array.from(e.target.files||[]);renderSelectedFiles()};
document.getElementById('clearFilesBtn').onclick=()=>{selectedFiles=[];document.getElementById('fileInput').value='';renderSelectedFiles()};
document.getElementById('promptForm').onsubmit=e=>safe(async()=>{e.preventDefault();const input=document.getElementById('promptInput');const text=input.value.trim();if(!text&&selectedFiles.length===0)return;const files=selectedFiles;input.value='';selectedFiles=[];document.getElementById('fileInput').value='';renderSelectedFiles();const payloadFiles=files.length?await Promise.all(files.map(filePayload)):[];const r=files.length?await api('/api/prompt/upload',{method:'POST',body:JSON.stringify({text,files:payloadFiles})}):await api('/api/prompt',{method:'POST',body:JSON.stringify({text})});if(r.transcribeOnly)appendMessage('system','Transcribed audio:\\n'+(r.transcript||'(empty)'));else if(r.queued)appendMessage('system','Queued prompt '+r.queueId)},e);
document.getElementById('newSessionBtn').onclick=()=>openNewSessionDialog();
document.getElementById('clearChatBtn').onclick=()=>safe(async()=>{if(confirm('Clear chat history for the current thread?')){const r=await api('/api/chat/history',{method:'DELETE'});renderChatMessages(r.messages||[]);toast('Removed '+r.removed+' messages')}});
document.getElementById('abortBtn').onclick=()=>safe(async()=>{await api('/api/abort',{method:'POST'});toast('Abort sent')});
document.getElementById('handbackBtn').onclick=()=>safe(async()=>{const r=await api('/api/handback',{method:'POST'});appendMessage('system','Handback command:\\n'+(r.command||'No command available'))});
function renderNewSessionControls(c){const s=state.snapshot?.session||{};const caps=c.capabilities||{};document.getElementById('workspaceOptions').innerHTML=(c.workspaces||[]).map(w=>'<option value="'+attr(w)+'"></option>').join('');document.getElementById('newModel').innerHTML='<option value="">Default</option>'+((c.models||[]).map(m=>'<option value="'+attr(m.slug)+'">'+esc(modelLabel(m))+'</option>').join(''));document.getElementById('newModel').parentElement.style.display=caps.modelSelection?'grid':'none';const reasoningWrap=document.getElementById('newReasoningWrap');reasoningWrap.firstChild.nodeValue=(c.reasoningLabel||'Reasoning');reasoningWrap.style.display=caps.reasoningSelection?'grid':'none';document.getElementById('newReasoning').innerHTML='<option value="">Default</option>'+((c.reasoningOptions||[]).map(v=>'<option value="'+attr(v)+'">'+esc(v)+'</option>').join(''));document.getElementById('newLaunch').innerHTML='<option value="">Default</option>'+((c.launchProfiles||[]).map(p=>'<option value="'+attr(p.id)+'">'+esc(p.label+' - '+p.behavior)+'</option>').join(''));document.getElementById('newFast').checked=Boolean(s.fastMode&&caps.fastMode);document.getElementById('newLaunchWrap').style.display=caps.launchProfiles?'grid':'none';document.getElementById('newFastWrap').style.display=caps.fastMode?'inline-flex':'none'}
function populateNewSessionForm(agents){const s=state.snapshot?.session||{};const agentSelect=document.getElementById('newAgent');agentSelect.innerHTML=(agents||[]).map(a=>'<option value="'+attr(a)+'" '+(a===s.agentId?'selected':'')+'>'+esc(a)+'</option>').join('');agentSelect.value=s.agentId||agentSelect.value;document.getElementById('newWorkspace').value=s.workspace||'';state.newSessionControls=state.controls||{};renderNewSessionControls(state.newSessionControls);agentSelect.onchange=()=>safe(async()=>{state.newSessionControls=await api('/api/control-options?agent='+encodeURIComponent(agentSelect.value));renderNewSessionControls(state.newSessionControls)})}
function openNewSessionDialog(){populateNewSessionForm(state.enabledAgents);document.getElementById('newSessionDialog').showModal()}
document.getElementById('newSessionForm').onsubmit=e=>safe(async()=>{e.preventDefault();const payload={agentId:val('newAgent'),workspace:val('newWorkspace')||undefined,model:val('newModel')||undefined,reasoningEffort:val('newReasoning')||undefined,launchProfileId:val('newLaunch')||undefined,fastMode:document.getElementById('newFast').checked};await api('/api/sessions/new',{method:'POST',body:JSON.stringify(payload)});document.getElementById('newSessionDialog').close();toast('New session started');await loadBootstrap();await loadChatHistory()},e);
document.getElementById('cancelSessionBtn').onclick=()=>document.getElementById('newSessionDialog').close();
function val(id){return document.getElementById(id).value.trim()}
async function loadSessions(reset=true){if(reset)sessionsPager.reset();const q=document.getElementById('sessionSearch').value||'';const data=await api('/api/sessions?query='+encodeURIComponent(q)+'&page='+sessionsPager.page+'&limit='+sessionsPager.pageSize);document.getElementById('sessionsList').innerHTML=data.sessions.map(s=>'<div class="item"><strong title="'+attr(s.title||s.firstUserMessage||s.id)+'">'+esc(short(s.title||s.firstUserMessage||s.id))+'</strong><small><button type="button" class="copy-id" data-copy-id="'+attr(s.id)+'" title="Copy thread ID">'+esc(short(s.id,64))+'</button> / '+esc(short((s.cwd||'')+' / '+fmtDate(s.updatedAt)))+'</small><div class="row"><button data-switch="'+attr(s.id)+'">Switch</button></div></div>').join('')||'<div class="item">No sessions found.</div>';sessionsPager.render(data.pagination||{});document.querySelectorAll('[data-copy-id]').forEach(b=>b.onclick=()=>copyText(b.dataset.copyId||''));document.querySelectorAll('[data-switch]').forEach(b=>b.onclick=async()=>{await api('/api/sessions/switch',{method:'POST',body:JSON.stringify({threadId:b.dataset.switch})});toast('Session switched');loadBootstrap()})}
document.getElementById('sessionSearchBtn').onclick=()=>loadSessions(true);document.getElementById('sessionSearch').addEventListener('keydown',e=>{if(e.key==='Enter')loadSessions(true)});document.getElementById('attachBtn').onclick=async()=>{const threadId=document.getElementById('attachInput').value.trim();if(threadId){await api('/api/sessions/attach',{method:'POST',body:JSON.stringify({threadId})});toast('Session attached');loadBootstrap()}};
function renderQueue(queue,paused){document.getElementById('queueStatus').textContent=paused?'Paused':'Running';document.getElementById('queueList').innerHTML=(queue||[]).map((q,i)=>'<div class="item queue-item" draggable="true" data-queue-id="'+attr(q.id)+'"><strong>'+esc((i+1)+'. '+q.id+' - '+q.description)+'</strong><small>Created '+fmtDate(q.createdAt)+' / attempts '+q.attempts+(q.lastError?' / '+esc(q.lastError):'')+'</small><div class="row"><button data-q="run" data-id="'+q.id+'">Run</button><button data-q="top" data-id="'+q.id+'">Top</button><button data-q="up" data-id="'+q.id+'">Up</button><button data-q="down" data-id="'+q.id+'">Down</button><button data-q="cancel" data-id="'+q.id+'" class="danger">Cancel</button></div></div>').join('')||'<div class="item">Queue is empty.</div>';document.querySelectorAll('[data-q]').forEach(b=>b.onclick=()=>safe(async()=>{const r=await api('/api/queue',{method:'POST',body:JSON.stringify({action:b.dataset.q,id:b.dataset.id})});renderQueue(r.queue,r.paused)}));let dragged=null;document.querySelectorAll('.queue-item').forEach(item=>{item.ondragstart=()=>{dragged=item.dataset.queueId;item.classList.add('dragging')};item.ondragend=()=>item.classList.remove('dragging');item.ondragover=e=>e.preventDefault();item.ondrop=()=>safe(async()=>{if(dragged&&dragged!==item.dataset.queueId){const ids=Array.from(document.querySelectorAll('.queue-item')).map(el=>el.dataset.queueId);const targetIndex=Math.max(0,ids.indexOf(item.dataset.queueId));await api('/api/queue',{method:'POST',body:JSON.stringify({action:'top',id:dragged})});for(let i=0;i<targetIndex;i++)await api('/api/queue',{method:'POST',body:JSON.stringify({action:'down',id:dragged})});const r=await api('/api/queue');renderQueue(r.queue,r.paused)}})})}
document.querySelectorAll('[data-queue]').forEach(b=>b.onclick=()=>safe(async()=>{const r=await api('/api/queue',{method:'POST',body:JSON.stringify({action:b.dataset.queue})});renderQueue(r.queue,r.paused)}));
async function loadArtifacts(){const data=await api('/api/artifacts');document.getElementById('artifactList').innerHTML=data.reports.map(r=>'<div class="item"><strong>'+esc(r.turnId)+' - '+r.fileCount+' files - '+fmtBytes(r.totalSizeBytes)+'</strong><small>'+fmtDate(r.updatedAt)+' / '+esc(r.source||'turn')+'</small><div class="row"><a href="/api/artifacts/zip?turnId='+encodeURIComponent(r.turnId)+(token?'&token='+encodeURIComponent(token):'')+'">Download ZIP</a><button data-del-art="'+esc(r.turnId)+'" class="danger">Delete</button></div>'+r.artifacts.slice(0,12).map(a=>'<small><a href="/api/artifacts/file?turnId='+encodeURIComponent(r.turnId)+'&path='+encodeURIComponent(a.relativePath)+(token?'&token='+encodeURIComponent(token):'')+'">'+esc(a.name)+'</a> '+fmtBytes(a.sizeBytes)+' <button class="secondary" data-preview-turn="'+attr(r.turnId)+'" data-preview-path="'+attr(a.relativePath)+'">Preview</button></small>').join('')+'</div>').join('')||'<div class="item">No artifacts.</div>';document.querySelectorAll('[data-del-art]').forEach(b=>b.onclick=()=>safe(async()=>{if(confirm('Delete artifact turn '+b.dataset.delArt+'?')){await api('/api/artifacts?turnId='+encodeURIComponent(b.dataset.delArt),{method:'DELETE'});loadArtifacts()}}));document.querySelectorAll('[data-preview-turn]').forEach(b=>b.onclick=()=>previewArtifact(b.dataset.previewTurn,b.dataset.previewPath))}
document.getElementById('reloadArtifactsBtn').onclick=loadArtifacts;
async function previewArtifact(turnId,path){const data=await api('/api/artifacts/preview?turnId='+encodeURIComponent(turnId)+'&path='+encodeURIComponent(path));const target=document.getElementById('artifactPreview');if(data.kind==='image'){target.innerHTML='<div class="panel"><h2>'+esc(data.name)+'</h2><img src="/api/artifacts/file?turnId='+encodeURIComponent(turnId)+'&path='+encodeURIComponent(path)+(token?'&token='+encodeURIComponent(token):'')+'"></div>';return}if(data.kind==='text'){target.innerHTML='<div class="panel"><h2>'+esc(data.name)+' '+fmtBytes(data.sizeBytes)+'</h2><pre>'+esc(data.text||'')+'</pre>'+(data.truncated?'<small>Preview truncated.</small>':'')+'</div>';return}target.innerHTML='<div class="panel"><h2>'+esc(data.name)+'</h2><p>'+esc(data.detail||'Preview unavailable')+'</p></div>'}
async function loadActivity(){const q='?source='+encodeURIComponent(val('activitySource'))+'&status='+encodeURIComponent(val('activityStatus'))+'&limit='+encodeURIComponent(val('activityLimit')||'100');const data=await api('/api/activity'+q);renderActivity(data.events||[])}
function renderActivity(events){document.getElementById('activityList').innerHTML=(events||[]).map(e=>'<div class="item"><strong>'+esc(fmtDate(e.timestamp)+' / '+e.source+' / '+e.status+' / '+e.type)+'</strong><small>'+esc(short(e.prompt||e.detail||'',220))+'</small><small>'+esc((e.threadId||'-')+' / '+(e.workspace||'-')+' / '+fmtDuration(e.durationMs))+'</small></div>').join('')||'<div class="item">No activity.</div>'}
document.getElementById('loadActivityBtn').onclick=()=>loadActivity();
async function loadSettings(){const data=await api('/api/settings');state.settings=data.settings;renderSettings()}
function renderSettings(){const groups={};state.settings.forEach(s=>(groups[s.group]??=[]).push(s));const names=Object.keys(groups);if(!state.settingsGroup||!groups[state.settingsGroup])state.settingsGroup=names[0];document.getElementById('settingsTabs').innerHTML=names.map(name=>'<button data-setting-tab="'+attr(name)+'" class="'+(name===state.settingsGroup?'active':'')+'">'+esc(name)+' ('+groups[name].length+')</button>').join('');document.querySelectorAll('[data-setting-tab]').forEach(b=>b.onclick=()=>{state.settingsGroup=b.dataset.settingTab;renderSettings()});const items=groups[state.settingsGroup]||[];document.getElementById('settingsForm').innerHTML='<div class="settings-section"><h2>'+esc(state.settingsGroup||'Settings')+'</h2>'+items.map(s=>'<div class="setting" data-setting-box="'+attr(s.key)+'"><label>'+esc(s.label)+'</label>'+settingInput(s)+'<small>'+esc(s.key)+' - '+esc(s.description)+(s.effectiveValue?' Active: '+esc(s.effectiveValue)+'.':'')+(s.restartRequired?' Restart required.':'')+(s.configured?' Configured.':' Inherited/default.')+'</small><div class="setting-error"></div></div>').join('')+'</div>'}
function settingAttrs(s,original){return ' data-setting="'+attr(s.key)+'" data-original-value="'+attr(original)+'" data-configured="'+(s.configured?'true':'false')+'"'}
function settingInput(s){const display=s.configured?(s.value||''):(s.effectiveValue||''); if(s.options){const blankLabel=s.effectiveValue?'Use active default ('+s.effectiveValue+')':'Use active default';return '<select'+settingAttrs(s,s.configured?s.value:'')+'><option value="" '+(!s.configured?'selected':'')+'>'+esc(blankLabel)+'</option>'+s.options.map(o=>'<option value="'+attr(o)+'" '+(s.configured&&s.value===o?'selected':'')+'>'+esc(o)+'</option>').join('')+'</select>'} if(s.kind==='boolean'){const blankLabel=s.effectiveValue?'Use active default ('+s.effectiveValue+')':'Use active default';return '<select'+settingAttrs(s,s.configured?s.value:'')+'><option value="" '+(!s.configured?'selected':'')+'>'+esc(blankLabel)+'</option><option value="true" '+(s.configured&&s.value==='true'?'selected':'')+'>true</option><option value="false" '+(s.configured&&s.value==='false'?'selected':'')+'>false</option></select>'} const value=esc(display); if(s.kind==='json')return '<textarea rows="4"'+settingAttrs(s,display)+'>'+value+'</textarea>'; return '<input'+settingAttrs(s,display)+' value="'+value+'" '+(s.kind==='secret'?'type="password"':'')+'>'}
document.getElementById('saveSettingsBtn').onclick=()=>safe(async()=>{document.querySelectorAll('.setting-error').forEach(e=>e.textContent='');const patch={};document.querySelectorAll('[data-setting]').forEach(el=>{const original=el.dataset.originalValue??'';if(el.value!==original)patch[el.dataset.setting]=el.value});const r=await api('/api/settings',{method:'PATCH',body:JSON.stringify({settings:patch})});(r.errors||[]).forEach(err=>{const box=document.querySelector('[data-setting-box="'+cssEscape(err.key)+'"] .setting-error');if(box)box.textContent=err.message});document.getElementById('settingsStatus').textContent=(r.errors&&r.errors.length)?'Fix '+r.errors.length+' setting error(s)':(r.changedKeys.length?'Saved '+r.changedKeys.length+' setting(s)'+(r.restartRequired?' - restart required':''):'No changes');toast((r.errors&&r.errors.length)?'Settings need attention':'Settings saved');if(!(r.errors&&r.errors.length))await loadSettings()});
document.getElementById('restartBtn').onclick=()=>safe(async()=>{if(confirm('Restart NordRelay now?')){await api('/api/runtime/restart',{method:'POST'});toast('Restart requested')}});
async function loadLogs(){const target=document.getElementById('logTarget').value;const lines=document.getElementById('logLines').value;const data=await api('/api/logs?target='+target+'&lines='+lines);state.logsPlain=data.plain||'';renderLogs()}document.getElementById('loadLogsBtn').onclick=loadLogs;
function renderLogs(){const level=val('logLevel');const query=val('logSearch').toLowerCase();const lines=state.logsPlain.split(/\\n/).filter(line=>(level==='all'||line.includes(level))&&(!query||line.toLowerCase().includes(query)));document.getElementById('logs').textContent=lines.join('\\n')||'(empty)'}
document.getElementById('logLevel').onchange=renderLogs;document.getElementById('logSearch').oninput=renderLogs;document.getElementById('logAutoRefresh').onchange=e=>{clearInterval(state.logTimer);state.logTimer=null;if(e.target.checked)state.logTimer=setInterval(loadLogs,5000)};document.getElementById('downloadLogsBtn').onclick=()=>{const blob=new Blob([document.getElementById('logs').textContent||''],{type:'text/plain'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='nordrelay-log.txt';a.click();URL.revokeObjectURL(a.href)};
async function loadDiagnostics(){const data=await api('/api/diagnostics');document.getElementById('diagnostics').innerHTML=diagnosticsHtml(data)}
function diagnosticsHtml(d){const h=d.health||{};const s=d.snapshot?.session||{};const vc=d.versionChecks||{};const caps=s.capabilities||{};const agentDiag=d.runtime?.agentDiagnostics;return '<div class="list">'+card('Runtime',[['Status',h.state?.status],['PID',h.state?.pid],['App PID',h.state?.appPid],['State',h.stateFile],['Log',h.logFile],['State backend',d.runtime?.stateBackend],['Uptime',h.uptimeSeconds+'s']])+card('Agent',[['Agent',s.agentLabel],['Thread',s.threadId],['Workspace',s.workspace],['Model',s.model],['Reasoning',s.reasoningEffort],['Fast',caps.fastMode?(s.fastMode?'on':'off'):'n/a']])+card('Agent State',(agentDiag?.lines||[]).map(x=>[x.label,x.value]))+card('CLI Versions',Object.values(vc).map(v=>[v.label,(v.status==='current'?'OK ':'WARN ')+(v.installedLabel||'-')+' latest '+(v.latestVersion||'-')]))+card('External Mirror',d.runtime?.externalMirror?Object.entries(d.runtime.externalMirror):[['Status','idle']])+'</div>'}
function card(title,rows){return '<div class="item"><strong>'+esc(title)+'</strong>'+rows.map(r=>'<small>'+esc(r[0])+': '+esc(r[1]??'-')+'</small>').join('')+'</div>'}
function safe(fn,event){if(event&&event.preventDefault)event.preventDefault();Promise.resolve().then(fn).catch(err=>toast(err.message||String(err)))}
loadBootstrap().then(()=>{connectEvents();loadChatHistory();loadSessions();loadArtifacts();loadSettings();loadLogs();loadDiagnostics();loadActivity()}).catch(err=>toast(err.message));
`;
}
