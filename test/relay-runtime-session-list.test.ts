import { describe, expect, it } from "vitest";

import { CODEX_AGENT_CAPABILITIES, type AgentSessionInfo, type AgentSessionService, type AgentThreadRecord } from "../src/agents/shared/agent.js";
import { relayRuntimeFilteredSessions } from "../src/runtime/relay-runtime-session-list.js";
import type { RelayRuntimeDelegate } from "../src/runtime/relay-runtime-delegate.js";
import type { ContextMetadata } from "../src/state/session-registry.js";

function baseInfo(patch: Partial<AgentSessionInfo> = {}): AgentSessionInfo {
  return {
    agentId: "codex",
    agentLabel: "Codex",
    threadId: "current-thread",
    workspace: "/workspace/current",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    launchProfileId: "default",
    launchProfileLabel: "Default",
    launchProfileBehavior: "workspace-write / never",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    fastMode: false,
    unsafeLaunch: false,
    capabilities: CODEX_AGENT_CAPABILITIES,
    ...patch,
  };
}

function fakeRuntime(info: AgentSessionInfo, metadata: ContextMetadata[] = []): RelayRuntimeDelegate {
  return {
    config: {
      workspaceAllowedRoots: [],
      workspaceWarnRoots: [],
    },
    publicInfo: () => info,
    listKnownContextMetadata: () => metadata,
    sessionNameStore: {
      get: () => null,
    },
    worktreeService: {
      getByThreadId: () => null,
      getByWorkspace: () => null,
      snapshot: () => null,
    },
  } as unknown as RelayRuntimeDelegate;
}

function fakeSession(records: AgentThreadRecord[] = []): AgentSessionService {
  return {
    listAllSessions: () => records,
  } as unknown as AgentSessionService;
}

describe("relayRuntimeFilteredSessions", () => {
  it("falls back to known NordRelay contexts when adapter history is empty", () => {
    const info = baseInfo();
    const metadata: ContextMetadata[] = [
      {
        contextKey: "web:dashboard",
        agentId: "codex",
        threadId: "remote-thread",
        workspace: "/workspace/remote",
        model: "gpt-5.5",
        reasoningEffort: "xhigh",
        updatedAt: 1_780_000_000_000,
      },
    ];

    const sessions = relayRuntimeFilteredSessions(fakeRuntime(info, metadata), fakeSession([]), "", 20);

    expect(sessions.map((session) => session.id)).toEqual(["current-thread", "remote-thread"]);
    expect(sessions.find((session) => session.id === "remote-thread")).toMatchObject({
      cwd: "/workspace/remote",
      agentId: "codex",
      model: "gpt-5.5",
    });
  });

  it("does not duplicate adapter records already present in the agent history", () => {
    const info = baseInfo({ threadId: "db-thread", workspace: "/workspace/db" });
    const dbRecord: AgentThreadRecord = {
      id: "db-thread",
      title: "Database thread",
      cwd: "/workspace/db",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      createdAt: new Date(1_700_000_000_000),
      updatedAt: new Date(1_700_000_000_000),
      firstUserMessage: "hello",
      agentId: "codex",
    };

    const sessions = relayRuntimeFilteredSessions(fakeRuntime(info), fakeSession([dbRecord]), "", 20);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: "db-thread", title: "Database thread" });
  });
});
