import { describe, expect, it } from "vitest";

import { getExternalSnapshotForSession } from "../src/agents/shared/agent-activity.js";
import { respondToExternalApproval } from "../src/agents/shared/agent-approval.js";
import {
  clearPendingAgentApprovals,
  listPendingAgentApprovals,
  registerPendingAgentApproval,
} from "../src/agents/shared/agent-approval-registry.js";
import {
  HERMES_AGENT_CAPABILITIES,
  type AgentSessionService,
} from "../src/agents/shared/agent.js";
import type { ConnectorConfig } from "../src/core/config.js";

describe("agent approval registry", () => {
  it("overlays in-memory approvals on generic external snapshots and resolves them", async () => {
    const session = fakeSession();
    const choices: string[] = [];
    const approval = registerPendingAgentApproval({
      agentId: "hermes",
      agentLabel: "Hermes",
      threadId: "thread-1",
      callId: "run-1:approval",
      toolName: "exec",
      command: "npm test",
      workdir: "/workspace",
      prefixRule: ["npm"],
      sourcePath: "memory:hermes:thread-1",
      respond: (choice) => {
        choices.push(choice);
        return { ok: true, status: "submitted", message: `choice:${choice}` };
      },
    });

    const snapshot = getExternalSnapshotForSession(session, { workspace: "/workspace", codexExternalBusyStaleMs: 60_000 } as ConnectorConfig, { maxEvents: 0 });
    expect(snapshot?.pendingApprovals?.[0]).toMatchObject({
      id: approval.id,
      toolName: "exec",
      command: "npm test",
    });

    const result = await respondToExternalApproval(session, {} as ConnectorConfig, approval.id, "persist");
    expect(result).toEqual({ ok: true, status: "submitted", message: "choice:persist" });
    expect(choices).toEqual(["persist"]);
    expect(listPendingAgentApprovals("hermes", "thread-1")).toEqual([]);
  });
});

function fakeSession(): AgentSessionService {
  return {
    getInfo: () => ({
      agentId: "hermes",
      agentLabel: "Hermes",
      threadId: "thread-1",
      workspace: "/workspace",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "default",
      sandboxMode: "host",
      approvalPolicy: "on-request",
      fastMode: false,
      unsafeLaunch: false,
      capabilities: HERMES_AGENT_CAPABILITIES,
    }),
    isProcessing: () => true,
    getActiveThreadId: () => "thread-1",
    hasActiveThread: () => true,
    getCurrentWorkspace: () => "/workspace",
    prompt: async () => {},
    abort: async () => {},
    newThread: async () => fakeSession().getInfo(),
    resumeThread: async () => fakeSession().getInfo(),
    switchSession: async () => fakeSession().getInfo(),
    listAllSessions: () => [],
    listWorkspaces: () => ["/workspace"],
    refreshModels: async () => {},
    listModels: () => [],
    listLaunchProfiles: () => [],
    getSessionRecord: () => null,
    setModel: (slug) => slug,
    setModelForCurrentSession: (slug) => ({ value: slug, appliedToActiveThread: true }),
    setReasoningEffort: () => {},
    setReasoningEffortForCurrentSession: (effort) => ({ value: effort, appliedToActiveThread: true }),
    setLaunchProfile: () => ({ id: "default", label: "Default", sandboxMode: "workspace-write", approvalPolicy: "on-request" }),
    setFastMode: () => ({ enabled: false, profile: { id: "default", label: "Default", sandboxMode: "workspace-write", approvalPolicy: "on-request" }, appliedToActiveThread: false }),
    getSelectedLaunchProfile: () => ({ id: "default", label: "Default", sandboxMode: "workspace-write", approvalPolicy: "on-request" }),
    syncFromAgentState: () => ({ threadId: "thread-1", changed: false, reattached: false, changedFields: [], info: fakeSession().getInfo() }),
    handback: () => ({ threadId: "thread-1", workspace: "/workspace" }),
    dispose: () => clearPendingAgentApprovals("hermes", "thread-1"),
  };
}
