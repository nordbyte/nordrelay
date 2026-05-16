import { describe, expect, it } from "vitest";

import { listAgentAdapterDescriptors } from "../src/agents/shared/agent-adapter.js";
import {
  AGENT_IDS,
  CODEX_AGENT_CAPABILITIES,
  HERMES_AGENT_CAPABILITIES,
  OPENCLAW_AGENT_CAPABILITIES,
  PI_AGENT_CAPABILITIES,
  CLAUDE_CODE_AGENT_CAPABILITIES,
  agentLabel,
  agentReasoningOptions,
  type AgentCapabilities,
  type AgentId,
  type AgentSessionService,
} from "../src/agents/shared/agent.js";
import { CodexSessionService } from "../src/agents/codex/codex-session.js";
import { ClaudeCodeSessionService } from "../src/agents/claude-code/claude-code-session.js";
import { createBuiltinLaunchProfiles, createDefaultLaunchProfile } from "../src/agents/codex/codex-launch.js";
import { listClaudeCodeLaunchProfiles } from "../src/agents/claude-code/claude-code-launch.js";
import { listHermesLaunchProfiles } from "../src/agents/hermes/hermes-launch.js";
import { HermesSessionService } from "../src/agents/hermes/hermes-session.js";
import { listOpenClawLaunchProfiles } from "../src/agents/openclaw/openclaw-launch.js";
import { OpenClawSessionService } from "../src/agents/openclaw/openclaw-session.js";
import { listPiLaunchProfiles } from "../src/agents/pi/pi-launch.js";
import { PiSessionService } from "../src/agents/pi/pi-session.js";

const CAPABILITY_KEYS = [
  "launchProfiles",
  "fastMode",
  "externalActivity",
  "cliMirror",
  "activityLog",
  "auth",
  "login",
  "logout",
  "usageStats",
  "subscriptionLimits",
  "usageLimits",
  "workspaces",
  "attachments",
  "modelSelection",
  "reasoningSelection",
  "handback",
] satisfies Array<keyof AgentCapabilities>;

const SERVICE_METHODS = [
  "getInfo",
  "isProcessing",
  "getActiveThreadId",
  "hasActiveThread",
  "getCurrentWorkspace",
  "prompt",
  "abort",
  "newThread",
  "resumeThread",
  "switchSession",
  "listAllSessions",
  "listWorkspaces",
  "refreshModels",
  "listModels",
  "listLaunchProfiles",
  "getSessionRecord",
  "setModel",
  "setModelForCurrentSession",
  "setReasoningEffort",
  "setReasoningEffortForCurrentSession",
  "setLaunchProfile",
  "setFastMode",
  "getSelectedLaunchProfile",
  "syncFromAgentState",
  "handback",
  "dispose",
] satisfies Array<keyof AgentSessionService>;

const CAPABILITIES_BY_AGENT: Record<AgentId, AgentCapabilities> = {
  codex: CODEX_AGENT_CAPABILITIES,
  pi: PI_AGENT_CAPABILITIES,
  hermes: HERMES_AGENT_CAPABILITIES,
  openclaw: OPENCLAW_AGENT_CAPABILITIES,
  "claude-code": CLAUDE_CODE_AGENT_CAPABILITIES,
};

const SERVICE_CLASS_BY_AGENT: Record<AgentId, { prototype: unknown }> = {
  codex: CodexSessionService,
  pi: PiSessionService,
  hermes: HermesSessionService,
  openclaw: OpenClawSessionService,
  "claude-code": ClaudeCodeSessionService,
};

const LAUNCH_PROFILES_BY_AGENT: Record<AgentId, () => Array<{ id: string; label: string; behavior?: string; unsafe: boolean }>> = {
  codex: () => createBuiltinLaunchProfiles(createDefaultLaunchProfile("workspace-write", "never")),
  pi: listPiLaunchProfiles,
  hermes: listHermesLaunchProfiles,
  openclaw: listOpenClawLaunchProfiles,
  "claude-code": listClaudeCodeLaunchProfiles,
};

describe("agent adapter contracts", () => {
  it("registers one available descriptor for every supported agent id", () => {
    const descriptors = listAgentAdapterDescriptors();
    const ids = descriptors.map((descriptor) => descriptor.id);

    expect(ids.sort()).toEqual([...AGENT_IDS].sort());
    expect(new Set(ids).size).toBe(AGENT_IDS.length);
    for (const descriptor of descriptors) {
      expect(descriptor.status).toBe("available");
      expect(descriptor.label).toBe(agentLabel(descriptor.id));
      expect(descriptor.capabilities).toEqual(CAPABILITIES_BY_AGENT[descriptor.id]);
    }
  });

  it("exposes complete boolean capability flags for every adapter", () => {
    for (const descriptor of listAgentAdapterDescriptors()) {
      for (const key of CAPABILITY_KEYS) {
        expect(typeof descriptor.capabilities[key], `${descriptor.id}.${key}`).toBe("boolean");
      }
    }
  });

  it("keeps reasoning and launch profile metadata usable for each capable adapter", () => {
    for (const descriptor of listAgentAdapterDescriptors()) {
      if (descriptor.capabilities.reasoningSelection) {
        expect(agentReasoningOptions(descriptor.id).length, `${descriptor.id} reasoning options`).toBeGreaterThan(0);
      }

      if (descriptor.capabilities.launchProfiles) {
        const profiles = LAUNCH_PROFILES_BY_AGENT[descriptor.id]();
        expect(profiles.length, `${descriptor.id} launch profiles`).toBeGreaterThan(0);
        expect(profiles.some((profile) => profile.id === "default"), `${descriptor.id} default profile`).toBe(true);
        for (const profile of profiles) {
          expect(profile.id).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
          expect(profile.label.length).toBeGreaterThan(0);
          expect(typeof profile.unsafe).toBe("boolean");
        }
      }
    }
  });

  it("keeps every concrete session service aligned with the shared service interface", () => {
    for (const agentId of AGENT_IDS) {
      const prototype = SERVICE_CLASS_BY_AGENT[agentId].prototype as Record<string, unknown>;
      for (const method of SERVICE_METHODS) {
        expect(typeof prototype[method], `${agentId}.${method}`).toBe("function");
      }
    }
  });

  it("documents intentionally agent-specific capability differences", () => {
    expect(CODEX_AGENT_CAPABILITIES.fastMode).toBe(true);
    expect(CODEX_AGENT_CAPABILITIES.subscriptionLimits).toBe(true);

    for (const agentId of AGENT_IDS.filter((id) => id !== "codex")) {
      expect(CAPABILITIES_BY_AGENT[agentId].fastMode, `${agentId}.fastMode`).toBe(false);
      expect(CAPABILITIES_BY_AGENT[agentId].subscriptionLimits, `${agentId}.subscriptionLimits`).toBe(false);
    }
  });
});
