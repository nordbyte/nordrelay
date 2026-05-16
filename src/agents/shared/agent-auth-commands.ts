import type { AgentId, AgentSessionInfo } from "./agent.js";
import type { ConnectorConfig } from "../../core/config.js";

export function agentIdForAuth(info?: AgentSessionInfo): AgentId {
  return info?.agentId ?? "codex";
}

export function agentLabelForAuth(info?: AgentSessionInfo): string {
  return info?.agentLabel ?? "Codex";
}

export function hostAgentLoginCommand(config: ConnectorConfig, info?: AgentSessionInfo): string {
  const agentId = agentIdForAuth(info);
  if (agentId === "hermes") return `${config.hermesCliPath ?? "hermes"} login --no-browser`;
  if (agentId === "claude-code") return `${config.claudeCodeCliPath ?? "claude"} auth login`;
  if (agentId === "pi") return `${config.piCliPath ?? "pi"} auth login`;
  if (agentId === "openclaw") return `${config.openClawCliPath ?? "openclaw"} login`;
  return "codex login --device-auth";
}

export function hostAgentLogoutCommand(config: ConnectorConfig, info?: AgentSessionInfo): string {
  const agentId = agentIdForAuth(info);
  if (agentId === "hermes") return `${config.hermesCliPath ?? "hermes"} logout`;
  if (agentId === "claude-code") return `${config.claudeCodeCliPath ?? "claude"} auth logout`;
  if (agentId === "pi") return `${config.piCliPath ?? "pi"} auth logout`;
  if (agentId === "openclaw") return `${config.openClawCliPath ?? "openclaw"} logout`;
  return "codex logout";
}
