import { describe, expect, it } from "vitest";

import { CODEX_AGENT_CAPABILITIES, PI_AGENT_CAPABILITIES } from "../src/agent.js";
import {
  logTailRequests,
  parseAgentUpdateId,
  parseLogsCommand,
  renderAgentUpdatePickerAction,
  renderAgentsAction,
  renderChannelsAction,
  renderQueueListAction,
} from "../src/channel-actions.js";

describe("channel-independent command actions", () => {
  it("renders channel and agent adapter summaries without Telegram primitives", () => {
    const channels = renderChannelsAction([
      { id: "telegram", label: "Telegram", capabilities: ["text"], status: "available", enabled: true },
      { id: "discord", label: "Discord", capabilities: ["text"], status: "available", enabled: false },
    ]);
    expect(channels.plain).toContain("Telegram: available / enabled");
    expect(channels.plain).toContain("Discord: available / disabled");
    expect(channels.html).toContain("<b>Channel adapters:</b>");

    const agents = renderAgentsAction([
      { id: "codex", label: "Codex", status: "available", capabilities: CODEX_AGENT_CAPABILITIES },
      { id: "pi", label: "Pi", status: "available", capabilities: PI_AGENT_CAPABILITIES },
    ], ["codex"]);
    expect(agents.plain).toContain("Codex: available · enabled");
    expect(agents.plain).toContain("Pi: available · disabled");
    expect(agents.html).toContain("<b>Supported:</b>");
  });

  it("parses reusable log and update actions", () => {
    expect(parseLogsCommand("agent 25")).toEqual({ target: "agent-updates", lines: 25 });
    expect(logTailRequests("all").map((request) => request.title)).toEqual(["Connector", "Update", "Agent updates"]);
    expect(parseAgentUpdateId("claude")).toBe("claude-code");

    const picker = renderAgentUpdatePickerAction([
      { id: "codex", label: "Codex", status: "available", capabilities: CODEX_AGENT_CAPABILITIES },
    ]);
    expect(picker.buttons?.[0]?.[0]).toMatchObject({ label: "Update Codex", action: "agent-update:start:codex" });
  });

  it("renders queue state for any channel", () => {
    const empty = renderQueueListAction([], true);
    expect(empty.plain).toBe("Queue is empty and paused.");

    const queued = renderQueueListAction([
      {
        id: "abc123",
        contextKey: "123",
        input: "hello",
        description: "hello",
        createdAt: Date.now(),
        attempts: 0,
      },
    ], false);
    expect(queued.plain).toContain("Queued prompts:");
    expect(queued.html).toContain("<b>Queued prompts:</b>");
  });
});
