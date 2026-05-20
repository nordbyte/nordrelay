import { listAgentAdapterDescriptors, type AgentAdapterDescriptor } from "./agent-adapter.js";
import { agentFeatureStates, type AgentFeatureState } from "./agent-feature-matrix.js";
import {
  listChannelDescriptors,
  type ChannelCapability,
  type ChannelDescriptor,
} from "../../channels/shared/channel-adapter.js";
import {
  channelCatalogCommandNames,
  type CommandTransport,
} from "../../channels/shared/channel-command-core.js";

export interface ChannelFeatureDefinition {
  key: ChannelCapability;
  label: string;
  description: string;
}

export interface ChannelFeatureState extends ChannelFeatureDefinition {
  supported: boolean;
}

export interface AgentAdapterConformance {
  id: AgentAdapterDescriptor["id"];
  label: string;
  status: AgentAdapterDescriptor["status"];
  enabled?: boolean;
  features: AgentFeatureState[];
  supported: string[];
  unsupported: string[];
  notes?: string;
}

export interface ChannelAdapterConformance {
  id: ChannelDescriptor["id"];
  label: string;
  status: ChannelDescriptor["status"];
  enabled?: boolean;
  features: ChannelFeatureState[];
  supported: string[];
  unsupported: string[];
  commands: string[];
  notes?: string;
}

export interface AdapterConformanceMatrix {
  generatedAt: string;
  agents: AgentAdapterConformance[];
  channels: ChannelAdapterConformance[];
}

export const CHANNEL_FEATURES: ChannelFeatureDefinition[] = [
  { key: "text", label: "Text", description: "Send and receive plain text prompts and replies." },
  { key: "streaming-edits", label: "Streaming edits", description: "Update an in-flight answer instead of sending only a final message." },
  { key: "typing", label: "Typing/status", description: "Show activity while an agent turn is still running." },
  { key: "inline-buttons", label: "Buttons", description: "Expose interactive choices for sessions, queue items, updates, artifacts, and aborts." },
  { key: "files", label: "Files", description: "Receive or send generic files." },
  { key: "photos", label: "Photos", description: "Receive image inputs for multimodal-capable agents." },
  { key: "voice", label: "Voice", description: "Receive audio and run transcription before prompting." },
  { key: "topics", label: "Threads/topics", description: "Keep independent contexts per topic, thread, forum topic, or equivalent channel scope." },
  { key: "webhooks", label: "Webhooks", description: "Support inbound HTTP webhook/event delivery where the platform provides it." },
];

export function channelFeatureStates(capabilities: readonly ChannelCapability[]): ChannelFeatureState[] {
  const supported = new Set(capabilities);
  return CHANNEL_FEATURES.map((feature) => ({
    ...feature,
    supported: supported.has(feature.key),
  }));
}

export function buildAdapterConformanceMatrix(input: {
  agents?: AgentAdapterDescriptor[];
  channels?: ChannelDescriptor[];
} = {}): AdapterConformanceMatrix {
  const agents = input.agents ?? listAgentAdapterDescriptors();
  const channels = input.channels ?? listChannelDescriptors();
  return {
    generatedAt: new Date().toISOString(),
    agents: agents.map((adapter) => {
      const features = agentFeatureStates(adapter.capabilities);
      return {
        id: adapter.id,
        label: adapter.label,
        status: adapter.status,
        features,
        supported: features.filter((feature) => feature.supported).map((feature) => feature.key),
        unsupported: features.filter((feature) => !feature.supported).map((feature) => feature.key),
        notes: adapter.notes,
      };
    }),
    channels: channels.map((adapter) => {
      const features = channelFeatureStates(adapter.capabilities);
      return {
        id: adapter.id,
        label: adapter.label,
        status: adapter.status,
        enabled: adapter.enabled,
        features,
        supported: features.filter((feature) => feature.supported).map((feature) => feature.key),
        unsupported: features.filter((feature) => !feature.supported).map((feature) => feature.key),
        commands: commandNamesForChannel(adapter.id),
        notes: adapter.notes,
      };
    }),
  };
}

function commandNamesForChannel(id: ChannelDescriptor["id"]): string[] {
  if (id === "telegram" || id === "discord" || id === "slack" || id === "matrix") {
    return channelCatalogCommandNames(id as CommandTransport);
  }
  return [];
}
