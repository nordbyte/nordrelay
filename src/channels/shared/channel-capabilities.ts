import type { ChannelCapability, ChannelDescriptor } from "./channel-adapter.js";
import type { CommandTransport } from "./channel-command-core.js";

export type ChannelActionKey =
  | "receive-text"
  | "send-text"
  | "stream-reply"
  | "typing-indicator"
  | "inline-actions"
  | "receive-files"
  | "send-files"
  | "receive-photos"
  | "voice-transcription"
  | "topic-contexts"
  | "webhook-events"
  | "cli-working-mirror"
  | "cli-final-mirror"
  | "queue-status-edits"
  | "artifact-summary"
  | "artifact-files"
  | "rate-limit-backoff";

export interface ChannelFeatureDefinition {
  key: ChannelCapability;
  label: string;
  description: string;
}

export interface ChannelFeatureState extends ChannelFeatureDefinition {
  supported: boolean;
}

export interface ChannelActionDefinition {
  key: ChannelActionKey;
  label: string;
  description: string;
  requiredCapabilities: ChannelCapability[];
  transports?: CommandTransport[];
}

export interface ChannelActionState extends ChannelActionDefinition {
  supported: boolean;
  reason?: string;
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

export const CHANNEL_ACTIONS: ChannelActionDefinition[] = [
  {
    key: "receive-text",
    label: "Receive text",
    description: "Accept user prompts through the channel transport.",
    requiredCapabilities: ["text"],
  },
  {
    key: "send-text",
    label: "Send text",
    description: "Deliver agent output and command responses through the channel transport.",
    requiredCapabilities: ["text"],
  },
  {
    key: "stream-reply",
    label: "Streaming replies",
    description: "Stream in-flight agent output by editing an existing channel message.",
    requiredCapabilities: ["text", "streaming-edits"],
  },
  {
    key: "typing-indicator",
    label: "Typing indicator",
    description: "Keep a visible channel activity indicator alive while the agent is working.",
    requiredCapabilities: ["typing"],
  },
  {
    key: "inline-actions",
    label: "Inline actions",
    description: "Expose buttons for queue, sessions, abort, artifacts, updates, and similar choices.",
    requiredCapabilities: ["inline-buttons"],
  },
  {
    key: "receive-files",
    label: "Receive files",
    description: "Stage channel uploads as agent attachments or transcription inputs.",
    requiredCapabilities: ["files"],
  },
  {
    key: "send-files",
    label: "Send files",
    description: "Send generated artifacts or bundles back to the channel.",
    requiredCapabilities: ["files"],
  },
  {
    key: "receive-photos",
    label: "Receive photos",
    description: "Accept image inputs for agents that can use them.",
    requiredCapabilities: ["photos"],
  },
  {
    key: "voice-transcription",
    label: "Voice transcription",
    description: "Receive audio and transcribe it before prompting or staging it.",
    requiredCapabilities: ["voice"],
  },
  {
    key: "topic-contexts",
    label: "Topic contexts",
    description: "Maintain independent NordRelay contexts per topic, thread, or room scope.",
    requiredCapabilities: ["topics"],
  },
  {
    key: "webhook-events",
    label: "Webhook events",
    description: "Receive platform events over a webhook or HTTP event endpoint.",
    requiredCapabilities: ["webhooks"],
  },
  {
    key: "cli-working-mirror",
    label: "CLI working mirror",
    description: "Mirror externally started CLI turns with Working on ... and live status updates.",
    requiredCapabilities: ["text", "typing"],
  },
  {
    key: "cli-final-mirror",
    label: "CLI final mirror",
    description: "Mirror final CLI answers and generated artifact summaries to the channel.",
    requiredCapabilities: ["text"],
  },
  {
    key: "queue-status-edits",
    label: "Queue status edits",
    description: "Update one queue status message instead of repeatedly posting new messages.",
    requiredCapabilities: ["text", "streaming-edits"],
  },
  {
    key: "artifact-summary",
    label: "Artifact summaries",
    description: "Show generated artifact summaries in the channel when delivery policy allows it.",
    requiredCapabilities: ["text"],
  },
  {
    key: "artifact-files",
    label: "Artifact files",
    description: "Send generated artifact files or bundles when delivery policy allows it.",
    requiredCapabilities: ["files"],
  },
  {
    key: "rate-limit-backoff",
    label: "Rate-limit backoff",
    description: "Serialize channel sends and edits with transport-specific retry/backoff handling.",
    requiredCapabilities: ["text"],
  },
];

export const CHANNEL_CAPABILITIES: Record<CommandTransport, readonly ChannelCapability[]> = {
  telegram: ["text", "streaming-edits", "typing", "inline-buttons", "files", "photos", "voice", "topics", "webhooks"],
  discord: ["text", "streaming-edits", "typing", "inline-buttons", "files", "photos", "voice", "topics"],
  slack: ["text", "streaming-edits", "typing", "inline-buttons", "files", "photos", "voice", "topics", "webhooks"],
  matrix: ["text", "streaming-edits", "typing", "files", "photos", "voice", "topics"],
};

export function channelFeatureStates(capabilities: readonly ChannelCapability[]): ChannelFeatureState[] {
  const supported = new Set(capabilities);
  return CHANNEL_FEATURES.map((feature) => ({
    ...feature,
    supported: supported.has(feature.key),
  }));
}

export function channelActionStates(adapter: Pick<ChannelDescriptor, "id" | "capabilities">): ChannelActionState[] {
  const capabilities = new Set(adapter.capabilities);
  return CHANNEL_ACTIONS.map((action) => {
    const transportAllowed = !action.transports || action.transports.includes(adapter.id);
    const missingCapabilities = action.requiredCapabilities.filter((capability) => !capabilities.has(capability));
    const supported = transportAllowed && missingCapabilities.length === 0;
    return {
      ...action,
      supported,
      reason: supported
        ? undefined
        : transportAllowed
          ? `Missing capability: ${missingCapabilities.join(", ")}`
          : `Not supported by ${adapter.id}`,
    };
  });
}
