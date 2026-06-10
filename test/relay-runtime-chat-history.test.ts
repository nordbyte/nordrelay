import { describe, expect, it, vi } from "vitest";

import { CODEX_AGENT_CAPABILITIES, type AgentSessionInfo } from "../src/agents/shared/agent.js";
import { relayRuntimeChatHistory, relayRuntimeChatHistoryPage } from "../src/runtime/relay-runtime-sessions.js";
import type { RelayRuntimeDelegate } from "../src/runtime/relay-runtime-delegate.js";
import type { WebChatMessage } from "../src/web/web-state.js";

const getExternalSnapshotForSession = vi.hoisted(() => vi.fn());

vi.mock("../src/agents/shared/agent-activity.js", () => ({
  getExternalSnapshotForSession,
}));

describe("relayRuntimeChatHistory", () => {
  it("merges external CLI messages into WebUI chat history without duplicates", async () => {
    getExternalSnapshotForSession.mockReturnValue({
      agentId: "codex",
      agentLabel: "Codex",
      threadId: "thread-1",
      sourcePath: "/tmp/rollout-thread-1.jsonl",
      sourceLabel: "Codex rollout",
      lineCount: 2,
      activity: {
        agentId: "codex",
        agentLabel: "Codex",
        threadId: "thread-1",
        sourcePath: "/tmp/rollout-thread-1.jsonl",
        sourceLabel: "Codex rollout",
        active: false,
        stale: false,
        turnId: "turn-1",
        startedAt: new Date("2026-05-21T08:00:00.000Z"),
        updatedAt: new Date("2026-05-21T08:00:10.000Z"),
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
          kind: "agent",
          timestamp: new Date("2026-05-21T08:00:10.000Z"),
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
      latestToolName: null,
    });

    const runtime = fakeRuntime([{
      id: "web-1",
      threadId: "thread-1",
      role: "agent",
      text: "Done.",
      timestamp: "2026-05-21T08:00:11.000Z",
      source: "web",
      turnId: "web-turn",
    }]);

    const messages = await relayRuntimeChatHistory(runtime, 20);

    expect(messages.map((message) => [message.role, message.text, message.source])).toEqual([
      ["user", "Build the feature", "cli"],
      ["agent", "Done.", "web"],
    ]);
    expect(messages.filter((message) => message.text === "Done.")).toHaveLength(1);
  });

  it("prefers external CLI user prompts over legacy Working status messages", async () => {
    getExternalSnapshotForSession.mockReturnValue({
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
        startedAt: new Date("2026-05-21T08:00:00.000Z"),
        updatedAt: new Date("2026-05-21T08:00:00.000Z"),
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
      ],
      latestAgentMessage: null,
      latestUserMessage: "Build the feature",
      latestToolName: null,
    });

    const runtime = fakeRuntime([{
      id: "legacy-working",
      threadId: "thread-1",
      role: "system",
      text: "Working on Build the feature",
      timestamp: "2026-05-21T08:00:00.000Z",
      source: "cli",
      turnId: "turn-1",
    }]);

    const messages = await relayRuntimeChatHistory(runtime, 20);

    expect(messages.map((message) => [message.role, message.text, message.source])).toEqual([
      ["user", "Build the feature", "cli"],
    ]);
  });

  it("paginates chat history with an older-message cursor", async () => {
    getExternalSnapshotForSession.mockReturnValue(null);
    const runtime = fakeRuntime([
      chatMessage("m1", "first", "2026-05-21T08:00:00.000Z"),
      chatMessage("m2", "second", "2026-05-21T08:00:01.000Z"),
      chatMessage("m3", "third", "2026-05-21T08:00:02.000Z"),
    ]);

    const firstPage = await relayRuntimeChatHistoryPage(runtime, { limit: 2 });
    const secondPage = await relayRuntimeChatHistoryPage(runtime, { limit: 2, cursor: firstPage.pagination.nextCursor });

    expect(firstPage.items.map((message) => message.id)).toEqual(["m2", "m3"]);
    expect(firstPage.pagination).toMatchObject({ hasNext: true, nextCursor: "m2", total: 3 });
    expect(secondPage.items.map((message) => message.id)).toEqual(["m1"]);
    expect(secondPage.pagination).toMatchObject({ hasNext: false, nextCursor: null, total: 3 });
  });
});

function chatMessage(id: string, text: string, timestamp: string): WebChatMessage {
  return {
    id,
    threadId: "thread-1",
    role: "agent",
    text,
    timestamp,
    source: "web",
  };
}

function fakeRuntime(webMessages: WebChatMessage[]): RelayRuntimeDelegate {
  const info: AgentSessionInfo = {
    agentId: "codex",
    agentLabel: "Codex",
    threadId: "thread-1",
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
  const session = {
    getInfo: () => info,
    getActiveThreadId: () => info.threadId,
  };
  return {
    config: { workspace: "/workspace/project", codexExternalBusyStaleMs: 60_000 },
    getSession: async () => session,
    publicInfo: () => info,
    chatStore: {
      list: () => webMessages,
    },
  } as unknown as RelayRuntimeDelegate;
}
