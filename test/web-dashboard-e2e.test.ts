import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { dashboardJs } from "../src/web-dashboard-client.js";
import { dashboardCss } from "../src/web-dashboard-style.js";
import { dashboardClientFoundation } from "../src/webui/client-foundation.js";
import { dashboardClientWorkflows } from "../src/webui/client-workflows.js";
import { dashboardStyleLayout } from "../src/webui/style-layout.js";
import { dashboardStyleTheme } from "../src/webui/style-theme.js";

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
    expect(js).toContain("card('Runtime'");
    expect(js).toContain(");bindAgentUpdateButtons()}");
  });

  it("loads dashboard CSS and JavaScript through static asset routes", () => {
    const source = readFileSync("src/web-dashboard.ts", "utf8");

    expect(source).toContain('/assets/dashboard.css');
    expect(source).toContain('/assets/dashboard.js');
    expect(source).toContain('href="/assets/dashboard.css"');
    expect(source).toContain('src="/assets/dashboard.js"');
    expect(source).not.toContain("<style>${dashboardCss()}</style>");
    expect(source).not.toContain("<script>${dashboardJs()}</script>");
  });

  it("guards dashboard stream and session data with scoped user access", () => {
    const source = readFileSync("src/web-dashboard.ts", "utf8");

    expect(source).toContain('users.hasPermission(authUser, "sessions.read")');
    expect(source).toContain("scopeRelayEvent(authUser, event, canUseCurrentSession)");
    expect(source).toContain("assertSessionDetailScope(authUser, threadId, detail)");
    expect(source).toContain("scopedSessionPage(authUser, page)");
    expect(source).toContain("filterActivityByScope(authUser");
  });

  it("composes dashboard assets from focused WebUI modules", () => {
    expect(dashboardClientFoundation()).toContain("function renderSnapshot");
    expect(dashboardClientWorkflows()).toContain("function loadSessions");
    expect(dashboardStyleTheme()).toContain(":root");
    expect(dashboardStyleLayout()).toContain(".chat-layout");
  });
});
