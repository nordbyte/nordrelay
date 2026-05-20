import { describe, expect, it } from "vitest";

import {
  relayRuntimeDiscoverActiveRecordedAgentSessions,
} from "../src/runtime/relay-runtime-active-sessions.js";
import type { RelayRuntimeDelegate } from "../src/runtime/relay-runtime-delegate.js";
import type { ActiveSessionDto } from "../src/runtime/relay-runtime-types.js";
import { CODEX_AGENT_CAPABILITIES, type AgentId, type AgentThreadRecord } from "../src/agents/shared/agent.js";
import type { BotPreferencesStore } from "../src/state/bot-preferences.js";

describe("relay runtime active sessions", () => {
  it("discovers active recorded sessions for non-Codex CLI adapters", () => {
    for (const agentId of ["hermes", "openclaw", "claude-code"] as AgentId[]) {
      const active = relayRuntimeDiscoverActiveRecordedAgentSessions(
        fakeRuntime(agentId),
        agentId,
        [threadRecord(agentId, `${agentId}-active`)],
        [],
        {} as BotPreferencesStore,
      );

      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({
        agentId,
        source: "cli",
        threadId: `${agentId}-active`,
        workspace: "/workspace/project",
      });
    }
  });

  it("skips disabled or stale recorded active session candidates", () => {
    const activeAgent = relayRuntimeDiscoverActiveRecordedAgentSessions(
      fakeRuntime("hermes", { hermesEnabled: false }),
      "hermes",
      [threadRecord("hermes", "hermes-active")],
      [],
      {} as BotPreferencesStore,
    );
    const staleRecord = relayRuntimeDiscoverActiveRecordedAgentSessions(
      fakeRuntime("hermes"),
      "hermes",
      [threadRecord("hermes", "hermes-active", Date.now() - 120_000)],
      [],
      {} as BotPreferencesStore,
    );

    expect(activeAgent).toEqual([]);
    expect(staleRecord).toEqual([]);
  });
});

function fakeRuntime(
  enabledAgent: AgentId,
  flags: Partial<RelayRuntimeDelegate["config"]> = {},
): RelayRuntimeDelegate {
  return {
    config: {
      codexEnabled: false,
      piEnabled: enabledAgent === "pi",
      hermesEnabled: enabledAgent === "hermes",
      openClawEnabled: enabledAgent === "openclaw",
      claudeCodeEnabled: enabledAgent === "claude-code",
      codexExternalBusyStaleMs: 60_000,
      ...flags,
    },
    capabilitiesForAgent: () => ({ ...CODEX_AGENT_CAPABILITIES, externalActivity: true }),
    externalActiveSession: (meta) => ({
      id: `cli:${meta.agentId}:${meta.threadId}:${meta.threadId}`,
      contextKey: `cli:${meta.agentId}:${meta.threadId}`,
      sourceContextKey: `cli:${meta.agentId}:${meta.threadId}`,
      source: "cli",
      status: "external",
      agentId: meta.agentId as AgentId,
      agentLabel: String(meta.agentId),
      threadId: meta.threadId,
      workspace: meta.workspace,
      prompt: "Run from external CLI",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      durationMs: 0,
      queueLength: 0,
      queuePaused: false,
      mirrorChannels: [],
    }) satisfies ActiveSessionDto,
  } as unknown as RelayRuntimeDelegate;
}

function threadRecord(agentId: AgentId, id: string, updatedAtMs = Date.now()): AgentThreadRecord {
  return {
    id,
    title: null,
    cwd: "/workspace/project",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    createdAt: new Date(updatedAtMs - 1_000),
    updatedAt: new Date(updatedAtMs),
    firstUserMessage: "Run from external CLI",
    agentId,
    sessionPath: `/tmp/${id}.jsonl`,
  };
}
