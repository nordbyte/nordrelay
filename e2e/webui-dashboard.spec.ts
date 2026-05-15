import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test } from "@playwright/test";

import { CODEX_AGENT_CAPABILITIES, PI_AGENT_CAPABILITIES } from "../src/agent.js";
import { listAgentAdapterDescriptors } from "../src/agent-adapter.js";
import { listChannelDescriptors } from "../src/channel-adapter.js";
import { dashboardCss, dashboardJs } from "../src/web-dashboard-assets.js";
import { renderDashboardApp } from "../src/web-dashboard-pages.js";

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
    await expect(page.getByRole("heading", { name: "Active Sessions" })).toBeVisible();
    await expect(page.locator("#activeSessions")).toContainText("Run active smoke test");
    await expect(page.locator("#activeSessions")).toContainText("exec_command");
    await expect(page.locator("#agentAdapters")).toContainText("Codex");
    await expect(page.locator("#chatAdapters")).toContainText("Telegram");
    await expect(page.locator("#footerHealth")).toContainText("Health: ready");

    await page.getByRole("button", { name: "Chat" }).click();
    await expect(page.locator("#messages")).toContainText("Existing web message");
    await expect(page.locator("#messages")).toHaveCSS("overflow-y", "auto");

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.locator("#settingsTabs")).toContainText("Agents");
    await expect(page.locator("#settingsForm")).toContainText("Enable Codex");
    await page.locator('[data-setting-tab="Discord"]').click();
    await expect(page.locator('[data-setting-box="DISCORD_BOT_TOKEN"] .setting-info')).toHaveAttribute("title", /Discord Developer Portal/);
    await page.locator('[data-setting-tab="Agents"]').click();

    await page.locator('[data-setting="NORDRELAY_PI_ENABLED"]').selectOption("true");
    await expect(page.locator("#settingsStatus")).toContainText("1 unsaved change");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.locator("#settingsStatus")).toContainText("Saved 1 setting");
    const settingsRequest = mock.requests.find((request) => request.path === "/api/settings" && request.method === "PATCH");
    expect(settingsRequest?.body).toMatchObject({ settings: { NORDRELAY_PI_ENABLED: "true" } });

    await page.getByRole("button", { name: "Version" }).click();
    await expect(page.locator("#versionPanel")).toContainText("NordRelay");
    await expect(page.locator("#agentUpdateJobs")).toContainText("No agent update jobs");

    await page.getByRole("button", { name: "Tasks" }).click();
    await expect(page.locator("#tasksList")).toContainText("Unified jobs");
    await expect(page.locator("#tasksList")).toContainText("Queued prompt queue-web-1");

    await page.getByRole("button", { name: "Metrics" }).click();
    await expect(page.locator("#metricsPanel")).toContainText("Runtime");
    await expect(page.locator("#metricsPanel")).toContainText("Telegram rate limits");
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

  test("renders Discord access controls and filters registered channels", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.goto(mock.baseUrl);
    await page.getByRole("button", { name: "Users" }).click();

    await expect(page.locator("#accessTabs")).toContainText("Discord");
    await page.locator('[data-access-tab="discord"]').click();
    await expect(page.locator("#discordChannelsList")).toContainText("Engineering Ops");
    await expect(page.locator("#createDiscordChannelBtn")).toBeVisible();

    await page.locator("#discordChannelSearch").fill("ops");
    await expect(page.locator("#discordChannelsList")).toContainText("Engineering Ops");
    await page.locator("#discordChannelSearch").fill("missing");
    await expect(page.locator("#discordChannelsList")).toContainText("No Discord channels registered.");
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
    if (url.pathname === "/") return sendText(res, 200, renderDashboardApp(), "text/html; charset=utf-8");
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

function apiResponse(url: URL, method: string, body: unknown, jobs: unknown[]): unknown {
  const session = sessionInfo((body as { agentId?: string } | null)?.agentId || "codex");
  if (url.pathname === "/api/bootstrap") return bootstrap(session);
  if (url.pathname === "/api/chat/history") return method === "DELETE" ? { messages: [], removed: 1 } : { messages: chatMessages() };
  if (url.pathname === "/api/queue") return { queue: [], paused: false };
  if (url.pathname === "/api/prompt") return { queued: true, queueId: "queue-web-1", files: [] };
  if (url.pathname === "/api/settings") return method === "PATCH" ? { envPath: "/tmp/nordrelay.env", changedKeys: ["NORDRELAY_PI_ENABLED"], restartRequired: true, errors: [] } : settings();
  if (url.pathname === "/api/active-sessions") return activeSessions();
  if (url.pathname === "/api/version") return version();
  if (url.pathname === "/api/agent-updates") return { jobs };
  if (url.pathname === "/api/agent-update") {
    const job = updateJob(body);
    jobs.unshift(job);
    return { job };
  }
  if (url.pathname === "/api/adapters/health") return { adapters: adaptersHealth() };
  if (url.pathname === "/api/tasks" || url.pathname === "/api/progress") return { current: null, external: null, queue: [], queuePaused: false, recent: [] };
  if (url.pathname === "/api/metrics") return metrics();
  if (url.pathname === "/api/jobs") return jobsList();
  if (url.pathname.match(/^\/api\/jobs\/[^/]+\/log$/)) return { job: jobsList().jobs[0], plain: "Queued prompt log" };
  if (url.pathname.match(/^\/api\/jobs\/[^/]+\/action$/)) return jobsList();
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

function metrics() {
  return {
    generatedAt: new Date().toISOString(),
    queue: { length: 1, paused: false },
    turns: { active: 1, completed: 4, failed: 0, aborted: 0, averageDurationMs: 1200 },
    jobs: { total: 2, queued: 1, running: 1, completed: 0, failed: 0, aborted: 0 },
    adapters: {
      telegram: { queued: 0, running: 0, completed: 2, failed: 0, retries: 0, rateLimitHits: 0, buckets: [] },
      discord: { queued: 0, running: 0, completed: 1, failed: 0, retries: 0, rateLimitHits: 0, buckets: [] },
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
    groups: [{ id: "admin", name: "Admin", description: "Full access", permissions: permissions(), system: true, agentIds: [], workspaceRoots: [], telegramChatIds: [], discordChannelIds: [], createdAt: now(), updatedAt: now() }],
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

function activeSessions() {
  return {
    updatedAt: now(),
    sessions: [
      {
        id: "web:dashboard:codex-thread-1",
        contextKey: "web:dashboard",
        source: "web",
        status: "running",
        agentId: "codex",
        agentLabel: "Codex",
        threadId: "codex-thread-1",
        workspace: "/tmp/project",
        prompt: "Run active smoke test",
        currentTool: "exec_command",
        startedAt: now(),
        updatedAt: now(),
        durationMs: 12000,
        queueLength: 1,
        queuePaused: false,
      },
    ],
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

function jobsList() {
  return {
    updatedAt: now(),
    jobs: [
      {
        id: "queue:queue-web-1",
        kind: "queued-prompt",
        title: "Queued prompt queue-web-1",
        status: "queued",
        source: "web",
        threadId: "codex-thread-1",
        workspace: "/tmp/project",
        startedAt: now(),
        updatedAt: now(),
        summary: "Run a browser smoke test",
        queueId: "queue-web-1",
        canCancel: true,
        canRetry: true,
        canReadLog: true,
      },
    ],
  };
}

function settings() {
  return {
    envPath: "/tmp/nordrelay.env",
    settings: [
      { key: "NORDRELAY_CODEX_ENABLED", label: "Enable Codex", description: "Allow Codex sessions.", group: "Agents", kind: "boolean", value: "true", effectiveValue: "true", configured: true, masked: false, restartRequired: true },
      { key: "NORDRELAY_PI_ENABLED", label: "Enable Pi", description: "Allow Pi sessions.", group: "Agents", kind: "boolean", value: "", effectiveValue: "false", configured: false, masked: false, restartRequired: true },
      { key: "DISCORD_BOT_TOKEN", label: "Discord bot token", description: "Discord bot token.", help: "Discord Developer Portal: open your application, go to Bot, then copy or reset the bot token.", group: "Discord", kind: "secret", value: "", effectiveValue: "", configured: false, masked: false, restartRequired: true },
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
    users: [
      {
        ...auth.user,
        groups: auth.groups,
        telegramIdentities: [],
        discordIdentities: [{ id: "discord-identity-1", userId: "user-1", discordUserId: "112233445566778899", username: "admin", createdAt: now(), updatedAt: now() }],
        webSessions: [],
      },
    ],
    groups: auth.groups,
    telegramChats: [],
    discordChannels: [
      {
        id: "discord-channel-1",
        guildId: "987654321012345678",
        channelId: "123456789012345678",
        title: "Engineering Ops",
        type: "guild",
        enabled: true,
        allowedGroupIds: ["admin"],
        createdAt: now(),
        updatedAt: now(),
      },
    ],
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
