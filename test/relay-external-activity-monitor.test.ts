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

  it("stores external status mirror updates as separate WebUI chat messages", async () => {
    getExternalSnapshotForSession
      .mockReturnValueOnce(activeSnapshot({ lineCount: 1, latestToolName: "read_file" }))
      .mockReturnValueOnce(activeSnapshot({ lineCount: 2, latestToolName: "exec_command" }));
    const appendWithResult = vi.fn((input: any) => ({
      message: {
        id: `message-${appendWithResult.mock.calls.length}`,
        timestamp: "2026-05-25T07:00:00.000Z",
        ...input,
        threadId: input.threadId ?? "pending",
      },
      inserted: true,
    }));
    const upsertByKey = vi.fn();
    const monitor = new RelayExternalActivityMonitor({
      config: { workspace: "/workspace", codexExternalBusyStaleMs: 60_000 } as never,
      getSession: async () => session(),
      publicInfo: () => sessionInfo(),
      queueLength: () => 0,
      mirrorMode: () => "status",
      mirrorMinUpdateMs: () => 0,
      chatStore: {
        appendWithResult,
        upsertByKey,
      } as never,
      chatHistory: async () => [],
      activity: () => [],
      persistWorkspaceArtifactsForTurn: async () => {},
      drainQueue: async () => {},
      appendActivity: vi.fn((input) => ({ ...input, id: "activity-1", timestamp: "2026-05-25T07:00:00.000Z" })),
      broadcast: vi.fn(),
      broadcastStatus: vi.fn(),
      scheduleActiveSessionsBroadcast: vi.fn(),
    });

    await monitor.monitorSafe();
    await monitor.monitorSafe();

    expect(upsertByKey).not.toHaveBeenCalled();
    expect(appendWithResult).toHaveBeenCalledWith(expect.objectContaining({
      key: "external:status:codex:thread-1:turn-1:1",
      text: expect.stringContaining("Last tool: read_file"),
    }));
    expect(appendWithResult).toHaveBeenCalledWith(expect.objectContaining({
      key: "external:status:codex:thread-1:turn-1:2",
      text: expect.stringContaining("Last tool: exec_command"),
    }));
  });

  it("broadcasts new external CLI agent messages live in status mode", async () => {
    getExternalSnapshotForSession
      .mockReturnValueOnce(activeSnapshot({ lineCount: 1 }))
      .mockReturnValueOnce(activeSnapshot({
        lineCount: 2,
        events: [
          activeSnapshot().events[0]!,
          {
            lineNumber: 2,
            kind: "agent",
            timestamp: new Date("2026-05-25T07:00:04.000Z"),
            type: "agent_message",
            turnId: "turn-1",
            status: null,
            text: "I am checking the schema now.",
            toolName: null,
            phase: null,
          },
        ],
        latestAgentMessage: "I am checking the schema now.",
      }));
    const messages: WebChatMessage[] = [];
    const broadcasts: RelayEvent[] = [];
    const appendWithResult = vi.fn((input: any) => {
      const existing = input.key ? messages.find((message) => message.key === input.key) : undefined;
      if (existing) {
        return { message: existing, inserted: false };
      }
      const message: WebChatMessage = {
        id: `message-${messages.length + 1}`,
        timestamp: input.timestamp ?? "2026-05-25T07:00:04.000Z",
        ...input,
        threadId: input.threadId ?? "pending",
      };
      messages.push(message);
      return { message, inserted: true };
    });
    const monitor = new RelayExternalActivityMonitor({
      config: { workspace: "/workspace", codexExternalBusyStaleMs: 60_000 } as never,
      getSession: async () => session(),
      publicInfo: () => sessionInfo(),
      queueLength: () => 0,
      mirrorMode: () => "status",
      mirrorMinUpdateMs: () => 60_000,
      chatStore: {
        appendWithResult,
        upsertByKey: vi.fn(),
      } as never,
      chatHistory: async () => messages,
      activity: () => [],
      persistWorkspaceArtifactsForTurn: async () => {},
      drainQueue: async () => {},
      appendActivity: vi.fn((input) => ({ ...input, id: "activity-1", timestamp: "2026-05-25T07:00:00.000Z" })),
      broadcast: (event) => broadcasts.push(event),
      broadcastStatus: vi.fn(),
      scheduleActiveSessionsBroadcast: vi.fn(),
    });

    await monitor.monitorSafe();
    broadcasts.length = 0;
    await monitor.monitorSafe();

    expect(appendWithResult).toHaveBeenCalledWith(expect.objectContaining({
      role: "agent",
      source: "cli",
      key: "external:/tmp/rollout-thread-1.jsonl:2",
      text: "I am checking the schema now.",
    }));
    expect(broadcasts).toContainEqual({
      type: "chat_history",
      messages: expect.arrayContaining([
        expect.objectContaining({ role: "agent", source: "cli", text: "I am checking the schema now." }),
      ]),
    });
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

function activeSnapshot(overrides: Partial<AgentExternalSnapshot> = {}): AgentExternalSnapshot {
  const snapshot: AgentExternalSnapshot = {
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
  return {
    ...snapshot,
    ...overrides,
    activity: {
      ...snapshot.activity,
      ...overrides.activity,
    },
    events: overrides.events ?? snapshot.events,
  };
}
