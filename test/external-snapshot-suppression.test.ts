import { describe, expect, it } from "vitest";

import type { AgentExternalSnapshot } from "../src/agents/shared/agent.js";
import { isExternalSnapshotSuppressedByManagedAbort } from "../src/runtime/relay-runtime-helpers.js";
import type { WebActivityEvent } from "../src/web/web-state.js";

describe("external snapshot suppression", () => {
  it("suppresses active external snapshots after a managed abort for the same turn", () => {
    expect(isExternalSnapshotSuppressedByManagedAbort(
      activeSnapshot("thread-1", new Date("2026-05-23T10:00:00.000Z")),
      [abortEvent("thread-1", "web", "2026-05-23T10:00:04.000Z")],
    )).toBe(true);
  });

  it("does not suppress real CLI abort activity", () => {
    expect(isExternalSnapshotSuppressedByManagedAbort(
      activeSnapshot("thread-1", new Date("2026-05-23T10:00:00.000Z")),
      [abortEvent("thread-1", "cli", "2026-05-23T10:00:04.000Z")],
    )).toBe(false);
  });

  it("does not suppress snapshots when the abort happened before the active turn", () => {
    expect(isExternalSnapshotSuppressedByManagedAbort(
      activeSnapshot("thread-1", new Date("2026-05-23T10:00:10.000Z")),
      [abortEvent("thread-1", "web", "2026-05-23T10:00:00.000Z")],
    )).toBe(false);
  });
});

function activeSnapshot(threadId: string, startedAt: Date): AgentExternalSnapshot {
  return {
    agentId: "codex",
    agentLabel: "Codex",
    threadId,
    sourcePath: `/tmp/${threadId}.jsonl`,
    sourceLabel: "Codex rollout",
    lineCount: 1,
    activity: {
      agentId: "codex",
      agentLabel: "Codex",
      threadId,
      sourcePath: `/tmp/${threadId}.jsonl`,
      sourceLabel: "Codex rollout",
      active: true,
      stale: false,
      turnId: "turn-1",
      startedAt,
      updatedAt: startedAt,
    },
    events: [],
    latestAgentMessage: null,
    latestUserMessage: "Do the work",
    latestToolName: null,
  };
}

function abortEvent(threadId: string, source: WebActivityEvent["source"], timestamp: string): WebActivityEvent {
  return {
    id: `event-${source}-${timestamp}`,
    timestamp,
    source,
    status: "aborted",
    type: "prompt_aborted",
    threadId,
    workspace: "/workspace",
    agentId: "codex",
    detail: "Current operation aborted.",
  };
}
