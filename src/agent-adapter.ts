import {
  CODEX_AGENT_CAPABILITIES,
  HERMES_AGENT_CAPABILITIES,
  OPENCLAW_AGENT_CAPABILITIES,
  PI_AGENT_CAPABILITIES,
  type AgentCapabilities,
  type AgentId,
} from "./agent.js";

export type AgentAdapterStatus = "available" | "planned";

export interface AgentAdapterDescriptor {
  id: AgentId | "claude-code";
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
    status: "planned",
    capabilities: plannedCapabilities(),
    notes: "Use this descriptor as the target contract for a future Claude Code session service.",
  },
];

export function listAgentAdapterDescriptors(): AgentAdapterDescriptor[] {
  return BUILTIN_AGENT_ADAPTERS.map((descriptor) => ({
    ...descriptor,
    capabilities: { ...descriptor.capabilities },
  }));
}

function plannedCapabilities(): AgentCapabilities {
  return {
    launchProfiles: false,
    fastMode: false,
    externalActivity: false,
    cliMirror: false,
    activityLog: false,
    auth: false,
    login: false,
    logout: false,
    usageLimits: false,
    workspaces: true,
    attachments: true,
    modelSelection: true,
    reasoningSelection: true,
    handback: true,
  };
}
