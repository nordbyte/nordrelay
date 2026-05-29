import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCodexConfig = vi.hoisted(() => ({
  readCodexFastMode: vi.fn(),
}));

vi.mock("../src/agents/codex/codex-config.js", () => ({
  readCodexFastMode: mockCodexConfig.readCodexFastMode,
  writeCodexFastMode: vi.fn(),
}));

import {
  relayRuntimeDiscoverActiveRecordedAgentSessions,
  relayRuntimeSessionStubForMetadata,
} from "../src/runtime/relay-runtime-active-sessions.js";
import type { RelayRuntimeDelegate } from "../src/runtime/relay-runtime-delegate.js";
import type { ActiveSessionDto } from "../src/runtime/relay-runtime-types.js";
import { CODEX_AGENT_CAPABILITIES, type AgentId, type AgentThreadRecord } from "../src/agents/shared/agent.js";
import type { BotPreferencesStore } from "../src/state/bot-preferences.js";
import type { ContextMetadata } from "../src/state/session-registry.js";

describe("relay runtime active sessions", () => {
  beforeEach(() => {
    mockCodexConfig.readCodexFastMode.mockReset();
    mockCodexConfig.readCodexFastMode.mockReturnValue(null);
  });

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

  it("uses the current Codex fast-mode setting for metadata-backed Codex sessions", () => {
    mockCodexConfig.readCodexFastMode.mockReturnValue(true);

    const session = relayRuntimeSessionStubForMetadata(
      fakeRuntime("codex"),
      contextMetadata({ fastMode: false }),
      "codex",
      CODEX_AGENT_CAPABILITIES,
    );

    expect(session.getInfo().fastMode).toBe(true);
  });

  it("falls back to stored metadata fast mode when Codex has no explicit setting", () => {
    mockCodexConfig.readCodexFastMode.mockReturnValue(null);

    const session = relayRuntimeSessionStubForMetadata(
      fakeRuntime("codex"),
      contextMetadata({ fastMode: true }),
      "codex",
      CODEX_AGENT_CAPABILITIES,
    );

    expect(session.getInfo().fastMode).toBe(true);
  });

  it("keeps metadata-backed non-Codex sessions in normal mode", () => {
    mockCodexConfig.readCodexFastMode.mockReturnValue(true);

    const session = relayRuntimeSessionStubForMetadata(
      fakeRuntime("hermes"),
      contextMetadata({ agentId: "hermes", fastMode: true }),
      "hermes",
      { ...CODEX_AGENT_CAPABILITIES, fastMode: false },
    );

    expect(session.getInfo().fastMode).toBe(false);
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
      defaultLaunchProfileId: "default",
      launchProfiles: [],
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

function contextMetadata(overrides: Partial<ContextMetadata> = {}): ContextMetadata {
  return {
    contextKey: "web:dashboard",
    agentId: "codex",
    threadId: "thread-1",
    workspace: "/workspace/project",
    launchProfileId: "default",
    updatedAt: Date.now(),
    ...overrides,
  };
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
