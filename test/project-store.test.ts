import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ProjectStore } from "../src/state/project-store.js";

describe("ProjectStore", () => {
  it("persists projects, linked sessions, plan items, and analysis jobs", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-projects-"));
    try {
      const store = new ProjectStore(workspace, "json");
      const project = store.save({
        name: "NordRelay",
        workspacePath: workspace,
        defaultAgentId: "codex",
        summaryMarkdown: "# Summary",
      });
      store.linkSession(project.id, {
        threadId: "thread-1",
        agentId: "codex",
        workspace,
      });
      store.patch(project.id, {
        planMarkdown: "# Plan",
        planItems: [{
          id: "plan-1",
          title: "Add Projects",
          description: "Track project planning state.",
          priority: 90,
          category: "WebUI",
          mode: "features",
          targetArea: "Projects",
          status: "proposed",
          userValue: "Admins can plan project work from NordRelay.",
          blockedBy: ["project summary"],
          confidence: 82,
          evidence: ["src/state/project-store.ts"],
          alreadyExistsCheck: "partial",
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z",
        }],
      });
      const job = store.saveJob({
        projectId: project.id,
        kind: "summary",
        status: "running",
        correlationId: "corr-1",
        log: ["started"],
      });
      store.patchJob(job.id, { status: "completed", outputMarkdown: "# Summary" });

      const restored = new ProjectStore(workspace, "json");
      expect(restored.get(project.id)).toMatchObject({
        name: "NordRelay",
        workspacePath: workspace,
        defaultAgentId: "codex",
        linkedSessions: [expect.objectContaining({ threadId: "thread-1", agentId: "codex" })],
        planItems: [expect.objectContaining({
          title: "Add Projects",
          priority: 90,
          category: "WebUI",
          mode: "features",
          targetArea: "Projects",
          blockedBy: ["project summary"],
          confidence: 82,
        })],
      });
      expect(restored.listJobs(project.id)).toEqual([
        expect.objectContaining({
          projectId: project.id,
          kind: "summary",
          status: "completed",
          correlationId: "corr-1",
        }),
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
