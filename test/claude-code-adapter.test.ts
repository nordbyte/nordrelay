import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveClaudeCodeCli } from "../src/claude-code-cli.js";
import { findClaudeCodeLaunchProfile, listClaudeCodeLaunchProfiles } from "../src/claude-code-launch.js";
import {
  getClaudeCodeSessionActivity,
  getClaudeCodeSessionDiagnostics,
  getClaudeCodeSessionSnapshot,
  listClaudeCodeSessions,
} from "../src/claude-code-state.js";

describe("claude-code adapter support", () => {
  it("prefers explicit Claude Code CLI paths and falls back to bundled runtime", () => {
    expect(resolveClaudeCodeCli({ CLAUDE_CODE_CLI_PATH: "/opt/claude" })).toEqual({
      path: "/opt/claude",
      source: "env",
    });
    expect(resolveClaudeCodeCli({ PATH: "" })).toEqual({ source: "bundled" });
  });

  it("exposes safe launch profiles by default and hides unsafe bypass profile", () => {
    const profiles = listClaudeCodeLaunchProfiles();

    expect(profiles.map((profile) => profile.id)).toContain("default");
    expect(profiles.map((profile) => profile.id)).toContain("readonly");
    expect(profiles.map((profile) => profile.id)).not.toContain("bypass-permissions");
    expect(findClaudeCodeLaunchProfile("plan").permissionMode).toBe("plan");
    expect(listClaudeCodeLaunchProfiles(true).map((profile) => profile.id)).toContain("bypass-permissions");
  });

  it("discovers Claude Code transcript sessions and activity", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "nordrelay-claude-code-"));
    try {
      const workspace = path.join(tempDir, "workspace");
      const configDir = path.join(tempDir, ".claude");
      const projectDir = path.join(configDir, "projects", "-tmp-workspace");
      mkdirSync(projectDir, { recursive: true });
      const sessionPath = path.join(projectDir, "session-1.jsonl");
      const lines = [
        {
          type: "system",
          subtype: "init",
          session_id: "session-1",
          cwd: workspace,
          model: "sonnet",
          timestamp: "2026-05-13T08:00:00.000Z",
        },
        {
          type: "user",
          session_id: "session-1",
          cwd: workspace,
          timestamp: "2026-05-13T08:00:01.000Z",
          message: { role: "user", content: "Build the dashboard" },
        },
        {
          type: "assistant",
          session_id: "session-1",
          timestamp: "2026-05-13T08:00:02.000Z",
          message: {
            role: "assistant",
            model: "sonnet",
            content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }],
          },
        },
        {
          type: "user",
          session_id: "session-1",
          timestamp: "2026-05-13T08:00:03.000Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-1", content: "README content" }],
          },
        },
        {
          type: "assistant",
          session_id: "session-1",
          timestamp: "2026-05-13T08:00:04.000Z",
          message: {
            role: "assistant",
            model: "sonnet",
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
            content: [{ type: "text", text: "Dashboard built." }],
          },
        },
      ];
      writeFileSync(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

      const sessions = listClaudeCodeSessions(10, { configDir, workspace });
      const snapshot = getClaudeCodeSessionSnapshot("session-1", { configDir, workspace });
      const activity = getClaudeCodeSessionActivity("session-1", { configDir, workspace });
      const diagnostics = getClaudeCodeSessionDiagnostics("session-1", { configDir, workspace });

      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: "session-1",
        agentId: "claude-code",
        cwd: workspace,
        model: "sonnet",
        firstUserMessage: "Build the dashboard",
      });
      expect(sessions[0]?.usage).toMatchObject({ input: 10, output: 5, cacheRead: 2, total: 17 });
      expect(snapshot?.latestAgentMessage).toBe("Dashboard built.");
      expect(snapshot?.latestToolName).toBe("Read");
      expect(activity?.active).toBe(false);
      expect(diagnostics.status).toBe("idle");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
