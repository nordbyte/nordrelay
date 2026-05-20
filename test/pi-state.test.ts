import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, afterEach, beforeEach } from "vitest";

import {
  type ActiveSessionDto,
  relayRuntimeDiscoverActivePiSessions,
} from "../src/runtime/relay-runtime-active-sessions.js";
import type { RelayRuntimeDelegate } from "../src/runtime/relay-runtime-delegate.js";
import { PI_AGENT_CAPABILITIES } from "../src/agents/shared/agent.js";
import type { BotPreferencesStore } from "../src/state/bot-preferences.js";
import {
  getPiSession,
  getPiSessionActivity,
  getPiSessionActivityLog,
  getPiSessionDiagnostics,
  listPiSessions,
  listPiWorkspaces,
} from "../src/agents/pi/pi-state.js";

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

  it("detects active Pi CLI turns from JSONL sessions", () => {
    const workspaceDir = path.join(tempDir, "--home-user-project--");
    mkdirSync(workspaceDir, { recursive: true });
    const sessionPath = path.join(workspaceDir, "2026-05-12T08-00-00-000Z_pi-active.jsonl");
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          id: "pi-active",
          timestamp: "2026-05-12T08:00:00.000Z",
          cwd: "/home/user/project",
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-12T08:00:03.000Z",
          message: {
            role: "user",
            content: "Still running",
          },
        }),
      ].join("\n"),
    );

    const activity = getPiSessionActivity("pi-active", {
      sessionDir: tempDir,
      nowMs: Date.parse("2026-05-12T08:00:05.000Z"),
      staleAfterMs: 60_000,
    });
    const events = getPiSessionActivityLog("pi-active", 10, { sessionDir: tempDir });
    const diagnostics = getPiSessionDiagnostics("pi-active", {
      sessionDir: tempDir,
      nowMs: Date.parse("2026-05-12T08:00:05.000Z"),
      staleAfterMs: 60_000,
    });

    expect(activity).toMatchObject({
      agentId: "pi",
      active: true,
      stale: false,
      threadId: "pi-active",
      sourcePath: sessionPath,
    });
    expect(events.map((event) => event.kind)).toEqual(["task", "user"]);
    expect(diagnostics.status).toBe("active");
    expect(diagnostics.lineCount).toBe(2);
  });

  it("keeps Pi tool-use turns active until a terminal assistant response is written", () => {
    const workspaceDir = path.join(tempDir, "--home-user-project--");
    mkdirSync(workspaceDir, { recursive: true });
    const sessionPath = path.join(workspaceDir, "2026-05-12T08-00-00-000Z_pi-tools.jsonl");
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          id: "pi-tools",
          timestamp: "2026-05-12T08:00:00.000Z",
          cwd: "/home/user/project",
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-12T08:00:03.000Z",
          message: {
            role: "user",
            content: "Inspect the repo",
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-12T08:00:04.000Z",
          message: {
            role: "assistant",
            stopReason: "toolUse",
            content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }],
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-12T08:00:05.000Z",
          message: {
            role: "toolResult",
            toolName: "bash",
            content: [{ type: "text", text: "README.md" }],
          },
        }),
      ].join("\n"),
    );

    const activity = getPiSessionActivity("pi-tools", {
      sessionDir: tempDir,
      nowMs: Date.parse("2026-05-12T08:00:06.000Z"),
      staleAfterMs: 60_000,
    });
    const events = getPiSessionActivityLog("pi-tools", 10, { sessionDir: tempDir });

    expect(activity).toMatchObject({
      active: true,
      stale: false,
      threadId: "pi-tools",
    });
    expect(events.map((event) => `${event.kind}:${event.status ?? "-"}`)).toEqual([
      "task:started",
      "user:-",
      "agent:-",
      "tool:started",
      "tool:finished",
    ]);

    writeFileSync(
      sessionPath,
      `${readFileSync(sessionPath, "utf8")}\n${JSON.stringify({
        type: "message",
        timestamp: "2026-05-12T08:00:07.000Z",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Done" }],
        },
      })}`,
    );

    expect(getPiSessionActivity("pi-tools", {
      sessionDir: tempDir,
      nowMs: Date.parse("2026-05-12T08:00:08.000Z"),
      staleAfterMs: 60_000,
    })?.active).toBe(false);
  });

  it("discovers active standalone Pi CLI sessions for Overview", () => {
    const workspaceDir = path.join(tempDir, "--home-user-project--");
    mkdirSync(workspaceDir, { recursive: true });
    const sessionPath = path.join(workspaceDir, "2026-05-12T08-00-00-000Z_pi-active-cli.jsonl");
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          id: "pi-active-cli",
          timestamp: "2026-05-12T08:00:00.000Z",
          cwd: "/home/user/project",
        }),
        JSON.stringify({
          type: "message",
          timestamp: new Date().toISOString(),
          message: {
            role: "user",
            content: "Run from Pi CLI",
          },
        }),
      ].join("\n"),
    );

    const runtime = {
      config: {
        codexEnabled: false,
        piEnabled: true,
        hermesEnabled: false,
        openClawEnabled: false,
        claudeCodeEnabled: false,
        piSessionDir: tempDir,
        codexExternalBusyStaleMs: 60_000,
      },
      capabilitiesForAgent: () => PI_AGENT_CAPABILITIES,
      externalActiveSession: (meta) => ({
        id: `cli:pi:${meta.threadId}:${meta.threadId}`,
        contextKey: `cli:pi:${meta.threadId}`,
        sourceContextKey: `cli:pi:${meta.threadId}`,
        source: "cli",
        status: "external",
        agentId: "pi",
        agentLabel: "Pi",
        threadId: meta.threadId,
        workspace: meta.workspace,
        prompt: "Run from Pi CLI",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        durationMs: 0,
        queueLength: 0,
        queuePaused: false,
        mirrorChannels: [],
      }) satisfies ActiveSessionDto,
    } as unknown as RelayRuntimeDelegate;

    const active = relayRuntimeDiscoverActivePiSessions(runtime, [], {} as BotPreferencesStore);

    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      agentId: "pi",
      source: "cli",
      threadId: "pi-active-cli",
      workspace: "/home/user/project",
    });
  });
});
