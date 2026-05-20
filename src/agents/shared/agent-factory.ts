import { CodexSessionService } from "../codex/codex-session.js";
import { ClaudeCodeSessionService } from "../claude-code/claude-code-session.js";
import { HermesSessionService } from "../hermes/hermes-session.js";
import { OpenClawSessionService } from "../openclaw/openclaw-session.js";
import { PiSessionService } from "../pi/pi-session.js";
import type { AgentCreateOptions, AgentId, AgentSessionService } from "./agent.js";
import type { ConnectorConfig } from "../../core/config.js";

export async function createAgentSessionService(
  config: ConnectorConfig,
  agentId: AgentId,
  options?: AgentCreateOptions,
): Promise<AgentSessionService> {
  if (agentId === "pi") {
    if (config.piEnabled !== true) {
      throw new Error("Pi support is disabled. Set NORDRELAY_PI_ENABLED=true.");
    }
    return PiSessionService.create(config, options);
  }
  if (agentId === "hermes") {
    if (config.hermesEnabled !== true) {
      throw new Error("Hermes support is disabled. Set NORDRELAY_HERMES_ENABLED=true.");
    }
    return HermesSessionService.create(config, options);
  }
  if (agentId === "openclaw") {
    if (config.openClawEnabled !== true) {
      throw new Error("OpenClaw support is disabled. Set NORDRELAY_OPENCLAW_ENABLED=true.");
    }
    return OpenClawSessionService.create(config, options);
  }
  if (agentId === "claude-code") {
    if (config.claudeCodeEnabled !== true) {
      throw new Error("Claude Code support is disabled. Set NORDRELAY_CLAUDE_CODE_ENABLED=true.");
    }
    return ClaudeCodeSessionService.create(config, options);
  }

  if (config.codexEnabled === false) {
    throw new Error("Codex support is disabled. Set NORDRELAY_CODEX_ENABLED=true.");
  }
  return CodexSessionService.create(config, options);
}

export function enabledAgents(config: ConnectorConfig): AgentId[] {
  const agents: AgentId[] = [];
  if (config.codexEnabled !== false) agents.push("codex");
  if (config.piEnabled) agents.push("pi");
  if (config.hermesEnabled) agents.push("hermes");
  if (config.openClawEnabled) agents.push("openclaw");
  if (config.claudeCodeEnabled) agents.push("claude-code");
  return agents;
}
