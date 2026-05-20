import { listAgentAdapterDescriptors, type AgentAdapterDescriptor } from "./agent-adapter.js";
import { agentFeatureStates, type AgentFeatureState } from "./agent-feature-matrix.js";
import {
  listChannelDescriptors,
  type ChannelDescriptor,
} from "../../channels/shared/channel-adapter.js";
import {
  CHANNEL_FEATURES,
  channelActionStates,
  channelFeatureStates,
  type ChannelActionState,
  type ChannelFeatureDefinition,
  type ChannelFeatureState,
} from "../../channels/shared/channel-capabilities.js";
import {
  channelCatalogCommandNames,
  channelCommandCoverage,
  type CommandTransport,
} from "../../channels/shared/channel-command-core.js";

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
  actions: ChannelActionState[];
  actionSupported: string[];
  actionUnsupported: string[];
  commands: string[];
  commandCoverage: {
    advertised: string[];
    implemented: string[];
    missing: string[];
    extra: string[];
  };
  notes?: string;
}

export interface AdapterConformanceMatrix {
  generatedAt: string;
  agents: AgentAdapterConformance[];
  channels: ChannelAdapterConformance[];
}

export { CHANNEL_FEATURES, channelFeatureStates, type ChannelFeatureDefinition, type ChannelFeatureState };

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
      const actions = channelActionStates(adapter);
      const commands = commandNamesForChannel(adapter.id);
      const commandCoverage = commandCoverageForChannel(adapter.id, commands);
      return {
        id: adapter.id,
        label: adapter.label,
        status: adapter.status,
        enabled: adapter.enabled,
        features,
        supported: features.filter((feature) => feature.supported).map((feature) => feature.key),
        unsupported: features.filter((feature) => !feature.supported).map((feature) => feature.key),
        actions,
        actionSupported: actions.filter((action) => action.supported).map((action) => action.key),
        actionUnsupported: actions.filter((action) => !action.supported).map((action) => action.key),
        commands,
        commandCoverage,
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

function commandCoverageForChannel(id: ChannelDescriptor["id"], implemented: string[]): ChannelAdapterConformance["commandCoverage"] {
  if (id === "telegram" || id === "discord" || id === "slack" || id === "matrix") {
    return channelCommandCoverage({
      transport: id as CommandTransport,
      implemented,
    });
  }
  return { advertised: [], implemented: [], missing: [], extra: [] };
}
