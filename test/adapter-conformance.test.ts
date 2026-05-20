import { describe, expect, it } from "vitest";

import {
  AGENT_IDS,
  type AgentCapabilities,
} from "../src/agents/shared/agent.js";
import {
  CHANNEL_FEATURES,
  buildAdapterConformanceMatrix,
} from "../src/agents/shared/adapter-conformance.js";
import { CHANNEL_COMMANDS } from "../src/channels/shared/channel-command-catalog.js";
import {
  channelCatalogCommandNames,
  channelCommandCoverage,
  createSharedChannelCommandDispatcher,
} from "../src/channels/shared/channel-command-core.js";
import { TELEGRAM_COMMANDS } from "../src/channels/telegram/telegram-command-menu.js";

describe("adapter conformance matrix", () => {
  it("reports one feature row for every agent and channel capability", () => {
    const matrix = buildAdapterConformanceMatrix();
    expect(matrix.agents.map((agent) => agent.id).sort()).toEqual([...AGENT_IDS].sort());

    for (const agent of matrix.agents) {
      const keys = agent.features.map((feature) => feature.key);
      expect(keys).toContain("modelSelection" satisfies keyof AgentCapabilities);
      expect(keys).toContain("reasoningSelection" satisfies keyof AgentCapabilities);
      expect(agent.supported.length + agent.unsupported.length).toBe(agent.features.length);
    }

    for (const channel of matrix.channels) {
      expect(channel.features.map((feature) => feature.key)).toEqual(CHANNEL_FEATURES.map((feature) => feature.key));
      expect(channel.supported.length + channel.unsupported.length).toBe(channel.features.length);
    }
  });

  it("derives command coverage from the shared catalog for implemented chat transports", () => {
    const matrix = buildAdapterConformanceMatrix();
    for (const transport of ["telegram", "discord", "slack", "matrix"] as const) {
      const channel = matrix.channels.find((candidate) => candidate.id === transport);
      expect(channel?.commands).toEqual(channelCatalogCommandNames(transport));
      expect(channel?.commands.length).toBeGreaterThan(20);
    }

    const planned = matrix.channels.filter((channel) => channel.status === "planned");
    expect(planned.every((channel) => channel.commands.length === 0)).toBe(true);
  });

  it("keeps the Telegram bot command menu backed by the shared command catalog", () => {
    expect(TELEGRAM_COMMANDS.map((command) => command.command).sort()).toEqual(channelCatalogCommandNames("telegram"));
  });

  it("keeps the shared dispatcher coverage check aligned with every implemented transport", async () => {
    for (const transport of ["telegram", "discord", "slack", "matrix"] as const) {
      const dispatcher = createSharedChannelCommandDispatcher<{ called: string[] }>({
        transport,
        bindings: CHANNEL_COMMANDS
          .filter((command) => command[transport] !== false)
          .map((command) => ({
            names: [command.name],
            handler: (request: { called: string[] }, _argument: string, name: string) => {
              request.called.push(name);
            },
          })),
      });
      const coverage = channelCommandCoverage({
        transport,
        implemented: dispatcher.commandNames,
      });

      expect(coverage.missing, transport).toEqual([]);
      const request = { called: [] as string[] };
      await dispatcher.dispatch(request, "help", "");
      expect(request.called).toEqual(["help"]);
    }
  });
});
