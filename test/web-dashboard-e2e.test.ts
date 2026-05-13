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
    expect(js).toContain("data-update-delete-log");
    expect(js).toContain("Delete Log");
    expect(js).not.toContain("data-update-log");
    expect(js).toContain("card('Runtime'");
    expect(js).toContain("bindAgentUpdateButtons();applyPermissions()");
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
    expect(readFileSync("src/webui/client/foundation.js", "utf8")).toContain("function renderSnapshot");
    expect(readFileSync("src/webui/client/workflows.js", "utf8")).toContain("function loadSessions");
    expect(readFileSync("src/webui/styles/theme.css", "utf8")).toContain(":root");
    expect(readFileSync("src/webui/styles/layout.css", "utf8")).toContain(".chat-layout");
  });

  it("renders parseable permission-aware dashboard JavaScript", () => {
    const js = dashboardJs();

    expect(() => new Script(js)).not.toThrow();
    expect(js).toContain("function applyPermissions");
    expect(js).toContain("function can(permission)");
    expect(js).toContain("disabledAttr('queue.write')");
    expect(js).toContain("Permission required: users.read");
  });
});
