import { readFileSync } from "node:fs";
import { Script } from "node:vm";

import { describe, expect, it } from "vitest";

import { dashboardCss, dashboardJs, dashboardStaticAsset } from "../src/web/web-dashboard-assets.js";

describe("web dashboard browser-flow assets", () => {
  it("includes the agent feature matrix and dedicated agent update log flow", () => {
    const css = dashboardCss();
    const js = dashboardJs();

    expect(css).toContain(".feature-matrix");
    expect(js).toContain("function featureMatrix");
    expect(js).toContain("agent-updates");
    expect(js).toContain("/api/agent-updates");
  });

  it("includes unified jobs on the Tasks page", () => {
    const js = dashboardJs();
    const contract = readFileSync("src/web/web-api-contract.ts", "utf8");

    expect(js).toContain("function renderUnifiedJobs");
    expect(js).toContain("/api/jobs");
    expect(js).toContain("data-job-action");
    expect(contract).toContain('exact("/api/jobs"');
    expect(contract).toContain('dynamic("/api/jobs/:id/action"');
  });

  it("renders Discord setting help icons from setting metadata", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const metadata = readFileSync("src/core/config-metadata.ts", "utf8");

    expect(metadata).toContain("DISCORD_SETTING_HELP");
    expect(metadata).toContain("DISCORD_BOT_TOKEN");
    expect(metadata).toContain("Discord Developer Portal");
    expect(js).toContain("function settingHelp");
    expect(js).toContain("class=\"setting-info\"");
    expect(css).toContain(".setting-info");
  });

  it("refreshes the active page after an agent switch", () => {
    const js = dashboardJs();

    expect(js).toContain("await loadBootstrap();await reloadCurrentPage({agentId:selected})");
    expect(js).toContain("if(name==='overview') await loadActiveSessions()");
    expect(js).toContain("if(name==='sessions') await loadSessions(true,options.agentId)");
  });

  it("renders active sessions on the overview instead of the single current session panel", () => {
    const js = dashboardJs();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");

    expect(pageSource).toContain("Active Sessions");
    expect(pageSource).toContain('id="activeSessions"');
    expect(pageSource).not.toContain("Current Session");
    expect(js).toContain("function renderActiveSessions");
    expect(js).toContain("/api/active-sessions");
    expect(js).toContain("active_sessions_update");
    expect(js).not.toContain("activeSessionsTimer=setInterval");
  });

  it("binds version agent update buttons after rendering version cards", () => {
    const js = dashboardJs();

    expect(js).toContain("data-update-agent");
    expect(js).toContain("data-update-operation");
    expect(js).toContain("Install");
    expect(js).toContain("data-update-delete-log");
    expect(js).toContain("Delete Log");
    expect(js).not.toContain("data-update-log");
    expect(js).toContain("card('Runtime'");
    expect(js).toContain("bindAgentUpdateButtons();applyPermissions()");
  });

  it("loads dashboard CSS and JavaScript through static asset routes", () => {
    const serverSource = readFileSync("src/web/web-dashboard.ts", "utf8");
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");

    expect(serverSource).toContain('/assets/dashboard.css');
    expect(serverSource).toContain('/assets/dashboard.js');
    expect(serverSource).toContain('/assets/logo.png');
    expect(serverSource).toContain('/favicon.ico');
    expect(pageSource).toContain('href="/assets/dashboard.css"');
    expect(pageSource).toContain('href="/favicon.ico"');
    expect(pageSource).toContain('src="/assets/logo.png"');
    expect(pageSource).toContain('width="44" height="44"');
    expect(pageSource).toContain('class="brand-separator"');
    expect(pageSource).toContain('src="/assets/dashboard.js"');
    expect(pageSource).not.toContain("<style>${dashboardCss()}</style>");
    expect(pageSource).not.toContain("<script>${dashboardJs()}</script>");
  });

  it("resolves WebUI logo and favicon assets from source files", () => {
    expect(dashboardStaticAsset("logo.png")?.contentType).toBe("image/png");
    expect(dashboardStaticAsset("favicon.png")?.contentType).toBe("image/png");
    expect(dashboardStaticAsset("favicon.ico")?.contentType).toBe("image/x-icon");
  });

  it("guards dashboard stream and session data with scoped user access", () => {
    const source = readFileSync("src/web/web-dashboard.ts", "utf8");
    const sessionRoutes = readFileSync("src/web/web-dashboard-session-routes.ts", "utf8");

    expect(source).toContain('users.hasPermission(authUser, "sessions.read")');
    expect(source).toContain("scopeRelayEvent(authUser, event, canUseCurrentSession)");
    expect(sessionRoutes).toContain("assertSessionDetailScope(authUser, threadId, detail)");
    expect(sessionRoutes).toContain("scopedSessionPage(authUser, page)");
    expect(sessionRoutes).toContain("filterActivityByScope(authUser");
  });

  it("includes first-run admin setup guarded by a setup token", () => {
    const source = readFileSync("src/web/web-dashboard.ts", "utf8");
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");

    expect(source).toContain("firstRunSetupToken");
    expect(source).toContain("/api/setup/admin");
    expect(source).toContain("isLoopbackRequest");
    expect(source).toContain("isLoopbackHost");
    expect(pageSource).toContain("NordRelay Setup");
    expect(pageSource).toContain("setupToken");
  });

  it("composes dashboard assets from focused WebUI modules", () => {
    expect(readFileSync("src/web/ui/client/core/api-client.js", "utf8")).toContain("async function api");
    expect(readFileSync("src/web/ui/client/core/runtime.js", "utf8")).toContain("const state");
    expect(readFileSync("src/web/ui/client/core/components.js", "utf8")).toContain("function uiItem");
    expect(readFileSync("src/web/ui/client/overview.js", "utf8")).toContain("function renderSnapshot");
    expect(readFileSync("src/web/ui/client/workflows.js", "utf8")).toContain("function loadSessions");
    expect(readFileSync("src/web/ui/client/jobs.js", "utf8")).toContain("function renderUnifiedJobs");
    expect(readFileSync("src/web/ui/client/metrics.js", "utf8")).toContain("function loadMetrics");
    expect(readFileSync("src/web/ui/styles/theme.css", "utf8")).toContain(":root");
    expect(readFileSync("src/web/ui/styles/layout.css", "utf8")).toContain(".chat-layout");
  });

  it("includes peer discovery and peer health history in the WebUI", () => {
    const js = dashboardJs();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const contract = readFileSync("src/web/web-api-contract.ts", "utf8");

    expect(pageSource).toContain("Discover LAN peers");
    expect(pageSource).toContain('id="peerDiscovery"');
    expect(js).toContain("function discoverPeers");
    expect(js).toContain("/api/peers/discover");
    expect(js).toContain("Health history");
    expect(contract).toContain('exact("/api/peers/discover"');
  });

  it("normalizes dashboard control typography across platforms", () => {
    const layout = readFileSync("src/web/ui/styles/layout.css", "utf8");
    const components = readFileSync("src/web/ui/styles/components.css", "utf8");

    expect(layout).toContain("line-height:1.4");
    expect(layout).toContain("button{appearance:none");
    expect(layout).toContain("display:inline-flex");
    expect(layout).toContain("nav button{display:flex");
    expect(layout).toContain(".badge,.adapter-status{display:inline-flex");
    expect(components).toContain(".chip{display:inline-flex");
    expect(components).toContain(".mini-button{min-height:26px");
  });

  it("renders parseable permission-aware dashboard JavaScript", () => {
    const js = dashboardJs();

    expect(() => new Script(js)).not.toThrow();
    expect(js).toContain("function assertApiRoute");
    expect(js).toContain("function applyPermissions");
    expect(js).toContain("function can(permission)");
    expect(js).toContain("disabledAttr('queue.write')");
    expect(js).toContain("Permission required: users.read");
  });
});
