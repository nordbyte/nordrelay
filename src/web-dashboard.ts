import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";

import { enabledAgents } from "./agent-factory.js";
import { listAgentAdapterDescriptors } from "./agent-adapter.js";
import { isAgentId } from "./agent.js";
import { AuditLogStore, type AuditEvent } from "./audit-log.js";
import { listChannelDescriptors } from "./channel-adapter.js";
import { ALL_PERMISSIONS, permissionForWebRequest } from "./access-control.js";
import { loadConfig } from "./config.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML } from "./format.js";
import { RelayRuntime, type RelayEvent } from "./relay-runtime.js";
import { resolveDashboardEnvPath, SettingsService } from "./settings-service.js";
import { UserStore, publicUser, publicUserSnapshot, type AuthenticatedUser } from "./user-management.js";
import { dashboardJs } from "./web-dashboard-client.js";
import { dashboardCss } from "./web-dashboard-style.js";
import { renderDashboardNav } from "./web-dashboard-ui.js";

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
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const options = parseOptions(process.argv.slice(2));
const config = loadConfig();
const runtime = new RelayRuntime(config);
const settings = new SettingsService(resolveDashboardEnvPath(options.home));
const users = new UserStore(options.home);
const auditLog = new AuditLogStore(config.workspace, config.stateBackend, config.auditMaxEvents);
const loginAttempts = new Map<string, RateLimitBucket>();

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
  if (url.pathname === "/api/auth" && req.method === "POST") {
    await handleLogin(req, res);
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
    handleEvents(req, res);
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
      actorId: authUser.user.id,
      actorRole: authUser.groups.map((group) => group.name).join(", "),
      description: `${permission} required for ${req.method ?? "GET"} ${url.pathname}`,
    });
    sendJson(res, 403, { error: `Access denied: ${permission} permission required.` });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    sendJson(res, 200, {
      auth: currentUserDto(authUser),
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
    sendJson(res, 200, { ...publicUserSnapshot(users.snapshot()), permissions: ALL_PERMISSIONS });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/users") {
    sendJson(res, 200, { ...publicUserSnapshot(users.snapshot()), permissions: ALL_PERMISSIONS });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/users") {
    const body = await readJsonBody(req);
    const user = users.createUser({
      email: stringField(body, "email"),
      displayName: optionalStringField(body, "displayName") ?? stringField(body, "email"),
      password: stringField(body, "password"),
      groupIds: arrayStringField(body, "groupIds"),
      active: optionalBooleanField(body, "active") ?? true,
      telegramUserId: optionalNumberField(body, "telegramUserId"),
    });
    auditUserAction(authUser, "user_created", user.user.email);
    sendJson(res, 201, { user: publicUser(user.user), groups: user.groups });
    return;
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch?.[1] && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const user = users.updateUser(decodeURIComponent(userMatch[1]), {
      email: optionalStringField(body, "email"),
      displayName: optionalStringField(body, "displayName"),
      active: optionalBooleanField(body, "active"),
      groupIds: body.groupIds === undefined ? undefined : arrayStringField(body, "groupIds"),
    });
    auditUserAction(authUser, "user_updated", user.user.email);
    sendJson(res, 200, { user: publicUser(user.user), groups: user.groups });
    return;
  }

  const passwordMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/password$/);
  if (passwordMatch?.[1] && req.method === "POST") {
    const body = await readJsonBody(req);
    const userId = decodeURIComponent(passwordMatch[1]);
    users.setPassword(userId, stringField(body, "password"));
    auditUserAction(authUser, "user_password_changed", userId);
    sendJson(res, 200, { ok: true });
    return;
  }

  const userSessionsMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/sessions$/);
  if (userSessionsMatch?.[1] && req.method === "GET") {
    sendJson(res, 200, { sessions: users.listWebSessions(decodeURIComponent(userSessionsMatch[1])) });
    return;
  }

  if (userSessionsMatch?.[1] && req.method === "DELETE") {
    const userId = decodeURIComponent(userSessionsMatch[1]);
    const revoked = users.revokeUserSessions(userId);
    auditUserAction(authUser, "user_session_revoked", `${userId}: ${revoked} sessions`);
    sendJson(res, 200, { revoked });
    return;
  }

  const userSessionMatch = url.pathname.match(/^\/api\/users\/[^/]+\/sessions\/([^/]+)$/);
  if (userSessionMatch?.[1] && req.method === "DELETE") {
    const sessionId = decodeURIComponent(userSessionMatch[1]);
    const revoked = users.revokeWebSession(sessionId);
    auditUserAction(authUser, "user_session_revoked", sessionId);
    sendJson(res, 200, { revoked });
    return;
  }

  const telegramLinkMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/telegram$/);
  if (telegramLinkMatch?.[1] && req.method === "POST") {
    const body = await readJsonBody(req);
    if (body.createCode === true) {
      const userId = decodeURIComponent(telegramLinkMatch[1]);
      const linkCode = users.createTelegramLinkCode(userId);
      auditUserAction(authUser, "telegram_link_created", userId);
      sendJson(res, 201, { linkCode });
      return;
    }
    const identity = users.linkTelegramUser(decodeURIComponent(telegramLinkMatch[1]), {
      telegramUserId: numberField(body, "telegramUserId"),
      username: optionalStringField(body, "username"),
    });
    auditUserAction(authUser, "telegram_linked", String(identity.telegramUserId));
    sendJson(res, 201, { identity });
    return;
  }

  const telegramUnlinkMatch = url.pathname.match(/^\/api\/users\/[^/]+\/telegram\/([^/]+)$/);
  if (telegramUnlinkMatch?.[1] && req.method === "DELETE") {
    const identityId = decodeURIComponent(telegramUnlinkMatch[1]);
    const removed = users.unlinkTelegramIdentity(identityId);
    auditUserAction(authUser, "telegram_unlinked", identityId);
    sendJson(res, 200, { removed });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/groups") {
    sendJson(res, 200, { groups: users.listGroups() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/groups") {
    const body = await readJsonBody(req);
    const group = users.createGroup({
      name: stringField(body, "name"),
      description: optionalStringField(body, "description"),
      permissions: arrayStringField(body, "permissions"),
      agentIds: arrayStringField(body, "agentIds"),
      workspaceRoots: arrayStringField(body, "workspaceRoots"),
      telegramChatIds: arrayNumberField(body, "telegramChatIds"),
    });
    auditUserAction(authUser, "group_created", group.id);
    sendJson(res, 201, { group });
    return;
  }

  const groupMatch = url.pathname.match(/^\/api\/groups\/([^/]+)$/);
  if (groupMatch?.[1] && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const group = users.updateGroup(decodeURIComponent(groupMatch[1]), {
      name: optionalStringField(body, "name"),
      description: optionalStringField(body, "description"),
      permissions: body.permissions === undefined ? undefined : arrayStringField(body, "permissions"),
      agentIds: body.agentIds === undefined ? undefined : arrayStringField(body, "agentIds"),
      workspaceRoots: body.workspaceRoots === undefined ? undefined : arrayStringField(body, "workspaceRoots"),
      telegramChatIds: body.telegramChatIds === undefined ? undefined : arrayNumberField(body, "telegramChatIds"),
    });
    auditUserAction(authUser, "group_updated", group.id);
    sendJson(res, 200, { group });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/telegram-chats") {
    sendJson(res, 200, { chats: users.snapshot().telegramChats });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/telegram-chats") {
    const body = await readJsonBody(req);
    const chat = users.registerTelegramChat({
      chatId: numberField(body, "chatId"),
      title: optionalStringField(body, "title"),
      type: optionalStringField(body, "type"),
      enabled: optionalBooleanField(body, "enabled") ?? true,
      allowedGroupIds: arrayStringField(body, "allowedGroupIds"),
    });
    auditUserAction(authUser, "telegram_chat_updated", String(chat.chatId));
    sendJson(res, 201, { chat });
    return;
  }

  const chatMatch = url.pathname.match(/^\/api\/telegram-chats\/([^/]+)$/);
  if (chatMatch?.[1] && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const chat = users.updateTelegramChat(decodeURIComponent(chatMatch[1]), {
      enabled: optionalBooleanField(body, "enabled"),
      title: optionalStringField(body, "title"),
      allowedGroupIds: body.allowedGroupIds === undefined ? undefined : arrayStringField(body, "allowedGroupIds"),
    });
    auditUserAction(authUser, "telegram_chat_updated", String(chat.chatId));
    sendJson(res, 200, { chat });
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
        parseAgentId(url.searchParams.get("agent") ?? undefined),
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
    assertScopedAgent(authUser, agentId);
    sendJson(res, 200, { session: await runtime.setAgent(agentId) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/new") {
    const body = await readJsonBody(req);
    const agentId = parseAgentId(optionalStringField(body, "agentId"));
    const workspace = optionalStringField(body, "workspace");
    assertScopedAgent(authUser, agentId);
    assertScopedWorkspace(authUser, workspace);
    sendJson(res, 200, {
      session: await runtime.newSession({
        agentId,
        workspace,
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
    const threadId = stringField(body, "threadId");
    const detail = await runtime.sessionDetail(threadId);
    if (detail.record && typeof detail.record === "object") {
      assertSessionScope(authUser, detail.record as Record<string, unknown>);
    }
    const session = await runtime.switchSession(threadId);
    assertSessionScope(authUser, session);
    sendJson(res, 200, { session });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/attach") {
    const body = await readJsonBody(req);
    const session = await runtime.attachSession(stringField(body, "threadId"));
    assertSessionScope(authUser, session);
    sendJson(res, 200, { session });
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
    await assertCurrentSessionScope(authUser);
    sendJson(res, 202, await runtime.sendPrompt(stringField(body, "text")));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/prompt/upload") {
    const body = await readJsonBody(req);
    await assertCurrentSessionScope(authUser);
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
    sendJson(res, 200, await runtime.logs(parseLogTarget(url.searchParams.get("target") ?? undefined), numberParam(url, "lines", 120)));
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
  const authUser = authenticateRequest(req);
  if (!authUser) {
    sendJson(res, 401, { error: "Authentication required" });
    return;
  }
  if (!users.hasPermission(authUser, "inspect")) {
    sendJson(res, 403, { error: "Access denied: inspect permission required." });
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
    actorId: authUser.user.id,
    actorRole: authUser.groups.map((group) => group.name).join(", "),
    description: `Login ${authUser.user.email}`,
  });
  setSessionCookie(res, session.token);
  sendJson(res, 200, currentUserDto(authUser));
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
    actorId: authUser.user.id,
    actorRole: authUser.groups.map((group) => group.name).join(", "),
    description,
  });
}

function assertScopedAgent(authUser: AuthenticatedUser, agentId: string | undefined): void {
  if (!users.canUseAgent(authUser, agentId)) {
    throw new Error(`Access denied: agent ${agentId} is outside your group scope.`);
  }
}

function assertScopedWorkspace(authUser: AuthenticatedUser, workspace: string | undefined): void {
  if (!users.canUseWorkspace(authUser, workspace)) {
    throw new Error(`Access denied: workspace ${workspace} is outside your group scope.`);
  }
}

function assertSessionScope(authUser: AuthenticatedUser, session: { agentId?: string; workspace?: string } | Record<string, unknown>): void {
  const agentId = typeof session.agentId === "string" ? session.agentId : undefined;
  const workspace = typeof session.workspace === "string" ? session.workspace : undefined;
  assertScopedAgent(authUser, agentId);
  assertScopedWorkspace(authUser, workspace);
}

async function assertCurrentSessionScope(authUser: AuthenticatedUser): Promise<void> {
  const snapshot = await runtime.snapshot();
  assertSessionScope(authUser, snapshot.session);
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

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  const parsed = typeof field === "number" ? field : typeof field === "string" ? Number(field) : Number.NaN;
  if (!Number.isInteger(parsed)) {
    throw new Error(`${key} must be an integer`);
  }
  return parsed;
}

function optionalNumberField(value: Record<string, unknown>, key: string): number | undefined {
  if (value[key] === undefined || value[key] === "") {
    return undefined;
  }
  return numberField(value, key);
}

function arrayStringField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  if (field === undefined || field === null || field === "") {
    return [];
  }
  if (Array.isArray(field)) {
    return field.filter((item): item is string => typeof item === "string");
  }
  if (typeof field === "string") {
    return field.split(",").map((item) => item.trim()).filter(Boolean);
  }
  throw new Error(`${key} must be a string list`);
}

function arrayNumberField(value: Record<string, unknown>, key: string): number[] {
  const field = value[key];
  if (field === undefined || field === null || field === "") {
    return [];
  }
  if (Array.isArray(field)) {
    return field.map((item) => typeof item === "number" ? item : Number(item)).filter((item) => Number.isInteger(item));
  }
  if (typeof field === "string") {
    return field.split(",").map((item) => Number(item.trim())).filter((item) => Number.isInteger(item));
  }
  throw new Error(`${key} must be a number list`);
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

function parseLogTarget(value: string | undefined): "connector" | "update" | "agent-updates" {
  return value === "update" || value === "agent-updates" ? value : "connector";
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
    TELEGRAM_BOT_TOKEN: current.telegramBotToken,
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

function renderLoginPage(options: { adminConfigured: boolean }): string {
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
    <p>${options.adminConfigured ? "Sign in with your NordRelay user account." : "No admin user exists. Run nordrelay user create-admin on this host first."}</p>
    <label>Email</label><input id="email" name="email" type="email" autocomplete="username" ${options.adminConfigured ? "" : "disabled"}>
    <label>Password</label><input id="password" name="password" type="password" autocomplete="current-password" ${options.adminConfigured ? "" : "disabled"}>
    <button ${options.adminConfigured ? "" : "disabled"}>Sign in</button>
    <div class="error" id="error"></div>
  </form>
  <script>
    document.getElementById('login').addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = {
        email: document.getElementById('email')?.value || undefined,
        password: document.getElementById('password')?.value || undefined,
      };
      const res = await fetch('/api/auth', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
      if (!res.ok) {
        document.getElementById('error').textContent = 'Invalid credentials';
        return;
      }
      location.href = '/';
    });
  </script>
</body>
</html>`;
}

function renderDashboardApp(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NordRelay Dashboard</title>
  <script>document.documentElement.dataset.theme = localStorage.getItem('nordrelayTheme') || 'light';</script>
  <link rel="stylesheet" href="/assets/dashboard.css">
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
          <button id="logoutBtn" class="secondary">Logout</button>
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
          <div class="row"><button id="loadAccessBtn">Reload users</button><button id="createUserBtn">Create user</button><button id="createGroupBtn" class="secondary">Create group</button><button id="createChatBtn" class="secondary">Add Telegram chat</button><button id="lockSessionBtn" class="secondary">Lock web session</button><button id="unlockSessionBtn" class="secondary">Unlock web session</button></div>
          <div id="accessPanel" class="settings-grid"></div>
          <h2>Groups</h2>
          <div id="groupsList" class="list"></div>
          <h2>Telegram chats</h2>
          <div id="telegramChatsList" class="list"></div>
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
          <div class="row"><select id="logTarget"><option value="connector">Connector</option><option value="update">NordRelay Update</option><option value="agent-updates">Agent Updates</option></select><select id="logLevel"><option value="all">All levels</option><option value="ERROR">Error</option><option value="WARN">Warn</option><option value="INFO">Info</option></select><input id="logSearch" placeholder="Search logs"><input id="logSince" type="datetime-local" title="Show entries after this time"><input id="logLines" type="number" value="120" min="1" max="300"><label class="checkbox"><input id="logAutoRefresh" type="checkbox"> Auto</label><label class="checkbox"><input id="logFollow" type="checkbox"> Follow</label><button id="loadLogsBtn">Load logs</button><button id="downloadLogsBtn" class="secondary">Download</button><button id="clearLogsBtn" class="danger">Clear</button></div>
          <pre id="logs" class="log-view"></pre>
        </div>
      </section>

      <section class="page" id="page-diagnostics">
        <div class="panel"><div id="diagnostics" class="list"></div></div>
      </section>

      <footer>
        <span id="footerVersion">NordRelay</span>
        <span id="footerHealth">Health: loading</span>
        <span id="footerUser">User: loading</span>
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
  <dialog id="adminDialog">
    <form method="dialog" id="adminDialogForm">
      <h2 id="adminDialogTitle">Edit</h2>
      <div id="adminDialogBody" class="form-grid"></div>
      <div class="row dialog-actions"><button type="button" id="adminDialogCancel" class="secondary">Cancel</button><button id="adminDialogSubmit" value="default">Save</button></div>
    </form>
  </dialog>
  <div id="toolTooltip" class="tool-tooltip"></div>
  <div id="toast"></div>
  <script src="/assets/dashboard.js"></script>
</body>
</html>`;
}
