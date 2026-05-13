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
import { renderDashboardNav } from "./web-dashboard-ui.js";

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
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

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
      status: await runtime.bootstrapStatus(),
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

  if (req.method === "GET" && url.pathname === "/api/version") {
    sendJson(res, 200, await runtime.version());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/update") {
    sendJson(res, 202, runtime.updateConnector());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent-updates") {
    sendJson(res, 200, { jobs: runtime.agentUpdateJobs() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent-update") {
    const body = await readJsonBody(req);
    sendJson(res, 202, { job: runtime.startAgentUpdate(parseAgentIdRequired(stringField(body, "agentId"))) });
    return;
  }

  const agentUpdateLogMatch = url.pathname.match(/^\/api\/agent-update\/([^/]+)\/log$/);
  if (req.method === "GET" && agentUpdateLogMatch?.[1]) {
    sendJson(res, 200, runtime.agentUpdateLog(decodeURIComponent(agentUpdateLogMatch[1])));
    return;
  }

  const agentUpdateInputMatch = url.pathname.match(/^\/api\/agent-update\/([^/]+)\/input$/);
  if (req.method === "POST" && agentUpdateInputMatch?.[1]) {
    const body = await readJsonBody(req);
    sendJson(res, 200, { job: runtime.sendAgentUpdateInput(decodeURIComponent(agentUpdateInputMatch[1]), stringField(body, "input")) });
    return;
  }

  const agentUpdateCancelMatch = url.pathname.match(/^\/api\/agent-update\/([^/]+)\/cancel$/);
  if (req.method === "POST" && agentUpdateCancelMatch?.[1]) {
    sendJson(res, 200, { job: runtime.cancelAgentUpdate(decodeURIComponent(agentUpdateCancelMatch[1])) });
    return;
  }

  if (req.method === "GET" && (url.pathname === "/api/tasks" || url.pathname === "/api/progress")) {
    sendJson(res, 200, runtime.tasks());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/adapters/health") {
    sendJson(res, 200, { adapters: await runtime.adapterHealth() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/permissions") {
    sendJson(res, 200, runtime.permissions());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    sendJson(res, 200, { events: runtime.audit(numberParam(url, "limit", 50)) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/locks") {
    sendJson(res, 200, { locks: runtime.locks() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/locks") {
    const body = await readJsonBody(req);
    sendJson(res, 200, { lock: runtime.lockWebSession(optionalStringField(body, "ownerName")), locks: runtime.locks() });
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/locks") {
    sendJson(res, 200, runtime.unlockWebSession());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    sendJson(res, 200, await runtime.authStatus(parseAgentId(url.searchParams.get("agent") ?? undefined)));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJsonBody(req);
    sendJson(res, 200, await runtime.login(parseAgentId(optionalStringField(body, "agentId"))));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const body = await readJsonBody(req);
    sendJson(res, 200, await runtime.logout(parseAgentId(optionalStringField(body, "agentId"))));
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

  if (req.method === "GET" && url.pathname === "/api/sessions/detail") {
    sendJson(res, 200, await runtime.sessionDetail(requiredSearch(url, "threadId")));
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

  if (req.method === "POST" && (url.pathname === "/api/abort" || url.pathname === "/api/stop")) {
    await runtime.abort();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/handback") {
    sendJson(res, 200, await runtime.handback());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/retry") {
    sendJson(res, 202, await runtime.retry());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sync") {
    sendJson(res, 200, await runtime.sync());
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

  if (req.method === "POST" && url.pathname === "/api/artifacts/bulk") {
    const body = await readJsonBody(req);
    const action = stringField(body, "action");
    const turnIds = Array.isArray(body.turnIds) ? body.turnIds.filter((item): item is string => typeof item === "string") : [];
    if (action !== "delete") {
      throw new Error("Unsupported artifact bulk action.");
    }
    const removed = [];
    for (const turnId of turnIds) {
      if (await runtime.deleteArtifact(turnId)) {
        removed.push(turnId);
      }
    }
    sendJson(res, 200, { removed });
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

  if (req.method === "POST" && url.pathname === "/api/logs/clear") {
    const body = await readJsonBody(req);
    sendJson(res, 200, runtime.clearLogs(parseLogTarget(optionalStringField(body, "target"))));
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
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
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
  return parseAgentIdRequired(value);
}

function parseAgentIdRequired(value: string) {
  if (!isAgentId(value)) {
    throw new Error(`Invalid agent: ${value}`);
  }
  return value;
}

function parseLogTarget(value: string | undefined): "connector" | "update" {
  return value === "update" ? "update" : "connector";
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
    TELEGRAM_BOT_TOKEN: current.telegramBotToken,
    TELEGRAM_ADMIN_USER_IDS: current.telegramAdminUserIds.join(","),
    TELEGRAM_ALLOWED_USER_IDS: current.telegramAllowedUserIds.join(","),
    TELEGRAM_READONLY_USER_IDS: current.telegramReadOnlyUserIds.join(","),
    TELEGRAM_ALLOWED_CHAT_IDS: current.telegramAllowedChatIds.join(","),
    TELEGRAM_ROLE_POLICIES_JSON: optionalEnv("TELEGRAM_ROLE_POLICIES_JSON"),
    TELEGRAM_TRANSPORT: current.telegramTransport,
    TELEGRAM_WEBHOOK_URL: current.telegramWebhookUrl,
    TELEGRAM_WEBHOOK_HOST: current.telegramWebhookHost,
    TELEGRAM_WEBHOOK_PORT: String(current.telegramWebhookPort),
    TELEGRAM_WEBHOOK_PATH: current.telegramWebhookPath,
    TELEGRAM_WEBHOOK_SECRET: current.telegramWebhookSecret,
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
        ${renderDashboardNav()}
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
          <span id="connectionStatus" class="badge">Connecting</span>
          <select id="agentSelect"></select>
          <button id="themeBtn" class="secondary" title="Toggle dark theme">Dark</button>
          <button id="refreshBtn">Refresh</button>
        </div>
      </header>

      <section class="page active" id="page-overview">
        <div class="metrics" id="metrics"></div>
        <div class="stack">
          <div class="panel"><h2>Current Session</h2><pre id="sessionText"></pre></div>
          <div class="overview-adapter-grid">
            <div class="panel"><h2>Agent Adapters</h2><div id="agentAdapters"></div></div>
            <div class="panel"><h2>Chat Adapters</h2><div id="chatAdapters"></div></div>
          </div>
        </div>
      </section>

      <section class="page" id="page-chat">
        <div class="chat-layout">
          <div class="panel chat-panel">
            <div class="chat-toolbar">
              <button id="newSessionBtn">New session</button>
              <button id="retryBtn" class="secondary">Retry</button>
              <button id="editLastBtn" class="secondary">Edit last</button>
              <button id="syncBtn" class="secondary">Sync</button>
              <button id="notifyBtn" class="secondary">Notify</button>
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
                  <button type="button" id="recordBtn" class="secondary">Record voice</button>
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

      <section class="page" id="page-tasks">
        <div class="panel">
          <div class="row"><button id="reloadTasksBtn">Reload tasks</button></div>
          <div id="tasksList" class="list"></div>
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
          <div class="row"><select id="activitySource"><option value="all">All sources</option><option value="web">Web</option><option value="cli">CLI</option></select><select id="activityStatus"><option value="all">All statuses</option><option value="queued">Queued</option><option value="running">Running</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="aborted">Aborted</option><option value="info">Info</option></select><input id="activitySince" type="datetime-local"><input id="activityLimit" type="number" value="100" min="1" max="500"><button id="loadActivityBtn">Load activity</button><button id="exportActivityBtn" class="secondary">Export</button></div>
          <div id="activityList" class="list"></div>
        </div>
      </section>

      <section class="page" id="page-artifacts">
        <div class="panel">
          <div class="row"><button id="reloadArtifactsBtn">Reload artifacts</button><input id="artifactSearch" placeholder="Search artifacts"><select id="artifactKind"><option value="all">All files</option><option value="images">Images</option><option value="docs">Docs/code</option></select><button id="zipSelectedArtifactsBtn" class="secondary">ZIP selected</button><button id="deleteSelectedArtifactsBtn" class="danger">Delete selected</button></div>
          <div id="artifactPreview" class="preview"></div>
          <div id="artifactList" class="list"></div>
        </div>
      </section>

      <section class="page" id="page-adapters">
        <div class="panel">
          <div class="row"><button id="reloadAdaptersBtn">Reload adapters</button></div>
          <div id="adapterHealth" class="list"></div>
        </div>
      </section>

      <section class="page" id="page-access">
        <div class="panel">
          <div class="row"><button id="loadAccessBtn">Reload access</button><button id="saveAccessBtn">Save access settings</button><button id="lockSessionBtn" class="secondary">Lock web session</button><button id="unlockSessionBtn" class="secondary">Unlock web session</button></div>
          <div id="accessPanel" class="settings-grid"></div>
          <h2>Locks</h2>
          <div id="locksList" class="list"></div>
          <h2>Audit</h2>
          <div class="row"><input id="auditLimit" type="number" value="50" min="1" max="200"><button id="loadAuditBtn">Load audit</button></div>
          <div id="auditList" class="list"></div>
        </div>
      </section>

      <section class="page" id="page-version">
        <div class="panel">
          <div class="row version-actions"><button id="loadVersionBtn">Check versions</button><button id="updateBtn" class="secondary">Update NordRelay</button></div>
          <div id="versionPanel" class="list"></div>
          <h2 class="version-update-title">Agent update jobs</h2>
          <div id="agentUpdateJobs" class="list"></div>
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
          <div class="row"><select id="logTarget"><option value="connector">Connector</option><option value="update">Update</option></select><select id="logLevel"><option value="all">All levels</option><option value="ERROR">Error</option><option value="WARN">Warn</option><option value="INFO">Info</option></select><input id="logSearch" placeholder="Search logs"><input id="logSince" type="datetime-local" title="Show entries after this time"><input id="logLines" type="number" value="120" min="1" max="300"><label class="checkbox"><input id="logAutoRefresh" type="checkbox"> Auto</label><label class="checkbox"><input id="logFollow" type="checkbox"> Follow</label><button id="loadLogsBtn">Load logs</button><button id="downloadLogsBtn" class="secondary">Download</button><button id="clearLogsBtn" class="danger">Clear</button></div>
          <pre id="logs" class="log-view"></pre>
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
  <dialog id="sessionDetailDialog">
    <div id="sessionDetail"></div>
    <div class="row dialog-actions"><button id="closeSessionDetailBtn" class="secondary">Close</button></div>
  </dialog>
  <div id="toolTooltip" class="tool-tooltip"></div>
  <div id="toast"></div>
  <script>${dashboardJs()}</script>
</body>
</html>`;
}

function dashboardCss(): string {
  return `
:root{color-scheme:light;--bg:#f4f6f2;--surface:#ffffff;--surface-soft:#fbfcf8;--text:#18201b;--muted:#5d675f;--border:#dce3d9;--border-soft:#e7ede4;--sidebar:#17251d;--sidebar-text:#f4f8f2;--sidebar-muted:#aebcaf;--accent:#235c42;--accent-strong:#17452f;--accent-soft:#dff5e8;--warn:#fff7da;--danger:#9b1c1c;--pre:#111812;--pre-text:#f3f7ef;--shadow:0 8px 24px rgba(24,32,27,.04);--link:#1d6a4c}
:root[data-theme="dark"]{color-scheme:dark;--bg:#101411;--surface:#171d19;--surface-soft:#1d251f;--text:#edf4ee;--muted:#a7b3aa;--border:#2d3830;--border-soft:#263128;--sidebar:#0c120f;--sidebar-text:#edf7ef;--sidebar-muted:#8da091;--accent:#4fa876;--accent-strong:#64bd89;--accent-soft:#173d2a;--warn:#3b3216;--danger:#cc4b4b;--pre:#070a08;--pre-text:#e8f1ea;--shadow:0 10px 28px rgba(0,0,0,.22);--link:#75c99a}
.agent-settings-nav{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 12px;padding:10px;border:1px solid var(--border-soft);border-radius:8px;background:var(--surface)}.agent-settings-nav strong{font-size:13px;color:var(--muted);margin-right:4px}.agent-settings-nav button{background:var(--surface);color:var(--text);border-color:var(--border);height:32px}.agent-settings-nav button.active{background:var(--accent);color:white;border-color:var(--accent)}@media(max-width:560px){.agent-settings-nav{align-items:stretch}.agent-settings-nav button{width:100%}}
.drop-active{outline:2px dashed var(--accent);outline-offset:-8px}.chip{display:inline-flex;align-items:center;border-radius:999px;border:1px solid var(--border);padding:2px 8px;font-size:12px;color:var(--muted);margin-right:6px}.chip.error{color:var(--danger);border-color:var(--danger)}.chip.warn{color:#8a6a12;border-color:#d9c27a;background:var(--warn)}.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:12px}.artifact-card{border:1px solid var(--border-soft);border-radius:8px;padding:8px;background:var(--surface-soft);min-width:0}.artifact-card img{width:100%;aspect-ratio:1.4;object-fit:cover;border:1px solid var(--border);border-radius:6px;background:var(--surface)}.artifact-card small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.overview-adapter-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.session-detail-section{margin-top:20px}.session-detail-section summary{cursor:pointer;font-weight:700;margin-bottom:0}.session-detail-section[open] summary{margin-bottom:10px}.setting.dirty{border-color:var(--accent)}.setting-actions{display:flex;gap:8px;align-items:center;margin-top:8px}.setting-help{font-size:12px;color:var(--muted)}.restart-banner{border:1px solid #d9c27a;background:var(--warn);border-radius:8px;padding:10px;margin:0 0 12px}.task-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}.task-section-title{margin:18px 0 6px}.loading-state{display:flex;align-items:center;gap:10px;min-height:90px;color:var(--muted)}.spinner{width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.log-view{max-height:min(64vh,720px);min-height:320px}.log-line{display:block}.log-line.ERROR{color:var(--danger);font-weight:700}.log-line.WARN{color:#8a6a12;font-weight:700}.tool-tooltip{position:fixed;z-index:60;display:none;max-width:220px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--pre);color:var(--pre-text);font-size:12px;box-shadow:var(--shadow);pointer-events:none}.connection-ok{color:#1e754e;border-color:#8ed0aa}.connection-warn{color:#8a6a12;border-color:#d9c27a}.connection-error{color:var(--danger);border-color:var(--danger)}.version-actions{margin-bottom:12px}.version-update-title{margin-top:22px}.mini-button{height:26px;padding:0 8px;font-size:12px}.update-log{max-height:280px;min-height:90px;margin-top:10px}.update-job-header{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap}.update-input{display:grid;grid-template-columns:1fr auto auto;gap:8px;margin-top:8px}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif}.app{min-height:100vh;display:grid;grid-template-columns:260px 1fr}.sidebar{background:var(--sidebar);color:var(--sidebar-text);padding:18px;display:flex;flex-direction:column;gap:22px}.brand{display:flex;align-items:center;gap:12px}.mark{display:grid;place-items:center;width:38px;height:38px;border-radius:8px;background:#d7ffe5;color:#173d29;font-weight:800}.brand small{display:block;color:var(--sidebar-muted)}nav{display:flex;flex-direction:column;gap:6px}nav button,.menu{border:0;border-radius:6px;padding:10px 12px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}nav button.active,nav button:hover{background:color-mix(in srgb,var(--accent) 35%,transparent)}main{min-width:0;display:flex;flex-direction:column}header{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;gap:16px;align-items:center;padding:16px 22px;background:color-mix(in srgb,var(--surface) 92%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--border)}h1{font-size:24px;margin:0}h2{font-size:16px;margin:0 0 12px}p{margin:4px 0 0;color:var(--muted)}a{color:var(--link)}.header-actions,.row,.chat-toolbar,.attachment-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.menu{display:none;background:var(--surface-soft);color:var(--text)}.page{display:none;padding:22px}.page.active{display:block}.stack{display:flex;flex-direction:column;gap:16px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}.metric,.panel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;box-shadow:var(--shadow)}.metric .label{font-size:12px;text-transform:uppercase;color:var(--muted)}.metric .value{font-size:22px;font-weight:750;margin-top:4px;overflow:hidden;text-overflow:ellipsis}button,select,input,textarea{border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font:inherit}button{height:36px;padding:0 12px;background:var(--accent);color:white;border-color:var(--accent);cursor:pointer}button:hover{background:var(--accent-strong)}button.secondary{background:var(--surface);color:var(--text)}input,select{height:36px;padding:0 10px}textarea{width:100%;padding:10px;resize:vertical}.chat-layout{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:16px;align-items:start}.chat-panel{height:calc(100vh - 170px);min-height:520px;display:flex;flex-direction:column}.control-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:12px 0}.control-grid label,.form-grid label{display:grid;gap:5px;font-size:12px;color:var(--muted)}.messages{flex:1;min-height:0;overflow:auto;border:1px solid var(--border-soft);border-radius:8px;padding:12px;background:var(--surface-soft)}.message{margin:0 0 12px;padding:10px 12px;border-radius:8px;max-width:92%;white-space:pre-wrap;word-break:break-word}.message.user{margin-left:auto;background:var(--accent-soft)}.message.agent{background:color-mix(in srgb,var(--surface-soft) 80%,var(--border))}.message.system{background:var(--warn)}.composer{display:grid;grid-template-columns:1fr auto;gap:10px;margin-top:12px}.composer-fields{min-width:0}.composer button{height:auto;min-width:90px}.attachment-row{margin-top:8px;color:var(--muted);font-size:13px}.file-button{display:inline-flex;align-items:center;height:34px;padding:0 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);cursor:pointer}input[type=file]{display:none}.sessions-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.sessions-toolbar .search-row{flex:1 1 320px}.sessions-toolbar .attach-row{flex:1 1 360px;justify-content:flex-end;margin-left:auto}.sessions-toolbar input{min-width:220px}.copy-id{height:auto;padding:0;border:0;background:transparent;color:var(--link);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}.copy-id:hover{background:transparent;text-decoration:underline}.side-panel{max-height:calc(100vh - 126px);display:flex;flex-direction:column}.tool-stream{display:flex;flex-direction:column;gap:8px;overflow:auto;max-height:calc(100vh - 190px);padding-right:4px}.tool{border:1px solid var(--border-soft);border-radius:6px;padding:8px;background:var(--surface-soft);white-space:pre-wrap;word-break:break-word}.list{display:flex;flex-direction:column;gap:8px;margin-top:12px}.item{border:1px solid var(--border-soft);border-radius:8px;padding:12px;background:var(--surface-soft)}.item strong{display:block;overflow-wrap:anywhere}.item small{display:block;color:var(--muted);overflow-wrap:anywhere}.queue-item{cursor:grab}.queue-item.dragging{opacity:.55}.badge,.adapter-status{display:inline-flex;align-items:center;border:1px solid var(--border);border-radius:999px;padding:2px 8px;color:var(--muted);font-size:12px}.adapter-status{margin-left:6px;text-transform:capitalize}.adapter-status.enabled,.adapter-status.available{color:#1e754e;border-color:#8ed0aa;background:color-mix(in srgb,var(--accent-soft) 55%,transparent)}.adapter-status.disabled{color:var(--muted)}.adapter-status.planned{color:#8a6a12;border-color:#d9c27a;background:var(--warn)}.preview{margin-top:12px}.preview img{max-width:100%;border:1px solid var(--border);border-radius:8px;background:var(--surface)}.settings-grid{display:block}.setting{border:1px solid var(--border-soft);border-radius:8px;padding:12px;margin-bottom:10px;background:var(--surface-soft)}.setting label{display:block;font-size:13px;font-weight:700;margin-bottom:6px}.setting small{display:block;color:var(--muted);margin-top:6px}.setting input,.setting textarea,.setting select{width:100%}.setting-error{color:var(--danger);font-size:12px;margin-top:6px}.checkbox{display:inline-flex!important;grid-template-columns:auto 1fr!important;align-items:center;gap:8px}.checkbox input{height:auto;width:auto}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.tabs button{background:var(--surface);color:var(--text);border-color:var(--border);height:34px}.tabs button.active{background:var(--accent);color:white;border-color:var(--accent)}.pager{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px;color:var(--muted)}.pager-actions{display:flex;gap:8px}.pager button:disabled{opacity:.45;cursor:not-allowed}pre{white-space:pre-wrap;word-break:break-word;background:var(--pre);color:var(--pre-text);border-radius:8px;padding:14px;overflow:auto}footer{margin-top:auto;display:flex;gap:18px;flex-wrap:wrap;padding:14px 22px;border-top:1px solid var(--border);color:var(--muted);background:var(--surface)}dialog{border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);width:min(720px,calc(100vw - 28px));padding:18px;box-shadow:0 18px 70px rgba(0,0,0,.22)}dialog::backdrop{background:rgba(0,0,0,.35)}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.dialog-actions{justify-content:flex-end;margin-top:16px}#toast{position:fixed;right:18px;bottom:18px;display:none;background:var(--accent);color:white;border-radius:8px;padding:12px 14px;max-width:360px}.danger{background:var(--danger);border-color:var(--danger);color:white}@media(max-width:860px){.app{display:block}.sidebar{position:fixed;inset:0 auto 0 0;width:270px;transform:translateX(-100%);transition:.18s transform;z-index:20}.sidebar.open{transform:translateX(0)}.menu{display:inline-block}.header-actions{justify-content:flex-end}.page{padding:14px}.overview-adapter-grid{grid-template-columns:1fr}.chat-layout{grid-template-columns:1fr}.chat-panel{height:auto;min-height:0}.messages{max-height:55vh;min-height:300px}.composer{grid-template-columns:1fr}.composer button{height:40px}.side-panel{order:-1;max-height:360px}.tool-stream{max-height:300px}header{align-items:flex-start}.metrics{grid-template-columns:1fr 1fr}}@media(max-width:560px){.metrics{grid-template-columns:1fr}.row{align-items:stretch}.row>*{width:100%}header{display:grid;grid-template-columns:auto 1fr}.header-actions{grid-column:1/3}.message{max-width:100%}.pager{align-items:stretch}.pager-actions,.pager button{width:100%}.attachment-row>*,.sessions-toolbar,.sessions-toolbar .row,.sessions-toolbar input,.sessions-toolbar button{width:100%}.sessions-toolbar .attach-row{margin-left:0;justify-content:stretch}}
`;
}

function dashboardJs(): string {
  return `
const token = localStorage.getItem('nordrelayDashboardToken') || '';
const state = { snapshot:null, controls:null, newSessionControls:null, enabledAgents:[], settings:[], currentPage:'overview', settingsGroup:null, logsPlain:'', logTimer:null, toastTimer:null, cliStatusActive:false, selectedArtifactTurns:new Set(), mediaRecorder:null, recordedChunks:[], events:null, reconnectTimer:null, notifications:false, toolTooltipTimer:null, toolTooltipTarget:null, agentUpdateJobs:[] };
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
async function copyText(text,label='Copied'){if(!text)return;try{await navigator.clipboard.writeText(text)}catch{const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();document.execCommand('copy');area.remove()}toast(label)}
function fmtDate(s){return s?new Date(s).toLocaleString(): '-'}
function fmtDuration(ms){if(!ms&&ms!==0)return '-';const sec=Math.round(ms/1000);if(sec<60)return sec+'s';return Math.floor(sec/60)+'m '+(sec%60)+'s'}
function fmtBytes(n){if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1).replace(/\\.0$/,'')+' KB';return (n/1048576).toFixed(1).replace(/\\.0$/,'')+' MB'}
function compactNum(n){if(!n)return'';if(n>=1000000000)return Math.round(n/100000000)/10+'B';if(n>=1000000)return Math.round(n/100000)/10+'M';if(n>=1000)return Math.round(n/100)/10+'K';return String(n)}
function loadingHtml(label){return '<div class="loading-state"><span class="spinner"></span><span>'+esc(label||'Loading...')+'</span></div>'}
function setLoading(id,label){const el=document.getElementById(id);if(el)el.innerHTML=loadingHtml(label)}
function modelLabel(m){const meta=[m.contextWindow?compactNum(m.contextWindow):'',m.supportsImages===true?'img':m.supportsImages===false?'text':'',m.supportsThinking===true?'think':''].filter(Boolean).join(' ');return (m.displayName||m.slug)+(meta?' · '+meta:'')}
function fmtAge(ms){const sec=Math.max(0,Math.floor(ms/1000));if(sec<60)return sec+'s ago';const min=Math.floor(sec/60);if(min<60)return min+'m ago';return Math.floor(min/60)+'h ago'}
function isCliRunningStatus(msg){return / CLI running\\b/.test(String(msg||''))}
function isCliDoneStatus(msg){return / CLI task\\b/.test(String(msg||''))}
function applyTheme(theme){document.documentElement.dataset.theme=theme;localStorage.setItem('nordrelayTheme',theme);document.getElementById('themeBtn').textContent=theme==='dark'?'Light':'Dark'}
function toggleTheme(){applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark')}
function page(name){state.currentPage=name;document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===name));document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+name));document.getElementById('pageTitle').textContent=name[0].toUpperCase()+name.slice(1);document.getElementById('sidebar').classList.remove('open'); void reloadCurrentPage().catch(err=>toast(err.message||String(err)));}
async function reloadCurrentPage(){const name=state.currentPage;if(name==='chat'){await loadChatHistory();scrollChatToBottom()} if(name==='sessions') await loadSessions(); if(name==='settings') await loadSettings(); if(name==='logs') await loadLogs(); if(name==='diagnostics') await loadDiagnostics(); if(name==='artifacts') await loadArtifacts(); if(name==='activity') await loadActivity(); if(name==='tasks') await loadTasks(); if(name==='adapters') await loadAdapterHealth(); if(name==='access') await loadAccess(); if(name==='version') await loadVersion();}
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
  agentSelect.onchange=()=>safe(async()=>{await api('/api/agent',{method:'POST',body:JSON.stringify({agentId:agentSelect.value})});toast('Agent switched');await loadBootstrap();await reloadCurrentPage()});
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
  const channelCards=(channels||[]).map(c=>adapterCard(c.label,c.status,'',c.capabilities.join(', ')));
  const agentCards=(agents||[]).map(a=>{const available=a.status==='available';const status=available?(state.enabledAgents.includes(a.id)?'enabled':'disabled'):(a.status||'planned');return adapterCard(a.label,status,'',a.notes||'')});
  document.getElementById('agentAdapters').innerHTML='<div class="list">'+(agentCards.join('')||'<div class="item">No agent adapters.</div>')+'</div>';
  document.getElementById('chatAdapters').innerHTML='<div class="list">'+(channelCards.join('')||'<div class="item">No chat adapters.</div>')+'</div>';
}
function adapterCard(label,status,detail,tooltip=''){return '<div class="item"><strong title="'+attr(tooltip)+'">'+esc(label)+' <span class="adapter-status '+esc(status)+'">'+esc(status)+'</span></strong>'+(detail?'<small>'+esc(detail)+'</small>':'')+'</div>'}
function versionStatusLabel(status){if(status==='current')return'Latest';if(status==='outdated')return'Outdated';if(status==='not-installed')return'Not installed';return'Unknown'}
function versionStatusClass(status){if(status==='current')return'available';if(status==='outdated')return'planned';return'disabled'}
function jobStatusClass(status){if(status==='completed')return'available';if(status==='running')return'planned';return'disabled'}
function scrollChatToBottom(){const box=document.getElementById('messages');if(!box)return;requestAnimationFrame(()=>{box.scrollTop=box.scrollHeight;requestAnimationFrame(()=>{box.scrollTop=box.scrollHeight})})}
function appendMessage(cls,text){const box=document.getElementById('messages');const div=document.createElement('div');div.className='message '+cls;div.textContent=text;box.appendChild(div);scrollChatToBottom();return div}
function appendQueuedMessage(id){const div=appendMessage('system','Queued prompt '+id);const btn=document.createElement('button');btn.textContent='Cancel queued message';btn.className='danger';btn.onclick=()=>safe(async()=>{const r=await api('/api/queue',{method:'POST',body:JSON.stringify({action:'cancel',id})});renderQueue(r.queue,r.paused);div.textContent='Cancelled queued prompt '+id});div.appendChild(document.createElement('br'));div.appendChild(btn)}
function renderChatMessages(messages){state.chatMessages=messages||[];const box=document.getElementById('messages');box.innerHTML=(messages||[]).map(m=>'<div class="message '+esc(m.role)+'"><small>'+esc((m.source||'web')+' / '+fmtDate(m.timestamp))+'</small>\\n'+esc(m.text)+'</div>').join('');scrollChatToBottom()}
async function loadChatHistory(){const data=await api('/api/chat/history');renderChatMessages(data.messages||[])}
let currentAgentMessage=null;
function connectEvents(){
  if(state.events) state.events.close();
  const qs = token ? '?token='+encodeURIComponent(token) : '';
  const events = new EventSource('/api/events'+qs);
  state.events=events;
  setConnection('Connecting','warn');
  events.onopen=()=>{if(state.reconnectTimer){clearTimeout(state.reconnectTimer);state.reconnectTimer=null}setConnection('Live','ok')};
  events.addEventListener('snapshot', e=>{const d=JSON.parse(e.data).data;state.snapshot=d;renderSnapshot(d);renderSessionControls()});
  events.addEventListener('chat_history', e=>renderChatMessages(JSON.parse(e.data).messages||[]));
  events.addEventListener('activity_update', e=>renderActivity(JSON.parse(e.data).events||[]));
  events.addEventListener('session_update', e=>{loadBootstrap();loadChatHistory()});
  events.addEventListener('agent_update', e=>{const d=JSON.parse(e.data);upsertAgentUpdateJob(d.job);if(state.currentPage==='version'){renderAgentUpdateJobs();if(d.job&&d.job.status!=='running')setTimeout(loadVersion,800)}});
  events.addEventListener('queue_update', e=>{const d=JSON.parse(e.data);renderQueue(d.queue,d.paused)});
  events.addEventListener('turn_start', e=>{const d=JSON.parse(e.data);appendMessage('user',d.prompt);currentAgentMessage=appendMessage('agent','');if(state.currentPage==='tasks')loadTasks()});
  events.addEventListener('text_delta', e=>{const d=JSON.parse(e.data);if(!currentAgentMessage)currentAgentMessage=appendMessage('agent','');currentAgentMessage.textContent+=d.delta;scrollChatToBottom();if(state.currentPage==='tasks')loadTasks()});
  events.addEventListener('tool_start', e=>{const d=JSON.parse(e.data);tool('tool','Started '+d.toolName);if(state.currentPage==='tasks')loadTasks()});
  events.addEventListener('tool_update', e=>{const d=JSON.parse(e.data);if(d.partialResult)tool('tool',d.partialResult.slice(-600))});
  events.addEventListener('tool_end', e=>{const d=JSON.parse(e.data);tool(d.isError?'danger':'tool','Finished '+d.toolCallId+(d.isError?' with error':''))});
  events.addEventListener('todo_update', e=>{const d=JSON.parse(e.data);tool('tool','Plan:\\n'+d.items.map(i=>(i.completed?'[x] ':'[ ] ')+i.text).join('\\n'))});
  events.addEventListener('turn_error', e=>{const d=JSON.parse(e.data);appendMessage('system','Error: '+d.error);currentAgentMessage=null});
  events.addEventListener('turn_complete', ()=>{currentAgentMessage=null;notify('NordRelay turn finished','The active task completed.');loadBootstrap();if(state.currentPage==='tasks')loadTasks()});
  events.addEventListener('status', e=>{const d=JSON.parse(e.data);const msg=d.message||'';if(isCliRunningStatus(msg)){state.cliStatusActive=true;toast(msg,{sticky:true});return}if(isCliDoneStatus(msg))state.cliStatusActive=false;toast(msg)});
  events.onerror=()=>{setConnection('Reconnecting','error');if(!state.reconnectTimer)state.reconnectTimer=setTimeout(()=>{state.reconnectTimer=null;connectEvents()},5000)};
}
function setConnection(text,kind){const el=document.getElementById('connectionStatus');el.textContent=text;el.className='badge connection-'+kind}
async function enableNotifications(){if(!('Notification' in window)){toast('Browser notifications are not supported');return}const permission=Notification.permission==='granted'?'granted':await Notification.requestPermission();state.notifications=permission==='granted';toast(state.notifications?'Browser notifications enabled':'Browser notifications denied')}
function notify(title,body){if(state.notifications&&'Notification' in window&&Notification.permission==='granted')new Notification(title,{body})}
function toolAgeText(el){const created=Number(el.dataset.createdAt||Date.now());return 'Updated '+fmtAge(Date.now()-created)}
function refreshToolTooltip(){const tip=document.getElementById('toolTooltip');if(tip&&state.toolTooltipTarget)tip.textContent=toolAgeText(state.toolTooltipTarget)}
function positionToolTooltip(event){const tip=document.getElementById('toolTooltip');if(!tip||tip.style.display==='none')return;const gap=12;const rect=tip.getBoundingClientRect();let x=event.clientX+gap;let y=event.clientY+gap;if(x+rect.width>window.innerWidth-8)x=event.clientX-rect.width-gap;if(y+rect.height>window.innerHeight-8)y=event.clientY-rect.height-gap;tip.style.left=Math.max(8,x)+'px';tip.style.top=Math.max(8,y)+'px'}
function showToolTooltip(target,event){state.toolTooltipTarget=target;const tip=document.getElementById('toolTooltip');if(!tip)return;refreshToolTooltip();tip.style.display='block';positionToolTooltip(event);if(state.toolTooltipTimer)clearInterval(state.toolTooltipTimer);state.toolTooltipTimer=setInterval(refreshToolTooltip,1000)}
function hideToolTooltip(){const tip=document.getElementById('toolTooltip');if(tip)tip.style.display='none';state.toolTooltipTarget=null;if(state.toolTooltipTimer)clearInterval(state.toolTooltipTimer);state.toolTooltipTimer=null}
function updateToolAgeTitles(){document.querySelectorAll('.tool[data-created-at]').forEach(el=>el.setAttribute('aria-label',toolAgeText(el)))}
const toolStreamEl=document.getElementById('toolStream');
toolStreamEl.addEventListener('mouseover',e=>{const target=e.target.closest?.('.tool[data-created-at]');if(target&&target!==state.toolTooltipTarget)showToolTooltip(target,e)});
toolStreamEl.addEventListener('mousemove',e=>positionToolTooltip(e));
toolStreamEl.addEventListener('mouseout',e=>{const target=e.target.closest?.('.tool[data-created-at]');if(target&&!target.contains(e.relatedTarget))hideToolTooltip()});
toolStreamEl.addEventListener('focusin',e=>{const target=e.target.closest?.('.tool[data-created-at]');if(target)showToolTooltip(target,{clientX:target.getBoundingClientRect().left,clientY:target.getBoundingClientRect().bottom})});
toolStreamEl.addEventListener('focusout',hideToolTooltip);
function tool(cls,text){const div=document.createElement('div');div.className='tool '+(cls==='danger'?'danger':'');div.dataset.createdAt=String(Date.now());div.tabIndex=0;div.textContent=text;document.getElementById('toolStream').prepend(div);updateToolAgeTitles()}
setInterval(updateToolAgeTitles,30000);
let selectedFiles=[];
function renderSelectedFiles(){const summary=document.getElementById('fileSummary');if(selectedFiles.length===0){summary.textContent='No files selected';return}const names=selectedFiles.slice(0,3).map(f=>f.name || 'file').join(', ');const more=selectedFiles.length>3?' +'+(selectedFiles.length-3)+' more':'';const bytes=selectedFiles.reduce((sum,file)=>sum+file.size,0);summary.textContent=names+more+' ('+fmtBytes(bytes)+')'}
function addFiles(files){selectedFiles=selectedFiles.concat(Array.from(files||[]));renderSelectedFiles()}
async function filePayload(file){return {name:file.name || 'upload',mimeType:file.type || 'application/octet-stream',dataBase64:await fileToBase64(file)}}
async function fileToBase64(file){const buffer=await file.arrayBuffer();const bytes=new Uint8Array(buffer);let binary='';const chunk=0x8000;for(let i=0;i<bytes.length;i+=chunk){binary+=String.fromCharCode(...bytes.subarray(i,i+chunk))}return btoa(binary)}
document.getElementById('fileInput').onchange=e=>{addFiles(e.target.files)};
document.getElementById('clearFilesBtn').onclick=()=>{selectedFiles=[];document.getElementById('fileInput').value='';renderSelectedFiles()};
document.addEventListener('paste',e=>{const files=Array.from(e.clipboardData?.files||[]);if(files.length){addFiles(files);toast('Pasted '+files.length+' file(s)')}});
document.addEventListener('dragover',e=>{e.preventDefault();document.body.classList.add('drop-active')});
document.addEventListener('dragleave',()=>document.body.classList.remove('drop-active'));
document.addEventListener('drop',e=>{e.preventDefault();document.body.classList.remove('drop-active');const files=Array.from(e.dataTransfer?.files||[]);if(files.length){addFiles(files);toast('Added '+files.length+' dropped file(s)')}});
document.getElementById('promptForm').onsubmit=e=>safe(async()=>{e.preventDefault();const input=document.getElementById('promptInput');const text=input.value.trim();if(!text&&selectedFiles.length===0)return;const files=selectedFiles;input.value='';selectedFiles=[];document.getElementById('fileInput').value='';renderSelectedFiles();const payloadFiles=files.length?await Promise.all(files.map(filePayload)):[];const r=files.length?await api('/api/prompt/upload',{method:'POST',body:JSON.stringify({text,files:payloadFiles})}):await api('/api/prompt',{method:'POST',body:JSON.stringify({text})});if(r.transcribeOnly)appendMessage('system','Transcribed audio:\\n'+(r.transcript||'(empty)'));else if(r.queued)appendQueuedMessage(r.queueId)},e);
document.getElementById('newSessionBtn').onclick=()=>openNewSessionDialog();
document.getElementById('retryBtn').onclick=()=>safe(async()=>{const r=await api('/api/retry',{method:'POST'});toast(r.queued?'Retry queued '+r.queueId:'Retry started')});
document.getElementById('editLastBtn').onclick=()=>{const last=[...(state.chatMessages||[])].reverse().find(m=>m.role==='user');if(last){document.getElementById('promptInput').value=last.text;document.getElementById('promptInput').focus()}else toast('No user prompt found')};
document.getElementById('syncBtn').onclick=()=>safe(async()=>{const r=await api('/api/sync',{method:'POST'});toast(r.changed?'Synced: '+(r.changedFields||[]).join(', '):'Already in sync');loadBootstrap()});
document.getElementById('notifyBtn').onclick=()=>enableNotifications();
document.getElementById('clearChatBtn').onclick=()=>safe(async()=>{if(confirm('Clear chat history for the current thread?')){const r=await api('/api/chat/history',{method:'DELETE'});renderChatMessages(r.messages||[]);toast('Removed '+r.removed+' messages')}});
document.getElementById('abortBtn').onclick=()=>safe(async()=>{await api('/api/abort',{method:'POST'});toast('Abort sent')});
document.getElementById('handbackBtn').onclick=()=>safe(async()=>{const r=await api('/api/handback',{method:'POST'});appendMessage('system','Handback command:\\n'+(r.command||'No command available'))});
document.getElementById('recordBtn').onclick=()=>safe(async()=>{const btn=document.getElementById('recordBtn');if(state.mediaRecorder&&state.mediaRecorder.state==='recording'){state.mediaRecorder.stop();btn.textContent='Record voice';return}const stream=await navigator.mediaDevices.getUserMedia({audio:true});state.recordedChunks=[];state.mediaRecorder=new MediaRecorder(stream);state.mediaRecorder.ondataavailable=e=>{if(e.data.size>0)state.recordedChunks.push(e.data)};state.mediaRecorder.onstop=()=>{stream.getTracks().forEach(t=>t.stop());const blob=new Blob(state.recordedChunks,{type:'audio/webm'});addFiles([new File([blob],'voice-note.webm',{type:'audio/webm'})]);toast('Voice note attached')};state.mediaRecorder.start();btn.textContent='Stop recording'});
function renderNewSessionControls(c){const s=state.snapshot?.session||{};const caps=c.capabilities||{};document.getElementById('workspaceOptions').innerHTML=(c.workspaces||[]).map(w=>'<option value="'+attr(w)+'"></option>').join('');document.getElementById('newModel').innerHTML='<option value="">Default</option>'+((c.models||[]).map(m=>'<option value="'+attr(m.slug)+'">'+esc(modelLabel(m))+'</option>').join(''));document.getElementById('newModel').parentElement.style.display=caps.modelSelection?'grid':'none';const reasoningWrap=document.getElementById('newReasoningWrap');reasoningWrap.firstChild.nodeValue=(c.reasoningLabel||'Reasoning');reasoningWrap.style.display=caps.reasoningSelection?'grid':'none';document.getElementById('newReasoning').innerHTML='<option value="">Default</option>'+((c.reasoningOptions||[]).map(v=>'<option value="'+attr(v)+'">'+esc(v)+'</option>').join(''));document.getElementById('newLaunch').innerHTML='<option value="">Default</option>'+((c.launchProfiles||[]).map(p=>'<option value="'+attr(p.id)+'">'+esc(p.label+' - '+p.behavior)+'</option>').join(''));document.getElementById('newFast').checked=Boolean(s.fastMode&&caps.fastMode);document.getElementById('newLaunchWrap').style.display=caps.launchProfiles?'grid':'none';document.getElementById('newFastWrap').style.display=caps.fastMode?'inline-flex':'none'}
function populateNewSessionForm(agents){const s=state.snapshot?.session||{};const agentSelect=document.getElementById('newAgent');agentSelect.innerHTML=(agents||[]).map(a=>'<option value="'+attr(a)+'" '+(a===s.agentId?'selected':'')+'>'+esc(a)+'</option>').join('');agentSelect.value=s.agentId||agentSelect.value;document.getElementById('newWorkspace').value=s.workspace||'';state.newSessionControls=state.controls||{};renderNewSessionControls(state.newSessionControls);agentSelect.onchange=()=>safe(async()=>{state.newSessionControls=await api('/api/control-options?agent='+encodeURIComponent(agentSelect.value));renderNewSessionControls(state.newSessionControls)})}
function openNewSessionDialog(){populateNewSessionForm(state.enabledAgents);document.getElementById('newSessionDialog').showModal()}
document.getElementById('newSessionForm').onsubmit=e=>safe(async()=>{e.preventDefault();const payload={agentId:val('newAgent'),workspace:val('newWorkspace')||undefined,model:val('newModel')||undefined,reasoningEffort:val('newReasoning')||undefined,launchProfileId:val('newLaunch')||undefined,fastMode:document.getElementById('newFast').checked};await api('/api/sessions/new',{method:'POST',body:JSON.stringify(payload)});document.getElementById('newSessionDialog').close();toast('New session started');await loadBootstrap();await loadChatHistory()},e);
document.getElementById('cancelSessionBtn').onclick=()=>document.getElementById('newSessionDialog').close();
function val(id){return document.getElementById(id).value.trim()}
async function loadSessions(reset=true){if(reset)sessionsPager.reset();setLoading('sessionsList','Loading sessions...');const q=document.getElementById('sessionSearch').value||'';const data=await api('/api/sessions?query='+encodeURIComponent(q)+'&page='+sessionsPager.page+'&limit='+sessionsPager.pageSize);document.getElementById('sessionsList').innerHTML=data.sessions.map(s=>'<div class="item"><strong title="'+attr(s.title||s.firstUserMessage||s.id)+'">'+esc(short(s.title||s.firstUserMessage||s.id))+'</strong><small><button type="button" class="copy-id" data-copy-id="'+attr(s.id)+'" title="Copy thread ID">'+esc(short(s.id,64))+'</button> / '+esc(short((s.cwd||'')+' / '+fmtDate(s.updatedAt)))+'</small><div class="row"><button data-switch="'+attr(s.id)+'">Switch</button><button class="secondary" data-session-detail="'+attr(s.id)+'">Details</button></div></div>').join('')||'<div class="item">No sessions found.</div>';sessionsPager.render(data.pagination||{});document.querySelectorAll('[data-copy-id]').forEach(b=>b.onclick=()=>copyText(b.dataset.copyId||'','Thread ID copied'));document.querySelectorAll('[data-switch]').forEach(b=>b.onclick=()=>safe(async()=>{await api('/api/sessions/switch',{method:'POST',body:JSON.stringify({threadId:b.dataset.switch})});toast('Session switched');loadBootstrap()}));document.querySelectorAll('[data-session-detail]').forEach(b=>b.onclick=()=>safe(()=>loadSessionDetail(b.dataset.sessionDetail)))}
function usageRows(rows){return (rows||[]).map(row=>{if(Array.isArray(row))return [row[0],row[1]];const text=String(row);const index=text.indexOf(':');return index>0?[text.slice(0,index),text.slice(index+1).trim()]:[text,'']})}
function detailSection(title,count,body){return '<details class="session-detail-section"><summary>'+esc(title+' ('+count+')')+'</summary><div class="list">'+(body||'<div class="item">No entries.</div>')+'</div></details>'}
async function loadSessionDetail(threadId){const d=await api('/api/sessions/detail?threadId='+encodeURIComponent(threadId));const r=d.record||{};const messages=d.messages||[];const activity=d.activity||[];const metadataRows=[['Thread',threadId],['Agent',r.agentId],['Title',r.title],['Workspace',r.cwd],['Model',r.model],['Reasoning',r.reasoningEffort],['Updated',fmtDate(r.updatedAt)],['Path',r.sessionPath]].concat(usageRows(d.usageRows));const messageItems=messages.slice(-20).map(m=>'<div class="item"><strong>'+esc(m.role+' / '+fmtDate(m.timestamp))+'</strong><small>'+esc(short(m.text,500))+'</small></div>').join('');const activityItems=activity.map(e=>'<div class="item"><strong>'+esc(e.status+' / '+e.type+' / '+fmtDate(e.timestamp))+'</strong><small>'+esc(short(e.prompt||e.detail||'',300))+'</small></div>').join('');document.getElementById('sessionDetail').innerHTML='<h2>Session detail</h2>'+card('Metadata',metadataRows)+detailSection('Recent messages',messages.length,messageItems)+detailSection('Activity',activity.length,activityItems);document.getElementById('sessionDetailDialog').showModal()}
document.getElementById('closeSessionDetailBtn').onclick=()=>document.getElementById('sessionDetailDialog').close();
document.getElementById('sessionSearchBtn').onclick=()=>loadSessions(true);document.getElementById('sessionSearch').addEventListener('keydown',e=>{if(e.key==='Enter')loadSessions(true)});document.getElementById('attachBtn').onclick=async()=>{const threadId=document.getElementById('attachInput').value.trim();if(threadId){await api('/api/sessions/attach',{method:'POST',body:JSON.stringify({threadId})});toast('Session attached');loadBootstrap()}};
function renderQueue(queue,paused){document.getElementById('queueStatus').textContent=paused?'Paused':'Running';document.getElementById('queueList').innerHTML=(queue||[]).map((q,i)=>'<div class="item queue-item" draggable="true" data-queue-id="'+attr(q.id)+'"><strong>'+esc((i+1)+'. '+q.id+' - '+q.description)+'</strong><small>Created '+fmtDate(q.createdAt)+' / attempts '+q.attempts+(q.lastError?' / '+esc(q.lastError):'')+'</small><div class="row"><button data-q="run" data-id="'+q.id+'">Run</button><button data-q="top" data-id="'+q.id+'">Top</button><button data-q="up" data-id="'+q.id+'">Up</button><button data-q="down" data-id="'+q.id+'">Down</button><button data-q="cancel" data-id="'+q.id+'" class="danger">Cancel</button></div></div>').join('')||'<div class="item">Queue is empty.</div>';document.querySelectorAll('[data-q]').forEach(b=>b.onclick=()=>safe(async()=>{const r=await api('/api/queue',{method:'POST',body:JSON.stringify({action:b.dataset.q,id:b.dataset.id})});renderQueue(r.queue,r.paused)}));let dragged=null;document.querySelectorAll('.queue-item').forEach(item=>{item.ondragstart=()=>{dragged=item.dataset.queueId;item.classList.add('dragging')};item.ondragend=()=>item.classList.remove('dragging');item.ondragover=e=>e.preventDefault();item.ondrop=()=>safe(async()=>{if(dragged&&dragged!==item.dataset.queueId){const ids=Array.from(document.querySelectorAll('.queue-item')).map(el=>el.dataset.queueId);const targetIndex=Math.max(0,ids.indexOf(item.dataset.queueId));await api('/api/queue',{method:'POST',body:JSON.stringify({action:'top',id:dragged})});for(let i=0;i<targetIndex;i++)await api('/api/queue',{method:'POST',body:JSON.stringify({action:'down',id:dragged})});const r=await api('/api/queue');renderQueue(r.queue,r.paused)}})})}
document.querySelectorAll('[data-queue]').forEach(b=>b.onclick=()=>safe(async()=>{const r=await api('/api/queue',{method:'POST',body:JSON.stringify({action:b.dataset.queue})});renderQueue(r.queue,r.paused)}));
async function loadTasks(){setLoading('tasksList','Loading tasks...');const d=await api('/api/tasks');renderTasks(d)}
function taskCard(t,title){if(!t)return '<div class="item"><strong>'+esc(title)+'</strong><small>Idle</small></div>';const tools=(t.tools||[]).map(x=>x.name+' x'+x.count).join(', ')||'-';return '<div class="item"><strong>'+esc(title+' · '+t.status)+'</strong><small>'+esc((t.agentLabel||t.agentId||t.source)+' / '+(t.threadId||'-'))+'</small><small>'+esc('Elapsed '+fmtDuration(t.durationMs)+' / current '+(t.currentTool||'-')+' / last '+(t.lastTool||'-'))+'</small><small>'+esc('Tools: '+tools+' / output chars '+(t.outputChars||0))+'</small><small>'+esc(t.prompt||t.detail||'')+'</small></div>'}
function renderTasks(d){document.getElementById('tasksList').innerHTML='<div class="task-grid">'+taskCard(d.current,'Current web turn')+taskCard(d.external,'External CLI turn')+'</div><h2 class="task-section-title">Queue</h2><div class="list">'+((d.queue||[]).map(q=>'<div class="item"><strong>'+esc(q.id+' · '+q.description)+'</strong><small>'+esc(fmtDate(q.createdAt)+' / attempts '+q.attempts)+'</small><div class="row"><button data-q="run" data-id="'+attr(q.id)+'">Run</button><button data-q="cancel" data-id="'+attr(q.id)+'" class="danger">Cancel</button></div></div>').join('')||'<div class="item">Queue is empty.</div>')+'</div><h2 class="task-section-title">Recent turns</h2><div class="list">'+((d.recent||[]).map(e=>'<div class="item"><strong>'+esc(e.status+' / '+e.source+' / '+e.type)+'</strong><small>'+esc(fmtDate(e.timestamp)+' / '+(e.threadId||'-'))+'</small><small>'+esc(short(e.prompt||e.detail||'',300))+'</small></div>').join('')||'<div class="item">No recent tasks.</div>')+'</div>';document.querySelectorAll('#tasksList [data-q]').forEach(b=>b.onclick=()=>safe(async()=>{const r=await api('/api/queue',{method:'POST',body:JSON.stringify({action:b.dataset.q,id:b.dataset.id})});renderQueue(r.queue,r.paused);loadTasks()}))}
document.getElementById('reloadTasksBtn').onclick=()=>loadTasks();
async function loadArtifacts(){setLoading('artifactList','Loading artifacts...');document.getElementById('artifactPreview').innerHTML='';const data=await api('/api/artifacts');state.artifactReports=data.reports||[];renderArtifacts()}
function artifactMatches(a,kind,query){const name=(a.name||a.relativePath||'').toLowerCase();if(query&&!name.includes(query))return false;if(kind==='images')return /\\.(png|jpe?g|gif|webp|svg)$/i.test(name);if(kind==='docs')return !/\\.(png|jpe?g|gif|webp|svg)$/i.test(name);return true}
function renderArtifacts(){const query=(document.getElementById('artifactSearch').value||'').toLowerCase();const kind=document.getElementById('artifactKind').value;const reports=state.artifactReports||[];document.getElementById('artifactList').innerHTML=reports.map(r=>{const files=(r.artifacts||[]).filter(a=>artifactMatches(a,kind,query));if(files.length===0)return'';const gallery=files.map(a=>{const href='/api/artifacts/file?turnId='+encodeURIComponent(r.turnId)+'&path='+encodeURIComponent(a.relativePath)+(token?'&token='+encodeURIComponent(token):'');const img=/\\.(png|jpe?g|gif|webp|svg)$/i.test(a.name)?'<img src="'+href+'">':'<pre>'+esc(a.name.split('.').pop()||'file')+'</pre>';return '<div class="artifact-card"><label><input type="checkbox" data-artifact-select="'+attr(r.turnId)+'" '+(state.selectedArtifactTurns.has(r.turnId)?'checked':'')+'> '+esc(short(a.name,32))+'</label>'+img+'<small>'+esc(fmtBytes(a.sizeBytes))+'</small><div class="row"><a href="'+href+'">Open</a><button class="secondary" data-preview-turn="'+attr(r.turnId)+'" data-preview-path="'+attr(a.relativePath)+'">Preview</button></div></div>'}).join('');return '<div class="item"><strong>'+esc(r.turnId)+' - '+files.length+'/'+r.fileCount+' files - '+fmtBytes(r.totalSizeBytes)+'</strong><small>'+fmtDate(r.updatedAt)+' / '+esc(r.source||'turn')+'</small><div class="row"><a href="/api/artifacts/zip?turnId='+encodeURIComponent(r.turnId)+(token?'&token='+encodeURIComponent(token):'')+'">Download ZIP</a><button data-del-art="'+esc(r.turnId)+'" class="danger">Delete</button></div><div class="gallery">'+gallery+'</div></div>'}).join('')||'<div class="item">No artifacts.</div>';document.querySelectorAll('[data-artifact-select]').forEach(c=>c.onchange=()=>{if(c.checked)state.selectedArtifactTurns.add(c.dataset.artifactSelect);else state.selectedArtifactTurns.delete(c.dataset.artifactSelect)});document.querySelectorAll('[data-del-art]').forEach(b=>b.onclick=()=>safe(async()=>{if(confirm('Delete artifact turn '+b.dataset.delArt+'?')){await api('/api/artifacts?turnId='+encodeURIComponent(b.dataset.delArt),{method:'DELETE'});state.selectedArtifactTurns.delete(b.dataset.delArt);loadArtifacts()}}));document.querySelectorAll('[data-preview-turn]').forEach(b=>b.onclick=()=>safe(()=>previewArtifact(b.dataset.previewTurn,b.dataset.previewPath)))}
document.getElementById('reloadArtifactsBtn').onclick=loadArtifacts;
document.getElementById('artifactSearch').oninput=renderArtifacts;
document.getElementById('artifactKind').onchange=renderArtifacts;
document.getElementById('zipSelectedArtifactsBtn').onclick=()=>{const turnIds=[...state.selectedArtifactTurns];if(turnIds.length===0){toast('No artifact turns selected');return}turnIds.forEach(turnId=>window.open('/api/artifacts/zip?turnId='+encodeURIComponent(turnId)+(token?'&token='+encodeURIComponent(token):''),'_blank'))};
document.getElementById('deleteSelectedArtifactsBtn').onclick=()=>safe(async()=>{const turnIds=[...state.selectedArtifactTurns];if(turnIds.length===0){toast('No artifact turns selected');return}if(confirm('Delete '+turnIds.length+' selected artifact turn(s)?')){const r=await api('/api/artifacts/bulk',{method:'POST',body:JSON.stringify({action:'delete',turnIds})});state.selectedArtifactTurns.clear();toast('Deleted '+(r.removed||[]).length+' artifact turn(s)');loadArtifacts()}});
function highlightCode(text){return esc(text).replace(/\\b(import|export|const|let|function|return|if|else|for|while|class|interface|type|async|await)\\b/g,'<span class="chip">$1</span>')}
async function previewArtifact(turnId,path){const target=document.getElementById('artifactPreview');target.innerHTML='<div class="panel">'+loadingHtml('Loading preview...')+'</div>';target.scrollIntoView({block:'start',behavior:'smooth'});try{const data=await api('/api/artifacts/preview?turnId='+encodeURIComponent(turnId)+'&path='+encodeURIComponent(path));if(data.kind==='image'){target.innerHTML='<div class="panel"><h2>'+esc(data.name)+'</h2><img src="/api/artifacts/file?turnId='+encodeURIComponent(turnId)+'&path='+encodeURIComponent(path)+(token?'&token='+encodeURIComponent(token):'')+'"></div>';return}if(data.kind==='text'){target.innerHTML='<div class="panel"><h2>'+esc(data.name)+' '+fmtBytes(data.sizeBytes)+'</h2><pre>'+highlightCode(data.text||'')+'</pre>'+(data.truncated?'<small>Preview truncated.</small>':'')+'</div>';return}target.innerHTML='<div class="panel"><h2>'+esc(data.name)+'</h2><p>'+esc(data.detail||'Preview unavailable')+'</p></div>'}catch(err){target.innerHTML='<div class="panel"><h2>Preview failed</h2><p>'+esc(err.message||String(err))+'</p></div>';throw err}}
async function loadActivity(){setLoading('activityList','Loading activity...');const q='?source='+encodeURIComponent(val('activitySource'))+'&status='+encodeURIComponent(val('activityStatus'))+'&limit='+encodeURIComponent(val('activityLimit')||'100');const data=await api('/api/activity'+q);state.activityEvents=data.events||[];renderActivity(state.activityEvents)}
function activityWorkspace(e){const active=state.snapshot?.session;return e.workspace||(active?.threadId&&e.threadId===active.threadId?active.workspace:'')}
function activityMetaHtml(e){const workspace=activityWorkspace(e);const duration=typeof e.durationMs==='number'?fmtDuration(e.durationMs):'';const parts=[];if(e.threadId)parts.push('<button type="button" class="copy-id" data-copy-id="'+attr(e.threadId)+'">'+esc(e.threadId)+'</button>');if(workspace)parts.push(esc(workspace));if(duration)parts.push(esc(duration));return parts.join(' | ')}
function renderActivity(events){const since=val('activitySince')?new Date(val('activitySince')).getTime():0;const filtered=(events||[]).filter(e=>!since||new Date(e.timestamp).getTime()>=since);document.getElementById('activityList').innerHTML=filtered.map(e=>{const meta=activityMetaHtml(e);return '<div class="item"><strong><span class="chip '+(e.status==='failed'?'error':e.status==='queued'?'warn':'')+'">'+esc(e.status)+'</span>'+esc([fmtDate(e.timestamp),e.source,e.type].filter(Boolean).join(' | '))+'</strong><small>'+esc(short(e.prompt||e.detail||'',220))+'</small>'+(meta?'<small>'+meta+'</small>':'')+'</div>'}).join('')||'<div class="item">No activity.</div>';document.querySelectorAll('#activityList [data-copy-id]').forEach(b=>b.onclick=()=>copyText(b.dataset.copyId||'','Thread ID copied'))}
document.getElementById('loadActivityBtn').onclick=()=>loadActivity();
document.getElementById('activitySince').onchange=()=>renderActivity(state.activityEvents||[]);
document.getElementById('exportActivityBtn').onclick=()=>{const rows=(state.activityEvents||[]).map(e=>[e.timestamp,e.source,e.status,e.type,e.threadId||'',e.prompt||e.detail||''].join('\\t')).join('\\n');const blob=new Blob([rows],{type:'text/tab-separated-values'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='nordrelay-activity.tsv';a.click();URL.revokeObjectURL(a.href)};
async function loadSettings(){setLoading('settingsForm','Loading settings...');const data=await api('/api/settings');state.settings=data.settings;renderSettings()}
const settingsGroupOrder=['Agents','Codex','Pi','Hermes','OpenClaw','Claude Code','Telegram','Operations','Artifacts','Workspace','Voice','Dashboard'];
const agentSettingGroups=['Codex','Pi','Hermes','OpenClaw','Claude Code'];
function orderedSettingsGroups(groups){const known=settingsGroupOrder.filter(name=>groups[name]);const extra=Object.keys(groups).filter(name=>!settingsGroupOrder.includes(name)).sort();return known.concat(extra)}
function agentSettingsNav(current){return '<div class="agent-settings-nav"><strong>Agent settings</strong>'+agentSettingGroups.map(name=>'<button type="button" data-setting-tab="'+attr(name)+'" class="'+(name===current?'active':'')+'">'+esc(name)+'</button>').join('')+'</div>'}
function renderSettings(){const groups={};state.settings.forEach(s=>(groups[s.group]??=[]).push(s));const names=orderedSettingsGroups(groups);if(!state.settingsGroup||!groups[state.settingsGroup])state.settingsGroup=groups.Agents?'Agents':names[0];document.getElementById('settingsTabs').innerHTML=names.map(name=>'<button data-setting-tab="'+attr(name)+'" class="'+(name===state.settingsGroup?'active':'')+'">'+esc(name)+' ('+groups[name].length+')</button>').join('');document.querySelectorAll('[data-setting-tab]').forEach(b=>b.onclick=()=>{state.settingsGroup=b.dataset.settingTab;renderSettings()});const items=groups[state.settingsGroup]||[];const nav=(state.settingsGroup==='Agents'||agentSettingGroups.includes(state.settingsGroup))?agentSettingsNav(state.settingsGroup):'';document.getElementById('settingsForm').innerHTML='<div class="settings-section"><h2>'+esc(state.settingsGroup||'Settings')+'</h2><div id="settingsRestartBanner"></div>'+nav+items.map(s=>'<div class="setting" data-setting-box="'+attr(s.key)+'" data-restart-required="'+(s.restartRequired?'true':'false')+'"><label>'+esc(s.label)+'</label>'+settingInput(s)+'<small>'+esc(s.key)+' - '+esc(s.description)+(s.effectiveValue?' Active: '+esc(s.effectiveValue)+'.':'')+(s.restartRequired?' Restart required.':'')+(s.configured?' Saved in env file.':' Using default.')+'</small><div class="setting-actions"><button type="button" class="secondary" data-reset-setting="'+attr(s.key)+'">Use default</button>'+(s.kind==='secret'?'<button type="button" class="secondary" data-reveal-setting="'+attr(s.key)+'">Reveal/replace</button>':'')+'</div><div class="setting-error"></div></div>').join('')+'</div>';document.querySelectorAll('[data-setting-tab]').forEach(b=>b.onclick=()=>{state.settingsGroup=b.dataset.settingTab;renderSettings()});bindSettingsUx()}
function settingAttrs(s,original){return ' data-setting="'+attr(s.key)+'" data-original-value="'+attr(original)+'" data-configured="'+(s.configured?'true':'false')+'"'}
function settingInput(s){const display=s.configured?(s.value||''):(s.effectiveValue||''); if(s.options){const blankLabel=s.effectiveValue?'Use active default ('+s.effectiveValue+')':'Use active default';return '<select'+settingAttrs(s,s.configured?s.value:'')+'><option value="" '+(!s.configured?'selected':'')+'>'+esc(blankLabel)+'</option>'+s.options.map(o=>'<option value="'+attr(o)+'" '+(s.configured&&s.value===o?'selected':'')+'>'+esc(o)+'</option>').join('')+'</select>'} if(s.kind==='boolean'){const blankLabel=s.effectiveValue?'Use active default ('+s.effectiveValue+')':'Use active default';return '<select'+settingAttrs(s,s.configured?s.value:'')+'><option value="" '+(!s.configured?'selected':'')+'>'+esc(blankLabel)+'</option><option value="true" '+(s.configured&&s.value==='true'?'selected':'')+'>true</option><option value="false" '+(s.configured&&s.value==='false'?'selected':'')+'>false</option></select>'} const value=esc(display); if(s.kind==='json')return '<textarea rows="4"'+settingAttrs(s,display)+'>'+value+'</textarea>'; return '<input'+settingAttrs(s,display)+' value="'+value+'" '+(s.kind==='secret'?'type="password"':'')+'>'}
function bindSettingsUx(){document.querySelectorAll('[data-setting]').forEach(el=>{el.oninput=markSettingDirty;el.onchange=markSettingDirty});document.querySelectorAll('[data-reset-setting]').forEach(b=>b.onclick=()=>{const input=document.querySelector('[data-setting="'+cssEscape(b.dataset.resetSetting)+'"]');if(input){input.value='';markSettingDirty({target:input})}});document.querySelectorAll('[data-reveal-setting]').forEach(b=>b.onclick=()=>{const input=document.querySelector('[data-setting="'+cssEscape(b.dataset.revealSetting)+'"]');if(input){input.type=input.type==='password'?'text':'password';input.focus()}})}
function markSettingDirty(e){const el=e.target;const box=el.closest('.setting');const dirty=el.value!==(el.dataset.originalValue??'');box.classList.toggle('dirty',dirty);const dirtyInputs=Array.from(document.querySelectorAll('[data-setting]')).filter(x=>x.value!==(x.dataset.originalValue??''));const restart=dirtyInputs.some(x=>x.closest('.setting')?.dataset.restartRequired==='true');document.getElementById('settingsStatus').textContent=dirtyInputs.length?dirtyInputs.length+' unsaved change(s)':'';const banner=document.getElementById('settingsRestartBanner');if(banner)banner.innerHTML=restart?'<div class="restart-banner">Some changed settings require a NordRelay restart.</div>':''}
document.getElementById('saveSettingsBtn').onclick=()=>safe(async()=>{document.querySelectorAll('.setting-error').forEach(e=>e.textContent='');const patch={};document.querySelectorAll('[data-setting]').forEach(el=>{const original=el.dataset.originalValue??'';if(el.value!==original)patch[el.dataset.setting]=el.value});const r=await api('/api/settings',{method:'PATCH',body:JSON.stringify({settings:patch})});(r.errors||[]).forEach(err=>{const box=document.querySelector('[data-setting-box="'+cssEscape(err.key)+'"] .setting-error');if(box)box.textContent=err.message});document.getElementById('settingsStatus').textContent=(r.errors&&r.errors.length)?'Fix '+r.errors.length+' setting error(s)':(r.changedKeys.length?'Saved '+r.changedKeys.length+' setting(s)'+(r.restartRequired?' - restart required':''):'No changes');toast((r.errors&&r.errors.length)?'Settings need attention':'Settings saved');if(!(r.errors&&r.errors.length))await loadSettings()});
document.getElementById('restartBtn').onclick=()=>safe(async()=>{if(confirm('Restart NordRelay now?')){await api('/api/runtime/restart',{method:'POST'});toast('Restart requested')}});
async function loadAccess(){const d=await api('/api/permissions');document.getElementById('accessPanel').innerHTML=['TELEGRAM_ADMIN_USER_IDS','TELEGRAM_ALLOWED_USER_IDS','TELEGRAM_READONLY_USER_IDS','TELEGRAM_ALLOWED_CHAT_IDS','TELEGRAM_ALLOW_ANY_CHAT','TELEGRAM_ROLE_POLICIES_JSON'].map(key=>{const value=key==='TELEGRAM_ADMIN_USER_IDS'?d.telegramAdminUserIds.join(','):key==='TELEGRAM_ALLOWED_USER_IDS'?d.telegramAllowedUserIds.join(','):key==='TELEGRAM_READONLY_USER_IDS'?d.telegramReadOnlyUserIds.join(','):key==='TELEGRAM_ALLOWED_CHAT_IDS'?d.telegramAllowedChatIds.join(','):key==='TELEGRAM_ALLOW_ANY_CHAT'?String(d.telegramAllowAnyChat):JSON.stringify(d.telegramRolePolicies||{},null,2);return '<div class="setting"><label>'+esc(key)+'</label>'+(key.endsWith('_JSON')?'<textarea rows="5" data-access-setting="'+key+'">'+esc(value)+'</textarea>':'<input data-access-setting="'+key+'" value="'+esc(value)+'">')+'<small>Access control setting. Restart required after saving.</small></div>'}).join('');await loadLocks();await loadAudit()}
document.getElementById('loadAccessBtn').onclick=()=>loadAccess();
document.getElementById('saveAccessBtn').onclick=()=>safe(async()=>{const settings={};document.querySelectorAll('[data-access-setting]').forEach(el=>settings[el.dataset.accessSetting]=el.value);const r=await api('/api/settings',{method:'PATCH',body:JSON.stringify({settings})});toast((r.errors&&r.errors.length)?'Access settings need attention':'Access settings saved. Restart required.');if(r.errors&&r.errors.length)document.getElementById('accessPanel').insertAdjacentHTML('afterbegin','<div class="restart-banner">'+esc(r.errors.map(e=>e.key+': '+e.message).join(' / '))+'</div>')});
async function loadLocks(){const d=await api('/api/locks');document.getElementById('locksList').innerHTML=(d.locks||[]).map(l=>'<div class="item"><strong>'+esc(l.contextKey)+'</strong><small>'+esc((l.ownerName||'owner')+' / '+l.ownerId+' / expires '+fmtDate(l.expiresAt))+'</small></div>').join('')||'<div class="item">No active locks.</div>'}
document.getElementById('lockSessionBtn').onclick=()=>safe(async()=>{await api('/api/locks',{method:'POST',body:JSON.stringify({ownerName:'Web dashboard'})});toast('Web session locked');loadLocks()});
document.getElementById('unlockSessionBtn').onclick=()=>safe(async()=>{await api('/api/locks',{method:'DELETE'});toast('Web session unlocked');loadLocks()});
async function loadAudit(){const d=await api('/api/audit?limit='+encodeURIComponent(val('auditLimit')||'50'));document.getElementById('auditList').innerHTML=(d.events||[]).map(e=>'<div class="item"><strong>'+esc(fmtDate(e.timestamp)+' / '+(e.channelId||'-')+' / '+e.status+' / '+e.action)+'</strong><small>'+esc((e.contextKey||'-')+' / '+(e.agentId||'-')+' / '+(e.threadId||'-'))+'</small><small>'+esc(e.description||e.detail||'')+'</small></div>').join('')||'<div class="item">No audit events.</div>'}
document.getElementById('loadAuditBtn').onclick=()=>loadAudit();
async function loadLogs(){if(!document.getElementById('logAutoRefresh').checked)setLoading('logs','Loading logs...');const target=document.getElementById('logTarget').value;const lines=document.getElementById('logLines').value;const data=await api('/api/logs?target='+target+'&lines='+lines);state.logsPlain=data.plain||'';renderLogs();if(document.getElementById('logFollow').checked)document.getElementById('logs').scrollTop=document.getElementById('logs').scrollHeight}document.getElementById('loadLogsBtn').onclick=loadLogs;
function logLevelOf(line){if(line.includes(' ERROR '))return'ERROR';if(line.includes(' WARN '))return'WARN';if(line.includes(' INFO '))return'INFO';return''}
function logTimeOf(line){const m=line.match(/^(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})/);return m?new Date(m[1].replace(' ','T')).getTime():0}
function renderLogs(){const level=val('logLevel');const query=val('logSearch').toLowerCase();const since=val('logSince')?new Date(val('logSince')).getTime():0;const lines=state.logsPlain.split(/\\n/).filter(line=>line.length>0&&(level==='all'||line.includes(level))&&(!query||line.toLowerCase().includes(query))&&(!since||!logTimeOf(line)||logTimeOf(line)>=since));document.getElementById('logs').innerHTML=lines.map(line=>'<span class="log-line '+logLevelOf(line)+'">'+esc(line)+'</span>').join('')||'(empty)'}
document.getElementById('logLevel').onchange=renderLogs;document.getElementById('logSearch').oninput=renderLogs;document.getElementById('logSince').onchange=renderLogs;document.getElementById('logAutoRefresh').onchange=e=>{clearInterval(state.logTimer);state.logTimer=null;if(e.target.checked)state.logTimer=setInterval(loadLogs,5000)};document.getElementById('downloadLogsBtn').onclick=()=>{const blob=new Blob([state.logsPlain||''],{type:'text/plain'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='nordrelay-log.txt';a.click();URL.revokeObjectURL(a.href)};document.getElementById('clearLogsBtn').onclick=()=>safe(async()=>{const target=document.getElementById('logTarget').value;if(confirm('Clear '+target+' log?')){await api('/api/logs/clear',{method:'POST',body:JSON.stringify({target})});state.logsPlain='';renderLogs();toast('Cleared '+target+' log')}});
async function loadAdapterHealth(){setLoading('adapterHealth','Loading adapters...');const d=await api('/api/adapters/health');document.getElementById('adapterHealth').innerHTML=(d.adapters||[]).map(a=>'<div class="item"><strong>'+esc(a.label)+' <span class="adapter-status '+esc(a.status)+'">'+esc(a.status)+'</span></strong><small>'+esc('CLI: '+(a.cli.label||'-')+' / path '+(a.cli.path||'-')+' / version '+(a.cli.version||'-'))+'</small><small>'+esc('Auth: '+(a.auth.supported?(a.auth.authenticated?'authenticated':'not authenticated'):'not managed')+' '+(a.auth.detail||''))+'</small><small>'+esc('Version: '+a.version.installed+' / latest '+(a.version.latest||'-')+' / '+a.version.status)+'</small><div class="row"><button data-auth-status="'+attr(a.id)+'">Auth status</button><button data-auth-login="'+attr(a.id)+'" class="secondary" '+(!a.capabilities.login?'disabled':'')+'>Login</button><button data-auth-logout="'+attr(a.id)+'" class="secondary" '+(!a.capabilities.logout?'disabled':'')+'>Logout</button></div></div>').join('')||'<div class="item">No adapters.</div>';document.querySelectorAll('[data-auth-status]').forEach(b=>b.onclick=()=>safe(async()=>{const r=await api('/api/auth/status?agent='+encodeURIComponent(b.dataset.authStatus));toast(r.agentLabel+': '+r.detail,{duration:6000})}));document.querySelectorAll('[data-auth-login]').forEach(b=>b.onclick=()=>safe(async()=>{const r=await api('/api/auth/login',{method:'POST',body:JSON.stringify({agentId:b.dataset.authLogin})});toast((r.result?.message||r.detail),{duration:8000});loadAdapterHealth()}));document.querySelectorAll('[data-auth-logout]').forEach(b=>b.onclick=()=>safe(async()=>{const r=await api('/api/auth/logout',{method:'POST',body:JSON.stringify({agentId:b.dataset.authLogout})});toast((r.result?.message||r.detail),{duration:8000});loadAdapterHealth()}))}
document.getElementById('reloadAdaptersBtn').onclick=()=>loadAdapterHealth();
const versionAgentIds={codex:'codex',pi:'pi',hermes:'hermes',openclaw:'openclaw',claudeCode:'claude-code'};
async function loadVersion(){setLoading('versionPanel','Checking versions...');await loadAgentUpdateJobs(false);const d=await api('/api/version');const checks=d.versionChecks||{};document.getElementById('versionPanel').innerHTML=Object.entries(checks).map(([key,v])=>versionCard(key,v)).join('')+card('Runtime',[['Status',d.state?.status],['Version',d.health?.version],['Codex CLI',d.health?.codexCli],['Pi CLI',d.health?.piCli],['Hermes CLI',d.health?.hermesCli],['OpenClaw CLI',d.health?.openClawCli],['Claude Code CLI',d.health?.claudeCodeCli]])}
function versionCard(key,v){const agentId=versionAgentIds[key];const running=agentId&&state.agentUpdateJobs.some(j=>j.agentId===agentId&&j.status==='running');const button=agentId&&v.status==='outdated'?'<button class="secondary mini-button" data-update-agent="'+attr(agentId)+'" '+(running?'disabled':'')+'>'+(running?'Updating':'Update')+'</button>':'';return '<div class="item"><strong>'+esc(v.label)+' <span class="adapter-status '+esc(versionStatusClass(v.status))+'">'+esc(versionStatusLabel(v.status))+'</span> '+button+'</strong><small>'+esc('Installed: '+(v.installedLabel||'-'))+'</small><small>'+esc('Latest: '+(v.latestVersion||'-'))+'</small>'+(v.detail?'<small>'+esc(v.detail)+'</small>':'')+'</div>'}
async function loadAgentUpdateJobs(showLoading=true){if(showLoading)setLoading('agentUpdateJobs','Loading update jobs...');const d=await api('/api/agent-updates');state.agentUpdateJobs=d.jobs||[];renderAgentUpdateJobs()}
function upsertAgentUpdateJob(job){if(!job)return;const index=state.agentUpdateJobs.findIndex(j=>j.id===job.id);if(index>=0)state.agentUpdateJobs[index]=job;else state.agentUpdateJobs.unshift(job)}
function renderAgentUpdateJobs(){const target=document.getElementById('agentUpdateJobs');if(!target)return;target.innerHTML=(state.agentUpdateJobs||[]).map(updateJobCard).join('')||'<div class="item">No agent update jobs.</div>';bindAgentUpdateButtons()}
function updateJobCard(job){const command=[job.command].concat(job.args||[]).join(' ');const needs=job.needsInput?'<small><span class="chip warn">Input may be required</span></small>':'';const input=job.canInput?'<div class="update-input"><input data-update-input="'+attr(job.id)+'" placeholder="Send response to update process"><button data-update-send="'+attr(job.id)+'" class="secondary">Send</button><button data-update-cancel="'+attr(job.id)+'" class="danger">Cancel</button></div>':'';return '<div class="item"><div class="update-job-header"><strong>'+esc(job.agentLabel)+' <span class="adapter-status '+esc(jobStatusClass(job.status))+'">'+esc(job.status)+'</span></strong><button class="secondary mini-button" data-update-log="'+attr(job.id)+'">Full log</button></div><small>'+esc(job.method+' / '+fmtDate(job.startedAt)+(job.finishedAt?' - '+fmtDate(job.finishedAt):''))+'</small><small>'+esc(command)+'</small><small>'+esc(job.error||job.summary||'')+'</small>'+needs+'<pre class="update-log">'+esc(job.outputTail||'(waiting for output)')+'</pre>'+input+'</div>'}
function bindAgentUpdateButtons(){document.querySelectorAll('[data-update-agent]').forEach(b=>b.onclick=()=>safe(async()=>{if(confirm('Start update for '+b.dataset.updateAgent+'?')){const r=await api('/api/agent-update',{method:'POST',body:JSON.stringify({agentId:b.dataset.updateAgent})});upsertAgentUpdateJob(r.job);renderAgentUpdateJobs();toast(r.job.agentLabel+' update started',{duration:6000});loadVersion()}}));document.querySelectorAll('[data-update-send]').forEach(b=>b.onclick=()=>safe(async()=>{const input=document.querySelector('[data-update-input="'+cssEscape(b.dataset.updateSend)+'"]');const text=input?.value||'';if(!text.trim())return;const r=await api('/api/agent-update/'+encodeURIComponent(b.dataset.updateSend)+'/input',{method:'POST',body:JSON.stringify({input:text})});if(input)input.value='';upsertAgentUpdateJob(r.job);renderAgentUpdateJobs()}));document.querySelectorAll('[data-update-cancel]').forEach(b=>b.onclick=()=>safe(async()=>{if(confirm('Cancel this update job?')){const r=await api('/api/agent-update/'+encodeURIComponent(b.dataset.updateCancel)+'/cancel',{method:'POST'});upsertAgentUpdateJob(r.job);renderAgentUpdateJobs()}}));document.querySelectorAll('[data-update-log]').forEach(b=>b.onclick=()=>safe(async()=>{const r=await api('/api/agent-update/'+encodeURIComponent(b.dataset.updateLog)+'/log');upsertAgentUpdateJob({...r.job,outputTail:r.plain});renderAgentUpdateJobs()}))}
document.getElementById('loadVersionBtn').onclick=()=>loadVersion();
document.getElementById('updateBtn').onclick=()=>safe(async()=>{if(confirm('Start NordRelay self-update now?')){const r=await api('/api/update',{method:'POST'});toast('Update started via '+r.method+'. Log: '+r.logPath,{duration:8000});page('logs');document.getElementById('logTarget').value='update';loadLogs()}});
async function loadDiagnostics(){setLoading('diagnostics','Loading diagnostics...');const data=await api('/api/diagnostics');document.getElementById('diagnostics').innerHTML=diagnosticsHtml(data)}
function diagnosticsHtml(d){const h=d.health||{};const s=d.snapshot?.session||{};const vc=d.versionChecks||{};const caps=s.capabilities||{};const agentDiag=d.runtime?.agentDiagnostics;return '<div class="list">'+card('Runtime',[['Status',h.state?.status],['PID',h.state?.pid],['App PID',h.state?.appPid],['State',h.stateFile],['Log',h.logFile],['State backend',d.runtime?.stateBackend],['Uptime',h.uptimeSeconds+'s']])+card('Agent',[['Agent',s.agentLabel],['Thread',s.threadId],['Workspace',s.workspace],['Model',s.model],['Reasoning',s.reasoningEffort],['Fast',caps.fastMode?(s.fastMode?'on':'off'):'n/a']])+card('Agent State',(agentDiag?.lines||[]).map(x=>[x.label,x.value]))+card('CLI Versions',Object.values(vc).map(v=>[v.label,(v.status==='current'?'OK ':'WARN ')+(v.installedLabel||'-')+' latest '+(v.latestVersion||'-')]))+card('External Mirror',d.runtime?.externalMirror?Object.entries(d.runtime.externalMirror):[['Status','idle']])+'</div>'}
function card(title,rows){return '<div class="item"><strong>'+esc(title)+'</strong>'+rows.map(r=>'<small>'+esc(r[0])+': '+esc(r[1]??'-')+'</small>').join('')+'</div>'}
function safe(fn,event){if(event&&event.preventDefault)event.preventDefault();Promise.resolve().then(fn).catch(err=>toast(err.message||String(err)))}
loadBootstrap().then(()=>connectEvents()).catch(err=>toast(err.message));
`;
}
