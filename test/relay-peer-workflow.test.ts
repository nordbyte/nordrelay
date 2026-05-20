import { describe, expect, it } from "vitest";

import { runPeerWorkflowPromptStep, type PeerWorkflowClient } from "../src/runtime/relay-peer-workflow.js";
import type { WorkflowStep } from "../src/state/workflow-store.js";

describe("runPeerWorkflowPromptStep", () => {
  it("prepares a remote session, sends the prompt, and waits for completion", async () => {
    const calls: Array<{ peerId: string; path: string; body?: Record<string, unknown>; query?: Record<string, unknown> }> = [];
    const client: PeerWorkflowClient = {
      async webProxy(peerId, payload) {
        calls.push({ peerId, path: payload.path, body: payload.body, query: payload.query });
        if (payload.path === "/api/trace") {
          return {
            correlationId: payload.query?.correlationId,
            summary: { startedAt: "2026-05-18T10:00:00.000Z", updatedAt: "2026-05-18T10:00:01.000Z", status: "completed", sources: ["activity"] },
            activity: [{ id: "a1", timestamp: "2026-05-18T10:00:01.000Z", source: "web", status: "completed", type: "prompt_completed", threadId: "t1", correlationId: payload.query?.correlationId }],
            audit: [],
            chat: [],
            queue: [],
            jobs: [],
            timeline: [],
          };
        }
        return { ok: true };
      },
    };
    const step: WorkflowStep = {
      id: "s1",
      name: "Remote step",
      type: "prompt",
      prompt: "Run remote",
      agentId: "codex",
      workspace: "/repo",
      workspaceMode: "worktree",
      model: "gpt-5.5",
      sessionMode: "new",
      target: "peer:peer-1",
      requiresApproval: false,
      continueOnError: false,
    };

    await expect(runPeerWorkflowPromptStep({
      client,
      peerId: "peer-1",
      step,
      prompt: "Run remote",
      correlationId: "corr-1",
    })).resolves.toMatchObject({ status: "completed" });

    expect(calls.map((call) => call.path)).toEqual(["/api/sessions/new", "/api/prompt", "/api/trace"]);
    expect(calls[0]?.body).toMatchObject({ agentId: "codex", workspace: "/repo", workspaceMode: "worktree", model: "gpt-5.5" });
    expect(calls[1]?.body).toMatchObject({ text: "Run remote", correlationId: "corr-1" });
  });
});
