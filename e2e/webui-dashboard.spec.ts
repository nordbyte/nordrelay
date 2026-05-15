import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test } from "@playwright/test";

import { CODEX_AGENT_CAPABILITIES, PI_AGENT_CAPABILITIES } from "../src/agent.js";
import { buildAdapterConformanceMatrix } from "../src/adapter-conformance.js";
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
    await expect(page.locator("#activeSessions")).toContainText("Source CLI");
    await expect(page.locator("#activeSessions")).toContainText("Mirroring: Telegram full, Discord final, Slack final");
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
    await page.locator('[data-setting-tab="Slack"]').click();
    await expect(page.locator('[data-setting-box="SLACK_BOT_TOKEN"] .setting-info')).toHaveAttribute("title", /Slack API Apps/);
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
    await expect(page.locator("#metricsPanel")).toContainText("Slack rate limits");
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

  test("renders Discord and Slack access controls and filters registered channels", async ({ page }) => {
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

    await expect(page.locator("#accessTabs")).toContainText("Slack");
    await page.locator('[data-access-tab="slack"]').click();
    await expect(page.locator("#slackChannelsList")).toContainText("Slack Engineering");
    await expect(page.locator("#createSlackChannelBtn")).toBeVisible();

    await page.locator("#slackChannelSearch").fill("engineering");
    await expect(page.locator("#slackChannelsList")).toContainText("Slack Engineering");
    await page.locator("#slackChannelSearch").fill("missing");
    await expect(page.locator("#slackChannelsList")).toContainText("No Slack channels registered.");
  });

  test("renders adapter conformance, artifact previews, and peer global sessions", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.goto(mock.baseUrl);

    await page.getByRole("button", { name: "Adapters" }).click();
    await expect(page.locator("#adapterConformance")).toContainText("Agent capability contract");
    await expect(page.locator("#adapterConformance")).toContainText("Channel command contract");
    await expect(page.locator("#adapterConformance")).toContainText("Codex");
    await expect(page.locator("#adapterConformance")).toContainText("Telegram");

    await page.getByRole("button", { name: "Artifacts" }).click();
    await expect(page.locator("#artifactList")).toContainText("turn-web-1");
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.locator("#artifactPreview")).toContainText("report.txt");
    await expect(page.locator("#artifactPreview")).toContainText("Artifact preview smoke");

    await page.getByRole("button", { name: "Peers" }).click();
    await expect(page.locator("#peerStatus")).toContainText("Local peer identity");
    await expect(page.locator("#peerStatus")).toContainText("Manual reachability check");
    await expect(page.locator("#peerStatus")).toContainText("nordrelay peer check https://127.0.0.1:31979");
    await page.getByRole("button", { name: "Check local endpoint" }).click();
    await expect(page.locator("#peerProbeResult")).toContainText("Local endpoint check");
    await expect(page.locator("#peerProbeResult")).toContainText("reachable");
    await expect(page.locator("#peersList")).toContainText("Ubuntu Workstation");
    await page.locator('[data-peer-probe="peer-ubuntu"]').click();
    await expect(page.locator("#peerProbeResult")).toContainText("Remote probe from Ubuntu Workstation");
    await expect(page.locator("#peerInvites")).toContainText("MacBook invite");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator('[data-peer-invite-delete="invite-1"]').click();
    expect(mock.requests.find((request) => request.path === "/api/peers/invitations/invite-1" && request.method === "DELETE")).toBeTruthy();
    await page.getByRole("button", { name: "Load global sessions" }).click();
    await expect(page.locator("#globalPeerSessionsList")).toContainText("peer-thread-1");
  });

  test("keeps newly created peer invite pairing details visible and copyable", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    const createdInvitation = {
      id: "invite-created",
      name: "NordRelay peer",
      expiresAt: "2099-05-14T10:20:00.000Z",
      scopes: ["inspect", "sessions.read"],
      allowedAgents: ["codex"],
      usedAt: null,
    };
    const pairingCode = "pair-code-123";
    const command = "nordrelay peer add https://127.0.0.1:31979 --code pair-code-123";
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as unknown as { __copiedText?: string }).__copiedText = text;
          },
        },
      });
    });
    await page.route("**/api/peers", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(peers([createdInvitation])),
      });
    });
    await page.route("**/api/peers/invite", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ invitation: createdInvitation, code: pairingCode, command }),
      });
    });

    await page.goto(mock.baseUrl);
    await page.getByRole("button", { name: "Peers" }).click();
    await page.getByRole("button", { name: "Create invite" }).click();
    await page.locator("#adminDialogSubmit").click();

    await expect(page.locator("#peerInvites")).toContainText(pairingCode);
    await expect(page.locator("#peerInvites")).toContainText(command);

    await page.locator('[data-peer-invite-copy="pair-code-123"]').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedText?: string }).__copiedText)).toBe(pairingCode);
    await page.locator('[data-peer-invite-copy^="nordrelay peer add"]').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedText?: string }).__copiedText)).toBe(command);
  });

  test("warns before creating invites when the peer server is not reachable", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.route("**/api/peers", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...peers(),
          enabled: false,
          readiness: peerReadiness({
            enabled: false,
            localListening: false,
            warnings: ["Peer server is disabled. Invites can be created, but pairing will fail until NORDRELAY_PEER_ENABLED=true and NordRelay is restarted."],
          }),
        }),
      });
    });

    await page.goto(mock.baseUrl);
    await page.getByRole("button", { name: "Peers" }).click();

    await expect(page.locator("#peerStatus")).toContainText("Peer server is disabled");
    await page.getByRole("button", { name: "Create invite" }).click();
    await expect(page.locator("#adminDialogBody")).toContainText("Pairing warning");
    await expect(page.locator("#adminDialogBody")).toContainText("pairing will fail");
    await expect(page.locator("#adminDialogSubmit")).toHaveText("Create invite anyway");
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

  test("guides channel setup through the settings wizard", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.goto(mock.baseUrl);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Setup wizard" }).click();

    await expect(page.locator("#settingsForm")).toContainText("Telegram");
    await expect(page.locator("#settingsForm")).toContainText("Discord");
    await expect(page.locator("#settingsForm")).toContainText("Slack");
    const firstWizardLink = page.locator(".wizard-links a").first();
    await expect(firstWizardLink).toHaveAttribute("target", "_blank");
    await expect(firstWizardLink).toHaveAttribute("rel", /noopener/);

    await page.locator('[data-start-wizard="telegram"]').click();
    await page.locator('[data-wizard-setting="TELEGRAM_BOT_TOKEN"]').fill("123456789:AABCDEFGHIJKLMNOPQRSTUVXYZ123456");
    await page.getByRole("button", { name: "Test setup" }).click();
    await expect(page.locator("#wizardTestResult")).toContainText("Telegram API");

    await page.getByRole("button", { name: "Save wizard settings" }).click();
    const wizardRequest = mock.requests.find((request) => request.path === "/api/settings" && request.method === "PATCH" && JSON.stringify(request.body).includes("TELEGRAM_BOT_TOKEN"));
    expect(wizardRequest?.body).toMatchObject({
      settings: {
        TELEGRAM_ENABLED: "true",
        TELEGRAM_TRANSPORT: "polling",
        TELEGRAM_BOT_TOKEN: "123456789:AABCDEFGHIJKLMNOPQRSTUVXYZ123456",
      },
    });
  });

  test("treats configured masked Telegram secrets as present in setup wizard status", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(settingsWithConfiguredTelegramToken()),
      });
    });

    await page.goto(mock.baseUrl);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Setup wizard" }).click();

    const telegramCard = page.locator(".wizard-card").filter({ hasText: "Telegram" });
    await expect(telegramCard).toContainText("ready");
    await expect(telegramCard).not.toContainText("Missing: TELEGRAM_BOT_TOKEN");
  });

  test("blocks wizard save while required settings are missing", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.goto(mock.baseUrl);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Setup wizard" }).click();
    await page.locator('[data-start-wizard="discord"]').click();

    await expect(page.locator("#wizardErrors")).toContainText("Discord bot token is required");
    await expect(page.locator("#wizardErrors")).toContainText("Discord client ID is required");
    await expect(page.getByRole("button", { name: "Save wizard settings" })).toBeDisabled();
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
  if (url.pathname === "/api/settings") return method === "PATCH" ? settingsPatchResponse(body) : settings();
  if (url.pathname === "/api/settings/wizard/test") return wizardTestResponse(body);
  if (url.pathname === "/api/active-sessions") return activeSessions();
  if (url.pathname === "/api/version") return version();
  if (url.pathname === "/api/agent-updates") return { jobs };
  if (url.pathname === "/api/agent-update") {
    const job = updateJob(body);
    jobs.unshift(job);
    return { job };
  }
  if (url.pathname === "/api/adapters/health") return { adapters: adaptersHealth() };
  if (url.pathname === "/api/adapters/conformance") return buildAdapterConformanceMatrix();
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
  if (url.pathname === "/api/artifacts") return artifacts();
  if (url.pathname === "/api/artifacts/preview") return artifactPreview(url.searchParams.get("path") || "report.txt");
  if (url.pathname === "/api/artifacts/file") return { name: "report.txt", mimeType: "text/plain", dataBase64: Buffer.from("Artifact preview smoke\n").toString("base64") };
  if (url.pathname === "/api/artifacts/zip") return { name: "turn-web-1.zip", mimeType: "application/zip", dataBase64: Buffer.from("zip").toString("base64") };
  if (url.pathname === "/api/logs") return { filePath: "/tmp/nordrelay.log", requestedLines: 120, lineCount: 2, updatedAt: new Date().toISOString(), plain: "2026-05-14 10:00:00 INFO Started\n2026-05-14 10:01:00 WARN Slow check" };
  if (url.pathname === "/api/logs/clear") return { filePath: "/tmp/nordrelay.log", clearedAt: new Date().toISOString() };
  if (url.pathname === "/api/diagnostics") return { health: health(), versionChecks: version().versionChecks, snapshot: bootstrap(session).status.snapshot, runtime: { stateBackend: "json", sourceWorkspace: "/tmp/project", queuePaused: false, externalMirror: null, agentDiagnostics: { lines: [] } } };
  if (url.pathname === "/api/users") return users();
  if (url.pathname === "/api/locks") return { locks: [] };
  if (url.pathname === "/api/audit") return { events: [] };
  if (url.pathname === "/api/auth/status") return { agentId: url.searchParams.get("agent") || "codex", agentLabel: "Codex", supported: true, authenticated: true, detail: "authenticated", loginSupported: true, logoutSupported: true };
  if (url.pathname === "/api/auth/login" || url.pathname === "/api/auth/logout") return { agentId: "codex", agentLabel: "Codex", supported: true, authenticated: true, detail: "ok", loginSupported: true, logoutSupported: true };
  if (url.pathname === "/api/update") return { method: "npm", logPath: "/tmp/update.log", sourceRoot: "/tmp/nordrelay", summary: "mock update" };
  if (url.pathname === "/api/peers") return peers();
  if (url.pathname === "/api/peers/probe") return peerProbe(body);
  if (url.pathname === "/api/peers/global-sessions") return globalPeerSessions();
  if (url.pathname.match(/^\/api\/peers\/invitations\/[^/]+$/) && method === "DELETE") return { removed: true };
  if (url.pathname.match(/^\/api\/peers\/[^/]+\/health$/)) return { data: { version: "0.7.0" } };
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
    process: {
      pid: 1234,
      nodeVersion: "v24.13.0",
      platform: "linux",
      arch: "x64",
      uptimeMs: 12_000,
      startedAt: new Date().toISOString(),
      memory: {
        rssBytes: 128 * 1024 * 1024,
        heapTotalBytes: 64 * 1024 * 1024,
        heapUsedBytes: 32 * 1024 * 1024,
        externalBytes: 1024,
        arrayBuffersBytes: 512,
      },
      cpu: {
        userMs: 120,
        systemMs: 30,
        totalMs: 150,
        percentSinceStart: 1.25,
      },
      eventLoop: {
        delayMeanMs: 1.1,
        delayMaxMs: 8.5,
        delayP95Ms: 3.4,
      },
    },
    adapters: {
      telegram: { queued: 0, running: 0, completed: 2, failed: 0, retries: 0, rateLimitHits: 0, buckets: [] },
      discord: { queued: 0, running: 0, completed: 1, failed: 0, retries: 0, rateLimitHits: 0, buckets: [] },
      slack: { queued: 0, running: 0, completed: 1, failed: 0, retries: 0, rateLimitHits: 0, buckets: [] },
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
    groups: [{ id: "admin", name: "Admin", description: "Full access", permissions: permissions(), system: true, agentIds: [], workspaceRoots: [], telegramChatIds: [], discordChannelIds: [], slackChannelIds: [], createdAt: now(), updatedAt: now() }],
    permissions: permissions(),
  };
}

function permissions() {
  return ["inspect", "sessions.read", "sessions.write", "prompt.send", "prompt.abort", "files.read", "files.write", "settings.read", "settings.write", "auth.manage", "diagnostics.read", "logs.read", "logs.clear", "queue.read", "queue.write", "updates.run", "system.restart", "users.read", "users.write", "audit.read", "peers.read", "peers.write", "peers.connect"];
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
        contextKey: "cli:codex:codex-thread-1",
        sourceContextKey: "cli:codex:codex-thread-1",
        source: "cli",
        status: "external",
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
        mirrorChannels: [
          { source: "telegram", contextKey: "123456789", mode: "full", queueLength: 0, queuePaused: false },
          { source: "discord", contextKey: "discord:guild:channel", mode: "final", queueLength: 0, queuePaused: false },
          { source: "slack", contextKey: "slack:T123:C123", mode: "final", queueLength: 0, queuePaused: false },
        ],
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

function artifacts() {
  return {
    reports: [
      {
        turnId: "turn-web-1",
        outDir: "/tmp/project/.nordrelay-artifacts/turn-web-1",
        updatedAt: now(),
        fileCount: 1,
        skippedCount: 0,
        totalSizeBytes: 42,
        source: "turn",
        artifacts: [
          {
            name: "report.txt",
            relativePath: "report.txt",
            sizeBytes: 42,
            mimeType: "text/plain",
            modifiedAt: now(),
          },
        ],
      },
    ],
  };
}

function artifactPreview(path: string) {
  return {
    kind: "text",
    name: path.split("/").pop() || "report.txt",
    sizeBytes: 42,
    truncated: false,
    text: "const message = 'Artifact preview smoke';\n",
  };
}

function settings() {
  return {
    envPath: "/tmp/nordrelay.env",
    settings: [
      settingRecord("NORDRELAY_CODEX_ENABLED", "Enable Codex", "Agents", "boolean", "Allow Codex sessions.", "true", "true", true),
      settingRecord("NORDRELAY_PI_ENABLED", "Enable Pi", "Agents", "boolean", "Allow Pi sessions.", "", "false", false),
      settingRecord("TELEGRAM_ENABLED", "Enable Telegram", "Telegram", "boolean", "Start the Telegram bot adapter.", "", "false", false),
      settingRecord("TELEGRAM_BOT_TOKEN", "Telegram bot token", "Telegram", "secret", "BotFather token.", "", "", false, undefined, "Telegram BotFather: open @BotFather, create a bot with /newbot, then paste only the token value."),
      settingRecord("TELEGRAM_TRANSPORT", "Telegram transport", "Telegram", "string", "polling or webhook.", "", "polling", false, ["polling", "webhook"]),
      settingRecord("TELEGRAM_WEBHOOK_URL", "Webhook public URL", "Telegram", "string", "Public base URL for webhook mode.", "", "", false),
      settingRecord("TELEGRAM_WEBHOOK_HOST", "Webhook bind host", "Telegram", "string", "Local webhook bind host.", "", "127.0.0.1", false),
      settingRecord("TELEGRAM_WEBHOOK_PORT", "Webhook bind port", "Telegram", "number", "Local webhook bind port.", "", "8080", false),
      settingRecord("TELEGRAM_WEBHOOK_PATH", "Webhook path", "Telegram", "string", "Webhook request path.", "", "/telegram/webhook", false),
      settingRecord("TELEGRAM_WEBHOOK_SECRET", "Webhook secret", "Telegram", "secret", "Optional Telegram webhook secret token.", "", "", false),
      settingRecord("DISCORD_ENABLED", "Enable Discord", "Discord", "boolean", "Start the Discord bot adapter.", "", "false", false),
      settingRecord("DISCORD_BOT_TOKEN", "Discord bot token", "Discord", "secret", "Discord bot token.", "", "", false, undefined, "Discord Developer Portal: open your application, go to Bot, then copy or reset the bot token."),
      settingRecord("DISCORD_CLIENT_ID", "Discord client ID", "Discord", "string", "Discord application/client id used for slash command registration.", "", "", false, undefined, "Discord Developer Portal: open your application, go to General Information, then copy Application ID."),
      settingRecord("DISCORD_GUILD_IDS", "Discord guild IDs", "Discord", "list", "Comma-separated guild ids for instant guild slash-command registration.", "", "", false),
      settingRecord("DISCORD_ALLOWED_GUILD_IDS", "Allowed Discord guilds", "Discord", "list", "Optional comma-separated guild allow-list.", "", "", false),
      settingRecord("DISCORD_ALLOWED_CHANNEL_IDS", "Allowed Discord channels", "Discord", "list", "Optional comma-separated channel allow-list before user/group checks.", "", "", false),
      settingRecord("DISCORD_MESSAGE_CONTENT_ENABLED", "Message content intent", "Discord", "boolean", "Read regular Discord text messages as prompts.", "", "true", false),
      settingRecord("DISCORD_COMMAND_MODE", "Discord command mode", "Discord", "string", "slash, message, or both.", "", "both", false, ["slash", "message", "both"]),
      settingRecord("DISCORD_AUTO_REGISTER_COMMANDS", "Auto-register slash commands", "Discord", "boolean", "Register Discord slash commands on startup.", "", "true", false),
      settingRecord("SLACK_ENABLED", "Enable Slack", "Slack", "boolean", "Start the Slack bot adapter.", "", "false", false),
      settingRecord("SLACK_BOT_TOKEN", "Slack bot token", "Slack", "secret", "Slack bot token.", "", "", false, undefined, "Slack API Apps: open your app, then copy the OAuth bot token from OAuth & Permissions."),
      settingRecord("SLACK_APP_TOKEN", "Slack app token", "Slack", "secret", "Slack app-level token for Socket Mode.", "", "", false),
      settingRecord("SLACK_SIGNING_SECRET", "Slack signing secret", "Slack", "secret", "Slack signing secret for HTTP Events mode.", "", "", false),
      settingRecord("SLACK_SOCKET_MODE", "Slack Socket Mode", "Slack", "boolean", "Use Slack Socket Mode instead of an HTTP events receiver.", "", "true", false),
      settingRecord("SLACK_PORT", "Slack HTTP port", "Slack", "number", "HTTP port used when Slack Socket Mode is disabled.", "", "3000", false),
      settingRecord("SLACK_ALLOWED_TEAM_IDS", "Allowed Slack teams", "Slack", "list", "Optional comma-separated Slack team/workspace allow-list.", "", "", false),
      settingRecord("SLACK_ALLOWED_CHANNEL_IDS", "Allowed Slack channels", "Slack", "list", "Optional comma-separated Slack channel allow-list.", "", "", false),
      settingRecord("SLACK_MESSAGE_CONTENT_ENABLED", "Slack message content", "Slack", "boolean", "Read regular Slack text messages as prompts.", "", "true", false),
      settingRecord("SLACK_COMMAND", "Slack Slash command", "Slack", "string", "Slash command configured in Slack.", "", "/nordrelay", false),
    ],
  };
}

function settingsWithConfiguredTelegramToken() {
  const snapshot = settings();
  const token = snapshot.settings.find((setting) => setting.key === "TELEGRAM_BOT_TOKEN");
  if (token) {
    token.value = "12345...masked";
    token.effectiveValue = "12345...masked";
    token.configured = true;
    token.masked = true;
  }
  return snapshot;
}

function settingRecord(key: string, label: string, group: string, kind: string, description: string, value: string, effectiveValue: string, configured: boolean, options?: string[], help?: string) {
  return { key, label, group, kind, description, value, effectiveValue, configured, options, help, masked: kind === "secret" && Boolean(effectiveValue), restartRequired: true };
}

function settingsPatchResponse(body: unknown) {
  const payload = body as { settings?: Record<string, string> };
  return {
    envPath: "/tmp/nordrelay.env",
    changedKeys: Object.keys(payload.settings || {}),
    restartRequired: true,
    errors: [],
  };
}

function wizardTestResponse(body: unknown) {
  const payload = body as { channel?: string };
  return {
    channel: payload.channel || "telegram",
    checkedAt: now(),
    checks: [
      { label: "Local validation", status: "ok", detail: "Required settings are present." },
      { label: `${payload.channel === "discord" ? "Discord" : payload.channel === "slack" ? "Slack" : "Telegram"} API`, status: "warn", detail: "Mock live check." },
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
        slackIdentities: [{ id: "slack-identity-1", userId: "user-1", slackUserId: "U123", teamId: "T123", username: "admin", active: true, createdAt: now(), updatedAt: now() }],
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
    slackChannels: [
      {
        id: "slack-channel-1",
        teamId: "T123",
        channelId: "C123",
        title: "Slack Engineering",
        type: "channel",
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

function peers(extraInvitations: unknown[] = []) {
  return {
    enabled: true,
    listenUrl: "https://127.0.0.1:31979",
    requireTls: true,
    readiness: peerReadiness(),
    identity: { nodeId: "local-node", fingerprint: "local-fingerprint" },
    peers: [
      {
        id: "peer-ubuntu",
        name: "Ubuntu Workstation",
        enabled: true,
        url: "https://10.0.0.12:31979",
        nodeId: "remote-node",
        fingerprint: "remote-fingerprint",
        direction: "outbound",
        scopes: ["inspect", "sessions.read", "prompt.send"],
        allowedAgents: ["codex", "pi"],
        allowedWorkspaceRoots: ["/srv/projects"],
        workspaceAliases: { demo: "/srv/projects/demo" },
        remoteStatus: "ready",
        remoteVersion: "0.7.0",
        lastLatencyMs: 24,
        lastCheckedAt: now(),
        lastSeenAt: now(),
      },
    ],
    invitations: [
      {
        id: "invite-1",
        name: "MacBook invite",
        expiresAt: "2099-05-14T10:10:00.000Z",
        scopes: ["inspect", "sessions.read"],
        allowedAgents: ["codex"],
        usedAt: null,
      },
      ...extraInvitations,
    ],
  };
}

function peerReadiness(patch: Record<string, unknown> = {}) {
  return {
    enabled: true,
    listenUrl: "https://127.0.0.1:31979",
    bindHost: "127.0.0.1",
    port: 31979,
    tlsEnabled: true,
    requireTls: true,
    localListening: true,
    loopbackOnly: true,
    bindLoopbackOnly: true,
    manualCheckCommand: "nordrelay peer check https://127.0.0.1:31979",
    warnings: ["Listen URL uses a loopback host. Other machines cannot reach this URL unless they run on the same host."],
    ...patch,
  };
}

function peerProbe(body: unknown) {
  const payload = body as { peerId?: string };
  return {
    type: payload.peerId ? "remote" : "local",
    peerId: payload.peerId,
    readiness: peerReadiness(),
    probe: {
      ok: true,
      status: "reachable",
      url: "https://127.0.0.1:31979/peer/healthz",
      latencyMs: 12,
      statusCode: 200,
      tlsFingerprint: "mock-tls-fingerprint",
      detail: "Peer health endpoint is reachable.",
    },
  };
}

function globalPeerSessions() {
  return {
    targets: [
      {
        peerId: "peer-ubuntu",
        peerName: "Ubuntu Workstation",
        ok: true,
        data: {
          sessions: [
            {
              id: "peer-thread-1",
              title: "Peer smoke session",
              cwd: "/srv/projects/demo",
              updatedAt: now(),
            },
          ],
        },
      },
    ],
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
