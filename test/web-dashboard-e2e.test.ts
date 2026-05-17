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

  it("includes unified jobs on the Monitor Tasks tab", () => {
    const js = dashboardJs();
    const contract = readFileSync("src/web/web-api-contract.ts", "utf8");

    expect(js).toContain("function renderUnifiedJobs");
    expect(js).toContain("function uiTraceControls");
    expect(js).toContain("bindUiCopyButtons(target)");
    expect(js).toContain("bindUiTraceButtons(target)");
    expect(js).toContain("/api/jobs");
    expect(js).toContain("data-job-action");
    expect(contract).toContain('exact("/api/jobs"');
    expect(contract).toContain('dynamic("/api/jobs/:id/action"');
  });

  it("groups activity, tasks, trace, and artifacts under the Monitor page", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const navSource = readFileSync("src/web/web-dashboard-ui.ts", "utf8");

    expect(navSource).toContain('{ id: "monitor", label: "Monitor"');
    expect(navSource).not.toContain('{ id: "tasks", label: "Tasks"');
    expect(navSource).not.toContain('{ id: "activity", label: "Activity"');
    expect(navSource).not.toContain('{ id: "trace", label: "Trace"');
    expect(navSource).not.toContain('{ id: "artifacts", label: "Artifacts"');
    expect(pageSource).toContain('id="page-monitor"');
    expect(pageSource).toContain('data-monitor-tab="activity"');
    expect(pageSource).toContain('data-monitor-tab="tasks"');
    expect(pageSource).toContain('data-monitor-tab="trace"');
    expect(pageSource).toContain('data-monitor-tab="artifacts"');
    expect(pageSource).not.toContain('id="page-tasks"');
    expect(pageSource).not.toContain('id="page-activity"');
    expect(pageSource).not.toContain('id="page-trace"');
    expect(pageSource).not.toContain('id="page-artifacts"');
    expect(js).toContain("function loadMonitor");
    expect(js).toContain("function switchMonitorTab");
    expect(js).toContain("page('monitor')");
    expect(css).toContain(".monitor-tab-heading");
  });

  it("includes workflow templates and workflow runs in the WebUI", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const contract = readFileSync("src/web/web-api-contract.ts", "utf8");

    expect(pageSource).toContain('id="page-workflows"');
    expect(pageSource).toContain('id="createTemplateBtn"');
    expect(pageSource).toContain('id="createWorkflowBtn"');
    expect(js).toContain("function loadWorkflows");
    expect(js).toContain("document.addEventListener('click'");
    expect(js).toContain("[data-workflow-tab]");
    expect(js).toContain("function workflowBuilderState");
    expect(js).toContain("function openWorkflowVariableDialog");
    expect(js).toContain("Advanced JSON import/export");
    expect(js).not.toContain("Steps JSON");
    expect(js).not.toContain("JSON.parse(val('dlgWorkflowSteps'))");
    expect(readFileSync("scripts/build-web-assets.mjs", "utf8")).toContain("src/web/ui/client/workflows-page.js");
    expect(js).toContain("/api/templates");
    expect(js).toContain("/api/workflows");
    expect(js).toContain("/api/workflow-runs/");
    expect(css).toContain(".workflow-section-header");
    expect(css).toContain(".workflow-tab-heading");
    expect(css).toContain(".workflow-builder-step");
    expect(css).toContain(".workflow-builder-json");
    expect(contract).toContain('exact("/api/templates"');
    expect(contract).toContain('exact("/api/workflows"');
    expect(contract).toContain('dynamic("/api/workflow-runs/:id/cancel"');
  });

  it("passes WebUI correlation IDs through prompts and queued feedback", () => {
    const js = dashboardJs();

    expect(js).toContain("function createWebCorrelationId");
    expect(js).toContain("body:JSON.stringify({text,correlationId})");
    expect(js).toContain("body:JSON.stringify({text,correlationId,files:payloadFiles})");
    expect(js).toContain("appendQueuedMessage(r.queueId,r.correlationId||correlationId)");
    expect(js).toContain("function appendQueuedMessage(id,correlationId)");
  });

  it("includes queue planner kanban tabs on the Queue page", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const contract = readFileSync("src/web/web-api-contract.ts", "utf8");

    expect(pageSource).toContain('data-queue-tab="planner"');
    expect(pageSource).toContain("queue-section-header");
    expect(pageSource).toContain('id="queuePlannerBoard"');
    expect(pageSource).toContain('id="queueProgressBoard"');
    expect(js).toContain("function loadQueue");
    expect(js).toContain("function renderQueueKanban");
    expect(js).toContain("loadQueuePlanner(options={})");
    expect(js).toContain("setLoading('queuePlannerBoard','Loading planned prompts...')");
    expect(js).toContain("loadQueuePlanner({notify:true})");
    expect(js).toContain("/api/queue/plans");
    expect(js).toContain("data-plan-enqueue");
    expect(css).toContain(".queue-kanban");
    expect(css).toContain(".queue-tab-heading");
    expect(contract).toContain('exact("/api/queue/plans"');
    expect(contract).toContain('dynamic("/api/queue/plans/:id/enqueue"');
    expect(readFileSync("scripts/build-web-assets.mjs", "utf8")).toContain("src/web/ui/client/queue-planner.js");
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

  it("includes Discord invite and channel registration guidance in the setup wizard", () => {
    const js = dashboardJs();
    const css = dashboardCss();

    expect(js).toContain("OAuth2 URL Generator");
    expect(js).toContain("applications.commands scopes");
    expect(js).toContain("View Channels, Send Messages, Send Messages in Threads, Read Message History, Attach Files, and Embed Links");
    expect(js).toContain("Message Content Intent");
    expect(js).toContain("/register_channel");
    expect(js).toContain("DISCORD_ALLOWED_GUILD_IDS");
    expect(js).toContain("function wizardChecklist");
    expect(css).toContain(".wizard-checklist");
  });

  it("refreshes the active page after an agent switch", () => {
    const js = dashboardJs();

    expect(js).toContain("await loadBootstrap();await reloadCurrentPage({agentId:selected})");
    expect(js).toContain("if(name==='overview') await loadActiveSessions()");
    expect(js).toContain("if(name==='sessions') await loadSessions(true,options.agentId)");
  });

  it("selects the current launch mode in the launch dropdown", () => {
    const js = dashboardJs();

    expect(js).toContain("selectedLaunch=s.launchProfileId||s.nextLaunchProfileId");
    expect(js).toContain("compactControlMenu('controlLaunch','Launch'");
    expect(js).toContain("function bindCompactControlMenus");
    expect(js).toContain("selectedCompactControlValue('controlLaunch')");
    expect(js).toContain(">Apply</button>");
    expect(js).not.toContain("Apply to Current");
    expect(js).not.toContain("<label>Launch<select id=\"controlLaunch\"");
    expect(js).not.toContain("Active launch");
    expect(js).not.toContain("Next launch");
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
    expect(js).toContain("function renderChatWorkingIndicator");
    expect(js).toContain("Working...");
    expect(readFileSync("src/runtime/relay-runtime-active-sessions.ts", "utf8")).toContain("right.durationMs - left.durationMs");
    expect(readFileSync("src/runtime/relay-runtime-active-sessions.ts", "utf8")).toContain("function safeActiveSessionList");
    expect(readFileSync("src/agents/shared/agent-activity.ts", "utf8")).toContain("snapshot = null");
    expect(js).not.toContain("activeSessionsTimer=setInterval");
  });

  it("renders compact chat lists and copy controls for chat messages", () => {
    const js = dashboardJs();
    const css = dashboardCss();

    expect(js).toContain("function normalizeChatListSpacing");
    expect(js).toContain('replace(/<\\/(ul|ol)>\\n+(?=\\S)/g');
    expect(js).toContain("function chatMessageCopyButtonHtml");
    expect(js).toContain("data-message-index");
    expect(js).toContain("function bindChatMessageCopyButton");
    expect(js).toContain("Message copied");
    expect(css).toContain(".message-copy-button");
    expect(css).toContain(".message:hover .message-copy-button");
  });

  it("uses a friendly dashboard API network failure message", () => {
    const js = dashboardJs();

    expect(js).toContain("function fetchApi");
    expect(js).toContain("NordRelay API is unreachable. Check that the dashboard is still running, then reload the page.");
    expect(js).not.toContain("await fetch(url.pathname + url.search");
  });

  it("allows every dashboard dialog to close from backdrop clicks", () => {
    const js = dashboardJs();

    expect(js).toContain("function bindDialogBackdropClose");
    expect(js).toContain("function isDialogBackdropClick");
    expect(js).toContain("event.target.close()");
  });

  it("binds version agent update buttons after rendering version cards", () => {
    const js = dashboardJs();

    expect(js).toContain("data-update-agent");
    expect(js).toContain("updateOperation");
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
    expect(pageSource).toContain('href="/assets/dashboard.css?v=');
    expect(pageSource).toContain('href="/favicon.ico"');
    expect(pageSource).toContain('src="/assets/logo.png"');
    expect(pageSource).toContain('width="44" height="44"');
    expect(pageSource).toContain('class="brand-separator"');
    expect(pageSource).toContain('src="/assets/dashboard.js?v=');
    expect(pageSource).not.toContain("<style>${dashboardCss()}</style>");
    expect(pageSource).not.toContain("<script>${dashboardJs()}</script>");
    expect(dashboardCss()).toContain("--sidebar-border:#2a3a30");
    expect(dashboardCss()).toContain("--scrollbar-thumb:#b6c5b8");
    expect(dashboardCss()).toContain("--scrollbar-thumb:#3a4c40");
    expect(dashboardCss()).toContain("scrollbar-color:var(--scrollbar-thumb) var(--scrollbar-track)");
    expect(dashboardCss()).toContain(".brand-separator{height:1px;background:var(--sidebar-border)");
    expect(dashboardCss()).toContain(".sidebar{position:sticky;top:0;height:100vh");
    expect(dashboardCss()).toContain("height:calc(var(--dashboard-header-height) - 1px);padding:0 18px");
    expect(dashboardCss()).toContain("input,select,textarea{font-size:15px}");
    expect(dashboardCss()).toContain(".workflow-builder-json textarea{width:100%;min-width:0;margin-top:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px}");
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

  it("includes account profile APIs and header profile controls", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const contract = readFileSync("src/web/web-api-contract.ts", "utf8");

    expect(contract).toContain('exact("/api/profile"');
    expect(contract).toContain('exact("/api/profile/password"');
    expect(contract).toContain('exact("/api/profile/logout-other-sessions"');
    expect(pageSource).toContain('id="userMenuBtn"');
    expect(pageSource).toContain('id="profileDialog"');
    expect(pageSource).toContain('id="profileThemeSelect"');
    expect(js).toContain("function applyAccountChrome");
    expect(js).toContain("/api/profile/logout-other-sessions");
    expect(js).toContain("applyThemePreference(accountTheme||savedThemePreference()");
    expect(js).toContain("local:true");
    expect(css).toContain(".account-menu-panel");
    expect(css).toContain(".profile-grid");
  });

  it("composes dashboard assets from focused WebUI modules", () => {
    expect(readFileSync("src/web/ui/client/core/api-client.js", "utf8")).toContain("async function api");
    expect(readFileSync("src/web/ui/client/core/runtime.js", "utf8")).toContain("const state");
    expect(readFileSync("src/web/ui/client/core/components.js", "utf8")).toContain("function uiItem");
    expect(readFileSync("src/web/ui/client/profile.js", "utf8")).toContain("function openProfileDialog");
    const overview = readFileSync("src/web/ui/client/overview.js", "utf8");
    expect(overview).toContain("function renderSnapshot");
    expect(overview).toContain("uiCopyButton(thread,'Thread ID copied')");
    expect(overview).toContain("bindUiCopyButtons(line)");
    expect(readFileSync("src/web/ui/client/workflows.js", "utf8")).toContain("function loadSessions");
    expect(readFileSync("src/web/ui/client/jobs.js", "utf8")).toContain("function renderUnifiedJobs");
    expect(readFileSync("src/web/ui/client/metrics.js", "utf8")).toContain("function loadMetrics");
    expect(readFileSync("src/web/ui/client/users.js", "utf8")).toContain("function renderUserManagementV2");
    expect(readFileSync("src/web/ui/styles/theme.css", "utf8")).toContain(":root");
    expect(readFileSync("src/web/ui/styles/layout.css", "utf8")).toContain(".chat-layout");
  });

  it("includes peer discovery and peer health history in the WebUI", () => {
    const js = dashboardJs();
    const css = dashboardCss();
    const pageSource = readFileSync("src/web/web-dashboard-pages.ts", "utf8");
    const contract = readFileSync("src/web/web-api-contract.ts", "utf8");

    expect(pageSource).toContain('id="peerTabs"');
    expect(pageSource).toContain('data-peer-tab="status"');
    expect(pageSource).toContain('data-peer-tab-panel="discovery"');
    expect(pageSource).toContain("Discover LAN peers");
    expect(pageSource).toContain('id="peerDiscovery"');
    expect(js).toContain("function switchPeerTab");
    expect(js).toContain("data-peer-tab-panel");
    expect(js).toContain("function discoverPeers");
    expect(js).toContain("/api/peers/discover");
    expect(js).toContain("Health history");
    expect(css).toContain(".peer-tab");
    expect(contract).toContain('exact("/api/peers/discover"');
  });

  it("normalizes dashboard control typography across platforms", () => {
    const layout = readFileSync("src/web/ui/styles/layout.css", "utf8");
    const components = readFileSync("src/web/ui/styles/components.css", "utf8");

    expect(layout).toContain("line-height:1.4");
    expect(layout).toContain("button{appearance:none");
    expect(layout).toContain("display:inline-flex");
    expect(layout).toContain(".control-grid{display:flex");
    expect(layout).toContain("align-items:flex-end");
    expect(layout).toContain(".control-menu-button");
    expect(layout).toContain(".control-menu-list");
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
