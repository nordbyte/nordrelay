import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test } from "@playwright/test";

import { CODEX_AGENT_CAPABILITIES, PI_AGENT_CAPABILITIES } from "../src/agent.js";
import { listAgentAdapterDescriptors } from "../src/agent-adapter.js";
import { listChannelDescriptors } from "../src/channel-adapter.js";
import { dashboardCss, dashboardJs } from "../src/web-dashboard-assets.js";
import { renderDashboardNav } from "../src/web-dashboard-ui.js";

interface MockServer {
  baseUrl: string;
  server: Server;
  close: () => Promise<void>;
  requests: Array<{ method: string; path: string; body: unknown }>;
}

test.describe("NordRelay WebUI", () => {
  let mock: MockServer;

  test.beforeEach(async () => {
    mock = await startMockDashboardServer();
  });

  test.afterEach(async () => {
    await mock.close();
  });

  test("renders the dashboard shell and navigates primary pages", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the dedicated responsive flow");
    await page.goto(mock.baseUrl);

    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expect(page.locator("#agentAdapters")).toContainText("Codex");
    await expect(page.locator("#chatAdapters")).toContainText("Telegram");
    await expect(page.locator("#footerHealth")).toContainText("Health: ready");

    await page.getByRole("button", { name: "Chat" }).click();
    await expect(page.locator("#messages")).toContainText("Existing web message");
    await expect(page.locator("#messages")).toHaveCSS("overflow-y", "auto");

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.locator("#settingsTabs")).toContainText("Agents");
    await expect(page.locator("#settingsForm")).toContainText("Enable Codex");

    await page.getByRole("button", { name: "Version" }).click();
    await expect(page.locator("#versionPanel")).toContainText("NordRelay");
    await expect(page.locator("#agentUpdateJobs")).toContainText("No agent update jobs");
  });

  test("sends prompts through the typed API client and shows queued feedback", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.goto(mock.baseUrl);
    await page.getByRole("button", { name: "Chat" }).click();

    await page.locator("#promptInput").fill("Run a browser smoke test");
    await page.locator("#promptForm button").last().click();

    await expect(page.locator("#messages")).toContainText("Queued prompt queue-web-1");
    const promptRequest = mock.requests.find((request) => request.path === "/api/prompt");
    expect(promptRequest?.body).toMatchObject({ text: "Run a browser smoke test" });
  });

  test("starts agent install/update jobs from the version page", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.goto(mock.baseUrl);
    await page.getByRole("button", { name: "Version" }).click();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Install" }).click();

    await expect(page.locator("#agentUpdateJobs")).toContainText("Pi install");
    const updateRequest = mock.requests.find((request) => request.path === "/api/agent-update");
    expect(updateRequest?.body).toMatchObject({ agentId: "pi", operation: "install" });
  });

  test("keeps the responsive navigation usable on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mock.baseUrl);

    await page.getByRole("button", { name: "Menu" }).click();
    await expect(page.locator("#sidebar")).toHaveClass(/open/);
    await page.getByRole("button", { name: "Logs" }).click();

    await expect(page.getByRole("heading", { name: "Logs" })).toBeVisible();
    await expect(page.locator("#logs")).toHaveCSS("overflow-y", "auto");
  });
});

async function startMockDashboardServer(): Promise<MockServer> {
  const requests: MockServer["requests"] = [];
  const jobs: unknown[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") return sendText(res, 200, dashboardHtml(), "text/html; charset=utf-8");
    if (url.pathname === "/assets/dashboard.css") return sendText(res, 200, dashboardCss(), "text/css; charset=utf-8");
    if (url.pathname === "/assets/dashboard.js") return sendText(res, 200, dashboardJs(), "application/javascript; charset=utf-8");
    if (url.pathname === "/api/events") return sendSse(res);
    if (url.pathname === "/favicon.ico") return sendText(res, 204, "", "text/plain");

    if (url.pathname.startsWith("/api/")) {
      const body = await readJson(req);
      requests.push({ method: req.method ?? "GET", path: url.pathname, body });
      return sendJson(res, 200, apiResponse(url, req.method ?? "GET", body, jobs));
    }

    sendText(res, 404, "not found", "text/plain; charset=utf-8");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NordRelay Dashboard Test</title>
  <link rel="stylesheet" href="/assets/dashboard.css">
</head>
<body>
  <div class="app">
    <aside class="sidebar" id="sidebar"><div class="brand"><span class="mark">NR</span><div><strong>NordRelay</strong><small>Remote control</small></div></div><nav>${renderDashboardNav()}</nav></aside>
    <main>
      <header><button class="menu" id="menuBtn">Menu</button><div><h1 id="pageTitle">Overview</h1><p id="sessionLine">Loading session...</p></div><div class="header-actions"><span id="connectionStatus" class="badge">Connecting</span><select id="agentSelect"></select><button id="themeBtn" class="secondary">Dark</button><button id="refreshBtn">Refresh</button><button id="logoutBtn" class="secondary">Logout</button></div></header>
      <section class="page active" id="page-overview"><div class="metrics" id="metrics"></div><div class="stack"><div class="panel"><h2>Current Session</h2><pre id="sessionText"></pre></div><div class="overview-adapter-grid"><div class="panel"><h2>Agent Adapters</h2><div id="agentAdapters"></div></div><div class="panel"><h2>Chat Adapters</h2><div id="chatAdapters"></div></div></div></div></section>
      <section class="page" id="page-chat"><div class="chat-layout"><div class="panel chat-panel"><div class="chat-toolbar"><button id="newSessionBtn">New session</button><button id="retryBtn" class="secondary">Retry</button><button id="editLastBtn" class="secondary">Edit last</button><button id="syncBtn" class="secondary">Sync</button><button id="notifyBtn" class="secondary">Notify</button><button id="clearChatBtn" class="secondary">Clear history</button><button id="abortBtn">Abort</button><button id="handbackBtn">Handback</button></div><div class="control-grid" id="sessionControls"></div><div id="messages" class="messages"></div><form id="promptForm" class="composer"><div class="composer-fields"><textarea id="promptInput" rows="3"></textarea><div class="attachment-row"><label class="file-button" for="fileInput">Attach files</label><input id="fileInput" type="file" multiple><button type="button" id="recordBtn" class="secondary">Record voice</button><span id="fileSummary">No files selected</span><button type="button" id="clearFilesBtn" class="secondary">Clear</button></div></div><button>Send</button></form></div><div class="panel side-panel"><h2>Tools / Plan</h2><div id="toolStream" class="tool-stream"></div></div></div></section>
      <section class="page" id="page-tasks"><div class="panel"><div class="row"><button id="reloadTasksBtn">Reload tasks</button></div><div id="tasksList" class="list"></div></div></section>
      <section class="page" id="page-sessions"><div class="panel"><div class="sessions-toolbar"><div class="row search-row"><input id="sessionSearch"><button id="sessionSearchBtn">Search</button></div><div class="row attach-row"><input id="attachInput"><button id="attachBtn">Attach</button></div></div><div id="sessionsList" class="list"></div><div id="sessionsPager" class="pager"></div></div></section>
      <section class="page" id="page-queue"><div class="panel"><div class="row"><button data-queue="pause">Pause</button><button data-queue="resume">Resume</button><button data-queue="clear" class="danger">Clear</button><span id="queueStatus"></span></div><div id="queueList" class="list"></div></div></section>
      <section class="page" id="page-activity"><div class="panel"><div class="row"><select id="activitySource"><option value="all">All</option></select><select id="activityStatus"><option value="all">All</option></select><input id="activitySince" type="datetime-local"><input id="activityLimit" value="100"><button id="loadActivityBtn">Load activity</button><button id="exportActivityBtn" class="secondary">Export</button></div><div id="activityList" class="list"></div></div></section>
      <section class="page" id="page-artifacts"><div class="panel"><div class="row"><button id="reloadArtifactsBtn">Reload artifacts</button><input id="artifactSearch"><select id="artifactKind"><option value="all">All files</option><option value="images">Images</option><option value="docs">Docs/code</option></select><button id="zipSelectedArtifactsBtn" class="secondary">ZIP selected</button><button id="deleteSelectedArtifactsBtn" class="danger">Delete selected</button></div><div id="artifactPreview" class="preview"></div><div id="artifactList" class="list"></div></div></section>
      <section class="page" id="page-adapters"><div class="panel"><div class="row"><button id="reloadAdaptersBtn">Reload adapters</button></div><div id="adapterHealth" class="list"></div></div></section>
      <section class="page" id="page-access"><div class="panel"><div class="row"><button id="loadAccessBtn">Reload users</button><button id="createUserBtn">Create user</button><button id="createGroupBtn" class="secondary">Create group</button><button id="createChatBtn" class="secondary">Add Telegram chat</button><button id="lockSessionBtn" class="secondary">Lock web session</button><button id="unlockSessionBtn" class="secondary">Unlock web session</button></div><div id="accessPanel" class="settings-grid"></div><h2>Groups</h2><div id="groupsList" class="list"></div><h2>Telegram chats</h2><div id="telegramChatsList" class="list"></div><h2>Locks</h2><div id="locksList" class="list"></div><h2>Audit</h2><div class="row"><input id="auditLimit" value="50"><button id="loadAuditBtn">Load audit</button></div><div id="auditList" class="list"></div></div></section>
      <section class="page" id="page-version"><div class="panel"><div class="row version-actions"><button id="loadVersionBtn">Check versions</button><button id="updateBtn" class="secondary">Update NordRelay</button></div><div id="versionPanel" class="list"></div><h2 class="version-update-title">Agent update jobs</h2><div id="agentUpdateJobs" class="list"></div></div></section>
      <section class="page" id="page-settings"><div class="panel"><div class="row"><button id="saveSettingsBtn">Save settings</button><button id="restartBtn" class="secondary">Restart NordRelay</button><span id="settingsStatus"></span></div><div id="settingsTabs" class="tabs"></div><div id="settingsForm" class="settings-grid"></div></div></section>
      <section class="page" id="page-logs"><div class="panel"><div class="row"><select id="logTarget"><option value="connector">Connector</option><option value="update">NordRelay Update</option><option value="agent-updates">Agent Updates</option></select><select id="logLevel"><option value="all">All levels</option><option value="ERROR">Error</option><option value="WARN">Warn</option><option value="INFO">Info</option></select><input id="logSearch"><input id="logSince" type="datetime-local"><input id="logLines" value="120"><label class="checkbox"><input id="logAutoRefresh" type="checkbox"> Auto</label><label class="checkbox"><input id="logFollow" type="checkbox"> Follow</label><button id="loadLogsBtn">Load logs</button><button id="downloadLogsBtn" class="secondary">Download</button><button id="clearLogsBtn" class="danger">Clear</button></div><pre id="logs" class="log-view"></pre></div></section>
      <section class="page" id="page-diagnostics"><div class="panel"><div id="diagnostics" class="list"></div></div></section>
      <footer><span id="footerVersion">NordRelay</span><span id="footerHealth">Health: loading</span><span id="footerUser">User: loading</span></footer>
    </main>
  </div>
  <dialog id="newSessionDialog"><form method="dialog" id="newSessionForm"><h2>New Session</h2><div class="form-grid"><label>Agent<select id="newAgent"></select></label><label>Workspace<input id="newWorkspace" list="workspaceOptions"></label><label>Model<select id="newModel"></select></label><label id="newReasoningWrap">Reasoning<select id="newReasoning"></select></label><label id="newLaunchWrap">Launch profile<select id="newLaunch"></select></label><label id="newFastWrap" class="checkbox"><input id="newFast" type="checkbox"> Fast mode</label></div><datalist id="workspaceOptions"></datalist><div class="row dialog-actions"><button type="button" id="cancelSessionBtn" class="secondary">Cancel</button><button id="createSessionBtn" value="default">Create session</button></div></form></dialog>
  <dialog id="sessionDetailDialog"><div id="sessionDetail"></div><div class="row dialog-actions"><button id="closeSessionDetailBtn" class="secondary">Close</button></div></dialog>
  <dialog id="adminDialog"><form method="dialog" id="adminDialogForm"><h2 id="adminDialogTitle">Edit</h2><div id="adminDialogBody" class="form-grid"></div><div class="row dialog-actions"><button type="button" id="adminDialogCancel" class="secondary">Cancel</button><button id="adminDialogSubmit" value="default">Save</button></div></form></dialog>
  <div id="toolTooltip" class="tool-tooltip"></div><div id="toast"></div><script src="/assets/dashboard.js"></script>
</body>
</html>`;
}

function apiResponse(url: URL, method: string, body: unknown, jobs: unknown[]): unknown {
  const session = sessionInfo((body as { agentId?: string } | null)?.agentId || "codex");
  if (url.pathname === "/api/bootstrap") return bootstrap(session);
  if (url.pathname === "/api/chat/history") return method === "DELETE" ? { messages: [], removed: 1 } : { messages: chatMessages() };
  if (url.pathname === "/api/queue") return { queue: [], paused: false };
  if (url.pathname === "/api/prompt") return { queued: true, queueId: "queue-web-1", files: [] };
  if (url.pathname === "/api/settings") return method === "PATCH" ? { envPath: "/tmp/nordrelay.env", changedKeys: ["NORDRELAY_CODEX_ENABLED"], restartRequired: true, errors: [] } : settings();
  if (url.pathname === "/api/version") return version();
  if (url.pathname === "/api/agent-updates") return { jobs };
  if (url.pathname === "/api/agent-update") {
    const job = updateJob(body);
    jobs.unshift(job);
    return { job };
  }
  if (url.pathname === "/api/adapters/health") return { adapters: adaptersHealth() };
  if (url.pathname === "/api/tasks" || url.pathname === "/api/progress") return { current: null, external: null, queue: [], queuePaused: false, recent: [] };
  if (url.pathname === "/api/sessions") return sessions();
  if (url.pathname === "/api/sessions/detail") return sessionDetail();
  if (url.pathname === "/api/control-options") return controls(url.searchParams.get("agent") || "codex");
  if (url.pathname === "/api/agent") return { session };
  if (url.pathname === "/api/activity") return { events: [] };
  if (url.pathname === "/api/artifacts") return { reports: [] };
  if (url.pathname === "/api/logs") return { filePath: "/tmp/nordrelay.log", requestedLines: 120, lineCount: 2, updatedAt: new Date().toISOString(), plain: "2026-05-14 10:00:00 INFO Started\n2026-05-14 10:01:00 WARN Slow check" };
  if (url.pathname === "/api/logs/clear") return { filePath: "/tmp/nordrelay.log", clearedAt: new Date().toISOString() };
  if (url.pathname === "/api/diagnostics") return { health: health(), versionChecks: version().versionChecks, snapshot: bootstrap(session).status.snapshot, runtime: { stateBackend: "json", sourceWorkspace: "/tmp/project", queuePaused: false, externalMirror: null, agentDiagnostics: { lines: [] } } };
  if (url.pathname === "/api/users") return users();
  if (url.pathname === "/api/locks") return { locks: [] };
  if (url.pathname === "/api/audit") return { events: [] };
  if (url.pathname === "/api/auth/status") return { agentId: url.searchParams.get("agent") || "codex", agentLabel: "Codex", supported: true, authenticated: true, detail: "authenticated", loginSupported: true, logoutSupported: true };
  if (url.pathname === "/api/auth/login" || url.pathname === "/api/auth/logout") return { agentId: "codex", agentLabel: "Codex", supported: true, authenticated: true, detail: "ok", loginSupported: true, logoutSupported: true };
  if (url.pathname === "/api/update") return { method: "npm", logPath: "/tmp/update.log", sourceRoot: "/tmp/nordrelay", summary: "mock update" };
  if (url.pathname === "/api/runtime/restart" || url.pathname === "/api/abort" || url.pathname === "/api/stop") return { ok: true };
  if (url.pathname === "/api/sync") return { changed: false, changedFields: [] };
  if (url.pathname === "/api/retry") return { queued: true, queueId: "queue-retry", files: [] };
  if (url.pathname === "/api/handback") return { command: "nordrelay handback mock" };
  return {};
}

function bootstrap(session = sessionInfo("codex")) {
  return {
    auth: currentUser(),
    channels: listChannelDescriptors(),
    agentAdapters: listAgentAdapterDescriptors(),
    enabledAgents: ["codex", "pi"],
    controls: controls(session.agentId),
    status: {
      health: { version: "0.5.0", state: { status: "ready" } },
      snapshot: {
        session,
        sessionText: "Agent: " + session.agentLabel + "\nThread: " + session.threadId,
        queue: [],
        queuePaused: false,
        processing: false,
        enabledAgents: ["codex", "pi"],
        workspaces: ["/tmp/project"],
      },
    },
  };
}

function sessionInfo(agentId = "codex") {
  const pi = agentId === "pi";
  return {
    agentId,
    agentLabel: pi ? "Pi" : "Codex",
    threadId: pi ? "pi-thread-1" : "codex-thread-1",
    workspace: "/tmp/project",
    cwd: "/tmp/project",
    model: pi ? "pi-default" : "gpt-5.5",
    reasoningEffort: "high",
    fastMode: !pi,
    capabilities: pi ? PI_AGENT_CAPABILITIES : CODEX_AGENT_CAPABILITIES,
  };
}

function controls(agentId = "codex") {
  const pi = agentId === "pi";
  return {
    models: [{ slug: pi ? "pi-default" : "gpt-5.5", displayName: pi ? "Pi Default" : "GPT-5.5", supportsImages: true, supportsThinking: true }],
    reasoningLabel: pi ? "Thinking" : "Reasoning",
    reasoningOptions: ["low", "medium", "high", "xhigh"],
    launchProfiles: [{ id: "default", label: "Default", behavior: "workspace-write / never", unsafe: false }],
    workspaces: ["/tmp/project"],
    capabilities: pi ? PI_AGENT_CAPABILITIES : CODEX_AGENT_CAPABILITIES,
  };
}

function currentUser() {
  return {
    user: { id: "user-1", email: "admin@example.com", displayName: "Admin", active: true, createdAt: now(), updatedAt: now() },
    groups: [{ id: "admin", name: "Admin", description: "Full access", permissions: permissions(), system: true, agentIds: [], workspaceRoots: [], telegramChatIds: [], createdAt: now(), updatedAt: now() }],
    permissions: permissions(),
  };
}

function permissions() {
  return ["inspect", "sessions.read", "sessions.write", "prompt.send", "prompt.abort", "files.read", "files.write", "settings.read", "settings.write", "auth.manage", "diagnostics.read", "logs.read", "logs.clear", "queue.read", "queue.write", "updates.run", "system.restart", "users.read", "users.write", "audit.read"];
}

function chatMessages() {
  return [
    { id: "m1", threadId: "codex-thread-1", role: "user", text: "Existing web message", timestamp: now(), source: "web" },
    { id: "m2", threadId: "codex-thread-1", role: "agent", text: "Existing agent response", timestamp: now(), source: "web" },
  ];
}

function sessions() {
  return {
    sessions: [{ id: "codex-thread-1", agentId: "codex", title: "Existing session", cwd: "/tmp/project", updatedAt: now(), firstUserMessage: "Existing web message" }],
    pagination: { page: 1, pageSize: 50, hasPrevious: false, hasNext: false },
  };
}

function sessionDetail() {
  return {
    record: { id: "codex-thread-1", agentId: "codex", cwd: "/tmp/project", model: "gpt-5.5", reasoningEffort: "high", updatedAt: now(), sessionPath: "/tmp/session.json" },
    messages: chatMessages(),
    activity: [],
    usageRows: [["Context", "12%"], ["Tokens", "1.2K in / 320 out"]],
  };
}

function settings() {
  return {
    envPath: "/tmp/nordrelay.env",
    settings: [
      { key: "NORDRELAY_CODEX_ENABLED", label: "Enable Codex", description: "Allow Codex sessions.", group: "Agents", kind: "boolean", value: "true", effectiveValue: "true", configured: true, masked: false, restartRequired: true },
      { key: "NORDRELAY_PI_ENABLED", label: "Enable Pi", description: "Allow Pi sessions.", group: "Agents", kind: "boolean", value: "", effectiveValue: "false", configured: false, masked: false, restartRequired: true },
    ],
  };
}

function version() {
  return {
    health: health(),
    state: { status: "ready" },
    versionChecks: {
      nordrelay: { label: "NordRelay", packageName: "@nordbyte/nordrelay", installedLabel: "0.5.0", installedVersion: "0.5.0", latestVersion: "0.5.0", status: "current" },
      codex: { label: "Codex CLI", packageName: "@openai/codex", installedLabel: "0.130.0", installedVersion: "0.130.0", latestVersion: "0.130.0", status: "current" },
      pi: { label: "Pi CLI", packageName: "@earendil-works/pi-coding-agent", installedLabel: "not installed", installedVersion: null, latestVersion: "1.2.3", status: "not-installed" },
      hermes: { label: "Hermes CLI", packageName: "hermes-agent", installedLabel: "0.1.0", installedVersion: "0.1.0", latestVersion: "0.1.0", status: "current" },
      openclaw: { label: "OpenClaw CLI", packageName: "openclaw", installedLabel: "0.1.0", installedVersion: "0.1.0", latestVersion: "0.1.0", status: "current" },
      claudeCode: { label: "Claude Code CLI", packageName: "@anthropic-ai/claude-code", installedLabel: "0.1.0", installedVersion: "0.1.0", latestVersion: "0.1.0", status: "current" },
    },
  };
}

function health() {
  return {
    version: "0.5.0",
    state: { status: "ready" },
    pidRunning: true,
    appPidRunning: true,
    codexCli: "codex",
    codexCliPath: "/usr/bin/codex",
    codexCliVersion: "0.130.0",
    piCli: "pi",
    piCliPath: null,
    piCliVersion: "not installed",
    hermesCli: "hermes",
    hermesCliPath: "/usr/bin/hermes",
    hermesCliVersion: "0.1.0",
    openClawCli: "openclaw",
    openClawCliPath: "/usr/bin/openclaw",
    openClawCliVersion: "0.1.0",
    claudeCodeCli: "claude",
    claudeCodeCliPath: "/usr/bin/claude",
    claudeCodeCliVersion: "0.1.0",
    stateFile: "/tmp/state.json",
    logFile: "/tmp/nordrelay.log",
    databasePath: null,
    uptimeSeconds: 12,
  };
}

function adaptersHealth() {
  return listAgentAdapterDescriptors().map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    enabled: adapter.id === "codex" || adapter.id === "pi",
    status: adapter.id === "codex" || adapter.id === "pi" ? "enabled" : "disabled",
    auth: { supported: adapter.capabilities.auth, authenticated: true, detail: "mock" },
    cli: { path: adapter.id === "pi" ? null : "/usr/bin/" + adapter.id, label: adapter.label, version: adapter.id === "pi" ? "not installed" : "0.1.0" },
    version: { installed: adapter.id === "pi" ? "not installed" : "0.1.0", latest: "0.1.0", status: adapter.id === "pi" ? "not-installed" : "current" },
    capabilities: adapter.capabilities,
    notes: adapter.notes,
  }));
}

function updateJob(body: unknown) {
  const payload = body as { agentId?: string; operation?: string };
  return {
    id: "job-pi-install",
    agentId: payload.agentId || "pi",
    agentLabel: payload.agentId === "codex" ? "Codex" : "Pi",
    operation: payload.operation || "install",
    status: "running",
    method: "npm",
    command: "npm",
    args: ["install", "-g"],
    cwd: "/tmp",
    summary: "Installing mock agent",
    interactive: true,
    canInput: true,
    needsInput: false,
    startedAt: now(),
    updatedAt: now(),
    logPath: "/tmp/agent-update.log",
    outputTail: "Installing...",
  };
}

function users() {
  const auth = currentUser();
  return {
    users: [{ ...auth.user, groups: auth.groups, telegramIdentities: [], webSessions: [] }],
    groups: auth.groups,
    telegramChats: [],
    adminConfigured: true,
    permissions: permissions(),
  };
}

function now() {
  return "2026-05-14T10:00:00.000Z";
}

function sendSse(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": ready\n\n");
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(`${JSON.stringify(value)}\n`);
}

function sendText(res: ServerResponse, status: number, text: string, contentType: string): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(text);
}

async function readJson(req: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}
