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

const PLANNED_CHANNELS: ChannelDescriptor[] = [
  {
    id: "whatsapp",
    label: "WhatsApp",
    capabilities: ["text", "typing", "files", "photos", "voice", "webhooks"],
    status: "planned",
    notes: "Requires a WhatsApp Business provider integration.",
  },
  {
    id: "slack",
    label: "Slack",
    capabilities: ["text", "streaming-edits", "typing", "inline-buttons", "files"],
    status: "planned",
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
    const enabled = process.env.TELEGRAM_ENABLED !== "false";
    return {
      id: this.id,
      label: this.label,
      capabilities: [...this.capabilities],
      status: "available",
      enabled,
      notes: enabled
        ? "Telegram bot runtime is enabled by default."
        : "Telegram bot runtime is disabled.",
    };
  }
}

export class DiscordChannelAdapter implements ChannelAdapter {
  readonly id = "discord";
  readonly label = "Discord";
  readonly capabilities = new Set<ChannelCapability>(DISCORD_CAPABILITIES);

  describe(): ChannelDescriptor {
    const enabled = process.env.DISCORD_ENABLED === "true";
    return {
      id: this.id,
      label: this.label,
      capabilities: [...this.capabilities],
      status: "available",
      enabled,
      notes: enabled
        ? "Discord bot runtime is enabled."
        : "Enable with DISCORD_ENABLED=true and DISCORD_BOT_TOKEN.",
    };
  }
}

export function listChannelDescriptors(): ChannelDescriptor[] {
  return [
    new TelegramChannelAdapter().describe(),
    new DiscordChannelAdapter().describe(),
    ...PLANNED_CHANNELS,
  ];
}
