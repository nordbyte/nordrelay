import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { QueuePlanStore } from "../src/state/queue-plan-store.js";

describe("QueuePlanStore", () => {
  it("persists planned prompts and approval metadata", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-queue-plans-"));
    try {
      const store = new QueuePlanStore(workspace, "json");
      const draft = store.save({
        title: "Review release",
        prompt: "Review the release branch.",
        labels: ["release", "review"],
        priority: 20,
        agentId: "codex",
        workspace,
        threadId: "thread-1",
        ownerUserId: "user-1",
      });
      store.patch(draft.id, {
        status: "approved",
        approvedBy: "admin-1",
        queueId: "queue-1",
        correlationId: "corr-1",
      });

      const restored = new QueuePlanStore(workspace, "json");
      expect(restored.get(draft.id)).toMatchObject({
        title: "Review release",
        status: "approved",
        approvedBy: "admin-1",
        queueId: "queue-1",
        correlationId: "corr-1",
        labels: ["release", "review"],
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
