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
});
