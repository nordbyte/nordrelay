import { describe, expect, it, vi } from "vitest";

import { CODEX_AGENT_CAPABILITIES, type AgentId, type AgentSessionInfo, type AgentThreadRecord } from "../src/agents/shared/agent.js";
import { relayRuntimeSessionDetail } from "../src/runtime/relay-runtime-session-detail.js";
import type { RelayRuntimeDelegate } from "../src/runtime/relay-runtime-delegate.js";
import type { ActiveSessionsDto } from "../src/runtime/relay-runtime-types.js";

const getExternalSnapshotForSession = vi.hoisted(() => vi.fn());

vi.mock("../src/agents/shared/agent-activity.js", () => ({
  getExternalSnapshotForSession,
}));

describe("relay runtime session detail", () => {
  it("includes external CLI messages and activity for active session details", async () => {
    getExternalSnapshotForSession.mockReturnValue({
      agentId: "codex",
      agentLabel: "Codex",
      threadId: "thread-1",
      sourcePath: "/tmp/rollout-thread-1.jsonl",
      sourceLabel: "Codex rollout",
      lineCount: 3,
      activity: {
        agentId: "codex",
        agentLabel: "Codex",
        threadId: "thread-1",
        sourcePath: "/tmp/rollout-thread-1.jsonl",
        sourceLabel: "Codex rollout",
        active: true,
        stale: false,
        turnId: "turn-1",
        startedAt: new Date("2026-05-21T08:00:00.000Z"),
        updatedAt: new Date("2026-05-21T08:00:03.000Z"),
      },
      events: [
        {
          lineNumber: 1,
          kind: "user",
          timestamp: new Date("2026-05-21T08:00:00.000Z"),
          type: "user_prompt",
          turnId: "turn-1",
          status: null,
          text: "Build the feature",
          toolName: null,
          phase: null,
        },
        {
          lineNumber: 2,
          kind: "tool",
          timestamp: new Date("2026-05-21T08:00:01.000Z"),
          type: "tool_call",
          turnId: "turn-1",
          status: "running",
          text: null,
          toolName: "exec_command",
          phase: null,
        },
        {
          lineNumber: 3,
          kind: "agent",
          timestamp: new Date("2026-05-21T08:00:03.000Z"),
          type: "agent_message",
          turnId: "turn-1",
          status: "completed",
          text: "Done.",
          toolName: null,
          phase: null,
        },
      ],
      latestAgentMessage: "Done.",
      latestUserMessage: "Build the feature",
      latestToolName: "exec_command",
    });

    const detail = await relayRuntimeSessionDetail(fakeRuntime(), "thread-1", "codex");
    const messages = detail.messages as Array<{ role: string; text: string; source: string }>;
    const activity = detail.activity as Array<{ type: string; detail?: string; source: string }>;

    expect(messages.map((message) => [message.role, message.text, message.source])).toEqual([
      ["user", "Build the feature", "cli"],
      ["agent", "Done.", "cli"],
    ]);
    expect(activity.map((event) => [event.type, event.detail, event.source])).toContainEqual([
      "tool_call",
      "exec_command",
      "cli",
    ]);
    expect((detail.active as AgentSessionInfo).threadId).toBe("thread-1");
    expect((detail.record as AgentThreadRecord).cwd).toBe("/workspace/project");
  });
});

function fakeRuntime(): RelayRuntimeDelegate {
  const info: AgentSessionInfo = {
    agentId: "codex",
    agentLabel: "Codex",
    threadId: "other-thread",
    workspace: "/workspace/project",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    launchProfileId: "default",
    launchProfileLabel: "Default",
    launchProfileBehavior: "workspace-write / never",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    fastMode: false,
    unsafeLaunch: false,
    capabilities: { ...CODEX_AGENT_CAPABILITIES, externalActivity: true },
  };
  const record: AgentThreadRecord = {
    id: "thread-1",
    title: "Build the feature",
    cwd: "/workspace/project",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    createdAt: new Date("2026-05-21T07:59:00.000Z"),
    updatedAt: new Date("2026-05-21T08:00:03.000Z"),
    firstUserMessage: "Build the feature",
    agentId: "codex",
    sessionPath: "/tmp/rollout-thread-1.jsonl",
  };
  const session = {
    getInfo: () => info,
    getActiveThreadId: () => info.threadId,
    getSessionRecord: (threadId: string) => threadId === record.id ? record : null,
  };
  return {
    config: {
      workspace: "/workspace/project",
      codexExternalBusyStaleMs: 60_000,
    },
    getSession: async () => session,
    publicInfo: (input: { getInfo: () => AgentSessionInfo }) => input.getInfo(),
    activeSessions: async () => ({
      sessions: [{
        id: "cli:codex:thread-1",
        contextKey: "cli:codex:thread-1",
        sourceContextKey: "cli:codex:thread-1",
        source: "cli",
        status: "external",
        agentId: "codex" as AgentId,
        agentLabel: "Codex",
        threadId: "thread-1",
        workspace: "/workspace/project",
        startedAt: "2026-05-21T08:00:00.000Z",
        updatedAt: "2026-05-21T08:00:03.000Z",
        durationMs: 3_000,
        queueLength: 0,
        queuePaused: false,
      }],
      updatedAt: "2026-05-21T08:00:03.000Z",
    }) satisfies ActiveSessionsDto,
    getControlSession: async () => ({ session, dispose: false }),
    capabilitiesForAgent: () => ({ ...CODEX_AGENT_CAPABILITIES, externalActivity: true }),
    sessionStubForMetadata: (meta) => ({
      getInfo: () => ({
        ...info,
        agentId: meta.agentId ?? "codex",
        threadId: meta.threadId,
        workspace: meta.workspace,
        sessionPath: meta.sessionPath,
      }),
      getActiveThreadId: () => meta.threadId,
    }),
    chatStore: { list: () => [] },
    activity: () => [],
  } as unknown as RelayRuntimeDelegate;
}
