import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, afterEach, beforeEach } from "vitest";

import { getPiSession, listPiSessions, listPiWorkspaces } from "../src/pi-state.js";

describe("pi-state", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "nordrelay-pi-state-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses Pi JSONL sessions and resolves them by id", () => {
    const workspaceDir = path.join(tempDir, "--home-user-project--");
    mkdirSync(workspaceDir, { recursive: true });
    const sessionPath = path.join(workspaceDir, "2026-05-12T08-00-00-000Z_019e1111-2222-7333-8444-555555555555.jsonl");
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "019e1111-2222-7333-8444-555555555555",
          timestamp: "2026-05-12T08:00:00.000Z",
          cwd: "/home/user/project",
        }),
        JSON.stringify({
          type: "model_change",
          provider: "openai-codex",
          modelId: "gpt-5.5",
          timestamp: "2026-05-12T08:00:01.000Z",
        }),
        JSON.stringify({
          type: "thinking_level_change",
          thinkingLevel: "xhigh",
          timestamp: "2026-05-12T08:00:02.000Z",
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-12T08:00:03.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "Implement Pi support" }],
            timestamp: 1778572803000,
          },
        }),
      ].join("\n"),
    );

    const sessions = listPiSessions(10, { sessionDir: tempDir });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      agentId: "pi",
      id: "019e1111-2222-7333-8444-555555555555",
      cwd: "/home/user/project",
      model: "openai-codex/gpt-5.5",
      reasoningEffort: "xhigh",
      firstUserMessage: "Implement Pi support",
      sessionPath,
    });
    expect(getPiSession("019e1111", { sessionDir: tempDir })?.sessionPath).toBe(sessionPath);
    expect(listPiWorkspaces({ sessionDir: tempDir })).toEqual(["/home/user/project"]);
  });
});
