import { CodexSessionService } from "./codex-session.js";
import { HermesSessionService } from "./hermes-session.js";
import { PiSessionService } from "./pi-session.js";
import type { AgentCreateOptions, AgentId, AgentSessionService } from "./agent.js";
import type { ConnectorConfig } from "./config.js";

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
  return agents;
}
