import type { AuthenticatedUser, DiscordChannelAccessRecord, SlackChannelAccessRecord, TelegramChatAccessRecord } from "../access/user-management.js";
import type { ChannelId } from "../channels/shared/channel-adapter.js";
import type { ConnectorConfig } from "../core/config.js";

export const ARTIFACT_DELIVERY_MODES = [
  "manual-only",
  "summary",
  "summary-with-actions",
  "auto-files",
  "auto-zip",
  "images-only",
  "off",
] as const;

export type ArtifactDeliveryMode = typeof ARTIFACT_DELIVERY_MODES[number];

export interface ArtifactDeliveryPolicy {
  mode: ArtifactDeliveryMode;
  sendSummary: boolean;
  includeActions: boolean;
  autoSendFiles: boolean;
  autoSendZip: boolean;
  imagesOnly: boolean;
}

export interface ArtifactDeliveryResolutionInput {
  config: ConnectorConfig;
  channelId: ChannelId;
  authUser?: AuthenticatedUser | null;
  channelAccess?: TelegramChatAccessRecord | DiscordChannelAccessRecord | SlackChannelAccessRecord | null;
}

export function isArtifactDeliveryMode(value: unknown): value is ArtifactDeliveryMode {
  return typeof value === "string" && ARTIFACT_DELIVERY_MODES.includes(value as ArtifactDeliveryMode);
}

export function parseArtifactDeliveryMode(value: string | undefined, fallback: ArtifactDeliveryMode): ArtifactDeliveryMode {
  const normalized = value?.trim().toLowerCase();
  return isArtifactDeliveryMode(normalized) ? normalized : fallback;
}

export function artifactDeliveryModeFromAutoSend(enabled: boolean): ArtifactDeliveryMode {
  return enabled ? "auto-files" : "manual-only";
}

export function resolveArtifactDeliveryPolicy(input: ArtifactDeliveryResolutionInput): ArtifactDeliveryPolicy {
  const mode = input.authUser?.user.preferences?.artifactDelivery ??
    input.channelAccess?.artifactDelivery ??
    channelDefaultMode(input.config, input.channelId);
  return artifactDeliveryPolicy(mode);
}

export function artifactDeliveryPolicy(mode: ArtifactDeliveryMode): ArtifactDeliveryPolicy {
  return {
    mode,
    sendSummary: ["summary", "summary-with-actions", "auto-files", "auto-zip", "images-only"].includes(mode),
    includeActions: mode === "summary-with-actions",
    autoSendFiles: mode === "auto-files" || mode === "images-only",
    autoSendZip: mode === "auto-zip",
    imagesOnly: mode === "images-only",
  };
}

function channelDefaultMode(config: ConnectorConfig, channelId: ChannelId): ArtifactDeliveryMode {
  if (channelId === "telegram") return config.telegramArtifactDeliveryMode;
  if (channelId === "discord") return config.discordArtifactDeliveryMode;
  if (channelId === "slack") return config.slackArtifactDeliveryMode;
  return config.artifactDeliveryMode;
}
