import type { AgentPromptInput } from "./agent.js";

export type ChannelId = "telegram" | "discord" | "whatsapp" | "slack" | "matrix";

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

const TELEGRAM_CAPABILITIES: ChannelCapability[] = [
  "text",
  "streaming-edits",
  "typing",
  "inline-buttons",
  "files",
  "photos",
  "voice",
  "topics",
  "webhooks",
];

const DISCORD_CAPABILITIES: ChannelCapability[] = [
  "text",
  "streaming-edits",
  "typing",
  "inline-buttons",
  "files",
  "photos",
  "voice",
  "topics",
];

const SLACK_CAPABILITIES: ChannelCapability[] = [
  "text",
  "streaming-edits",
  "typing",
  "inline-buttons",
  "files",
  "photos",
  "voice",
  "topics",
  "webhooks",
];

const PLANNED_CHANNELS: ChannelDescriptor[] = [
  {
    id: "whatsapp",
    label: "WhatsApp",
    capabilities: ["text", "typing", "files", "photos", "voice", "webhooks"],
    status: "planned",
    notes: "Requires a WhatsApp Business provider integration.",
  },
  {
    id: "matrix",
    label: "Matrix",
    capabilities: ["text", "files", "photos", "voice"],
    status: "planned",
  },
];

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly id = "telegram";
  readonly label = "Telegram";
  readonly capabilities = new Set<ChannelCapability>(TELEGRAM_CAPABILITIES);

  describe(): ChannelDescriptor {
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
  readonly capabilities = new Set<ChannelCapability>(DISCORD_CAPABILITIES);

  describe(): ChannelDescriptor {
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
  readonly capabilities = new Set<ChannelCapability>(SLACK_CAPABILITIES);

  describe(): ChannelDescriptor {
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

export function listChannelDescriptors(): ChannelDescriptor[] {
  return [
    new TelegramChannelAdapter().describe(),
    new DiscordChannelAdapter().describe(),
    new SlackChannelAdapter().describe(),
    ...PLANNED_CHANNELS,
  ];
}
