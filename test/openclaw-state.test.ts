import { describe, expect, it } from "vitest";

import {
  getOpenClawSession,
  getOpenClawSessionActivity,
  getOpenClawSessionActivityLog,
  getOpenClawSessionDiagnostics,
  listOpenClawSessions,
  listOpenClawWorkspaces,
} from "../src/agents/openclaw/openclaw-state.js";

describe("openclaw-state", () => {
  it("parses OpenClaw sessions, activity, diagnostics, and workspaces", () => {
    const sessionsJson = {
      stores: [{ agentId: "main", path: "/home/user/.openclaw/agents/main/sessions/sessions.json" }],
      sessions: [
        {
          agentId: "main",
          key: "agent:main:telegram:direct:123",
          model: "openai/gpt-5.5",
          thinking: "xhigh",
          workspace: "/workspace/project",
          status: "running",
          createdAt: "2026-05-12T08:00:00.000Z",
          updatedAt: "2026-05-12T08:00:04.000Z",
          usage: { inputTokens: 1200, outputTokens: 300, cacheRead: 20 },
          messages: [
            { role: "user", content: "OpenClaw task", timestamp: "2026-05-12T08:00:01.000Z" },
            { role: "tool", toolName: "read_file", status: "started", text: "reading", timestamp: "2026-05-12T08:00:02.000Z" },
            { role: "assistant", content: "working", timestamp: "2026-05-12T08:00:03.000Z" },
          ],
        },
      ],
    };
    const options = {
      sessionsJson,
      nowMs: Date.parse("2026-05-12T08:00:05.000Z"),
      staleAfterMs: 60_000,
    };

    const sessions = listOpenClawSessions(10, options);
    const record = getOpenClawSession("agent:main", options);
    const activity = getOpenClawSessionActivity("agent:main", options);
    const events = getOpenClawSessionActivityLog("agent:main", 10, options);
    const diagnostics = getOpenClawSessionDiagnostics("agent:main", options);
    const workspaces = listOpenClawWorkspaces(options);

    expect(sessions).toHaveLength(1);
    expect(record).toMatchObject({
      agentId: "openclaw",
      openClawAgentId: "main",
      id: "agent:main:telegram:direct:123",
      cwd: "/workspace/project",
      model: "openai/gpt-5.5",
      reasoningEffort: "xhigh",
      firstUserMessage: "OpenClaw task",
      sessionPath: "/home/user/.openclaw/agents/main/sessions/sessions.json",
    });
    expect(record?.usage).toMatchObject({
      input: 1200,
      output: 300,
      cacheRead: 20,
      total: 1520,
    });
    expect(activity).toMatchObject({
      agentId: "openclaw",
      active: true,
      stale: false,
      threadId: "agent:main:telegram:direct:123",
    });
    expect(events.map((event) => event.kind)).toEqual(["task", "user", "tool", "agent"]);
    expect(events.find((event) => event.kind === "tool")).toMatchObject({
      toolName: "read_file",
      status: "started",
    });
    expect(diagnostics.status).toBe("active");
    expect(workspaces).toContain("/workspace/project");
  });
});
