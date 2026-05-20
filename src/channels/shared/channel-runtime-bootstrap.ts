import type { ConnectorConfig } from "../../core/config.js";
import { configureRedaction } from "../../core/redaction.js";
import type { ChannelRuntime } from "./channel-adapter.js";
import type { ChannelQueueStatusAdapter } from "./channel-bridge-environment.js";

export function configureChannelRuntime(config: ConnectorConfig): void {
  configureRedaction(config.telegramRedactPatterns);
}

export function createTextQueueStatusAdapter<
  Key extends string,
  MessageId extends string | number = string,
>(runtime: ChannelRuntime): ChannelQueueStatusAdapter<Key, MessageId> {
  return {
    send: async (_contextKey, context, text) => {
      const result = await runtime.sendMessage(context, { text, fallbackText: text });
      return result.messageId as MessageId;
    },
    edit: async (_contextKey, context, messageId, text) => {
      await runtime.editMessage(context, String(messageId), { text, fallbackText: text });
    },
  };
}
