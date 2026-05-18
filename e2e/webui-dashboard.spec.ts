import { createReadStream } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type Page } from "@playwright/test";

import { CODEX_AGENT_CAPABILITIES, PI_AGENT_CAPABILITIES } from "../src/agents/shared/agent.js";
import { buildAdapterConformanceMatrix } from "../src/agents/shared/adapter-conformance.js";
import { listAgentAdapterDescriptors } from "../src/agents/shared/agent-adapter.js";
import { listChannelDescriptors } from "../src/channels/shared/channel-adapter.js";
import { dashboardCss, dashboardJs, dashboardStaticAsset } from "../src/web/web-dashboard-assets.js";
import { renderDashboardApp } from "../src/web/web-dashboard-pages.js";

interface MockServer {
  baseUrl: string;
  server: Server;
  close: () => Promise<void>;
  requests: Array<{ method: string; path: string; query: Record<string, string>; body: unknown }>;
}

const NAV_SECTION_BY_PAGE: Record<string, string> = {
  Metrics: "operations",
  Adapters: "operations",
  Version: "operations",
  Logs: "operations",
  Diagnostics: "operations",
  Users: "administration",
  Settings: "administration",
  Peers: "administration",
};

const MONITOR_TAB_BY_PAGE: Record<string, string> = {
  Activity: "activity",
  Tasks: "tasks",
  Trace: "trace",
  Artifacts: "artifacts",
};

async function navigateDashboard(page: Page, label: string): Promise<void> {
  const monitorTab = MONITOR_TAB_BY_PAGE[label];
  if (monitorTab) {
    await page.getByRole("button", { name: "Monitor", exact: true }).click();
    await page.getByRole("tab", { name: label, exact: true }).click();
    return;
  }

  const section = NAV_SECTION_BY_PAGE[label];
  if (section) {
    const toggle = page.locator(`[data-nav-toggle="${section}"]`);
    if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) !== "true") {
      await toggle.click();
    }
  }
  await page.getByRole("button", { name: label, exact: true }).click();
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
    await expect(page.getByRole("button", { name: "Work", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Operations", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("button", { name: "Administration", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator('[data-nav-section="operations"] .nav-section-items')).toBeHidden();
    await expect(page.locator('[data-nav-section="administration"] .nav-section-items')).toBeHidden();
    await expect(page.locator('nav > .nav-primary button[data-page]')).toHaveText([
      "Overview",
      "Chat",
      "Workflows",
      "Sessions",
      "Queue",
      "Monitor",
    ]);
    await expect(page.getByRole("heading", { name: "Active Sessions" })).toBeVisible();
    await expect(page.locator("#activeSessions")).toContainText("Run active smoke test");
    await expect(page.locator("#activeSessions")).toContainText("exec_command");
    await expect(page.locator("#activeSessions")).toContainText("Source CLI");
    await expect(page.locator("#activeSessions")).toContainText("Mirroring: Telegram full, Discord final, Slack final");
    await expect(page.locator("#agentAdapters")).toContainText("Codex");
    await expect(page.locator("#chatAdapters")).toContainText("Telegram");
    await expect(page.locator("#footerHealth")).toContainText("Health: healthy");
    await expect(page.locator("#metrics")).toContainText("Current Session");
    await expect(page.locator("#metrics .metric .label")).toHaveText([
      "Current Session",
      "Queue",
      "Workspace",
      "Agent / Model",
      "Reasoning / Fast",
      "Permissions",
    ]);
    await expect(page.locator("#metrics .metric").nth(3)).toContainText("Codex / gpt-5.5");
    await expect(page.locator("#metrics")).toContainText("Reasoning / Fast");
    await expect(page.locator("#metrics")).toContainText("high / on");
    await expect(page.locator("#metrics")).toContainText("Permissions");
    await expect(page.locator("#metrics")).toContainText("workspace-write / never");
    await expect(page.locator("#metrics .metric-thread-copy")).toHaveAttribute("title", "Copy thread ID");
    await expect(page.locator("#metrics .metric .label").filter({ hasText: /^Fast$/ })).toHaveCount(0);
    await expect(page.locator("#metrics .metric .label").filter({ hasText: /^Thread$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0);
    await page.locator("#headerTargetBtn").click();
    await page.getByRole("button", { name: "Show recent codex sessions" }).click();
    const headerSessions = page.locator('[data-target-sessions="local::codex"]');
    await expect(headerSessions).toContainText("Existing session 5");
    await expect(headerSessions.locator('[data-target-session-load-more]')).toContainText("Load more");
    await headerSessions.locator('[data-target-session-load-more]').click();
    await expect(headerSessions).toContainText("Existing session 7");
    await expect(headerSessions.locator('[data-target-session-load-more]')).toHaveCount(0);

    await navigateDashboard(page, "Chat");
    await expect(page.locator("#messages")).toContainText("Existing web message");
    await expect(page.locator("#messages")).toHaveCSS("overflow-y", "auto");
    await expect(page.locator("#toolPanel")).toBeHidden();
    await expect(page.getByRole("button", { name: "Show Tools" })).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "Show Tools" }).click();
    await expect(page.locator("#toolPanel")).toBeVisible();
    await expect(page.getByRole("button", { name: "Hide Tools" })).toHaveAttribute("aria-expanded", "true");

    await navigateDashboard(page, "Settings");
    await expect(page.locator("#settingsTabs")).toContainText("Agents");
    await expect(page.locator("#settingsTabs")).toContainText("Chat");
    await expect(page.locator("#settingsTabs")).not.toContainText("Codex");
    await expect(page.locator("#settingsTabs")).not.toContainText("Telegram");
    await expect(page.locator(".settings-section-header #settingsTabs")).toBeVisible();
    await expect(page.locator("#settingsTabs")).toHaveAttribute("role", "tablist");
    await expect(page.getByRole("tab", { name: /Agents/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#settingsTabs")).toHaveCSS("border-radius", "0px");
    await expect
      .poll(async () => {
        const tabs = await page.locator("#settingsTabs").boundingBox();
        const actions = await page.locator("#settingsActions").boundingBox();
        return Boolean(tabs && actions && tabs.y < actions.y);
      })
      .toBe(true);
    await expect(page.locator("#settingsForm")).toContainText("Enable Codex");
    await page.getByRole("tab", { name: /Chat/ }).click();
    await expect(page.getByRole("tab", { name: /Chat/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#settingsSubgroupSelect")).toHaveValue("Telegram");
    await page.locator("#settingsSubgroupSelect").selectOption("Discord");
    await expect(page.locator('[data-setting-box="DISCORD_BOT_TOKEN"] .setting-info')).toHaveAttribute("title", /Discord Developer Portal/);
    await page.locator("#settingsSubgroupSelect").selectOption("Slack");
    await expect(page.locator('[data-setting-box="SLACK_BOT_TOKEN"] .setting-info')).toHaveAttribute("title", /Slack API Apps/);
    await page.getByRole("tab", { name: /Agents/ }).click();

    await page.locator('[data-setting="NORDRELAY_PI_ENABLED"]').selectOption("true");
    await expect(page.locator("#settingsStatus")).toContainText("1 unsaved change");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.locator("#settingsStatus")).toContainText("Saved 1 setting");
    const settingsRequest = mock.requests.find((request) => request.path === "/api/settings" && request.method === "PATCH");
    expect(settingsRequest?.body).toMatchObject({ settings: { NORDRELAY_PI_ENABLED: "true" } });

    await navigateDashboard(page, "Version");
    await expect(page.locator("#versionPanel")).toContainText("NordRelay");
    await expect(page.locator("#versionPanel .version-table")).toBeVisible();
    await expect(page.locator("#versionPanel .version-table thead th")).toHaveText([
      "Name",
      "Status",
      "Installed",
      "Latest",
      "Package",
      "Detail",
      "Actions",
    ]);
    await expect(page.locator("#versionPanel")).not.toContainText("Runtime");
    await expect(page.locator("#agentUpdateJobs")).toContainText("No agent update jobs");

    await navigateDashboard(page, "Tasks");
    await expect(page.locator("#tasksList")).toContainText("Unified jobs");
    await expect(page.locator("#tasksList")).toContainText("Queued prompt queue-web-1");
    await expect(page.locator("#tasksList")).toContainText("CID:");
    await expect(page.locator('#tasksList [data-trace-id="cid-job-1"]')).toBeVisible();

    await navigateDashboard(page, "Trace");
    await page.locator("#traceCorrelationId").fill("cid-job-1");
    await page.locator("#loadTraceBtn").click();
    await expect(page.locator("#traceDetail .trace-table")).toBeVisible();
    await expect(page.locator("#traceDetail .trace-table th")).toHaveText([
      "Time",
      "Source",
      "Status",
      "Type",
      "Title",
      "Context",
      "Detail",
      "Actions",
    ]);
    await expect(page.locator("#traceDetail .trace-table tbody tr")).toHaveCount(2);

    await navigateDashboard(page, "Metrics");
    await expect(page.locator("#metricsTabs")).toHaveAttribute("role", "tablist");
    await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#metricsPanel .metrics-summary")).toBeVisible();
    await expect(page.locator("#metricsPanel")).toContainText("Runtime");
    await expect(page.locator("#metricsPanel .metric-kv").first()).toBeVisible();
    await page.getByRole("tab", { name: "Web API" }).click();
    await expect(page.locator("#metricsPanel .metrics-web-routes")).toBeVisible();
    await expect(page.locator("#metricsPanel .metrics-web-routes thead th")).toHaveText(["Route", "Avg", "Max", "Last", "Hits", "Status", "Last seen"]);
    await page.getByRole("tab", { name: "Rate Limits" }).click();
    await expect(page.locator("#metricsPanel .metrics-rate-table")).toBeVisible();
    await expect(page.locator("#metricsPanel .metrics-rate-table")).toContainText("Telegram");
    await expect(page.locator("#metricsPanel .metrics-rate-table")).toContainText("Slack");
    await page.locator("#metricsAutoRefresh").check();
    await expect(page.locator("#metricsAutoRefresh")).toBeChecked();
  });

  test("sends prompts through the typed API client and shows queued feedback", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.goto(mock.baseUrl);
    await navigateDashboard(page, "Chat");

    await page.locator("#promptInput").fill("Run a browser smoke test");
    await page.locator("#promptForm button").last().click();

    await expect(page.locator("#messages")).toContainText("Queued prompt queue-web-1");
    const promptRequest = mock.requests.find((request) => request.path === "/api/prompt");
    const promptBody = promptRequest?.body as { text?: string; correlationId?: string } | undefined;
    expect(promptBody).toMatchObject({ text: "Run a browser smoke test", correlationId: expect.stringMatching(/^[a-f0-9]{12}$/) });
    await expect(page.locator("#messages")).toContainText("CID:");
    await expect(page.locator(`#messages [data-trace-id="${promptBody?.correlationId}"]`)).toBeVisible();
  });

  test("opens the account menu, updates profile preferences, and changes password", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.goto(mock.baseUrl);

    await expect(page.locator("#userMenuName")).toHaveText("Admin");
    await page.locator("#userMenuBtn").click();
    await expect(page.locator("#userMenuPanel")).toBeVisible();
    await expect(page.locator('[data-theme-choice="dark"]')).toHaveAttribute("aria-checked", "true");
    await page.locator('[data-theme-choice="light"]').click();
    await expect.poll(() => mock.requests.some((request) => request.path === "/api/profile" && request.method === "PATCH")).toBe(true);
    expect(mock.requests.find((request) => request.path === "/api/profile" && request.method === "PATCH")?.body).toMatchObject({ preferences: { theme: "light" } });

    await page.locator("#userMenuBtn").click();
    await page.locator("#profileBtn").click();
    await expect(page.locator("#profileDialog")).toBeVisible();
    await expect(page.locator("#profileLinkedAccounts")).toContainText("Telegram");
    await expect(page.locator("#profileWebSessions")).toContainText("Current session");
    await page.locator("#profileNameInput").fill("Admin Profile");
    await page.locator("#profileThemeSelect").selectOption("system");
    await page.locator("#saveProfileBtn").click();
    await expect(page.locator("#profileStatus")).toContainText("Saved");
    expect(mock.requests.filter((request) => request.path === "/api/profile" && request.method === "PATCH").at(-1)?.body).toMatchObject({
      displayName: "Admin Profile",
      preferences: { theme: "system" },
    });

    await page.locator("#profileCurrentPassword").fill("current-password");
    await page.locator("#profileNewPassword").fill("new-password-123");
    await page.locator("#profileConfirmPassword").fill("new-password-123");
    await page.locator("#changeProfilePasswordBtn").click();
    await expect.poll(() => mock.requests.some((request) => request.path === "/api/profile/password" && request.method === "POST")).toBe(true);
    expect(mock.requests.find((request) => request.path === "/api/profile/password" && request.method === "POST")?.body).toMatchObject({
      currentPassword: "current-password",
      newPassword: "new-password-123",
    });

    await page.locator("#logoutOtherSessionsBtn").click();
    await expect.poll(() => mock.requests.some((request) => request.path === "/api/profile/logout-other-sessions" && request.method === "POST")).toBe(true);
  });

  test("builds workflows with step cards and variable forms", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.goto(mock.baseUrl);
    await navigateDashboard(page, "Workflows");

    await page.locator('[data-workflow-tab="workflows"]').click();
    await page.getByRole("button", { name: "Create workflow" }).click();

    await expect(page.locator("#adminDialogTitle")).toHaveText("Create workflow");
    await expect(page.locator("#adminDialogBody")).toContainText("Workflow builder");
    await expect(page.locator("#adminDialogBody")).toContainText("Advanced JSON import/export");
    await expect(page.locator("#adminDialogBody")).not.toContainText("Steps JSON");
    await expect(page.locator("[data-workflow-builder-step]")).toHaveCount(1);

    await page.locator("#dlgWorkflowName").fill("Builder smoke workflow");
    await page.locator('[data-workflow-builder-step]').first().locator('[data-builder-field="name"]').fill("Prompt step");
    await page.locator('[data-workflow-builder-step]').first().locator('[data-builder-field="prompt"]').fill("Run {{target}}");

    await page.locator("[data-workflow-builder-add]").click();
    await expect(page.locator("[data-workflow-builder-step]")).toHaveCount(2);
    const secondStep = page.locator("[data-workflow-builder-step]").nth(1);
    await secondStep.locator('[data-builder-field="name"]').fill("Template step");
    await secondStep.locator('[data-builder-field="source"]').selectOption("template");
    await secondStep.locator('[data-builder-field="templateId"]').selectOption("template-review");
    await secondStep.locator('[data-builder-field="sessionMode"]').selectOption("new");
    await secondStep.locator('[data-builder-field="agentId"]').selectOption("pi");
    await secondStep.locator('[data-builder-field="workspace"]').fill("/tmp/project");
    await secondStep.locator('[data-builder-field="model"]').fill("pi-default");
    await secondStep.locator('[data-builder-field="reasoningEffort"]').selectOption("high");
    await secondStep.locator('[data-builder-field="launchProfileId"]').selectOption("default");
    await expect(page.locator("#workflowBuilderPreview")).toContainText("Run {{target}}");
    await expect(page.locator("#workflowBuilderPreview")).toContainText("Review {{target}}");
    await expect(page.locator("#workflowBuilderPreview")).toContainText("Variables: target");

    await page.locator("#adminDialogSubmit").click();
    await expect.poll(() => mock.requests.some((request) => request.path === "/api/workflows" && request.method === "POST")).toBe(true);
    const createRequest = mock.requests.find((request) => request.path === "/api/workflows" && request.method === "POST");
    expect(createRequest?.body).toMatchObject({
      name: "Builder smoke workflow",
      steps: [
        { name: "Prompt step", prompt: "Run {{target}}", sessionMode: "current", target: "local" },
        {
          name: "Template step",
          templateId: "template-review",
          sessionMode: "new",
          agentId: "pi",
          workspace: "/tmp/project",
          model: "pi-default",
          reasoningEffort: "high",
          launchProfileId: "default",
          target: "local",
        },
      ],
    });

    await page.locator('[data-workflow-run="workflow-existing"]').click();
    await expect(page.locator("#adminDialogTitle")).toHaveText("Run workflow");
    await expect(page.locator("#adminDialogBody")).toContainText("Set variables for this run");
    await page.locator('[data-workflow-variable="target"]').fill("src/runtime");
    await page.locator("#adminDialogSubmit").click();
    await expect.poll(() => mock.requests.some((request) => request.path === "/api/workflows/workflow-existing/run" && request.method === "POST")).toBe(true);
    const runRequest = mock.requests.find((request) => request.path === "/api/workflows/workflow-existing/run" && request.method === "POST");
    expect(runRequest?.body).toMatchObject({ variables: { target: "src/runtime" } });
  });

  test("controls WebUI CLI mirroring from the chat toolbar and slash command", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.goto(mock.baseUrl);
    await navigateDashboard(page, "Chat");

    await expect(page.locator("#mirrorModeSelect")).toHaveValue("status");
    await page.locator("#mirrorModeSelect").selectOption("full");
    await expect.poll(() => mock.requests.filter((request) => request.path === "/api/chat/mirror" && request.method === "POST").length).toBe(1);
    expect(mock.requests.find((request) => request.path === "/api/chat/mirror" && request.method === "POST")?.body).toMatchObject({ argument: "full" });

    await page.locator("#promptInput").fill("/mirror");
    await page.locator("#promptForm button").last().click();
    await expect(page.locator("#messages")).toContainText("CLI mirroring: status");
    await expect(page.locator("#messages")).toContainText("Minimum update interval: 4000 ms");
  });

  test("keeps sticky CLI status visible after transient toasts expire", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.goto(mock.baseUrl);

    await page.evaluate(() => {
      const api = window as unknown as { isCliDoneStatus: (message: string) => boolean; toast: (message: string, options?: { sticky?: boolean; duration?: number }) => void };
      if (api.isCliDoneStatus("Waiting for Codex CLI task... 1 queued")) throw new Error("waiting status must not be terminal");
      if (!api.isCliDoneStatus("Codex CLI task finished.")) throw new Error("finished status must be terminal");
      api.toast("Codex CLI running · 7m 41s · tool write_stdin · 0 queued", { sticky: true });
      api.toast("Temporary notice", { duration: 500 });
    });

    await expect(page.locator("#toast")).toBeVisible();
    await expect(page.locator("#toast")).toContainText("Temporary notice");
    await page.waitForTimeout(600);
    await expect(page.locator("#toast")).toBeVisible();
    await expect(page.locator("#toast")).toContainText("Codex CLI running");

    await page.evaluate(() => {
      const api = window as unknown as { clearStickyToast: () => void; toast: (message: string, options?: { duration?: number }) => void };
      api.clearStickyToast();
      api.toast("Codex CLI task finished.", { duration: 50 });
    });
    await page.waitForTimeout(100);
    await expect(page.locator("#toast")).toBeHidden();
  });

  test("formats chat markdown and copies code snippets", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
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
    await page.goto(mock.baseUrl);
    await navigateDashboard(page, "Chat");

    await expect(page.locator("#messages .chat-inline-code")).toContainText("npm test");
    await expect(page.locator("#messages .chat-inline-code").first()).toHaveClass(/copy-id/);
    await expect(page.locator("#messages .chat-inline-code").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    expect(await page.locator("#messages .chat-inline-code").first().evaluate((el) => getComputedStyle(el).fontSize)).toBe(
      await page.locator("#messages .message-body").first().evaluate((el) => getComputedStyle(el).fontSize),
    );
    await expect(page.locator("#messages .chat-code-block code")).toContainText("const value = 1;");
    await expect.poll(() => page.locator("#messages .chat-code-block code").first().evaluate((el) => el.textContent ?? "")).toBe("const value = 1;");
    await expect
      .poll(() => page.locator("#messages .message-body").filter({ has: page.locator(".chat-code-block") }).first().evaluate((el) => el.innerHTML.includes("</pre>\n\n")))
      .toBe(false);
    await expect(page.locator("#messages strong")).toContainText("bold");
    await expect(page.locator("#messages em")).toContainText("italic");
    await expect(page.locator('#messages a[href="https://example.com"]')).toContainText("docs");
    await expect(page.locator("#messages .chat-list li")).toContainText("bullet item");
    await expect(page.locator("#messages .chat-blockquote")).toContainText("quoted line");

    await page.locator("#messages .chat-inline-code").first().click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedText?: string }).__copiedText)).toBe("npm test");
    await page.locator("#messages .chat-code-block").first().click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedText?: string }).__copiedText)).toContain("const value = 1;");
  });

  test("preserves chat scroll position when live history updates arrive", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.goto(mock.baseUrl);
    await navigateDashboard(page, "Chat");

    const messages = Array.from({ length: 80 }, (_, index) => ({
      id: `scroll-${index}`,
      role: index % 2 ? "agent" : "user",
      source: "cli",
      timestamp: now(),
      text: `History message ${index}\n${"A long chat line. ".repeat(8)}`,
    }));
    await page.evaluate((items) => {
      (window as unknown as { renderChatMessages: (messages: unknown[]) => void }).renderChatMessages(items);
    }, messages);
    await expect.poll(async () => page.locator("#messages .message").count()).toBe(messages.length);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    await page.evaluate(() => {
      const box = document.getElementById("messages");
      if (box) box.scrollTop = 0;
    });
    await expect.poll(async () => page.evaluate(() => document.getElementById("messages")?.scrollTop ?? -1)).toBe(0);

    await page.evaluate(
      (items) => {
        (window as unknown as { renderChatMessages: (messages: unknown[]) => void }).renderChatMessages(items);
      },
      [
        ...messages,
        {
          id: "scroll-new",
          role: "agent",
          source: "cli",
          timestamp: now(),
          text: "Live update while the reader is reviewing older chat content.",
        },
      ],
    );
    await expect.poll(async () => page.locator("#messages .message").count()).toBe(messages.length + 1);
    await expect.poll(async () => page.evaluate(() => document.getElementById("messages")?.scrollTop ?? -1)).toBe(0);
  });

  test("renders Discord and Slack access controls and filters registered channels", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.goto(mock.baseUrl);
    await navigateDashboard(page, "Users");

    await expect(page.locator("#pageTitle")).toHaveText("Users");
    await expect(page.locator(".access-section-header #accessTabs")).toBeVisible();
    await expect(page.locator("#accessTabs")).toHaveAttribute("role", "tablist");
    await expect(page.getByRole("tab", { name: "Users" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#accessTabs")).toHaveCSS("border-radius", "0px");
    await expect(page.locator("#accessTabs")).toHaveCSS("overflow-y", "hidden");
    await expect
      .poll(async () => page.locator("#accessTabs").evaluate((el) => el.scrollHeight <= el.clientHeight))
      .toBe(true);
    await expect(page.locator('[data-access-tab-panel="users"] h2')).toHaveCount(0);
    await expect(page.locator('[data-access-tab-panel="users"] .access-heading-actions')).toContainText("Reload");
    await expect(page.locator('[data-access-tab-panel="users"] .access-heading-actions')).toContainText("Create user");
    await expect(page.locator(".access-toolbar")).toHaveCount(0);
    await expect(page.locator("#createUserBtn")).toBeVisible();
    await expect(page.locator("#createGroupBtn")).toBeHidden();
    await expect(page.locator("#accessPanel")).toContainText("Admin");
    await page.locator("#userSearch").fill("missing");
    await expect(page.locator("#accessPanel")).toContainText("No users match");
    await page.locator("#userSearch").fill("admin");
    await expect(page.locator("#accessPanel")).toContainText("Admin");
    await page.getByRole("button", { name: "Details" }).click();
    await expect(page.locator("#userDetailDialog")).toBeVisible();
    await expect(page.locator("#userDetail")).toContainText("Effective access");
    await page.locator('[data-user-detail-tab="identities"]').click();
    await expect(page.locator("#userDetail")).toContainText("Discord");
    await expect(page.locator("#userDetail")).toContainText("Slack");
    await page.locator("#closeUserDetailBtn").click();

    await page.locator('[data-access-tab="groups"]').click();
    await expect(page.getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-access-tab-panel="groups"] h2')).toHaveCount(0);
    await expect(page.locator('[data-access-tab-panel="groups"] .access-heading-actions')).toContainText("Create group");
    await expect(page.locator("#createGroupBtn")).toBeVisible();
    await expect(page.locator("#createUserBtn")).toBeHidden();

    await page.locator('[data-access-tab="telegram"]').click();
    await expect(page.locator('[data-access-tab-panel="telegram"] h2')).toHaveCount(0);
    await expect(page.locator('[data-access-tab-panel="telegram"] .access-heading-actions')).toContainText("Add Telegram chat");
    await expect(page.locator("#createChatBtn")).toBeVisible();

    await expect(page.locator("#accessTabs")).toContainText("Discord");
    await page.locator('[data-access-tab="discord"]').click();
    await expect(page.locator('[data-access-tab-panel="discord"] h2')).toHaveCount(0);
    await expect(page.locator("#discordChannelsList")).toContainText("Engineering Ops");
    await expect(page.locator("#createDiscordChannelBtn")).toBeVisible();
    await expect(page.locator("#createGroupBtn")).toBeHidden();

    await page.locator("#discordChannelSearch").fill("ops");
    await expect(page.locator("#discordChannelsList")).toContainText("Engineering Ops");
    await page.locator("#discordChannelSearch").fill("missing");
    await expect(page.locator("#discordChannelsList")).toContainText("No Discord channels registered.");

    await expect(page.locator("#accessTabs")).toContainText("Slack");
    await page.locator('[data-access-tab="slack"]').click();
    await expect(page.locator('[data-access-tab-panel="slack"] h2')).toHaveCount(0);
    await expect(page.locator("#slackChannelsList")).toContainText("Slack Engineering");
    await expect(page.locator("#createSlackChannelBtn")).toBeVisible();

    await page.locator("#slackChannelSearch").fill("engineering");
    await expect(page.locator("#slackChannelsList")).toContainText("Slack Engineering");
    await page.locator("#slackChannelSearch").fill("missing");
    await expect(page.locator("#slackChannelsList")).toContainText("No Slack channels registered.");

    await page.locator('[data-access-tab="locks"]').click();
    await expect(page.locator('[data-access-tab-panel="locks"] h2')).toHaveCount(0);
    await expect(page.locator('[data-access-tab-panel="locks"] .access-heading-actions')).toContainText("Lock web session");
    await expect(page.locator("#lockSessionBtn")).toBeVisible();

    await page.locator('[data-access-tab="audit"]').click();
    await expect(page.locator('[data-access-tab-panel="audit"] h2')).toHaveCount(0);
    await expect(page.locator('[data-access-tab-panel="audit"] .access-heading-actions')).toContainText("Load audit");
    await expect(page.locator("#loadAuditBtn")).toBeVisible();
  });

  test("renders adapter conformance, artifact previews, and peer global sessions", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.goto(mock.baseUrl);

    await navigateDashboard(page, "Adapters");
    await expect(page.locator(".adapter-section-header #adapterTabs")).toBeVisible();
    await expect(page.locator("#adapterTabs")).toHaveAttribute("role", "tablist");
    await expect(page.getByRole("tab", { name: "Adapters" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#adapterHealth")).toContainText("Codex");
    await expect(page.locator("#adapterHealth .adapters-table")).toBeVisible();
    await expect(page.locator("#adapterHealth .adapters-table thead th")).toHaveText([
      "Adapter",
      "Status",
      "CLI Path",
      "CLI Version",
      "Auth",
      "Version",
      "Actions",
    ]);
    await expect(page.locator("#adapterHealth .feature-matrix")).toHaveCount(0);
    await expect(page.locator("#adapterHealth")).not.toContainText("CLI:");
    await expect(page.locator("#adapterHealth")).not.toContainText(" / path ");
    await expect(page.locator('[data-adapter-tab-panel="conformance"]')).toBeHidden();
    await page.getByRole("tab", { name: "Adapter Conformance" }).click();
    await expect(page.getByRole("tab", { name: "Adapter Conformance" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-adapter-tab-panel="conformance"]')).toBeVisible();
    await expect(page.locator("#adapterConformance")).toContainText("Agent capability contract");
    await expect(page.locator("#adapterConformance")).toContainText("Channel command contract");
    await expect(page.locator("#adapterConformance")).toContainText("Codex");
    await expect(page.locator("#adapterConformance")).toContainText("Telegram");
    await expect(page.locator("#adapterConformance .feature-matrix").first()).toBeVisible();

    await navigateDashboard(page, "Artifacts");
    await expect(page.locator("#artifactList")).toContainText("turn-web-1");
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.locator("#artifactPreview")).toContainText("report.txt");
    await expect(page.locator("#artifactPreview")).toContainText("Artifact preview smoke");

    await navigateDashboard(page, "Peers");
    await expect(page.locator("#peerStatus")).toContainText("Local peer identity");
    await expect(page.locator("#peerStatus")).toContainText("Manual reachability check");
    await expect(page.locator("#peerStatus")).toContainText("nordrelay peer check https://127.0.0.1:31979");
    await page.getByRole("button", { name: "Check local endpoint" }).click();
    await expect(page.locator("#peerProbeResult")).toContainText("Local endpoint check");
    await expect(page.locator("#peerProbeResult")).toContainText("reachable");
    await page.getByRole("tab", { name: "Peers" }).click();
    await expect(page.locator("#peersList")).toContainText("Ubuntu Workstation");
    await page.locator('[data-peer-probe="peer-ubuntu"]').click();
    await expect(page.locator("#peerProbeResult")).toContainText("Remote probe from Ubuntu Workstation");
    await page.getByRole("tab", { name: "Invitations" }).click();
    await expect(page.locator("#peerInvites")).toContainText("MacBook invite");
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator('[data-peer-invite-delete="invite-1"]').click();
    await expect.poll(() => mock.requests.some((request) => request.path === "/api/peers/invitations/invite-1" && request.method === "DELETE")).toBe(true);
    await page.getByRole("tab", { name: "Global Sessions" }).click();
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
    await navigateDashboard(page, "Peers");
    await page.getByRole("tab", { name: "Invitations" }).click();
    await page.getByRole("button", { name: "Create invite" }).click();
    await page.locator("#adminDialogSubmit").click();
    await expect(page.locator("#adminDialog")).not.toBeVisible();

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
    await navigateDashboard(page, "Peers");

    await expect(page.locator("#peerStatus")).toContainText("Peer server is disabled");
    await page.getByRole("tab", { name: "Invitations" }).click();
    await page.getByRole("button", { name: "Create invite" }).click();
    await expect(page.locator("#adminDialogBody")).toContainText("Pairing warning");
    await expect(page.locator("#adminDialogBody")).toContainText("pairing will fail");
    await expect(page.locator("#adminDialogSubmit")).toHaveText("Create invite anyway");
  });

  test("starts agent install/update jobs from the version page", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.goto(mock.baseUrl);
    await navigateDashboard(page, "Version");

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Install" }).click();

    await expect(page.locator("#agentUpdateJobs")).toContainText("Pi install");
    const updateRequest = mock.requests.find((request) => request.path === "/api/agent-update");
    expect(updateRequest?.body).toMatchObject({ agentId: "pi", operation: "install" });
  });

  test("guides channel setup through the settings wizard", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.goto(mock.baseUrl);
    await navigateDashboard(page, "Settings");
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
    await navigateDashboard(page, "Settings");
    await page.getByRole("button", { name: "Setup wizard" }).click();

    const telegramCard = page.locator(".wizard-card").filter({ hasText: "Telegram" });
    await expect(telegramCard).toContainText("ready");
    await expect(telegramCard).not.toContainText("Missing: TELEGRAM_BOT_TOKEN");
  });

  test("blocks wizard save while required settings are missing", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop interaction flow");
    await page.goto(mock.baseUrl);
    await navigateDashboard(page, "Settings");
    await page.getByRole("button", { name: "Setup wizard" }).click();
    await page.locator('[data-start-wizard="discord"]').click();

    await expect(page.locator("#wizardErrors")).toContainText("Discord bot token is required");
    await expect(page.locator("#wizardErrors")).toContainText("Discord client ID is required");
    await expect(page.getByRole("button", { name: "Save wizard settings" })).toBeDisabled();
  });

  test("keeps the responsive navigation usable on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mock.baseUrl);

    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.locator("#sidebar")).toHaveClass(/open/);
    await navigateDashboard(page, "Logs");

    await expect(page.getByRole("heading", { name: "Logs" })).toBeVisible();
    await expect(page.locator("#logs")).toHaveCSS("overflow-y", "auto");
    await expect(page.locator("#logs")).toHaveCSS("font-size", "14px");
  });

  test("colors log levels and multiline entries consistently", async ({ page }) => {
    test.skip(test.info().project.name === "mobile-chromium", "covered by the desktop log rendering flow");
    await page.goto(mock.baseUrl);
    await navigateDashboard(page, "Logs");

    const lines = page.locator("#logs .log-line");
    await expect(lines).toHaveCount(6);
    await expect(lines.nth(0)).toHaveClass(/INFO/);
    await expect(lines.nth(1)).toHaveClass(/INFO/);
    await expect(lines.nth(2)).toHaveClass(/WARN/);
    await expect(lines.nth(3)).toHaveClass(/WARN/);
    await expect(lines.nth(4)).toHaveClass(/ERROR/);
    await expect(lines.nth(5)).toHaveClass(/ERROR/);

    const colors = await lines.evaluateAll((items) => items.map((item) => getComputedStyle(item).color));
    expect(colors[1]).toBe(colors[0]);
    expect(colors[3]).toBe(colors[2]);
    expect(colors[5]).toBe(colors[4]);
    expect(colors[0]).not.toBe(colors[2]);
    expect(colors[2]).not.toBe(colors[4]);

    await page.locator("#logLevel").selectOption("WARN");
    await expect(lines).toHaveCount(2);
    await expect(page.locator("#logs")).toContainText("Slow check");
    await expect(page.locator("#logs")).toContainText("warn detail");
    await expect(page.locator("#logs")).not.toContainText("Started");

    const beforeTargetSwitch = mock.requests.length;
    await page.locator("#logTarget").selectOption("agent-updates");
    await expect
      .poll(() => mock.requests.slice(beforeTargetSwitch).some((request) => request.path === "/api/logs" && request.query.target === "agent-updates"))
      .toBe(true);
  });

  test("runs core settings, chat, peers, and version flows on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(mock.baseUrl);

    await page.getByRole("button", { name: "Open navigation" }).click();
    await navigateDashboard(page, "Settings");
    await expect(page.locator("#settingsTabs")).toContainText("Agents");
    await expect(page.locator("#settingsTabs")).toHaveAttribute("role", "tablist");
    await page.getByRole("tab", { name: /Chat/ }).click();
    await page.locator("#settingsSubgroupSelect").selectOption("Discord");
    await expect(page.locator('[data-setting-box="DISCORD_CLIENT_ID"]')).toBeVisible();

    await page.getByRole("button", { name: "Open navigation" }).click();
    await navigateDashboard(page, "Chat");
    await expect(page.locator("#messages")).toHaveCSS("overflow-y", "auto");
    await page.locator("#promptInput").fill("Mobile prompt smoke");
    await page.locator("#promptForm button").last().click();
    await expect(page.locator("#messages")).toContainText("Queued prompt queue-web-1");

    await page.getByRole("button", { name: "Open navigation" }).click();
    await navigateDashboard(page, "Peers");
    await expect(page.locator("#peerStatus")).toContainText("Local peer identity");
    await page.getByRole("tab", { name: "Peers" }).click();
    await expect(page.locator("#peersList")).toContainText("Ubuntu Workstation");

    await page.getByRole("button", { name: "Open navigation" }).click();
    await navigateDashboard(page, "Version");
    await expect(page.locator("#versionPanel")).toContainText("NordRelay");
    await expect(page.locator("#agentUpdateJobs")).toContainText("No agent update jobs");
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
    if (url.pathname === "/assets/logo.png") return sendDashboardAsset(res, "logo.png");
    if (url.pathname === "/assets/favicon.png") return sendDashboardAsset(res, "favicon.png");
    if (url.pathname === "/api/events") return sendSse(res);
    if (url.pathname === "/favicon.ico") return sendDashboardAsset(res, "favicon.ico");

    if (url.pathname.startsWith("/api/")) {
      const body = await readJson(req);
      requests.push({ method: req.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), body });
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
  if (url.pathname === "/api/chat/mirror") return mirrorPreference(body);
  if (url.pathname === "/api/queue") return { queue: [], paused: false };
  if (url.pathname === "/api/prompt") return { queued: true, queueId: "queue-web-1", correlationId: (body as { correlationId?: string } | null)?.correlationId, files: [] };
  if (url.pathname === "/api/settings") return method === "PATCH" ? settingsPatchResponse(body) : settings();
  if (url.pathname === "/api/settings/wizard/test") return wizardTestResponse(body);
  if (url.pathname === "/api/profile") return method === "PATCH" ? profile(body as Record<string, unknown>) : profile();
  if (url.pathname === "/api/profile/password") return { ok: true, profile: profile() };
  if (url.pathname === "/api/profile/logout-other-sessions") return { revoked: 1, profile: profile() };
  if (url.pathname === "/api/active-sessions") return activeSessions();
  if (url.pathname === "/api/templates") {
    if (method === "POST") return { template: savedTemplate(body) };
    return { templates: workflowTemplates() };
  }
  if (url.pathname.match(/^\/api\/templates\/[^/]+\/preview$/)) return workflowPreview("Template preview", ["Review {{target}}"]);
  if (url.pathname.match(/^\/api\/templates\/[^/]+\/run$/)) return { run: workflowRun("Template run") };
  if (url.pathname.match(/^\/api\/templates\/[^/]+$/)) {
    if (method === "DELETE") return { removed: true };
    return { template: savedTemplate(body) };
  }
  if (url.pathname === "/api/workflows") {
    if (method === "POST") return { workflow: savedWorkflow(body) };
    return { workflows: workflows(), runs: workflowRuns() };
  }
  if (url.pathname.match(/^\/api\/workflows\/[^/]+\/preview$/)) return workflowPreview("Workflow preview", ["Run {{target}}", "Review {{target}}"]);
  if (url.pathname.match(/^\/api\/workflows\/[^/]+\/run$/)) return { run: workflowRun("Workflow run") };
  if (url.pathname.match(/^\/api\/workflows\/[^/]+$/)) {
    if (method === "DELETE") return { removed: true };
    return { workflow: savedWorkflow(body) };
  }
  if (url.pathname.match(/^\/api\/workflow-runs\/[^/]+\/cancel$/)) return workflowRun("Workflow run", "aborted");
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
  if (url.pathname === "/api/trace") return traceDetail(url.searchParams.get("correlationId") || "cid-job-1");
  if (url.pathname === "/api/sessions") return sessions(url);
  if (url.pathname === "/api/sessions/detail") return sessionDetail();
  if (url.pathname === "/api/control-options") return controls(url.searchParams.get("agent") || "codex");
  if (url.pathname === "/api/agent") return { session };
  if (url.pathname === "/api/activity") return { events: [] };
  if (url.pathname === "/api/artifacts") return artifacts();
  if (url.pathname === "/api/artifacts/preview") return artifactPreview(url.searchParams.get("path") || "report.txt");
  if (url.pathname === "/api/artifacts/file") return { name: "report.txt", mimeType: "text/plain", dataBase64: Buffer.from("Artifact preview smoke\n").toString("base64") };
  if (url.pathname === "/api/artifacts/zip") return { name: "turn-web-1.zip", mimeType: "application/zip", dataBase64: Buffer.from("zip").toString("base64") };
  if (url.pathname === "/api/logs") return { filePath: "/tmp/nordrelay.log", requestedLines: 120, lineCount: 6, updatedAt: new Date().toISOString(), plain: "2026-05-14 10:00:00 INFO Started\ninfo detail\n2026-05-14 10:01:00 WARN Slow check\nwarn detail\n2026-05-14 10:02:00 ERROR Failed\nstack detail" };
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
  if (url.pathname === "/api/peers/discovery-jobs") return { jobs: discoveryJobs() };
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
    web: {
      routes: [
        { method: "GET", path: "/api/version", count: 3, averageMs: 42, maxMs: 80, lastMs: 35, lastStatusCode: 200, lastAt: new Date().toISOString() },
      ],
      slowest: [
        { method: "GET", path: "/api/diagnostics", statusCode: 200, durationMs: 120, at: new Date().toISOString() },
      ],
      recent: [],
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
    launchProfileId: "default",
    launchProfileLabel: "Default",
    launchProfileBehavior: "workspace-write / never",
    unsafeLaunch: false,
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
    user: { id: "user-1", email: "admin@example.com", displayName: "Admin", active: true, preferences: { theme: "dark" }, createdAt: now(), updatedAt: now() },
    groups: [{ id: "admin", name: "Admin", description: "Full access", permissions: permissions(), system: true, agentIds: [], workspaceRoots: [], telegramChatIds: [], discordChannelIds: [], slackChannelIds: [], createdAt: now(), updatedAt: now() }],
    permissions: permissions(),
  };
}

function profile(patch: Record<string, unknown> = {}) {
  const auth = currentUser();
  const preferences = patch.preferences && typeof patch.preferences === "object" ? patch.preferences as Record<string, unknown> : auth.user.preferences;
  return {
    ...auth,
    user: {
      ...auth.user,
      displayName: typeof patch.displayName === "string" && patch.displayName.trim() ? patch.displayName.trim() : auth.user.displayName,
      preferences,
    },
    telegramIdentities: [{ id: "telegram-identity-1", userId: "user-1", telegramUserId: 296626516, username: "nordbyte", active: true, linkedAt: now(), updatedAt: now() }],
    discordIdentities: [{ id: "discord-identity-1", userId: "user-1", discordUserId: "discord-user-mock", username: "admin", active: true, linkedAt: now(), updatedAt: now() }],
    slackIdentities: [{ id: "slack-identity-1", userId: "user-1", slackUserId: "U123", teamId: "T123", username: "admin", active: true, linkedAt: now(), updatedAt: now() }],
    webSessions: [
      { id: "web-current", userId: "user-1", createdAt: now(), expiresAt: "2099-05-14T10:20:00.000Z", lastSeenAt: now() },
      { id: "web-other", userId: "user-1", createdAt: now(), expiresAt: "2099-05-14T10:20:00.000Z", lastSeenAt: now() },
    ],
    currentSessionId: "web-current",
  };
}

function permissions() {
  return ["inspect", "sessions.read", "sessions.write", "prompt.send", "prompt.abort", "files.read", "files.write", "settings.read", "settings.write", "auth.manage", "diagnostics.read", "logs.read", "logs.clear", "queue.read", "queue.write", "updates.run", "system.restart", "users.read", "users.write", "audit.read", "peers.read", "peers.write", "peers.connect", "workflows.read", "workflows.write", "workflows.run"];
}

function workflowTemplates() {
  return [
    {
      id: "template-review",
      name: "Review template",
      description: "Reusable review prompt",
      tags: ["review"],
      prompt: "Review {{target}} and summarize risks.",
      variables: [{ name: "target", required: true }],
      scope: "shared",
      createdAt: now(),
      updatedAt: now(),
    },
  ];
}

function workflows() {
  return [
    {
      id: "workflow-existing",
      name: "Existing workflow",
      description: "Builder workflow",
      tags: ["smoke"],
      scope: "private",
      steps: [
        {
          id: "step-existing",
          name: "Review",
          type: "prompt",
          prompt: "Review {{target}}",
          sessionMode: "current",
          target: "local",
          requiresApproval: false,
          continueOnError: false,
        },
      ],
      createdAt: now(),
      updatedAt: now(),
    },
  ];
}

function workflowRuns() {
  return [];
}

function savedTemplate(body: unknown) {
  return { id: "template-created", ...(body as Record<string, unknown>), createdAt: now(), updatedAt: now() };
}

function savedWorkflow(body: unknown) {
  return { id: "workflow-created", ...(body as Record<string, unknown>), createdAt: now(), updatedAt: now() };
}

function workflowPreview(name: string, prompts: string[]) {
  return { name, prompts: prompts.map((prompt, index) => ({ stepId: `preview-${index + 1}`, name: `Step ${index + 1}`, prompt })) };
}

function workflowRun(name: string, status = "queued") {
  return {
    id: "workflow-run-1",
    name,
    status,
    steps: [],
    currentStepIndex: 0,
    createdAt: now(),
    updatedAt: now(),
  };
}

function chatMessages() {
  return [
    { id: "m1", threadId: "codex-thread-1", role: "user", text: "Existing web message", timestamp: now(), source: "web" },
    { id: "m2", threadId: "codex-thread-1", role: "agent", text: "Existing agent response", timestamp: now(), source: "web" },
    { id: "m3", threadId: "codex-thread-1", role: "agent", text: "Run `npm test` with **bold** and _italic_ text plus [docs](https://example.com).\n```ts\nconst value = 1;\n```\n- bullet item\n> quoted line", timestamp: now(), source: "web" },
  ];
}

function mirrorPreference(body: unknown) {
  const mode = (body as { argument?: string } | null)?.argument || "status";
  return {
    mode,
    minInterval: 4000,
    response: {
      plain: [`CLI mirroring: ${mode}`, "Minimum update interval: 4000 ms", "Modes: off, status, final, full"].join("\n"),
      html: "",
    },
  };
}

function sessions(url?: URL) {
  const agentId = url?.searchParams.get("agent") || "codex";
  const page = Number(url?.searchParams.get("page") || 1);
  const limit = Number(url?.searchParams.get("limit") || 50);
  const all = Array.from({ length: 7 }, (_, index) => {
    const number = index + 1;
    return {
      id: agentId === "pi" ? `pi-thread-${number}` : `codex-thread-${number}`,
      agentId,
      title: number === 1 ? "Existing session" : `Existing session ${number}`,
      cwd: "/tmp/project",
      model: agentId === "pi" ? "pi-default" : "gpt-5.5",
      updatedAt: now(),
      firstUserMessage: number === 1 ? "Existing web message" : `Existing web message ${number}`,
    };
  });
  const start = Math.max(0, (page - 1) * limit);
  const end = start + limit;
  return {
    sessions: all.slice(start, end),
    pagination: { page, pageSize: limit, hasPrevious: page > 1, hasNext: end < all.length },
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
        correlationId: "cid-job-1",
        canCancel: true,
        canRetry: true,
        canReadLog: true,
      },
    ],
  };
}

function traceDetail(correlationId: string) {
  return {
    correlationId,
    summary: {
      startedAt: now(),
      updatedAt: now(),
      status: "completed",
      sources: ["activity", "job"],
      agentId: "codex",
      threadId: "codex-thread-1",
      workspace: "/tmp/project",
    },
    activity: [],
    audit: [],
    chat: [],
    queue: [],
    jobs: [],
    timeline: [
      {
        id: "trace-activity-1",
        at: now(),
        source: "activity",
        status: "running",
        type: "prompt",
        title: "web prompt",
        detail: "Queued prompt from WebUI",
        agentId: "codex",
        threadId: "codex-thread-1",
        workspace: "/tmp/project",
      },
      {
        id: "trace-job-1",
        at: now(),
        source: "job",
        status: "completed",
        type: "queued_prompt",
        title: "Queued prompt job",
        detail: "Prompt completed",
        agentId: "codex",
        threadId: "codex-thread-1",
        workspace: "/tmp/project",
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
        discordIdentities: [{ id: "discord-identity-1", userId: "user-1", discordUserId: "discord-user-mock", username: "admin", createdAt: now(), updatedAt: now() }],
        slackIdentities: [{ id: "slack-identity-1", userId: "user-1", slackUserId: "U123", teamId: "T123", username: "admin", active: true, createdAt: now(), updatedAt: now() }],
        webSessions: [],
      },
    ],
    groups: auth.groups,
    telegramChats: [],
    discordChannels: [
      {
        id: "discord-channel-1",
        guildId: "discord-guild-mock",
        channelId: "discord-channel-mock",
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

function discoveryJobs() {
  return [
    {
      id: "discover-1",
      status: "completed",
      createdAt: now(),
      startedAt: now(),
      completedAt: now(),
      scanned: 2,
      total: 2,
      candidates: [
        {
          url: "https://10.0.0.12:31979",
          host: "10.0.0.12",
          port: 31979,
          scheme: "https",
          nodeId: "remote-node",
          name: "Ubuntu Workstation",
          fingerprint: "remote-fingerprint",
          tlsFingerprint: "mock-tls-fingerprint",
          latencyMs: 24,
        },
      ],
      warnings: [],
      log: ["[5/16/2026, 10:00:00 AM] Completed with 1 candidate(s)."],
      options: { targets: ["10.0.0.12"], timeoutMs: 250, concurrency: 8, maxHosts: 64 },
    },
  ];
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

function sendDashboardAsset(res: ServerResponse, assetName: string): void {
  const asset = dashboardStaticAsset(assetName);
  if (!asset) {
    sendText(res, 404, "not found", "text/plain; charset=utf-8");
    return;
  }
  res.writeHead(200, { "content-type": asset.contentType, "cache-control": "public, max-age=86400" });
  createReadStream(asset.filePath).pipe(res);
}

async function readJson(req: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}
