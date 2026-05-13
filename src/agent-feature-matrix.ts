import type { AgentCapabilities } from "./agent.js";
import { escapeHTML } from "./format.js";

export interface AgentFeatureDefinition {
  key: keyof AgentCapabilities;
  label: string;
  description: string;
}

export interface AgentFeatureState extends AgentFeatureDefinition {
  supported: boolean;
}

export const AGENT_FEATURES: AgentFeatureDefinition[] = [
  { key: "modelSelection", label: "Model", description: "Pick the model used for new turns or sessions." },
  { key: "reasoningSelection", label: "Reasoning", description: "Pick thinking/reasoning effort where the agent exposes it." },
  { key: "launchProfiles", label: "Launch profiles", description: "Switch sandbox/approval launch behavior for new sessions." },
  { key: "fastMode", label: "Fast mode", description: "Toggle the agent-specific low-latency mode." },
  { key: "workspaces", label: "Workspaces", description: "List and switch allowed workspaces." },
  { key: "attachments", label: "Files/images", description: "Send files, photos, staged attachments, and voice transcripts." },
  { key: "externalActivity", label: "External busy", description: "Detect active CLI turns started outside NordRelay." },
  { key: "cliMirror", label: "CLI mirror", description: "Mirror CLI-started turns back to Telegram/WebUI." },
  { key: "activityLog", label: "Activity", description: "Read activity timelines for sessions and turns." },
  { key: "usageStats", label: "Usage stats", description: "Show token/context usage reported by the agent." },
  { key: "subscriptionLimits", label: "Limits", description: "Show subscription/quota limits when the agent exposes them." },
  { key: "auth", label: "Auth status", description: "Check whether the agent is authenticated." },
  { key: "login", label: "Login", description: "Start an agent login flow from NordRelay." },
  { key: "logout", label: "Logout", description: "Sign out of the agent from NordRelay." },
  { key: "handback", label: "Handback", description: "Return a remote session to the native CLI." },
];

export function agentFeatureStates(capabilities: AgentCapabilities): AgentFeatureState[] {
  return AGENT_FEATURES.map((feature) => ({
    ...feature,
    supported: Boolean(capabilities[feature.key]),
  }));
}

export function formatAgentFeatureSummaryPlain(capabilities: AgentCapabilities): string[] {
  const states = agentFeatureStates(capabilities);
  const supported = states.filter((feature) => feature.supported).map((feature) => feature.label);
  const unsupported = states.filter((feature) => !feature.supported).map((feature) => feature.label);
  return [
    `Supported: ${supported.join(", ") || "-"}`,
    `Not supported: ${unsupported.join(", ") || "-"}`,
  ];
}

export function formatAgentFeatureSummaryHTML(capabilities: AgentCapabilities): string[] {
  const states = agentFeatureStates(capabilities);
  const supported = states.filter((feature) => feature.supported).map((feature) => feature.label);
  const unsupported = states.filter((feature) => !feature.supported).map((feature) => feature.label);
  return [
    `<b>Supported:</b> ${escapeHTML(supported.join(", ") || "-")}`,
    `<b>Not supported:</b> ${escapeHTML(unsupported.join(", ") || "-")}`,
  ];
}
