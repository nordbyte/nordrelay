import {
  CLAUDE_CODE_AGENT_CAPABILITIES,
  CODEX_AGENT_CAPABILITIES,
  HERMES_AGENT_CAPABILITIES,
  OPENCLAW_AGENT_CAPABILITIES,
  PI_AGENT_CAPABILITIES,
  type AgentCapabilities,
  type AgentId,
} from "./agent.js";

export type AgentAdapterStatus = "available" | "planned";

export interface AgentAdapterDescriptor {
  id: AgentId;
  label: string;
  status: AgentAdapterStatus;
  capabilities: AgentCapabilities;
  envFlag?: string;
  notes?: string;
}

export const BUILTIN_AGENT_ADAPTERS: AgentAdapterDescriptor[] = [
  {
    id: "codex",
    label: "Codex",
    status: "available",
    capabilities: CODEX_AGENT_CAPABILITIES,
    envFlag: "NORDRELAY_CODEX_ENABLED",
  },
  {
    id: "pi",
    label: "Pi",
    status: "available",
    capabilities: PI_AGENT_CAPABILITIES,
    envFlag: "NORDRELAY_PI_ENABLED",
  },
  {
    id: "hermes",
    label: "Hermes",
    status: "available",
    capabilities: HERMES_AGENT_CAPABILITIES,
    envFlag: "NORDRELAY_HERMES_ENABLED",
    notes: "Uses the Hermes API Server for streaming runs, stop, session continuity, and tool lifecycle events.",
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    status: "available",
    capabilities: OPENCLAW_AGENT_CAPABILITIES,
    envFlag: "NORDRELAY_OPENCLAW_ENABLED",
    notes: "Uses the OpenClaw Gateway WebSocket RPC surface for streamed agent runs, session continuity, and tool lifecycle events.",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    status: "available",
    capabilities: CLAUDE_CODE_AGENT_CAPABILITIES,
    envFlag: "NORDRELAY_CLAUDE_CODE_ENABLED",
    notes: "Uses the Claude Agent SDK with host Claude Code sessions, streaming, tool lifecycle events, session continuity, and handback.",
  },
];

export function listAgentAdapterDescriptors(): AgentAdapterDescriptor[] {
  return BUILTIN_AGENT_ADAPTERS.map((descriptor) => ({
    ...descriptor,
    capabilities: { ...descriptor.capabilities },
  }));
}
