import type { ConnectorConfig } from "../../core/config.js";
import { friendlyErrorText } from "../../core/error-messages.js";

export interface StartableDiscordBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function startDiscordBridgeOrDisable<T extends StartableDiscordBridge>(
  config: ConnectorConfig,
  bridge: T | null | undefined,
): Promise<T | undefined> {
  if (!config.discordEnabled || !bridge) {
    return undefined;
  }

  try {
    await bridge.start();
    return bridge;
  } catch (error) {
    await bridge.stop().catch(() => undefined);
    config.discordEnabled = false;
    const warning = `Discord disabled: failed to start Discord adapter (${friendlyErrorText(error)}).`;
    config.adapterWarnings = [...(config.adapterWarnings ?? []), warning];
    return undefined;
  }
}
