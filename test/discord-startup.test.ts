import { describe, expect, it, vi } from "vitest";

import { startDiscordBridgeOrDisable, type StartableDiscordBridge } from "../src/channels/discord/discord-startup.js";
import type { ConnectorConfig } from "../src/core/config.js";

describe("Discord startup", () => {
  it("disables Discord when the bridge fails to start", async () => {
    const config = {
      discordEnabled: true,
      adapterWarnings: ["existing warning"],
    } as ConnectorConfig;
    const bridge: StartableDiscordBridge = {
      start: vi.fn().mockRejectedValue(new Error("invalid token")),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const started = await startDiscordBridgeOrDisable(config, bridge);

    expect(started).toBeUndefined();
    expect(config.discordEnabled).toBe(false);
    expect(bridge.stop).toHaveBeenCalledOnce();
    expect(config.adapterWarnings).toEqual([
      "existing warning",
      "Discord disabled: failed to start Discord adapter (invalid token).",
    ]);
  });

  it("keeps Discord enabled when startup succeeds", async () => {
    const config = {
      discordEnabled: true,
      adapterWarnings: [],
    } as ConnectorConfig;
    const bridge: StartableDiscordBridge = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const started = await startDiscordBridgeOrDisable(config, bridge);

    expect(started).toBe(bridge);
    expect(config.discordEnabled).toBe(true);
    expect(bridge.stop).not.toHaveBeenCalled();
    expect(config.adapterWarnings).toEqual([]);
  });
});
