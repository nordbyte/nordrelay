import { describe, expect, it, vi } from "vitest";

import { CODEX_AGENT_CAPABILITIES, type AgentExternalSnapshot, type AgentSessionInfo, type AgentSessionService } from "../src/agents/shared/agent.js";
import { RelayExternalActivityMonitor } from "../src/runtime/relay-external-activity-monitor.js";
import type { RelayEvent } from "../src/runtime/relay-runtime-types.js";
import type { WebChatMessage } from "../src/web/web-state.js";

const getExternalSnapshotForSession = vi.hoisted(() => vi.fn());

vi.mock("../src/agents/shared/agent-activity.js", () => ({
  getExternalSnapshotForSession,
}));

describe("RelayExternalActivityMonitor", () => {
  it("broadcasts WebUI chat history for external CLI prompts even when Web mirror is off", async () => {
    getExternalSnapshotForSession.mockReturnValue(activeSnapshot());
    const broadcasts: RelayEvent[] = [];
    const chatMessages: WebChatMessage[] = [{
      id: "external-user",
      threadId: "thread-1",
      role: "user",
      text: "Build the feature",
      timestamp: "2026-05-25T07:00:00.000Z",
      source: "cli",
      turnId: "turn-1",
    }];
    const monitor = new RelayExternalActivityMonitor({
      config: { workspace: "/workspace", codexExternalBusyStaleMs: 60_000 } as never,
      getSession: async () => session(),
      publicInfo: () => sessionInfo(),
      queueLength: () => 0,
      mirrorMode: () => "off",
      mirrorMinUpdateMs: () => 0,
      chatStore: {
        appendWithResult: vi.fn(),
        upsertByKey: vi.fn(),
      } as never,
      chatHistory: async () => chatMessages,
      activity: () => [],
      persistWorkspaceArtifactsForTurn: async () => {},
      drainQueue: async () => {},
      appendActivity: vi.fn((input) => ({ ...input, id: "activity-1", timestamp: "2026-05-25T07:00:00.000Z" })),
      broadcast: (event) => broadcasts.push(event),
      broadcastStatus: vi.fn(),
      scheduleActiveSessionsBroadcast: vi.fn(),
    });

    await monitor.monitorSafe();

    expect(broadcasts).toContainEqual({ type: "chat_history", messages: chatMessages });
  });
});

function session(): AgentSessionService {
  return {
    getInfo: () => sessionInfo(),
    getActiveThreadId: () => "thread-1",
    isProcessing: () => false,
  } as AgentSessionService;
}

function sessionInfo(): AgentSessionInfo {
  return {
    agentId: "codex",
    agentLabel: "Codex",
    threadId: "thread-1",
    workspace: "/workspace",
    model: "gpt-5.5",
    launchProfileId: "default",
    launchProfileLabel: "Default",
    launchProfileBehavior: "workspace-write / never",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    fastMode: false,
    unsafeLaunch: false,
    capabilities: { ...CODEX_AGENT_CAPABILITIES, externalActivity: true },
  };
}

function activeSnapshot(): AgentExternalSnapshot {
  return {
    agentId: "codex",
    agentLabel: "Codex",
    threadId: "thread-1",
    sourcePath: "/tmp/rollout-thread-1.jsonl",
    sourceLabel: "Codex rollout",
    lineCount: 1,
    activity: {
      agentId: "codex",
      agentLabel: "Codex",
      threadId: "thread-1",
      sourcePath: "/tmp/rollout-thread-1.jsonl",
      sourceLabel: "Codex rollout",
      active: true,
      stale: false,
      turnId: "turn-1",
      startedAt: new Date("2026-05-25T07:00:00.000Z"),
      updatedAt: new Date("2026-05-25T07:00:00.000Z"),
    },
    events: [{
      lineNumber: 1,
      kind: "user",
      timestamp: new Date("2026-05-25T07:00:00.000Z"),
      type: "user_prompt",
      turnId: "turn-1",
      status: null,
      text: "Build the feature",
      toolName: null,
      phase: null,
    }],
    latestAgentMessage: null,
    latestUserMessage: "Build the feature",
    latestToolName: null,
  };
}
