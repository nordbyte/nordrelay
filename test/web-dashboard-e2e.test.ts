import { readFileSync } from "node:fs";
import { Script } from "node:vm";

import { describe, expect, it } from "vitest";

import { dashboardCss, dashboardJs } from "../src/web-dashboard-assets.js";

describe("web dashboard browser-flow assets", () => {
  it("includes the agent feature matrix and dedicated agent update log flow", () => {
    const css = dashboardCss();
    const js = dashboardJs();

    expect(css).toContain(".feature-matrix");
    expect(js).toContain("function featureMatrix");
    expect(js).toContain("agent-updates");
    expect(js).toContain("/api/agent-updates");
  });

  it("refreshes the active page after an agent switch", () => {
    const js = dashboardJs();

    expect(js).toContain("await loadBootstrap();await reloadCurrentPage({agentId:selected})");
    expect(js).toContain("if(name==='sessions') await loadSessions(true,options.agentId)");
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
    const serverSource = readFileSync("src/web-dashboard.ts", "utf8");
    const pageSource = readFileSync("src/web-dashboard-pages.ts", "utf8");

    expect(serverSource).toContain('/assets/dashboard.css');
    expect(serverSource).toContain('/assets/dashboard.js');
    expect(pageSource).toContain('href="/assets/dashboard.css"');
    expect(pageSource).toContain('src="/assets/dashboard.js"');
    expect(pageSource).not.toContain("<style>${dashboardCss()}</style>");
    expect(pageSource).not.toContain("<script>${dashboardJs()}</script>");
  });

  it("guards dashboard stream and session data with scoped user access", () => {
    const source = readFileSync("src/web-dashboard.ts", "utf8");
    const sessionRoutes = readFileSync("src/web-dashboard-session-routes.ts", "utf8");

    expect(source).toContain('users.hasPermission(authUser, "sessions.read")');
    expect(source).toContain("scopeRelayEvent(authUser, event, canUseCurrentSession)");
    expect(sessionRoutes).toContain("assertSessionDetailScope(authUser, threadId, detail)");
    expect(sessionRoutes).toContain("scopedSessionPage(authUser, page)");
    expect(sessionRoutes).toContain("filterActivityByScope(authUser");
  });

  it("composes dashboard assets from focused WebUI modules", () => {
    expect(readFileSync("src/webui/client/core/api-client.js", "utf8")).toContain("async function api");
    expect(readFileSync("src/webui/client/core/runtime.js", "utf8")).toContain("const state");
    expect(readFileSync("src/webui/client/overview.js", "utf8")).toContain("function renderSnapshot");
    expect(readFileSync("src/webui/client/workflows.js", "utf8")).toContain("function loadSessions");
    expect(readFileSync("src/webui/styles/theme.css", "utf8")).toContain(":root");
    expect(readFileSync("src/webui/styles/layout.css", "utf8")).toContain(".chat-layout");
  });

  it("normalizes dashboard control typography across platforms", () => {
    const layout = readFileSync("src/webui/styles/layout.css", "utf8");
    const components = readFileSync("src/webui/styles/components.css", "utf8");

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
