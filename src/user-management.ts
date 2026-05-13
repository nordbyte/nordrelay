import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  ADMIN_GROUP_ID,
  BUILTIN_GROUPS,
  READONLY_GROUP_ID,
  USER_GROUP_ID,
  type GroupDefinition,
  type Permission,
  isPermission,
} from "./access-control.js";
import { readJsonFileWithBackup, writeJsonFileAtomic } from "./persistence.js";

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
}

export interface GroupRecord extends GroupDefinition {
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
}

export interface TelegramLinkCodeRecord {
  code: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface AuthenticatedUser {
  user: UserRecord;
  groups: GroupRecord[];
  permissions: Permission[];
}

export interface UserManagementSnapshot {
  users: Array<UserRecord & { groups: GroupRecord[]; telegramIdentities: TelegramIdentityRecord[] }>;
  groups: GroupRecord[];
  telegramChats: TelegramChatAccessRecord[];
  adminConfigured: boolean;
}

interface PersistedUsers {
  version: 1;
  users: UserRecord[];
  groups: GroupRecord[];
  userGroups: UserGroupRecord[];
  telegramIdentities: TelegramIdentityRecord[];
  telegramChats: TelegramChatAccessRecord[];
  webSessions: WebSessionRecord[];
  telegramLinkCodes: TelegramLinkCodeRecord[];
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const PASSWORD_KEYLEN = 64;

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
      })),
      groups: payload.groups,
      telegramChats: payload.telegramChats,
      adminConfigured: payload.users.some((user) => user.active && this.groupIdsForUser(payload, user.id).includes(ADMIN_GROUP_ID)),
    };
  }

  listGroups(): GroupRecord[] {
    return this.readPayload().groups;
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
  }): AuthenticatedUser {
    const payload = this.readPayload();
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
    this.writePayload(payload);
    return this.authenticatedUser(payload, user);
  }

  createAdmin(input: {
    email: string;
    displayName: string;
    password: string;
    telegramUserId?: number;
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
    const payload = this.readPayload();
    const user = payload.users.find((candidate) => candidate.id === id);
    if (!user) {
      throw new Error("User not found.");
    }
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
    user.updatedAt = new Date().toISOString();
    this.writePayload(payload);
    return this.authenticatedUser(payload, user);
  }

  setPassword(id: string, password: string): void {
    const payload = this.readPayload();
    const user = payload.users.find((candidate) => candidate.id === id);
    if (!user) {
      throw new Error("User not found.");
    }
    const next = hashPassword(password);
    user.passwordHash = next.hash;
    user.passwordSalt = next.salt;
    user.updatedAt = new Date().toISOString();
    this.revokeUserSessionsInPayload(payload, id);
    this.writePayload(payload);
  }

  verifyPassword(email: string, password: string): AuthenticatedUser | null {
    const payload = this.readPayload();
    const user = payload.users.find((candidate) => candidate.email === normalizeEmail(email));
    if (!user || !user.active || !verifyPasswordHash(password, user.passwordSalt, user.passwordHash)) {
      return null;
    }
    user.lastLoginAt = new Date().toISOString();
    user.updatedAt = user.lastLoginAt;
    this.writePayload(payload);
    return this.authenticatedUser(payload, user);
  }

  createWebSession(userId: string): { token: string; session: WebSessionRecord } {
    const payload = this.readPayload();
    const user = payload.users.find((candidate) => candidate.id === userId && candidate.active);
    if (!user) {
      throw new Error("Active user not found.");
    }
    const token = randomBytes(32).toString("hex");
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
    this.writePayload(payload);
    return { token, session };
  }

  resolveWebSession(token: string | undefined): AuthenticatedUser | null {
    if (!token) {
      return null;
    }
    const payload = this.readPayload();
    this.pruneExpiredSessionsInPayload(payload);
    const tokenHash = hashToken(token);
    const session = payload.webSessions.find((candidate) => constantTimeStringEqual(candidate.tokenHash, tokenHash));
    if (!session) {
      this.writePayload(payload);
      return null;
    }
    const user = payload.users.find((candidate) => candidate.id === session.userId && candidate.active);
    if (!user) {
      payload.webSessions = payload.webSessions.filter((candidate) => candidate.id !== session.id);
      this.writePayload(payload);
      return null;
    }
    session.lastSeenAt = new Date().toISOString();
    this.writePayload(payload);
    return this.authenticatedUser(payload, user);
  }

  destroyWebSession(token: string | undefined): void {
    if (!token) {
      return;
    }
    const payload = this.readPayload();
    const tokenHash = hashToken(token);
    payload.webSessions = payload.webSessions.filter((session) => !constantTimeStringEqual(session.tokenHash, tokenHash));
    this.writePayload(payload);
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

  linkTelegramUser(userId: string, input: {
    telegramUserId: number;
    username?: string;
    firstName?: string;
    lastName?: string;
  }): TelegramIdentityRecord {
    const payload = this.readPayload();
    const user = payload.users.find((candidate) => candidate.id === userId);
    if (!user) {
      throw new Error("User not found.");
    }
    const identity = this.upsertTelegramIdentityInPayload(payload, userId, input);
    this.writePayload(payload);
    return identity;
  }

  unlinkTelegramIdentity(identityId: string): boolean {
    const payload = this.readPayload();
    const before = payload.telegramIdentities.length;
    payload.telegramIdentities = payload.telegramIdentities.filter((identity) => identity.id !== identityId);
    this.writePayload(payload);
    return payload.telegramIdentities.length !== before;
  }

  createTelegramLinkCode(userId: string): TelegramLinkCodeRecord {
    const payload = this.readPayload();
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
    this.writePayload(payload);
    return code;
  }

  consumeTelegramLinkCode(code: string, input: {
    telegramUserId: number;
    username?: string;
    firstName?: string;
    lastName?: string;
  }): AuthenticatedUser {
    const payload = this.readPayload();
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
    this.writePayload(payload);
    return this.authenticatedUser(payload, user);
  }

  registerTelegramChat(input: {
    chatId: number;
    title?: string;
    type?: string;
    enabled?: boolean;
    allowedGroupIds?: string[];
  }): TelegramChatAccessRecord {
    const payload = this.readPayload();
    const now = new Date().toISOString();
    const existing = payload.telegramChats.find((chat) => chat.chatId === input.chatId);
    const allowedGroupIds = normalizeGroupIds(payload, input.allowedGroupIds ?? [], null);
    if (existing) {
      existing.title = input.title ?? existing.title;
      existing.type = input.type ?? existing.type;
      existing.enabled = input.enabled ?? existing.enabled;
      existing.allowedGroupIds = allowedGroupIds;
      existing.updatedAt = now;
      this.writePayload(payload);
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
    this.writePayload(payload);
    return chat;
  }

  updateTelegramChat(id: string, patch: { enabled?: boolean; allowedGroupIds?: string[]; title?: string }): TelegramChatAccessRecord {
    const payload = this.readPayload();
    const chat = payload.telegramChats.find((candidate) => candidate.id === id);
    if (!chat) {
      throw new Error("Telegram chat not found.");
    }
    if (patch.enabled !== undefined) chat.enabled = patch.enabled;
    if (patch.title !== undefined) chat.title = patch.title;
    if (patch.allowedGroupIds !== undefined) chat.allowedGroupIds = normalizeGroupIds(payload, patch.allowedGroupIds, null);
    chat.updatedAt = new Date().toISOString();
    this.writePayload(payload);
    return chat;
  }

  isTelegramChatAllowed(chatId: number | undefined, chatType: string | undefined, user: AuthenticatedUser): boolean {
    if (chatId === undefined) {
      return false;
    }
    if (chatType === "private") {
      return true;
    }
    const payload = this.readPayload();
    const access = payload.telegramChats.find((chat) => chat.chatId === chatId);
    if (!access?.enabled) {
      return false;
    }
    if (access.allowedGroupIds.length === 0) {
      return true;
    }
    const userGroupIds = new Set(user.groups.map((group) => group.id));
    return access.allowedGroupIds.some((groupId) => userGroupIds.has(groupId));
  }

  hasPermission(user: AuthenticatedUser | null | undefined, permission: Permission): boolean {
    return Boolean(user?.permissions.includes(permission));
  }

  createGroup(input: { name: string; description?: string; permissions?: string[] }): GroupRecord {
    const payload = this.readPayload();
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
      permissions: normalizePermissions(input.permissions ?? []),
      system: false,
      createdAt: now,
      updatedAt: now,
    };
    payload.groups.push(group);
    this.writePayload(payload);
    return group;
  }

  updateGroup(id: string, patch: { name?: string; description?: string; permissions?: string[] }): GroupRecord {
    const payload = this.readPayload();
    const group = payload.groups.find((candidate) => candidate.id === id);
    if (!group) {
      throw new Error("Group not found.");
    }
    if (group.system && id === ADMIN_GROUP_ID && patch.permissions) {
      group.permissions = ALL_PERMISSIONS_SAFE();
    } else if (patch.permissions !== undefined) {
      group.permissions = normalizePermissions(patch.permissions);
    }
    if (!group.system && patch.name !== undefined) group.name = patch.name.trim() || group.name;
    if (patch.description !== undefined) group.description = patch.description.trim();
    group.updatedAt = new Date().toISOString();
    this.writePayload(payload);
    return group;
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

  private pruneExpiredSessionsInPayload(payload: PersistedUsers): void {
    const now = Date.now();
    payload.webSessions = payload.webSessions.filter((session) => new Date(session.expiresAt).getTime() > now);
  }

  private revokeUserSessionsInPayload(payload: PersistedUsers, userId: string): void {
    payload.webSessions = payload.webSessions.filter((session) => session.userId !== userId);
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

export function publicUserSnapshot(snapshot: UserManagementSnapshot) {
  return {
    ...snapshot,
    users: snapshot.users.map((user) => {
      const { passwordHash: _passwordHash, passwordSalt: _passwordSalt, ...rest } = user;
      return rest;
    }),
  };
}

function normalizePayload(payload: PersistedUsers | undefined): PersistedUsers {
  const now = new Date().toISOString();
  const groupsById = new Map<string, GroupRecord>();
  for (const group of BUILTIN_GROUPS) {
    groupsById.set(group.id, {
      ...group,
      permissions: group.id === ADMIN_GROUP_ID ? ALL_PERMISSIONS_SAFE() : group.permissions,
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const group of payload?.groups ?? []) {
    if (!isGroupRecord(group)) continue;
    groupsById.set(group.id, {
      ...group,
      permissions: group.id === ADMIN_GROUP_ID ? ALL_PERMISSIONS_SAFE() : normalizePermissions(group.permissions),
      system: BUILTIN_GROUPS.some((builtin) => builtin.id === group.id) || group.system,
    });
  }
  const groups = Array.from(groupsById.values());
  const groupIds = new Set(groups.map((group) => group.id));
  const users = (payload?.users ?? []).filter(isUserRecord);
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
    webSessions: (payload?.webSessions ?? []).filter((item) => isWebSessionRecord(item) && userIds.has(item.userId)),
    telegramLinkCodes: (payload?.telegramLinkCodes ?? []).filter((item) => isTelegramLinkCodeRecord(item) && userIds.has(item.userId)),
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeGroupIds(payload: PersistedUsers, values: string[], emptyFallback: string | null = READONLY_GROUP_ID): string[] {
  const available = new Set(payload.groups.map((group) => group.id));
  const groupIds = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  for (const groupId of groupIds) {
    if (!available.has(groupId)) {
      throw new Error(`Unknown group: ${groupId}`);
    }
  }
  return groupIds.length > 0 ? groupIds : (emptyFallback ? [emptyFallback] : []);
}

function normalizePermissions(values: string[]): Permission[] {
  const permissions: Permission[] = [];
  for (const value of values) {
    if (isPermission(value) && !permissions.includes(value)) {
      permissions.push(value);
    }
  }
  return permissions;
}

function hashPassword(password: string): { salt: string; hash: string } {
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, PASSWORD_KEYLEN).toString("hex");
  return { salt, hash };
}

function verifyPasswordHash(password: string, salt: string, expectedHash: string): boolean {
  const actual = scryptSync(password, salt, PASSWORD_KEYLEN);
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function randomId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function randomLinkCode(): string {
  return `NR-${randomBytes(4).toString("hex").toUpperCase()}`;
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function ALL_PERMISSIONS_SAFE(): Permission[] {
  return [...BUILTIN_GROUPS.find((group) => group.id === ADMIN_GROUP_ID)!.permissions];
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
