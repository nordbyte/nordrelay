import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ADMIN_GROUP_ID,
  USER_GROUP_ID,
  type Permission,
} from "./access-control.js";
import { readJsonFileWithBackup, writeJsonFileAtomic } from "../state/persistence.js";
import {
  allPermissionsSafe as ALL_PERMISSIONS_SAFE,
  assertActiveAdminExists,
  isPathInside,
  normalizeDiscordId,
  normalizeEmail,
  normalizeGroupIds,
  normalizeNumberList,
  normalizePayload,
  normalizePermissions,
  normalizeSlackId,
  normalizeStringList,
  normalizeWorkspacePath,
  slugify,
} from "./user-management-normalize.js";
import {
  constantTimeStringEqual,
  hashPassword,
  hashToken,
  randomId,
  randomLinkCode,
  randomSessionToken,
  sleepSync,
  verifyPasswordHash,
} from "./user-management-crypto.js";
import type {
  AuthenticatedUser,
  DiscordChannelAccessRecord,
  DiscordIdentityRecord,
  DiscordLinkCodeRecord,
  GroupRecord,
  PersistedUsers,
  PublicWebSessionRecord,
  SlackChannelAccessRecord,
  SlackIdentityRecord,
  SlackLinkCodeRecord,
  TelegramChatAccessRecord,
  TelegramIdentityRecord,
  TelegramLinkCodeRecord,
  UserGroupRecord,
  UserManagementSnapshot,
  UserRecord,
  WebSessionRecord,
} from "./user-management-types.js";

export type {
  AuthenticatedUser,
  DiscordChannelAccessRecord,
  DiscordIdentityRecord,
  DiscordLinkCodeRecord,
  GroupRecord,
  PersistedUsers,
  PublicWebSessionRecord,
  SlackChannelAccessRecord,
  SlackIdentityRecord,
  SlackLinkCodeRecord,
  TelegramChatAccessRecord,
  TelegramIdentityRecord,
  TelegramLinkCodeRecord,
  UserGroupRecord,
  UserManagementSnapshot,
  UserRecord,
  WebSessionRecord,
} from "./user-management-types.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const WRITE_LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export class UserStore {
  readonly filePath: string;

  constructor(home = process.env.NORDRELAY_HOME || path.join(os.homedir(), ".nordrelay")) {
    this.filePath = path.join(home, "users.json");
  }

  hasAdminUser(): boolean {
    const payload = this.readPayload();
    return payload.users.some((user) => user.active && this.groupIdsForUser(payload, user.id).includes(ADMIN_GROUP_ID));
  }

  snapshot(): UserManagementSnapshot {
    const payload = this.readPayload();
    return {
      users: payload.users.map((user) => ({
        ...user,
        groups: this.groupsForUser(payload, user.id),
        telegramIdentities: payload.telegramIdentities.filter((identity) => identity.userId === user.id),
        discordIdentities: payload.discordIdentities.filter((identity) => identity.userId === user.id),
        slackIdentities: payload.slackIdentities.filter((identity) => identity.userId === user.id),
        webSessions: payload.webSessions
          .filter((session) => session.userId === user.id)
          .map(publicWebSession),
      })),
      groups: payload.groups,
      telegramChats: payload.telegramChats,
      discordChannels: payload.discordChannels,
      slackChannels: payload.slackChannels,
      adminConfigured: payload.users.some((user) => user.active && this.groupIdsForUser(payload, user.id).includes(ADMIN_GROUP_ID)),
    };
  }

  listGroups(): GroupRecord[] {
    return this.readPayload().groups;
  }

  listWebSessions(userId?: string): PublicWebSessionRecord[] {
    const payload = this.readPayload();
    return payload.webSessions
      .filter((session) => !userId || session.userId === userId)
      .map(publicWebSession);
  }

  getUser(id: string): AuthenticatedUser | null {
    const payload = this.readPayload();
    const user = payload.users.find((candidate) => candidate.id === id);
    return user ? this.authenticatedUser(payload, user) : null;
  }

  getUserByEmail(email: string): AuthenticatedUser | null {
    const payload = this.readPayload();
    const normalized = normalizeEmail(email);
    const user = payload.users.find((candidate) => candidate.email === normalized);
    return user ? this.authenticatedUser(payload, user) : null;
  }

  createUser(input: {
    email: string;
    displayName: string;
    password: string;
    groupIds?: string[];
    active?: boolean;
    telegramUserId?: number;
    discordUserId?: string;
    slackUserId?: string;
    slackTeamId?: string;
  }): AuthenticatedUser {
    return this.mutatePayload((payload) => {
      const email = normalizeEmail(input.email);
      if (!email) {
        throw new Error("Email is required.");
      }
      if (payload.users.some((user) => user.email === email)) {
        throw new Error(`User already exists: ${email}`);
      }
      const now = new Date().toISOString();
      const password = hashPassword(input.password);
      const user: UserRecord = {
        id: randomId(),
        email,
        displayName: input.displayName.trim() || email,
        passwordHash: password.hash,
        passwordSalt: password.salt,
        active: input.active ?? true,
        createdAt: now,
        updatedAt: now,
      };
      const groupIds = normalizeGroupIds(payload, input.groupIds?.length ? input.groupIds : [USER_GROUP_ID]);
      payload.users.push(user);
      payload.userGroups.push(...groupIds.map((groupId) => ({ userId: user.id, groupId })));
      if (input.telegramUserId !== undefined) {
        this.upsertTelegramIdentityInPayload(payload, user.id, {
          telegramUserId: input.telegramUserId,
        });
      }
      if (input.discordUserId !== undefined) {
        this.upsertDiscordIdentityInPayload(payload, user.id, {
          discordUserId: input.discordUserId,
        });
      }
      if (input.slackUserId !== undefined) {
        this.upsertSlackIdentityInPayload(payload, user.id, {
          slackUserId: input.slackUserId,
          teamId: input.slackTeamId,
        });
      }
      return this.authenticatedUser(payload, user);
    });
  }

  createAdmin(input: {
    email: string;
    displayName: string;
    password: string;
    telegramUserId?: number;
    discordUserId?: string;
    slackUserId?: string;
    slackTeamId?: string;
  }): AuthenticatedUser {
    return this.createUser({
      ...input,
      groupIds: [ADMIN_GROUP_ID],
      active: true,
    });
  }

  updateUser(id: string, patch: {
    email?: string;
    displayName?: string;
    active?: boolean;
    groupIds?: string[];
  }): AuthenticatedUser {
    return this.mutatePayload((payload) => {
      const user = payload.users.find((candidate) => candidate.id === id);
      if (!user) {
        throw new Error("User not found.");
      }
      const shouldRevokeSessions = patch.active === false || patch.groupIds !== undefined;
      if (patch.email !== undefined) {
        const email = normalizeEmail(patch.email);
        if (!email) {
          throw new Error("Email is required.");
        }
        if (payload.users.some((candidate) => candidate.id !== id && candidate.email === email)) {
          throw new Error(`User already exists: ${email}`);
        }
        user.email = email;
      }
      if (patch.displayName !== undefined) {
        user.displayName = patch.displayName.trim() || user.email;
      }
      if (patch.active !== undefined) {
        user.active = patch.active;
      }
      if (patch.groupIds !== undefined) {
        const groupIds = normalizeGroupIds(payload, patch.groupIds);
        payload.userGroups = payload.userGroups.filter((item) => item.userId !== id);
        payload.userGroups.push(...groupIds.map((groupId) => ({ userId: id, groupId })));
      }
      assertActiveAdminExists(payload);
      if (shouldRevokeSessions) {
        this.revokeUserSessionsInPayload(payload, id);
      }
      user.updatedAt = new Date().toISOString();
      return this.authenticatedUser(payload, user);
    });
  }

  setPassword(id: string, password: string): void {
    this.mutatePayload((payload) => {
      const user = payload.users.find((candidate) => candidate.id === id);
      if (!user) {
        throw new Error("User not found.");
      }
      const next = hashPassword(password);
      user.passwordHash = next.hash;
      user.passwordSalt = next.salt;
      user.updatedAt = new Date().toISOString();
      this.revokeUserSessionsInPayload(payload, id);
    });
  }

  verifyPassword(email: string, password: string): AuthenticatedUser | null {
    return this.mutatePayload((payload) => {
      const user = payload.users.find((candidate) => candidate.email === normalizeEmail(email));
      if (!user || !user.active || !verifyPasswordHash(password, user.passwordSalt, user.passwordHash)) {
        return null;
      }
      user.lastLoginAt = new Date().toISOString();
      user.updatedAt = user.lastLoginAt;
      return this.authenticatedUser(payload, user);
    });
  }

  createWebSession(userId: string): { token: string; session: WebSessionRecord } {
    return this.mutatePayload((payload) => {
      const user = payload.users.find((candidate) => candidate.id === userId && candidate.active);
      if (!user) {
        throw new Error("Active user not found.");
      }
      const token = randomSessionToken();
      const now = new Date();
      const session: WebSessionRecord = {
        id: randomId(),
        userId,
        tokenHash: hashToken(token),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
        lastSeenAt: now.toISOString(),
      };
      payload.webSessions.push(session);
      this.pruneExpiredSessionsInPayload(payload);
      return { token, session };
    });
  }

  resolveWebSession(token: string | undefined): AuthenticatedUser | null {
    if (!token) {
      return null;
    }
    return this.mutatePayload((payload) => {
      this.pruneExpiredSessionsInPayload(payload);
      const tokenHash = hashToken(token);
      const session = payload.webSessions.find((candidate) => constantTimeStringEqual(candidate.tokenHash, tokenHash));
      if (!session) {
        return null;
      }
      const user = payload.users.find((candidate) => candidate.id === session.userId && candidate.active);
      if (!user) {
        payload.webSessions = payload.webSessions.filter((candidate) => candidate.id !== session.id);
        return null;
      }
      session.lastSeenAt = new Date().toISOString();
      return this.authenticatedUser(payload, user);
    });
  }

  destroyWebSession(token: string | undefined): void {
    if (!token) {
      return;
    }
    this.mutatePayload((payload) => {
      const tokenHash = hashToken(token);
      payload.webSessions = payload.webSessions.filter((session) => !constantTimeStringEqual(session.tokenHash, tokenHash));
    });
  }

  revokeWebSession(sessionId: string): boolean {
    return this.mutatePayload((payload) => {
      const before = payload.webSessions.length;
      payload.webSessions = payload.webSessions.filter((session) => session.id !== sessionId);
      return payload.webSessions.length !== before;
    });
  }

  revokeUserSessions(userId: string): number {
    return this.mutatePayload((payload) => {
      const before = payload.webSessions.length;
      this.revokeUserSessionsInPayload(payload, userId);
      return before - payload.webSessions.length;
    });
  }

  resolveTelegramUser(telegramUserId: number | undefined): AuthenticatedUser | null {
    if (telegramUserId === undefined) {
      return null;
    }
    const payload = this.readPayload();
    const identity = payload.telegramIdentities.find((candidate) => candidate.telegramUserId === telegramUserId && candidate.active);
    if (!identity) {
      return null;
    }
    const user = payload.users.find((candidate) => candidate.id === identity.userId && candidate.active);
    return user ? this.authenticatedUser(payload, user) : null;
  }

  resolveDiscordUser(discordUserId: string | undefined): AuthenticatedUser | null {
    const normalized = normalizeDiscordId(discordUserId);
    if (!normalized) {
      return null;
    }
    const payload = this.readPayload();
    const identity = payload.discordIdentities.find((candidate) => candidate.discordUserId === normalized && candidate.active);
    if (!identity) {
      return null;
    }
    const user = payload.users.find((candidate) => candidate.id === identity.userId && candidate.active);
    return user ? this.authenticatedUser(payload, user) : null;
  }

  resolveSlackUser(input: { slackUserId?: string; teamId?: string }): AuthenticatedUser | null {
    const slackUserId = normalizeSlackId(input.slackUserId);
    if (!slackUserId) {
      return null;
    }
    const teamId = normalizeSlackId(input.teamId);
    const payload = this.readPayload();
    const identity = payload.slackIdentities.find((candidate) =>
      candidate.slackUserId === slackUserId &&
      candidate.active &&
      (!teamId || !candidate.teamId || candidate.teamId === teamId)
    );
    if (!identity) {
      return null;
    }
    const user = payload.users.find((candidate) => candidate.id === identity.userId && candidate.active);
    return user ? this.authenticatedUser(payload, user) : null;
  }

  linkTelegramUser(userId: string, input: {
    telegramUserId: number;
    username?: string;
    firstName?: string;
    lastName?: string;
  }): TelegramIdentityRecord {
    return this.mutatePayload((payload) => {
      const user = payload.users.find((candidate) => candidate.id === userId);
      if (!user) {
        throw new Error("User not found.");
      }
      return this.upsertTelegramIdentityInPayload(payload, userId, input);
    });
  }

  unlinkTelegramIdentity(identityId: string): boolean {
    return this.mutatePayload((payload) => {
      const before = payload.telegramIdentities.length;
      payload.telegramIdentities = payload.telegramIdentities.filter((identity) => identity.id !== identityId);
      return payload.telegramIdentities.length !== before;
    });
  }

  linkDiscordUser(userId: string, input: {
    discordUserId: string;
    username?: string;
    globalName?: string;
  }): DiscordIdentityRecord {
    return this.mutatePayload((payload) => {
      const user = payload.users.find((candidate) => candidate.id === userId);
      if (!user) {
        throw new Error("User not found.");
      }
      return this.upsertDiscordIdentityInPayload(payload, userId, input);
    });
  }

  unlinkDiscordIdentity(identityId: string): boolean {
    return this.mutatePayload((payload) => {
      const before = payload.discordIdentities.length;
      payload.discordIdentities = payload.discordIdentities.filter((identity) => identity.id !== identityId);
      return payload.discordIdentities.length !== before;
    });
  }

  linkSlackUser(userId: string, input: {
    slackUserId: string;
    teamId?: string;
    username?: string;
    realName?: string;
  }): SlackIdentityRecord {
    return this.mutatePayload((payload) => {
      const user = payload.users.find((candidate) => candidate.id === userId);
      if (!user) {
        throw new Error("User not found.");
      }
      return this.upsertSlackIdentityInPayload(payload, userId, input);
    });
  }

  unlinkSlackIdentity(identityId: string): boolean {
    return this.mutatePayload((payload) => {
      const before = payload.slackIdentities.length;
      payload.slackIdentities = payload.slackIdentities.filter((identity) => identity.id !== identityId);
      return payload.slackIdentities.length !== before;
    });
  }

  createTelegramLinkCode(userId: string): TelegramLinkCodeRecord {
    return this.mutatePayload((payload) => {
      if (!payload.users.some((user) => user.id === userId && user.active)) {
        throw new Error("Active user not found.");
      }
      const now = Date.now();
      payload.telegramLinkCodes = payload.telegramLinkCodes.filter((code) => new Date(code.expiresAt).getTime() > now);
      const code: TelegramLinkCodeRecord = {
        code: randomLinkCode(),
        userId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + LINK_CODE_TTL_MS).toISOString(),
      };
      payload.telegramLinkCodes.push(code);
      return code;
    });
  }

  createDiscordLinkCode(userId: string): DiscordLinkCodeRecord {
    return this.mutatePayload((payload) => {
      if (!payload.users.some((user) => user.id === userId && user.active)) {
        throw new Error("Active user not found.");
      }
      const now = Date.now();
      payload.discordLinkCodes = payload.discordLinkCodes.filter((code) => new Date(code.expiresAt).getTime() > now);
      const code: DiscordLinkCodeRecord = {
        code: randomLinkCode(),
        userId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + LINK_CODE_TTL_MS).toISOString(),
      };
      payload.discordLinkCodes.push(code);
      return code;
    });
  }

  createSlackLinkCode(userId: string): SlackLinkCodeRecord {
    return this.mutatePayload((payload) => {
      if (!payload.users.some((user) => user.id === userId && user.active)) {
        throw new Error("Active user not found.");
      }
      const now = Date.now();
      payload.slackLinkCodes = payload.slackLinkCodes.filter((code) => new Date(code.expiresAt).getTime() > now);
      const code: SlackLinkCodeRecord = {
        code: randomLinkCode(),
        userId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + LINK_CODE_TTL_MS).toISOString(),
      };
      payload.slackLinkCodes.push(code);
      return code;
    });
  }

  consumeTelegramLinkCode(code: string, input: {
    telegramUserId: number;
    username?: string;
    firstName?: string;
    lastName?: string;
  }): AuthenticatedUser {
    return this.mutatePayload((payload) => {
      const normalized = code.trim().toUpperCase();
      const now = Date.now();
      const link = payload.telegramLinkCodes.find((candidate) => candidate.code === normalized && new Date(candidate.expiresAt).getTime() > now);
      if (!link) {
        throw new Error("Invalid or expired link code.");
      }
      const user = payload.users.find((candidate) => candidate.id === link.userId && candidate.active);
      if (!user) {
        throw new Error("Linked user is not active.");
      }
      this.upsertTelegramIdentityInPayload(payload, user.id, input);
      payload.telegramLinkCodes = payload.telegramLinkCodes.filter((candidate) => candidate.code !== normalized);
      return this.authenticatedUser(payload, user);
    });
  }

  consumeDiscordLinkCode(code: string, input: {
    discordUserId: string;
    username?: string;
    globalName?: string;
  }): AuthenticatedUser {
    return this.mutatePayload((payload) => {
      const normalized = code.trim().toUpperCase();
      const now = Date.now();
      const link = payload.discordLinkCodes.find((candidate) => candidate.code === normalized && new Date(candidate.expiresAt).getTime() > now);
      if (!link) {
        throw new Error("Invalid or expired link code.");
      }
      const user = payload.users.find((candidate) => candidate.id === link.userId && candidate.active);
      if (!user) {
        throw new Error("Linked user is not active.");
      }
      this.upsertDiscordIdentityInPayload(payload, user.id, input);
      payload.discordLinkCodes = payload.discordLinkCodes.filter((candidate) => candidate.code !== normalized);
      return this.authenticatedUser(payload, user);
    });
  }

  consumeSlackLinkCode(code: string, input: {
    slackUserId: string;
    teamId?: string;
    username?: string;
    realName?: string;
  }): AuthenticatedUser {
    return this.mutatePayload((payload) => {
      const normalized = code.trim().toUpperCase();
      const now = Date.now();
      const link = payload.slackLinkCodes.find((candidate) => candidate.code === normalized && new Date(candidate.expiresAt).getTime() > now);
      if (!link) {
        throw new Error("Invalid or expired link code.");
      }
      const user = payload.users.find((candidate) => candidate.id === link.userId && candidate.active);
      if (!user) {
        throw new Error("Linked user is not active.");
      }
      this.upsertSlackIdentityInPayload(payload, user.id, input);
      payload.slackLinkCodes = payload.slackLinkCodes.filter((candidate) => candidate.code !== normalized);
      return this.authenticatedUser(payload, user);
    });
  }

  registerTelegramChat(input: {
    chatId: number;
    title?: string;
    type?: string;
    enabled?: boolean;
    allowedGroupIds?: string[];
  }): TelegramChatAccessRecord {
    return this.mutatePayload((payload) => {
      const now = new Date().toISOString();
      const existing = payload.telegramChats.find((chat) => chat.chatId === input.chatId);
      const allowedGroupIds = normalizeGroupIds(payload, input.allowedGroupIds ?? [], null);
      if (existing) {
        existing.title = input.title ?? existing.title;
        existing.type = input.type ?? existing.type;
        existing.enabled = input.enabled ?? existing.enabled;
        existing.allowedGroupIds = allowedGroupIds;
        existing.updatedAt = now;
        return existing;
      }
      const chat: TelegramChatAccessRecord = {
        id: randomId(),
        chatId: input.chatId,
        title: input.title,
        type: input.type,
        enabled: input.enabled ?? true,
        allowedGroupIds,
        createdAt: now,
        updatedAt: now,
      };
      payload.telegramChats.push(chat);
      return chat;
    });
  }

  updateTelegramChat(id: string, patch: { enabled?: boolean; allowedGroupIds?: string[]; title?: string }): TelegramChatAccessRecord {
    return this.mutatePayload((payload) => {
      const chat = payload.telegramChats.find((candidate) => candidate.id === id);
      if (!chat) {
        throw new Error("Telegram chat not found.");
      }
      if (patch.enabled !== undefined) chat.enabled = patch.enabled;
      if (patch.title !== undefined) chat.title = patch.title;
      if (patch.allowedGroupIds !== undefined) chat.allowedGroupIds = normalizeGroupIds(payload, patch.allowedGroupIds, null);
      chat.updatedAt = new Date().toISOString();
      return chat;
    });
  }

  registerDiscordChannel(input: {
    guildId?: string;
    channelId: string;
    title?: string;
    type?: string;
    enabled?: boolean;
    allowedGroupIds?: string[];
  }): DiscordChannelAccessRecord {
    return this.mutatePayload((payload) => {
      const now = new Date().toISOString();
      const channelId = normalizeDiscordId(input.channelId);
      if (!channelId) {
        throw new Error("Discord channel id is required.");
      }
      const guildId = normalizeDiscordId(input.guildId);
      const existing = payload.discordChannels.find((channel) => channel.channelId === channelId && channel.guildId === guildId);
      const allowedGroupIds = normalizeGroupIds(payload, input.allowedGroupIds ?? [], null);
      if (existing) {
        existing.title = input.title ?? existing.title;
        existing.type = input.type ?? existing.type;
        existing.enabled = input.enabled ?? existing.enabled;
        existing.allowedGroupIds = allowedGroupIds;
        existing.updatedAt = now;
        return existing;
      }
      const channel: DiscordChannelAccessRecord = {
        id: randomId(),
        guildId,
        channelId,
        title: input.title,
        type: input.type,
        enabled: input.enabled ?? true,
        allowedGroupIds,
        createdAt: now,
        updatedAt: now,
      };
      payload.discordChannels.push(channel);
      return channel;
    });
  }

  updateDiscordChannel(id: string, patch: { enabled?: boolean; allowedGroupIds?: string[]; title?: string }): DiscordChannelAccessRecord {
    return this.mutatePayload((payload) => {
      const channel = payload.discordChannels.find((candidate) => candidate.id === id);
      if (!channel) {
        throw new Error("Discord channel not found.");
      }
      if (patch.enabled !== undefined) channel.enabled = patch.enabled;
      if (patch.title !== undefined) channel.title = patch.title;
      if (patch.allowedGroupIds !== undefined) channel.allowedGroupIds = normalizeGroupIds(payload, patch.allowedGroupIds, null);
      channel.updatedAt = new Date().toISOString();
      return channel;
    });
  }

  registerSlackChannel(input: {
    teamId?: string;
    channelId: string;
    title?: string;
    type?: string;
    enabled?: boolean;
    allowedGroupIds?: string[];
  }): SlackChannelAccessRecord {
    return this.mutatePayload((payload) => {
      const now = new Date().toISOString();
      const channelId = normalizeSlackId(input.channelId);
      if (!channelId) {
        throw new Error("Slack channel id is required.");
      }
      const teamId = normalizeSlackId(input.teamId);
      const existing = payload.slackChannels.find((channel) => channel.channelId === channelId && channel.teamId === teamId);
      const allowedGroupIds = normalizeGroupIds(payload, input.allowedGroupIds ?? [], null);
      if (existing) {
        existing.title = input.title ?? existing.title;
        existing.type = input.type ?? existing.type;
        existing.enabled = input.enabled ?? existing.enabled;
        existing.allowedGroupIds = allowedGroupIds;
        existing.updatedAt = now;
        return existing;
      }
      const channel: SlackChannelAccessRecord = {
        id: randomId(),
        teamId,
        channelId,
        title: input.title,
        type: input.type,
        enabled: input.enabled ?? true,
        allowedGroupIds,
        createdAt: now,
        updatedAt: now,
      };
      payload.slackChannels.push(channel);
      return channel;
    });
  }

  updateSlackChannel(id: string, patch: { enabled?: boolean; allowedGroupIds?: string[]; title?: string }): SlackChannelAccessRecord {
    return this.mutatePayload((payload) => {
      const channel = payload.slackChannels.find((candidate) => candidate.id === id);
      if (!channel) {
        throw new Error("Slack channel not found.");
      }
      if (patch.enabled !== undefined) channel.enabled = patch.enabled;
      if (patch.title !== undefined) channel.title = patch.title;
      if (patch.allowedGroupIds !== undefined) channel.allowedGroupIds = normalizeGroupIds(payload, patch.allowedGroupIds, null);
      channel.updatedAt = new Date().toISOString();
      return channel;
    });
  }

  isTelegramChatAllowed(chatId: number | undefined, chatType: string | undefined, user: AuthenticatedUser): boolean {
    if (chatId === undefined) {
      return false;
    }
    if (chatType === "private") {
      return this.canUseTelegramChat(user, chatId);
    }
    const payload = this.readPayload();
    const access = payload.telegramChats.find((chat) => chat.chatId === chatId);
    if (!access?.enabled) {
      return false;
    }
    if (access.allowedGroupIds.length === 0) {
      return this.canUseTelegramChat(user, chatId);
    }
    const userGroupIds = new Set(user.groups.map((group) => group.id));
    return access.allowedGroupIds.some((groupId) => userGroupIds.has(groupId)) && this.canUseTelegramChat(user, chatId);
  }

  isDiscordChannelAllowed(input: { guildId?: string; channelId?: string; isDirectMessage?: boolean }, user: AuthenticatedUser): boolean {
    const channelId = normalizeDiscordId(input.channelId);
    if (!channelId) {
      return false;
    }
    if (input.isDirectMessage) {
      return this.canUseDiscordChannel(user, channelId);
    }
    const guildId = normalizeDiscordId(input.guildId);
    const payload = this.readPayload();
    const access = payload.discordChannels.find((channel) => channel.channelId === channelId && channel.guildId === guildId);
    if (!access?.enabled) {
      return false;
    }
    if (access.allowedGroupIds.length === 0) {
      return this.canUseDiscordChannel(user, channelId);
    }
    const userGroupIds = new Set(user.groups.map((group) => group.id));
    return access.allowedGroupIds.some((groupId) => userGroupIds.has(groupId)) && this.canUseDiscordChannel(user, channelId);
  }

  isSlackChannelAllowed(input: { teamId?: string; channelId?: string; isDirectMessage?: boolean }, user: AuthenticatedUser): boolean {
    const channelId = normalizeSlackId(input.channelId);
    if (!channelId) {
      return false;
    }
    if (input.isDirectMessage) {
      return this.canUseSlackChannel(user, channelId);
    }
    const teamId = normalizeSlackId(input.teamId);
    const payload = this.readPayload();
    const access = payload.slackChannels.find((channel) => channel.channelId === channelId && channel.teamId === teamId);
    if (!access?.enabled) {
      return false;
    }
    if (access.allowedGroupIds.length === 0) {
      return this.canUseSlackChannel(user, channelId);
    }
    const userGroupIds = new Set(user.groups.map((group) => group.id));
    return access.allowedGroupIds.some((groupId) => userGroupIds.has(groupId)) && this.canUseSlackChannel(user, channelId);
  }

  hasPermission(user: AuthenticatedUser | null | undefined, permission: Permission | null | undefined): boolean {
    return Boolean(permission && user?.permissions.includes(permission));
  }

  canUseAgent(user: AuthenticatedUser | null | undefined, agentId: string | undefined): boolean {
    if (!user || !agentId) {
      return true;
    }
    return user.groups.some((group) => group.agentIds.length === 0 || group.agentIds.includes(agentId));
  }

  canUseWorkspace(user: AuthenticatedUser | null | undefined, workspace: string | undefined): boolean {
    if (!user || !workspace) {
      return true;
    }
    const normalizedWorkspace = normalizeWorkspacePath(workspace);
    return user.groups.some((group) => group.workspaceRoots.length === 0 ||
      group.workspaceRoots.some((root) => isPathInside(normalizedWorkspace, normalizeWorkspacePath(root))));
  }

  canUseTelegramChat(user: AuthenticatedUser | null | undefined, chatId: number | undefined): boolean {
    if (!user || chatId === undefined) {
      return true;
    }
    return user.groups.some((group) => group.telegramChatIds.length === 0 || group.telegramChatIds.includes(chatId));
  }

  canUseDiscordChannel(user: AuthenticatedUser | null | undefined, channelId: string | undefined): boolean {
    const normalized = normalizeDiscordId(channelId);
    if (!user || !normalized) {
      return true;
    }
    return user.groups.some((group) => group.discordChannelIds.length === 0 || group.discordChannelIds.includes(normalized));
  }

  canUseSlackChannel(user: AuthenticatedUser | null | undefined, channelId: string | undefined): boolean {
    const normalized = normalizeSlackId(channelId);
    if (!user || !normalized) {
      return true;
    }
    return user.groups.some((group) => group.slackChannelIds.length === 0 || group.slackChannelIds.includes(normalized));
  }

  createGroup(input: {
    name: string;
    description?: string;
    permissions?: string[];
    agentIds?: string[];
    workspaceRoots?: string[];
    telegramChatIds?: number[];
    discordChannelIds?: string[];
    slackChannelIds?: string[];
  }): GroupRecord {
    return this.mutatePayload((payload) => {
      const now = new Date().toISOString();
      const id = slugify(input.name);
      if (!id) {
        throw new Error("Group name is required.");
      }
      if (payload.groups.some((group) => group.id === id)) {
        throw new Error(`Group already exists: ${id}`);
      }
      const group: GroupRecord = {
        id,
        name: input.name.trim(),
        description: input.description?.trim() ?? "",
        permissions: normalizePermissions(input.permissions ?? [], true),
        system: false,
        agentIds: normalizeStringList(input.agentIds ?? []),
        workspaceRoots: normalizeStringList(input.workspaceRoots ?? []),
        telegramChatIds: normalizeNumberList(input.telegramChatIds ?? []),
        discordChannelIds: normalizeStringList(input.discordChannelIds ?? []),
        slackChannelIds: normalizeStringList(input.slackChannelIds ?? []),
        createdAt: now,
        updatedAt: now,
      };
      payload.groups.push(group);
      return group;
    });
  }

  updateGroup(id: string, patch: {
    name?: string;
    description?: string;
    permissions?: string[];
    agentIds?: string[];
    workspaceRoots?: string[];
    telegramChatIds?: number[];
    discordChannelIds?: string[];
    slackChannelIds?: string[];
  }): GroupRecord {
    return this.mutatePayload((payload) => {
      const group = payload.groups.find((candidate) => candidate.id === id);
      if (!group) {
        throw new Error("Group not found.");
      }
      if (group.system && id === ADMIN_GROUP_ID && patch.permissions) {
        group.permissions = ALL_PERMISSIONS_SAFE();
      } else if (patch.permissions !== undefined) {
        group.permissions = normalizePermissions(patch.permissions, true);
      }
      if (!group.system && patch.name !== undefined) group.name = patch.name.trim() || group.name;
      if (patch.description !== undefined) group.description = patch.description.trim();
      if (patch.agentIds !== undefined) group.agentIds = normalizeStringList(patch.agentIds);
      if (patch.workspaceRoots !== undefined) group.workspaceRoots = normalizeStringList(patch.workspaceRoots);
      if (patch.telegramChatIds !== undefined) group.telegramChatIds = normalizeNumberList(patch.telegramChatIds);
      if (patch.discordChannelIds !== undefined) group.discordChannelIds = normalizeStringList(patch.discordChannelIds);
      if (patch.slackChannelIds !== undefined) group.slackChannelIds = normalizeStringList(patch.slackChannelIds);
      group.updatedAt = new Date().toISOString();
      return group;
    });
  }

  private authenticatedUser(payload: PersistedUsers, user: UserRecord): AuthenticatedUser {
    const groups = this.groupsForUser(payload, user.id);
    const permissions = Array.from(new Set(groups.flatMap((group) => group.permissions)));
    return { user, groups, permissions };
  }

  private groupIdsForUser(payload: PersistedUsers, userId: string): string[] {
    return payload.userGroups.filter((item) => item.userId === userId).map((item) => item.groupId);
  }

  private groupsForUser(payload: PersistedUsers, userId: string): GroupRecord[] {
    const groupIds = new Set(this.groupIdsForUser(payload, userId));
    return payload.groups.filter((group) => groupIds.has(group.id));
  }

  private upsertTelegramIdentityInPayload(payload: PersistedUsers, userId: string, input: {
    telegramUserId: number;
    username?: string;
    firstName?: string;
    lastName?: string;
  }): TelegramIdentityRecord {
    if (!Number.isInteger(input.telegramUserId) || input.telegramUserId <= 0) {
      throw new Error("Telegram user id must be a positive integer.");
    }
    const now = new Date().toISOString();
    for (const identity of payload.telegramIdentities) {
      if (identity.telegramUserId === input.telegramUserId && identity.userId !== userId) {
        identity.active = false;
      }
    }
    const existing = payload.telegramIdentities.find((identity) => identity.userId === userId && identity.telegramUserId === input.telegramUserId);
    if (existing) {
      existing.username = input.username ?? existing.username;
      existing.firstName = input.firstName ?? existing.firstName;
      existing.lastName = input.lastName ?? existing.lastName;
      existing.active = true;
      existing.updatedAt = now;
      return existing;
    }
    const identity: TelegramIdentityRecord = {
      id: randomId(),
      userId,
      telegramUserId: input.telegramUserId,
      username: input.username,
      firstName: input.firstName,
      lastName: input.lastName,
      active: true,
      linkedAt: now,
      updatedAt: now,
    };
    payload.telegramIdentities.push(identity);
    return identity;
  }

  private upsertDiscordIdentityInPayload(payload: PersistedUsers, userId: string, input: {
    discordUserId: string;
    username?: string;
    globalName?: string;
  }): DiscordIdentityRecord {
    const discordUserId = normalizeDiscordId(input.discordUserId);
    if (!discordUserId) {
      throw new Error("Discord user id is required.");
    }
    const now = new Date().toISOString();
    for (const identity of payload.discordIdentities) {
      if (identity.discordUserId === discordUserId && identity.userId !== userId) {
        identity.active = false;
      }
    }
    const existing = payload.discordIdentities.find((identity) => identity.userId === userId && identity.discordUserId === discordUserId);
    if (existing) {
      existing.username = input.username ?? existing.username;
      existing.globalName = input.globalName ?? existing.globalName;
      existing.active = true;
      existing.updatedAt = now;
      return existing;
    }
    const identity: DiscordIdentityRecord = {
      id: randomId(),
      userId,
      discordUserId,
      username: input.username,
      globalName: input.globalName,
      active: true,
      linkedAt: now,
      updatedAt: now,
    };
    payload.discordIdentities.push(identity);
    return identity;
  }

  private upsertSlackIdentityInPayload(payload: PersistedUsers, userId: string, input: {
    slackUserId: string;
    teamId?: string;
    username?: string;
    realName?: string;
  }): SlackIdentityRecord {
    const slackUserId = normalizeSlackId(input.slackUserId);
    if (!slackUserId) {
      throw new Error("Slack user id is required.");
    }
    const teamId = normalizeSlackId(input.teamId);
    const now = new Date().toISOString();
    for (const identity of payload.slackIdentities) {
      if (identity.slackUserId === slackUserId && (identity.teamId ?? "") === (teamId ?? "") && identity.userId !== userId) {
        identity.active = false;
      }
    }
    const existing = payload.slackIdentities.find((identity) =>
      identity.userId === userId &&
      identity.slackUserId === slackUserId &&
      (identity.teamId ?? "") === (teamId ?? "")
    );
    if (existing) {
      existing.username = input.username ?? existing.username;
      existing.realName = input.realName ?? existing.realName;
      existing.active = true;
      existing.updatedAt = now;
      return existing;
    }
    const identity: SlackIdentityRecord = {
      id: randomId(),
      userId,
      slackUserId,
      teamId,
      username: input.username,
      realName: input.realName,
      active: true,
      linkedAt: now,
      updatedAt: now,
    };
    payload.slackIdentities.push(identity);
    return identity;
  }

  private pruneExpiredSessionsInPayload(payload: PersistedUsers): void {
    const now = Date.now();
    payload.webSessions = payload.webSessions.filter((session) => new Date(session.expiresAt).getTime() > now);
  }

  private revokeUserSessionsInPayload(payload: PersistedUsers, userId: string): void {
    payload.webSessions = payload.webSessions.filter((session) => session.userId !== userId);
  }

  private mutatePayload<T>(updater: (payload: PersistedUsers) => T): T {
    return this.withWriteLock(() => {
      const payload = this.readPayload();
      const result = updater(payload);
      this.writePayload(payload);
      return result;
    });
  }

  private withWriteLock<T>(operation: () => T): T {
    const lockPath = `${this.filePath}.lock`;
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const deadline = Date.now() + WRITE_LOCK_TIMEOUT_MS;
    let fd: number | undefined;
    for (;;) {
      try {
        fd = openSync(lockPath, "wx");
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw error;
        }
        try {
          const stat = statSync(lockPath);
          if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
            rmSync(lockPath, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error("User store is busy. Try again shortly.");
        }
        sleepSync(25);
      }
    }
    try {
      return operation();
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
      rmSync(lockPath, { force: true });
    }
  }

  private readPayload(): PersistedUsers {
    const payload = readJsonFileWithBackup<PersistedUsers>(this.filePath).value;
    return normalizePayload(payload);
  }

  private writePayload(payload: PersistedUsers): void {
    writeJsonFileAtomic(this.filePath, normalizePayload(payload));
  }
}

export function publicUser(user: UserRecord): Omit<UserRecord, "passwordHash" | "passwordSalt"> {
  const { passwordHash: _passwordHash, passwordSalt: _passwordSalt, ...rest } = user;
  return rest;
}

export function publicWebSession(session: WebSessionRecord): PublicWebSessionRecord {
  const { tokenHash: _tokenHash, ...rest } = session;
  return rest;
}

export function publicUserSnapshot(snapshot: UserManagementSnapshot) {
  return {
    ...snapshot,
    users: snapshot.users.map((user) => {
      const { passwordHash: _passwordHash, passwordSalt: _passwordSalt, ...rest } = user;
      return rest;
    }),
  };
}
