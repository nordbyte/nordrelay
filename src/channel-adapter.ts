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
  parseMode?: "html" | "markdown" | "plain";
  threadId?: string;
  buttons?: Array<{ label: string; action: string }>;
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

const PLANNED_CHANNELS: ChannelDescriptor[] = [
  {
    id: "discord",
    label: "Discord",
    capabilities: ["text", "streaming-edits", "typing", "inline-buttons", "files", "photos", "voice"],
    status: "planned",
    notes: "Adapter boundary is ready; runtime integration still needs bot credentials and event mapping.",
  },
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
    return {
      id: this.id,
      label: this.label,
      capabilities: [...this.capabilities],
      status: "available",
    };
  }
}

export function listChannelDescriptors(): ChannelDescriptor[] {
  return [
    new TelegramChannelAdapter().describe(),
    ...PLANNED_CHANNELS,
  ];
}
