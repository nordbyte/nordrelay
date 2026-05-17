import path from "node:path";

import {
  ADMIN_GROUP_ID,
  BUILTIN_GROUPS,
  READONLY_GROUP_ID,
  type Permission,
  isPermission,
} from "./access-control.js";
import type {
  DiscordChannelAccessRecord,
  DiscordIdentityRecord,
  DiscordLinkCodeRecord,
  GroupRecord,
  PersistedUsers,
  SlackChannelAccessRecord,
  SlackIdentityRecord,
  SlackLinkCodeRecord,
  TelegramChatAccessRecord,
  TelegramIdentityRecord,
  TelegramLinkCodeRecord,
  UserGroupRecord,
  UserPreferences,
  UserRecord,
  WebSessionRecord,
} from "./user-management-types.js";

export function normalizePayload(payload: PersistedUsers | undefined): PersistedUsers {
  const now = new Date().toISOString();
  const groupsById = new Map<string, GroupRecord>();
  for (const group of BUILTIN_GROUPS) {
    groupsById.set(group.id, {
      ...group,
      permissions: group.id === ADMIN_GROUP_ID ? allPermissionsSafe() : group.permissions,
      agentIds: [],
      workspaceRoots: [],
      telegramChatIds: [],
      discordChannelIds: [],
      slackChannelIds: [],
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const group of payload?.groups ?? []) {
    if (!isGroupRecord(group)) continue;
    groupsById.set(group.id, {
      ...group,
      permissions: group.id === ADMIN_GROUP_ID ? allPermissionsSafe() : normalizePermissions(group.permissions),
      system: BUILTIN_GROUPS.some((builtin) => builtin.id === group.id) || group.system,
      agentIds: normalizeStringList(group.agentIds),
      workspaceRoots: normalizeStringList(group.workspaceRoots),
      telegramChatIds: normalizeNumberList(group.telegramChatIds),
      discordChannelIds: normalizeStringList(group.discordChannelIds),
      slackChannelIds: normalizeStringList(group.slackChannelIds),
    });
  }
  const groups = Array.from(groupsById.values());
  const groupIds = new Set(groups.map((group) => group.id));
  const users = (payload?.users ?? []).filter(isUserRecord).map((user) => ({
    ...user,
    preferences: normalizeUserPreferences(user.preferences),
  }));
  const userIds = new Set(users.map((user) => user.id));
  return {
    version: 1,
    users,
    groups,
    userGroups: (payload?.userGroups ?? []).filter((item) => isUserGroupRecord(item) && userIds.has(item.userId) && groupIds.has(item.groupId)),
    telegramIdentities: (payload?.telegramIdentities ?? []).filter((item) => isTelegramIdentityRecord(item) && userIds.has(item.userId)),
    telegramChats: (payload?.telegramChats ?? []).filter(isTelegramChatAccessRecord).map((chat) => ({
      ...chat,
      allowedGroupIds: chat.allowedGroupIds.filter((groupId) => groupIds.has(groupId)),
    })),
    discordIdentities: (payload?.discordIdentities ?? []).filter((item) => isDiscordIdentityRecord(item) && userIds.has(item.userId)),
    discordChannels: (payload?.discordChannels ?? []).filter(isDiscordChannelAccessRecord).map((channel) => ({
      ...channel,
      allowedGroupIds: channel.allowedGroupIds.filter((groupId) => groupIds.has(groupId)),
    })),
    slackIdentities: (payload?.slackIdentities ?? []).filter((item) => isSlackIdentityRecord(item) && userIds.has(item.userId)),
    slackChannels: (payload?.slackChannels ?? []).filter(isSlackChannelAccessRecord).map((channel) => ({
      ...channel,
      allowedGroupIds: channel.allowedGroupIds.filter((groupId) => groupIds.has(groupId)),
    })),
    webSessions: (payload?.webSessions ?? []).filter((item) => isWebSessionRecord(item) && userIds.has(item.userId)),
    telegramLinkCodes: (payload?.telegramLinkCodes ?? []).filter((item) => isTelegramLinkCodeRecord(item) && userIds.has(item.userId)),
    discordLinkCodes: (payload?.discordLinkCodes ?? []).filter((item) => isDiscordLinkCodeRecord(item) && userIds.has(item.userId)),
    slackLinkCodes: (payload?.slackLinkCodes ?? []).filter((item) => isSlackLinkCodeRecord(item) && userIds.has(item.userId)),
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeGroupIds(payload: PersistedUsers, values: string[], emptyFallback: string | null = READONLY_GROUP_ID): string[] {
  const available = new Set(payload.groups.map((group) => group.id));
  const groupIds = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  for (const groupId of groupIds) {
    if (!available.has(groupId)) {
      throw new Error(`Unknown group: ${groupId}`);
    }
  }
  return groupIds.length > 0 ? groupIds : (emptyFallback ? [emptyFallback] : []);
}

export function normalizePermissions(values: string[] | undefined, strict = false): Permission[] {
  const permissions: Permission[] = [];
  for (const value of values ?? []) {
    if (isPermission(value)) {
      if (!permissions.includes(value)) {
        permissions.push(value);
      }
      continue;
    }
    if (strict && value.trim()) {
      throw new Error(`Unknown permission: ${value}`);
    }
  }
  return permissions;
}

export function normalizeStringList(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

export function normalizeNumberList(values: number[] | undefined): number[] {
  return Array.from(new Set((values ?? []).filter((value) => Number.isInteger(value))));
}

export function normalizeDiscordId(value: string | undefined | null): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

export function normalizeSlackId(value: string | undefined | null): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

export function assertActiveAdminExists(payload: PersistedUsers): void {
  const hasAdmin = payload.users.some((user) => user.active && payload.userGroups.some((item) => item.userId === user.id && item.groupId === ADMIN_GROUP_ID));
  if (!hasAdmin) {
    throw new Error("Cannot remove or disable the last active admin user.");
  }
}

export function normalizeWorkspacePath(value: string): string {
  return path.resolve(value);
}

export function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function allPermissionsSafe(): Permission[] {
  return [...BUILTIN_GROUPS.find((group) => group.id === ADMIN_GROUP_ID)!.permissions];
}

export function normalizeUserPreferences(value: unknown): UserPreferences | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as UserPreferences;
  const theme = candidate.theme === "light" || candidate.theme === "dark" || candidate.theme === "system"
    ? candidate.theme
    : undefined;
  return theme ? { theme } : undefined;
}

function isUserRecord(value: unknown): value is UserRecord {
  const candidate = value as UserRecord;
  return Boolean(candidate) && typeof candidate.id === "string" && typeof candidate.email === "string" &&
    typeof candidate.displayName === "string" && typeof candidate.passwordHash === "string" &&
    typeof candidate.passwordSalt === "string" && typeof candidate.active === "boolean";
}

function isGroupRecord(value: unknown): value is GroupRecord {
  const candidate = value as GroupRecord;
  return Boolean(candidate) && typeof candidate.id === "string" && typeof candidate.name === "string" &&
    Array.isArray(candidate.permissions);
}

function isUserGroupRecord(value: unknown): value is UserGroupRecord {
  const candidate = value as UserGroupRecord;
  return Boolean(candidate) && typeof candidate.userId === "string" && typeof candidate.groupId === "string";
}

function isTelegramIdentityRecord(value: unknown): value is TelegramIdentityRecord {
  const candidate = value as TelegramIdentityRecord;
  return Boolean(candidate) && typeof candidate.id === "string" && typeof candidate.userId === "string" &&
    Number.isInteger(candidate.telegramUserId) && typeof candidate.active === "boolean";
}

function isTelegramChatAccessRecord(value: unknown): value is TelegramChatAccessRecord {
  const candidate = value as TelegramChatAccessRecord;
  return Boolean(candidate) && typeof candidate.id === "string" && Number.isInteger(candidate.chatId) &&
    typeof candidate.enabled === "boolean" && Array.isArray(candidate.allowedGroupIds);
}

function isDiscordIdentityRecord(value: unknown): value is DiscordIdentityRecord {
  const candidate = value as DiscordIdentityRecord;
  return Boolean(candidate) && typeof candidate.id === "string" && typeof candidate.userId === "string" &&
    typeof candidate.discordUserId === "string" && typeof candidate.active === "boolean";
}

function isDiscordChannelAccessRecord(value: unknown): value is DiscordChannelAccessRecord {
  const candidate = value as DiscordChannelAccessRecord;
  return Boolean(candidate) && typeof candidate.id === "string" && typeof candidate.channelId === "string" &&
    typeof candidate.enabled === "boolean" && Array.isArray(candidate.allowedGroupIds);
}

function isSlackIdentityRecord(value: unknown): value is SlackIdentityRecord {
  const candidate = value as SlackIdentityRecord;
  return Boolean(candidate) && typeof candidate.id === "string" && typeof candidate.userId === "string" &&
    typeof candidate.slackUserId === "string" && typeof candidate.active === "boolean";
}

function isSlackChannelAccessRecord(value: unknown): value is SlackChannelAccessRecord {
  const candidate = value as SlackChannelAccessRecord;
  return Boolean(candidate) && typeof candidate.id === "string" && typeof candidate.channelId === "string" &&
    typeof candidate.enabled === "boolean" && Array.isArray(candidate.allowedGroupIds);
}

function isWebSessionRecord(value: unknown): value is WebSessionRecord {
  const candidate = value as WebSessionRecord;
  return Boolean(candidate) && typeof candidate.id === "string" && typeof candidate.userId === "string" &&
    typeof candidate.tokenHash === "string" && typeof candidate.expiresAt === "string";
}

function isTelegramLinkCodeRecord(value: unknown): value is TelegramLinkCodeRecord {
  const candidate = value as TelegramLinkCodeRecord;
  return Boolean(candidate) && typeof candidate.code === "string" && typeof candidate.userId === "string" &&
    typeof candidate.expiresAt === "string";
}

function isDiscordLinkCodeRecord(value: unknown): value is DiscordLinkCodeRecord {
  const candidate = value as DiscordLinkCodeRecord;
  return Boolean(candidate) && typeof candidate.code === "string" && typeof candidate.userId === "string" &&
    typeof candidate.expiresAt === "string";
}

function isSlackLinkCodeRecord(value: unknown): value is SlackLinkCodeRecord {
  const candidate = value as SlackLinkCodeRecord;
  return Boolean(candidate) && typeof candidate.code === "string" && typeof candidate.userId === "string" &&
    typeof candidate.expiresAt === "string";
}
