import { describe, expect, it } from "vitest";

import {
  agentIdForAuth,
  agentLabelForAuth,
  hostAgentLoginCommand,
  hostAgentLogoutCommand,
} from "../src/agents/shared/agent-auth-commands.js";
import type { AgentSessionInfo } from "../src/agents/shared/agent.js";
import type { ConnectorConfig } from "../src/core/config.js";

const config = {
  workspace: "/repo",
  piCliPath: "/opt/pi/bin/pi",
  hermesCliPath: "/opt/hermes/bin/hermes",
  openClawCliPath: "/opt/openclaw/bin/openclaw",
  claudeCodeCliPath: "/opt/claude/bin/claude",
} as ConnectorConfig;

function info(agentId: AgentSessionInfo["agentId"], agentLabel: string): AgentSessionInfo {
  return {
    agentId,
    agentLabel,
    threadId: null,
    workspace: "/repo",
    launchProfileId: "default",
    launchProfileLabel: "Default",
    launchProfileBehavior: "workspace-write / never",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    fastMode: false,
    unsafeLaunch: false,
    capabilities: {} as AgentSessionInfo["capabilities"],
  };
}

describe("agent auth command helpers", () => {
  it("uses Codex defaults when no session info is available", () => {
    expect(agentIdForAuth()).toBe("codex");
    expect(agentLabelForAuth()).toBe("Codex");
    expect(hostAgentLoginCommand(config)).toBe("codex login --device-auth");
    expect(hostAgentLogoutCommand(config)).toBe("codex logout");
  });

  it("renders host login and logout commands for all managed agents", () => {
    expect(hostAgentLoginCommand(config, info("hermes", "Hermes"))).toBe("/opt/hermes/bin/hermes login --no-browser");
    expect(hostAgentLogoutCommand(config, info("hermes", "Hermes"))).toBe("/opt/hermes/bin/hermes logout");

    expect(hostAgentLoginCommand(config, info("claude-code", "Claude Code"))).toBe("/opt/claude/bin/claude auth login");
    expect(hostAgentLogoutCommand(config, info("claude-code", "Claude Code"))).toBe("/opt/claude/bin/claude auth logout");

    expect(hostAgentLoginCommand(config, info("pi", "Pi"))).toBe("/opt/pi/bin/pi auth login");
    expect(hostAgentLogoutCommand(config, info("pi", "Pi"))).toBe("/opt/pi/bin/pi auth logout");

    expect(hostAgentLoginCommand(config, info("openclaw", "OpenClaw"))).toBe("/opt/openclaw/bin/openclaw login");
    expect(hostAgentLogoutCommand(config, info("openclaw", "OpenClaw"))).toBe("/opt/openclaw/bin/openclaw logout");
  });
});
