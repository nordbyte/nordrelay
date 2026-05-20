import type { AgentPromptInput } from "../../agents/shared/agent.js";
import type { ConnectorConfig } from "../../core/config.js";
import { CHANNEL_CAPABILITIES } from "./channel-capabilities.js";

export type ChannelId = "telegram" | "discord" | "slack" | "matrix";

export type ChannelCapability =
  | "text"
  | "streaming-edits"
  | "typing"
  | "inline-buttons"
  | "files"
  | "photos"
  | "voice"
  | "topics"
  | "webhooks";

export interface ChannelContext {
  channelId: ChannelId;
  chatId: string;
  topicId?: string;
  userId?: string;
  username?: string;
}

export interface ChannelOutboundMessage {
  text: string;
  fallbackText?: string;
  parseMode?: "html" | "markdown" | "plain";
  threadId?: string;
  buttons?: Array<Array<{ label: string; action: string }>>;
}

export interface ChannelOutboundResult {
  messageId: string;
}

export interface ChannelOutboundFile {
  localPath: string;
  name?: string;
  caption?: string;
  threadId?: string;
}

export interface ChannelRuntime {
  id: ChannelId;
  label: string;
  capabilities: Set<ChannelCapability>;
  describe(): ChannelDescriptor;
  sendMessage(context: ChannelContext, message: ChannelOutboundMessage): Promise<ChannelOutboundResult>;
  editMessage(context: ChannelContext, messageId: string, message: ChannelOutboundMessage): Promise<void>;
  sendTyping(context: ChannelContext): Promise<void>;
  sendFile?(context: ChannelContext, file: ChannelOutboundFile): Promise<ChannelOutboundResult>;
}

export interface ChannelInboundMessage {
  id: string;
  context: ChannelContext;
  text?: string;
  input?: AgentPromptInput;
  attachments?: Array<{ name: string; localPath: string; mimeType?: string }>;
}

export interface ChannelAdapter {
  id: ChannelId;
  label: string;
  capabilities: Set<ChannelCapability>;
  describe(): ChannelDescriptor;
}

export interface ChannelDescriptor {
  id: ChannelId;
  label: string;
  capabilities: ChannelCapability[];
  status: "available" | "planned";
  enabled?: boolean;
  notes?: string;
}

type ChannelDescriptorConfig = Pick<
  ConnectorConfig,
  | "adapterWarnings"
  | "telegramEnabled"
  | "telegramBotToken"
  | "telegramTransport"
  | "discordEnabled"
  | "discordBotToken"
  | "slackEnabled"
  | "slackBotToken"
  | "slackAppToken"
  | "slackSocketMode"
  | "matrixEnabled"
  | "matrixHomeserverUrl"
  | "matrixAccessToken"
  | "matrixUserId"
>;

function adapterWarning(config: ChannelDescriptorConfig, label: "Telegram" | "Discord" | "Slack" | "Matrix"): string | undefined {
  return config.adapterWarnings?.find((warning) => warning.startsWith(`${label} disabled:`));
}

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly id = "telegram";
  readonly label = "Telegram";
  readonly capabilities = new Set<ChannelCapability>(CHANNEL_CAPABILITIES.telegram);

  describe(config?: ChannelDescriptorConfig): ChannelDescriptor {
    if (config) {
      const warning = adapterWarning(config, "Telegram");
      return {
        id: this.id,
        label: this.label,
        capabilities: [...this.capabilities],
        status: "available",
        enabled: config.telegramEnabled,
        notes: config.telegramEnabled
          ? `Telegram bot runtime is enabled (${config.telegramTransport}).`
          : (warning ?? "Telegram bot runtime is disabled."),
      };
    }
    const requested = process.env.TELEGRAM_ENABLED !== "false";
    const enabled = requested && Boolean(process.env.TELEGRAM_BOT_TOKEN);
    return {
      id: this.id,
      label: this.label,
      capabilities: [...this.capabilities],
      status: "available",
      enabled,
      notes: enabled
        ? "Telegram bot runtime is enabled."
        : requested
          ? "Telegram bot runtime is disabled because TELEGRAM_BOT_TOKEN is missing."
          : "Telegram bot runtime is disabled.",
    };
  }
}

export class DiscordChannelAdapter implements ChannelAdapter {
  readonly id = "discord";
  readonly label = "Discord";
  readonly capabilities = new Set<ChannelCapability>(CHANNEL_CAPABILITIES.discord);

  describe(config?: ChannelDescriptorConfig): ChannelDescriptor {
    if (config) {
      const warning = adapterWarning(config, "Discord");
      return {
        id: this.id,
        label: this.label,
        capabilities: [...this.capabilities],
        status: "available",
        enabled: config.discordEnabled,
        notes: config.discordEnabled
          ? "Discord bot runtime is enabled."
          : (warning ?? "Enable with DISCORD_ENABLED=true and DISCORD_BOT_TOKEN."),
      };
    }
    const requested = process.env.DISCORD_ENABLED === "true";
    const enabled = requested && Boolean(process.env.DISCORD_BOT_TOKEN);
    return {
      id: this.id,
      label: this.label,
      capabilities: [...this.capabilities],
      status: "available",
      enabled,
      notes: enabled
        ? "Discord bot runtime is enabled."
        : requested
          ? "Discord bot runtime is disabled because DISCORD_BOT_TOKEN is missing."
          : "Enable with DISCORD_ENABLED=true and DISCORD_BOT_TOKEN.",
    };
  }
}

export class SlackChannelAdapter implements ChannelAdapter {
  readonly id = "slack";
  readonly label = "Slack";
  readonly capabilities = new Set<ChannelCapability>(CHANNEL_CAPABILITIES.slack);

  describe(config?: ChannelDescriptorConfig): ChannelDescriptor {
    if (config) {
      const warning = adapterWarning(config, "Slack");
      return {
        id: this.id,
        label: this.label,
        capabilities: [...this.capabilities],
        status: "available",
        enabled: config.slackEnabled,
        notes: config.slackEnabled
          ? "Slack bot runtime is enabled."
          : (warning ?? "Enable with SLACK_ENABLED=true, SLACK_BOT_TOKEN, and SLACK_APP_TOKEN."),
      };
    }
    const requested = process.env.SLACK_ENABLED === "true";
    const enabled = requested && Boolean(process.env.SLACK_BOT_TOKEN) && Boolean(process.env.SLACK_APP_TOKEN);
    return {
      id: this.id,
      label: this.label,
      capabilities: [...this.capabilities],
      status: "available",
      enabled,
      notes: enabled
        ? "Slack bot runtime is enabled."
        : requested
          ? "Slack bot runtime is disabled because SLACK_BOT_TOKEN or SLACK_APP_TOKEN is missing."
          : "Enable with SLACK_ENABLED=true, SLACK_BOT_TOKEN, and SLACK_APP_TOKEN.",
    };
  }
}

export class MatrixChannelAdapter implements ChannelAdapter {
  readonly id = "matrix";
  readonly label = "Matrix";
  readonly capabilities = new Set<ChannelCapability>(CHANNEL_CAPABILITIES.matrix);

  describe(config?: ChannelDescriptorConfig): ChannelDescriptor {
    if (config) {
      const warning = adapterWarning(config, "Matrix");
      return {
        id: this.id,
        label: this.label,
        capabilities: [...this.capabilities],
        status: "available",
        enabled: config.matrixEnabled,
        notes: config.matrixEnabled
          ? `Matrix bot runtime is enabled (${config.matrixHomeserverUrl ?? "homeserver"}).`
          : (warning ?? "Enable with MATRIX_ENABLED=true, MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, and MATRIX_USER_ID."),
      };
    }
    const requested = process.env.MATRIX_ENABLED === "true";
    const enabled = requested && Boolean(process.env.MATRIX_HOMESERVER_URL) && Boolean(process.env.MATRIX_ACCESS_TOKEN) && Boolean(process.env.MATRIX_USER_ID);
    return {
      id: this.id,
      label: this.label,
      capabilities: [...this.capabilities],
      status: "available",
      enabled,
      notes: enabled
        ? "Matrix bot runtime is enabled."
        : requested
          ? "Matrix bot runtime is disabled because MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, or MATRIX_USER_ID is missing."
          : "Enable with MATRIX_ENABLED=true, MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, and MATRIX_USER_ID.",
    };
  }
}

export function listChannelDescriptors(config?: ChannelDescriptorConfig): ChannelDescriptor[] {
  return [
    new TelegramChannelAdapter().describe(config),
    new DiscordChannelAdapter().describe(config),
    new SlackChannelAdapter().describe(config),
    new MatrixChannelAdapter().describe(config),
  ];
}
