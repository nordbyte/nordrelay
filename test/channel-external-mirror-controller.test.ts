import { describe, expect, it } from "vitest";

import type { AgentExternalSnapshot, AgentSessionInfo, AgentSessionService } from "../src/agents/shared/agent.js";
import { createChannelExternalMirrorController } from "../src/channels/shared/channel-external-mirror-controller.js";
import type { ChannelContext } from "../src/channels/shared/channel-adapter.js";
import type { ChannelExternalMirrorState } from "../src/channels/shared/channel-bridge-state.js";
import type { ConnectorConfig } from "../src/core/config.js";
import type { WebActivityEvent } from "../src/web/web-state.js";

describe("channel external mirror controller", () => {
  it("mirrors active CLI status and records tool lifecycle events once", async () => {
    const states = new Map<string, ChannelExternalMirrorState<string>>();
    const activity: Array<Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }> = [];
    const sent: string[] = [];
    const edited: string[] = [];
    const typing: string[] = [];
    const artifacts: string[] = [];
    const context: ChannelContext = { channelId: "discord", chatId: "c1" };

    const controller = createChannelExternalMirrorController<string>({
      config: { workspace: "/tmp/nordrelay-test" } as ConnectorConfig,
      states,
      typingIntervalMs: 0,
      minUpdateMs: () => 0,
      mirrorMode: () => "full",
      queueLength: () => 2,
      activityActor: () => ({ channel: "cli", label: "Codex CLI" }),
      appendActivity: (input) => activity.push(input),
      sendTyping: async () => { typing.push("typing"); },
      sendWorkingNotice: async () => { sent.push("working"); },
      sendStatus: async (_key, _context, _state, rendered) => {
        sent.push(rendered.plain);
        return "status-1";
      },
      editStatus: async (_key, _context, _state, _messageId, rendered) => {
        edited.push(rendered.plain);
      },
      sendEvent: async (_key, _context, _state, rendered) => {
        sent.push(rendered.plain);
      },
      sendDone: async (_key, _context, _state, text) => {
        sent.push(text);
      },
      sendFinalAnswer: async (_key, _context, _state, _snapshot, text) => {
        sent.push(text);
      },
      deliverArtifacts: async (_key, _context, _session, _state, turnId) => {
        artifacts.push(turnId ?? "");
      },
    });

    await controller.mirror("discord:g1:c1", context, session(), activeSnapshot());
    await controller.mirror("discord:g1:c1", context, session(), terminalSnapshot());

    expect(typing).toEqual(["typing"]);
    expect(sent.some((line) => line.includes("Codex CLI task running"))).toBe(true);
    expect(sent.some((line) => line.includes("CLI tool started: exec_command"))).toBe(true);
    expect(sent).toContain("Codex CLI task completed.");
    expect(sent).toContain("done");
    expect(edited).toEqual([]);
    expect(artifacts).toEqual(["turn-1"]);
    expect(activity.map((event) => event.type)).toEqual([
      "cli_turn_started",
      "cli_tool_started",
      "cli_tool_completed",
      "cli_turn_finished",
    ]);
  });

  it("uses a working notice instead of status updates in final mirror mode", async () => {
    const states = new Map<string, ChannelExternalMirrorState<string>>();
    const sent: string[] = [];
    const context: ChannelContext = { channelId: "slack", chatId: "c1" };

    const controller = createChannelExternalMirrorController<string>({
      config: { workspace: "/tmp/nordrelay-test" } as ConnectorConfig,
      states,
      typingIntervalMs: 0,
      minUpdateMs: () => 0,
      mirrorMode: () => "final",
      queueLength: () => 0,
      activityActor: () => ({ channel: "cli", label: "Codex CLI" }),
      appendActivity: () => {},
      sendTyping: async () => {},
      sendWorkingNotice: async (_key, _context, state, snapshot, prompt) => {
        const turnKey = snapshot.activity.turnId ?? snapshot.activity.startedAt?.toISOString() ?? "unknown";
        if (state.workingNoticeTurnKey === turnKey) {
          return;
        }
        sent.push(`Working on ${prompt}`);
        state.workingNoticeTurnKey = turnKey;
      },
      sendStatus: async () => {
        throw new Error("status should not be sent");
      },
      editStatus: async () => {
        throw new Error("status should not be edited");
      },
      sendEvent: async () => {},
      sendDone: async () => {},
      sendFinalAnswer: async () => {},
      deliverArtifacts: async () => {},
    });

    await controller.mirror("slack:t1:c1", context, session(), activeSnapshot());
    await controller.mirror("slack:t1:c1", context, session(), activeSnapshot());

    expect(sent).toEqual(["Working on Build the feature"]);
  });
});

function session(): AgentSessionService {
  const info: AgentSessionInfo = {
    agentId: "codex",
    agentLabel: "Codex",
    threadId: "thread-1",
    workspace: "/tmp/nordrelay-test",
    model: "gpt-5.5",
    launchProfileId: "default",
    launchProfileLabel: "Default",
    launchProfileBehavior: "workspace-write / never",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    fastMode: false,
    unsafeLaunch: false,
  };
  return {
    getInfo: () => info,
    getActiveThreadId: () => info.threadId,
  } as AgentSessionService;
}

function activeSnapshot(): AgentExternalSnapshot {
  return {
    agentId: "codex",
    agentLabel: "Codex",
    threadId: "thread-1",
    sourcePath: "/tmp/rollout.jsonl",
    sourceLabel: "Codex rollout",
    lineCount: 10,
    latestAgentMessage: null,
    latestUserMessage: "Build the feature",
    latestToolName: "exec_command",
    activity: {
      agentId: "codex",
      agentLabel: "Codex",
      threadId: "thread-1",
      sourcePath: "/tmp/rollout.jsonl",
      sourceLabel: "Codex rollout",
      active: true,
      stale: false,
      turnId: "turn-1",
      startedAt: new Date("2026-05-16T06:00:00.000Z"),
      updatedAt: new Date("2026-05-16T06:00:01.000Z"),
    },
    events: [
      {
        lineNumber: 11,
        kind: "tool",
        timestamp: new Date("2026-05-16T06:00:01.000Z"),
        type: "tool",
        turnId: "turn-1",
        status: "started",
        text: null,
        toolName: "exec_command",
        phase: null,
      },
      {
        lineNumber: 12,
        kind: "tool",
        timestamp: new Date("2026-05-16T06:00:02.000Z"),
        type: "tool",
        turnId: "turn-1",
        status: "finished",
        text: null,
        toolName: "exec_command",
        phase: null,
      },
    ],
  };
}

function terminalSnapshot(): AgentExternalSnapshot {
  return {
    ...activeSnapshot(),
    lineCount: 14,
    activity: {
      ...activeSnapshot().activity,
      active: false,
      updatedAt: new Date("2026-05-16T06:00:04.000Z"),
    },
    events: [
      ...activeSnapshot().events,
      {
        lineNumber: 13,
        kind: "agent",
        timestamp: new Date("2026-05-16T06:00:03.000Z"),
        type: "agent",
        turnId: "turn-1",
        status: null,
        text: "done",
        toolName: null,
        phase: null,
      },
      {
        lineNumber: 14,
        kind: "task",
        timestamp: new Date("2026-05-16T06:00:04.000Z"),
        type: "task",
        turnId: "turn-1",
        status: "completed",
        text: null,
        toolName: null,
        phase: null,
      },
    ],
  };
}
