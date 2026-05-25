import type { GroupDefinition, Permission } from "./access-control.js";
import type { ArtifactDeliveryMode } from "../artifacts/artifact-delivery.js";

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  passwordSalt: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  preferences?: UserPreferences;
}

export type UserThemePreference = "light" | "dark" | "system";

export interface UserPreferences {
  theme?: UserThemePreference;
  artifactDelivery?: ArtifactDeliveryMode;
}

export interface TotpCredentialRecord {
  userId: string;
  secret: string;
  enabledAt: string;
  lastUsedStep?: number;
}

export interface RecoveryCodeRecord {
  id: string;
  userId: string;
  codeHash: string;
  createdAt: string;
  usedAt?: string;
}

export interface WebAuthnCredentialRecord {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  name: string;
  deviceType?: string;
  backedUp?: boolean;
  createdAt: string;
  lastUsedAt?: string;
}

export interface ApiTokenRecord {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  permissions: Permission[];
  agentIds: string[];
  workspaceRoots: string[];
  peerIds: string[];
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface GroupRecord extends GroupDefinition {
  agentIds: string[];
  workspaceRoots: string[];
  telegramChatIds: number[];
  discordChannelIds: string[];
  slackChannelIds: string[];
  matrixRoomIds: string[];
  peerIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UserGroupRecord {
  userId: string;
  groupId: string;
}

export interface TelegramIdentityRecord {
  id: string;
  userId: string;
  telegramUserId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  active: boolean;
  linkedAt: string;
  updatedAt: string;
}

export interface TelegramChatAccessRecord {
  id: string;
  chatId: number;
  title?: string;
  type?: string;
  enabled: boolean;
  allowedGroupIds: string[];
  artifactDelivery?: ArtifactDeliveryMode;
  createdAt: string;
  updatedAt: string;
}

export interface DiscordIdentityRecord {
  id: string;
  userId: string;
  discordUserId: string;
  username?: string;
  globalName?: string;
  active: boolean;
  linkedAt: string;
  updatedAt: string;
}

export interface DiscordChannelAccessRecord {
  id: string;
  guildId?: string;
  channelId: string;
  title?: string;
  type?: string;
  enabled: boolean;
  allowedGroupIds: string[];
  artifactDelivery?: ArtifactDeliveryMode;
  createdAt: string;
  updatedAt: string;
}

export interface SlackIdentityRecord {
  id: string;
  userId: string;
  slackUserId: string;
  teamId?: string;
  username?: string;
  realName?: string;
  active: boolean;
  linkedAt: string;
  updatedAt: string;
}

export interface SlackChannelAccessRecord {
  id: string;
  teamId?: string;
  channelId: string;
  title?: string;
  type?: string;
  enabled: boolean;
  allowedGroupIds: string[];
  artifactDelivery?: ArtifactDeliveryMode;
  createdAt: string;
  updatedAt: string;
}

export interface MatrixIdentityRecord {
  id: string;
  userId: string;
  matrixUserId: string;
  homeserver?: string;
  displayName?: string;
  active: boolean;
  linkedAt: string;
  updatedAt: string;
}

export interface MatrixRoomAccessRecord {
  id: string;
  roomId: string;
  homeserver?: string;
  title?: string;
  canonicalAlias?: string;
  type?: string;
  enabled: boolean;
  allowedGroupIds: string[];
  artifactDelivery?: ArtifactDeliveryMode;
  createdAt: string;
  updatedAt: string;
}

export interface WebSessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent?: string;
  ipAddress?: string;
  deviceName?: string;
  mfaVerified?: boolean;
  apiTokenId?: string;
}

export interface TelegramLinkCodeRecord {
  code: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface DiscordLinkCodeRecord {
  code: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface SlackLinkCodeRecord {
  code: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface MatrixLinkCodeRecord {
  code: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface AuthenticatedUser {
  user: UserRecord;
  groups: GroupRecord[];
  permissions: Permission[];
  apiToken?: PublicApiTokenRecord;
}

export type PublicWebSessionRecord = Omit<WebSessionRecord, "tokenHash">;
export type PublicApiTokenRecord = Omit<ApiTokenRecord, "tokenHash">;

export interface UserManagementSnapshot {
  users: Array<UserRecord & {
    groups: GroupRecord[];
    telegramIdentities: TelegramIdentityRecord[];
    discordIdentities: DiscordIdentityRecord[];
    slackIdentities: SlackIdentityRecord[];
    matrixIdentities: MatrixIdentityRecord[];
    webSessions: PublicWebSessionRecord[];
    mfa: {
      totpEnabled: boolean;
      recoveryCodesRemaining: number;
      webAuthnCredentials: PublicWebAuthnCredentialRecord[];
    };
    apiTokens: PublicApiTokenRecord[];
  }>;
  groups: GroupRecord[];
  telegramChats: TelegramChatAccessRecord[];
  discordChannels: DiscordChannelAccessRecord[];
  slackChannels: SlackChannelAccessRecord[];
  matrixRooms: MatrixRoomAccessRecord[];
  adminConfigured: boolean;
}

export type PublicWebAuthnCredentialRecord = Omit<WebAuthnCredentialRecord, "publicKey">;

export interface PersistedUsers {
  version: 1;
  users: UserRecord[];
  groups: GroupRecord[];
  userGroups: UserGroupRecord[];
  telegramIdentities: TelegramIdentityRecord[];
  telegramChats: TelegramChatAccessRecord[];
  discordIdentities: DiscordIdentityRecord[];
  discordChannels: DiscordChannelAccessRecord[];
  slackIdentities: SlackIdentityRecord[];
  slackChannels: SlackChannelAccessRecord[];
  matrixIdentities: MatrixIdentityRecord[];
  matrixRooms: MatrixRoomAccessRecord[];
  totpCredentials: TotpCredentialRecord[];
  recoveryCodes: RecoveryCodeRecord[];
  webAuthnCredentials: WebAuthnCredentialRecord[];
  apiTokens: ApiTokenRecord[];
  webSessions: WebSessionRecord[];
  telegramLinkCodes: TelegramLinkCodeRecord[];
  discordLinkCodes: DiscordLinkCodeRecord[];
  slackLinkCodes: SlackLinkCodeRecord[];
  matrixLinkCodes: MatrixLinkCodeRecord[];
}
