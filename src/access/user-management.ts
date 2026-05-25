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
  normalizeMatrixId,
  normalizeNumberList,
  normalizeArtifactDeliveryMode,
  normalizePayload,
  normalizePermissions,
  normalizeSlackId,
  normalizeStringList,
  normalizeUserPreferences,
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
import { generateRecoveryCodes, generateTotpSecret, totpUri, verifyTotpCode } from "./mfa.js";
import type {
  ApiTokenRecord,
  AuthenticatedUser,
  DiscordChannelAccessRecord,
  DiscordIdentityRecord,
  DiscordLinkCodeRecord,
  GroupRecord,
  MatrixIdentityRecord,
  MatrixLinkCodeRecord,
  MatrixRoomAccessRecord,
  PersistedUsers,
  PublicApiTokenRecord,
  PublicWebSessionRecord,
  PublicWebAuthnCredentialRecord,
  RecoveryCodeRecord,
  SlackChannelAccessRecord,
  SlackIdentityRecord,
  SlackLinkCodeRecord,
  TelegramChatAccessRecord,
  TelegramIdentityRecord,
  TelegramLinkCodeRecord,
  TotpCredentialRecord,
  UserGroupRecord,
  UserManagementSnapshot,
  UserPreferences,
  UserRecord,
  WebAuthnCredentialRecord,
  WebSessionRecord,
} from "./user-management-types.js";

export type {
  AuthenticatedUser,
  DiscordChannelAccessRecord,
  DiscordIdentityRecord,
  DiscordLinkCodeRecord,
  GroupRecord,
  MatrixIdentityRecord,
  MatrixLinkCodeRecord,
  MatrixRoomAccessRecord,
  PersistedUsers,
  PublicApiTokenRecord,
  PublicWebSessionRecord,
  PublicWebAuthnCredentialRecord,
  RecoveryCodeRecord,
  SlackChannelAccessRecord,
  SlackIdentityRecord,
  SlackLinkCodeRecord,
  TelegramChatAccessRecord,
  TelegramIdentityRecord,
  TelegramLinkCodeRecord,
  TotpCredentialRecord,
  UserGroupRecord,
  UserManagementSnapshot,
  UserPreferences,
  UserRecord,
  WebAuthnCredentialRecord,
  WebSessionRecord,
} from "./user-management-types.js";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const API_TOKEN_BYTES = 32;
const WRITE_LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

type UserPreferencePatch = {
  theme?: UserPreferences["theme"] | null;
  artifactDelivery?: UserPreferences["artifactDelivery"] | string | null;
};

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
        matrixIdentities: payload.matrixIdentities.filter((identity) => identity.userId === user.id),
        webSessions: payload.webSessions
          .filter((session) => session.userId === user.id)
          .map(publicWebSession),
        mfa: {
          totpEnabled: payload.totpCredentials.some((credential) => credential.userId === user.id),
          recoveryCodesRemaining: payload.recoveryCodes.filter((code) => code.userId === user.id && !code.usedAt).length,
          webAuthnCredentials: payload.webAuthnCredentials
            .filter((credential) => credential.userId === user.id)
            .map(publicWebAuthnCredential),
        },
        apiTokens: payload.apiTokens
          .filter((token) => token.userId === user.id)
          .map(publicApiToken),
      })),
      groups: payload.groups,
      telegramChats: payload.telegramChats,
      discordChannels: payload.discordChannels,
      slackChannels: payload.slackChannels,
      matrixRooms: payload.matrixRooms,
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
    matrixUserId?: string;
    matrixHomeserver?: string;
    preferences?: UserPreferencePatch;
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
      user.preferences = mergeUserPreferences(undefined, input.preferences);
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
      if (input.matrixUserId !== undefined) {
        this.upsertMatrixIdentityInPayload(payload, user.id, {
          matrixUserId: input.matrixUserId,
          homeserver: input.matrixHomeserver,
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
    matrixUserId?: string;
    matrixHomeserver?: string;
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
    preferences?: UserPreferencePatch;
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
      if (patch.preferences !== undefined) {
        user.preferences = mergeUserPreferences(user.preferences, patch.preferences);
      }
      assertActiveAdminExists(payload);
      if (shouldRevokeSessions) {
        this.revokeUserSessionsInPayload(payload, id);
      }
      user.updatedAt = new Date().toISOString();
      return this.authenticatedUser(payload, user);
    });
  }

  updateProfile(id: string, patch: {
    displayName?: string;
    preferences?: UserPreferencePatch;
  }): AuthenticatedUser {
    return this.mutatePayload((payload) => {
      const user = payload.users.find((candidate) => candidate.id === id);
      if (!user) {
        throw new Error("User not found.");
      }
      if (patch.displayName !== undefined) {
        user.displayName = patch.displayName.trim() || user.email;
      }
      if (patch.preferences !== undefined) {
        user.preferences = mergeUserPreferences(user.preferences, patch.preferences);
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

  changePassword(id: string, currentPassword: string, nextPassword: string, keepSessionId?: string): void {
    this.mutatePayload((payload) => {
      const user = payload.users.find((candidate) => candidate.id === id && candidate.active);
      if (!user) {
        throw new Error("User not found.");
      }
      if (!verifyPasswordHash(currentPassword, user.passwordSalt, user.passwordHash)) {
        throw new Error("Current password is incorrect.");
      }
      const next = hashPassword(nextPassword);
      user.passwordHash = next.hash;
      user.passwordSalt = next.salt;
      user.updatedAt = new Date().toISOString();
      this.revokeUserSessionsInPayload(payload, id, keepSessionId);
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

  authenticatedUserById(userId: string): AuthenticatedUser | null {
    const payload = this.readPayload();
    const user = payload.users.find((candidate) => candidate.id === userId && candidate.active);
    return user ? this.authenticatedUser(payload, user) : null;
  }

  createWebSession(userId: string, metadata: Partial<Pick<WebSessionRecord, "userAgent" | "ipAddress" | "deviceName" | "mfaVerified" | "apiTokenId">> = {}): { token: string; session: WebSessionRecord } {
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
        userAgent: metadata.userAgent,
        ipAddress: metadata.ipAddress,
        deviceName: metadata.deviceName,
        mfaVerified: Boolean(metadata.mfaVerified),
        apiTokenId: metadata.apiTokenId,
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

  revokeOtherUserSessions(userId: string, keepSessionId?: string): number {
    return this.mutatePayload((payload) => {
      const before = payload.webSessions.length;
      this.revokeUserSessionsInPayload(payload, userId, keepSessionId);
      return before - payload.webSessions.length;
    });
  }

  webSessionForToken(token: string | undefined): PublicWebSessionRecord | null {
    if (!token) {
      return null;
    }
    const payload = this.readPayload();
    const tokenHash = hashToken(token);
    const session = payload.webSessions.find((candidate) =>
      constantTimeStringEqual(candidate.tokenHash, tokenHash) &&
      new Date(candidate.expiresAt).getTime() > Date.now()
    );
    return session ? publicWebSession(session) : null;
  }

  mfaStatus(userId: string): {
    totpEnabled: boolean;
    recoveryCodesRemaining: number;
    webAuthnCredentials: PublicWebAuthnCredentialRecord[];
  } {
    const payload = this.readPayload();
    return this.mfaStatusInPayload(payload, userId);
  }

  setupTotp(userId: string, accountName?: string): { secret: string; otpauthUrl: string } {
    const payload = this.readPayload();
    const user = payload.users.find((candidate) => candidate.id === userId && candidate.active);
    if (!user) throw new Error("Active user not found.");
    const secret = generateTotpSecret();
    return {
      secret,
      otpauthUrl: totpUri({ issuer: "NordRelay", accountName: accountName || user.email, secret }),
    };
  }

  enableTotp(userId: string, secret: string, code: string): { recoveryCodes: string[]; status: ReturnType<UserStore["mfaStatus"]> } {
    return this.mutatePayload((payload) => {
      const user = payload.users.find((candidate) => candidate.id === userId && candidate.active);
      if (!user) throw new Error("Active user not found.");
      const verified = verifyTotpCode({ secret, code, window: 1 });
      if (!verified.ok || verified.step === undefined) {
        throw new Error("Invalid authenticator code.");
      }
      const now = new Date().toISOString();
      const credential: TotpCredentialRecord = {
        userId,
        secret,
        enabledAt: now,
        lastUsedStep: verified.step,
      };
      payload.totpCredentials = payload.totpCredentials.filter((item) => item.userId !== userId);
      payload.totpCredentials.push(credential);
      const recoveryCodes = this.replaceRecoveryCodesInPayload(payload, userId);
      user.updatedAt = now;
      return { recoveryCodes, status: this.mfaStatusInPayload(payload, userId) };
    });
  }

  disableTotp(userId: string): ReturnType<UserStore["mfaStatus"]> {
    return this.mutatePayload((payload) => {
      payload.totpCredentials = payload.totpCredentials.filter((item) => item.userId !== userId);
      payload.recoveryCodes = payload.recoveryCodes.filter((item) => item.userId !== userId);
      const user = payload.users.find((candidate) => candidate.id === userId);
      if (user) user.updatedAt = new Date().toISOString();
      return this.mfaStatusInPayload(payload, userId);
    });
  }

  verifyMfaCode(userId: string, code: string): "totp" | "recovery" | null {
    return this.mutatePayload((payload) => {
      const user = payload.users.find((candidate) => candidate.id === userId && candidate.active);
      if (!user) return null;
      const totp = payload.totpCredentials.find((credential) => credential.userId === userId);
      if (totp) {
        const verified = verifyTotpCode({
          secret: totp.secret,
          code,
          window: 1,
          lastUsedStep: totp.lastUsedStep,
        });
        if (verified.ok && verified.step !== undefined) {
          totp.lastUsedStep = verified.step;
          return "totp";
        }
      }
      const normalized = normalizeRecoveryCode(code);
      if (!normalized) return null;
      const hash = hashToken(normalized);
      const recovery = payload.recoveryCodes.find((candidate) =>
        candidate.userId === userId &&
        !candidate.usedAt &&
        constantTimeStringEqual(candidate.codeHash, hash)
      );
      if (!recovery) return null;
      recovery.usedAt = new Date().toISOString();
      return "recovery";
    });
  }

  regenerateRecoveryCodes(userId: string): { recoveryCodes: string[]; status: ReturnType<UserStore["mfaStatus"]> } {
    return this.mutatePayload((payload) => {
      if (!payload.users.some((candidate) => candidate.id === userId && candidate.active)) {
        throw new Error("Active user not found.");
      }
      const recoveryCodes = this.replaceRecoveryCodesInPayload(payload, userId);
      return { recoveryCodes, status: this.mfaStatusInPayload(payload, userId) };
    });
  }

  addWebAuthnCredential(userId: string, input: {
    credentialId: string;
    publicKey: string;
    counter: number;
    transports?: string[];
    name?: string;
    deviceType?: string;
    backedUp?: boolean;
  }): WebAuthnCredentialRecord {
    return this.mutatePayload((payload) => {
      if (!payload.users.some((candidate) => candidate.id === userId && candidate.active)) {
        throw new Error("Active user not found.");
      }
      const now = new Date().toISOString();
      payload.webAuthnCredentials = payload.webAuthnCredentials.filter((credential) => credential.credentialId !== input.credentialId);
      const credential: WebAuthnCredentialRecord = {
        id: randomId(),
        userId,
        credentialId: input.credentialId,
        publicKey: input.publicKey,
        counter: input.counter,
        transports: normalizeStringList(input.transports ?? []),
        name: input.name?.trim() || "Passkey",
        deviceType: input.deviceType,
        backedUp: input.backedUp,
        createdAt: now,
      };
      payload.webAuthnCredentials.push(credential);
      return credential;
    });
  }

  listWebAuthnCredentials(userId?: string): WebAuthnCredentialRecord[] {
    const payload = this.readPayload();
    return payload.webAuthnCredentials.filter((credential) => !userId || credential.userId === userId);
  }

  getWebAuthnCredential(credentialId: string): WebAuthnCredentialRecord | null {
    return this.readPayload().webAuthnCredentials.find((credential) => credential.credentialId === credentialId || credential.id === credentialId) ?? null;
  }

  updateWebAuthnCredentialUse(credentialId: string, counter: number): WebAuthnCredentialRecord | null {
    return this.mutatePayload((payload) => {
      const credential = payload.webAuthnCredentials.find((candidate) => candidate.credentialId === credentialId || candidate.id === credentialId);
      if (!credential) return null;
      credential.counter = counter;
      credential.lastUsedAt = new Date().toISOString();
      return credential;
    });
  }

  deleteWebAuthnCredential(userId: string, credentialId: string): boolean {
    return this.mutatePayload((payload) => {
      const before = payload.webAuthnCredentials.length;
      payload.webAuthnCredentials = payload.webAuthnCredentials.filter((credential) =>
        !(credential.userId === userId && (credential.id === credentialId || credential.credentialId === credentialId))
      );
      return payload.webAuthnCredentials.length !== before;
    });
  }

  createApiToken(userId: string, input: {
    name: string;
    permissions?: string[];
    agentIds?: string[];
    workspaceRoots?: string[];
    peerIds?: string[];
    expiresAt?: string;
  }): { token: string; record: PublicApiTokenRecord } {
    return this.mutatePayload((payload) => {
      if (!payload.users.some((candidate) => candidate.id === userId && candidate.active)) {
        throw new Error("Active user not found.");
      }
      const raw = `nrp_${randomSessionToken()}${randomSessionToken().slice(0, API_TOKEN_BYTES)}`;
      const now = new Date().toISOString();
      const permissions = normalizePermissions(input.permissions ?? [], true);
      if (permissions.length === 0) {
        throw new Error("At least one API token permission is required.");
      }
      const record: ApiTokenRecord = {
        id: randomId(),
        userId,
        name: input.name.trim() || "API token",
        tokenHash: hashToken(raw),
        tokenPrefix: raw.slice(0, 12),
        permissions,
        agentIds: normalizeStringList(input.agentIds ?? []),
        workspaceRoots: normalizeStringList(input.workspaceRoots ?? []),
        peerIds: normalizeStringList(input.peerIds ?? []),
        createdAt: now,
        expiresAt: normalizeFutureIso(input.expiresAt),
      };
      payload.apiTokens.push(record);
      return { token: raw, record: publicApiToken(record) };
    });
  }

  revokeApiToken(userId: string, tokenId: string): boolean {
    return this.mutatePayload((payload) => {
      const token = payload.apiTokens.find((candidate) => candidate.userId === userId && candidate.id === tokenId);
      if (!token || token.revokedAt) return false;
      token.revokedAt = new Date().toISOString();
      return true;
    });
  }

  resolveApiToken(token: string | undefined): AuthenticatedUser | null {
    if (!token) return null;
    return this.mutatePayload((payload) => {
      const tokenHash = hashToken(token);
      const now = Date.now();
      const record = payload.apiTokens.find((candidate) =>
        !candidate.revokedAt &&
        (!candidate.expiresAt || Date.parse(candidate.expiresAt) > now) &&
        constantTimeStringEqual(candidate.tokenHash, tokenHash)
      );
      if (!record) return null;
      const user = payload.users.find((candidate) => candidate.id === record.userId && candidate.active);
      if (!user) return null;
      record.lastUsedAt = new Date(now).toISOString();
      const auth = this.authenticatedUser(payload, user);
      return {
        ...auth,
        permissions: auth.permissions.filter((permission) => record.permissions.includes(permission)),
        apiToken: publicApiToken(record),
      };
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

  resolveMatrixUser(input: { matrixUserId?: string; homeserver?: string }): AuthenticatedUser | null {
    const matrixUserId = normalizeMatrixId(input.matrixUserId);
    if (!matrixUserId) {
      return null;
    }
    const homeserver = normalizeMatrixId(input.homeserver);
    const payload = this.readPayload();
    const identity = payload.matrixIdentities.find((candidate) =>
      candidate.matrixUserId === matrixUserId &&
      candidate.active &&
      (!homeserver || !candidate.homeserver || candidate.homeserver === homeserver)
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

  linkMatrixUser(userId: string, input: {
    matrixUserId: string;
    homeserver?: string;
    displayName?: string;
  }): MatrixIdentityRecord {
    return this.mutatePayload((payload) => {
      const user = payload.users.find((candidate) => candidate.id === userId);
      if (!user) {
        throw new Error("User not found.");
      }
      return this.upsertMatrixIdentityInPayload(payload, userId, input);
    });
  }

  unlinkMatrixIdentity(identityId: string): boolean {
    return this.mutatePayload((payload) => {
      const before = payload.matrixIdentities.length;
      payload.matrixIdentities = payload.matrixIdentities.filter((identity) => identity.id !== identityId);
      return payload.matrixIdentities.length !== before;
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

  createMatrixLinkCode(userId: string): MatrixLinkCodeRecord {
    return this.mutatePayload((payload) => {
      if (!payload.users.some((user) => user.id === userId && user.active)) {
        throw new Error("Active user not found.");
      }
      const now = Date.now();
      payload.matrixLinkCodes = payload.matrixLinkCodes.filter((code) => new Date(code.expiresAt).getTime() > now);
      const code: MatrixLinkCodeRecord = {
        code: randomLinkCode(),
        userId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + LINK_CODE_TTL_MS).toISOString(),
      };
      payload.matrixLinkCodes.push(code);
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

  consumeMatrixLinkCode(code: string, input: {
    matrixUserId: string;
    homeserver?: string;
    displayName?: string;
  }): AuthenticatedUser {
    return this.mutatePayload((payload) => {
      const normalized = code.trim().toUpperCase();
      const now = Date.now();
      const link = payload.matrixLinkCodes.find((candidate) => candidate.code === normalized && new Date(candidate.expiresAt).getTime() > now);
      if (!link) {
        throw new Error("Invalid or expired link code.");
      }
      const user = payload.users.find((candidate) => candidate.id === link.userId && candidate.active);
      if (!user) {
        throw new Error("Linked user is not active.");
      }
      this.upsertMatrixIdentityInPayload(payload, user.id, input);
      payload.matrixLinkCodes = payload.matrixLinkCodes.filter((candidate) => candidate.code !== normalized);
      return this.authenticatedUser(payload, user);
    });
  }

  registerTelegramChat(input: {
    chatId: number;
    title?: string;
    type?: string;
    enabled?: boolean;
    allowedGroupIds?: string[];
    artifactDelivery?: string;
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
        existing.artifactDelivery = normalizeArtifactDeliveryMode(input.artifactDelivery) ?? existing.artifactDelivery;
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
        artifactDelivery: normalizeArtifactDeliveryMode(input.artifactDelivery),
        createdAt: now,
        updatedAt: now,
      };
      payload.telegramChats.push(chat);
      return chat;
    });
  }

  updateTelegramChat(id: string, patch: { enabled?: boolean; allowedGroupIds?: string[]; title?: string; artifactDelivery?: string | null }): TelegramChatAccessRecord {
    return this.mutatePayload((payload) => {
      const chat = payload.telegramChats.find((candidate) => candidate.id === id);
      if (!chat) {
        throw new Error("Telegram chat not found.");
      }
      if (patch.enabled !== undefined) chat.enabled = patch.enabled;
      if (patch.title !== undefined) chat.title = patch.title;
      if (patch.allowedGroupIds !== undefined) chat.allowedGroupIds = normalizeGroupIds(payload, patch.allowedGroupIds, null);
      if (patch.artifactDelivery !== undefined) chat.artifactDelivery = normalizeArtifactDeliveryMode(patch.artifactDelivery) ?? undefined;
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
    artifactDelivery?: string;
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
        existing.artifactDelivery = normalizeArtifactDeliveryMode(input.artifactDelivery) ?? existing.artifactDelivery;
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
        artifactDelivery: normalizeArtifactDeliveryMode(input.artifactDelivery),
        createdAt: now,
        updatedAt: now,
      };
      payload.discordChannels.push(channel);
      return channel;
    });
  }

  updateDiscordChannel(id: string, patch: { enabled?: boolean; allowedGroupIds?: string[]; title?: string; artifactDelivery?: string | null }): DiscordChannelAccessRecord {
    return this.mutatePayload((payload) => {
      const channel = payload.discordChannels.find((candidate) => candidate.id === id);
      if (!channel) {
        throw new Error("Discord channel not found.");
      }
      if (patch.enabled !== undefined) channel.enabled = patch.enabled;
      if (patch.title !== undefined) channel.title = patch.title;
      if (patch.allowedGroupIds !== undefined) channel.allowedGroupIds = normalizeGroupIds(payload, patch.allowedGroupIds, null);
      if (patch.artifactDelivery !== undefined) channel.artifactDelivery = normalizeArtifactDeliveryMode(patch.artifactDelivery) ?? undefined;
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
    artifactDelivery?: string;
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
        existing.artifactDelivery = normalizeArtifactDeliveryMode(input.artifactDelivery) ?? existing.artifactDelivery;
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
        artifactDelivery: normalizeArtifactDeliveryMode(input.artifactDelivery),
        createdAt: now,
        updatedAt: now,
      };
      payload.slackChannels.push(channel);
      return channel;
    });
  }

  updateSlackChannel(id: string, patch: { enabled?: boolean; allowedGroupIds?: string[]; title?: string; artifactDelivery?: string | null }): SlackChannelAccessRecord {
    return this.mutatePayload((payload) => {
      const channel = payload.slackChannels.find((candidate) => candidate.id === id);
      if (!channel) {
        throw new Error("Slack channel not found.");
      }
      if (patch.enabled !== undefined) channel.enabled = patch.enabled;
      if (patch.title !== undefined) channel.title = patch.title;
      if (patch.allowedGroupIds !== undefined) channel.allowedGroupIds = normalizeGroupIds(payload, patch.allowedGroupIds, null);
      if (patch.artifactDelivery !== undefined) channel.artifactDelivery = normalizeArtifactDeliveryMode(patch.artifactDelivery) ?? undefined;
      channel.updatedAt = new Date().toISOString();
      return channel;
    });
  }

  registerMatrixRoom(input: {
    homeserver?: string;
    roomId: string;
    title?: string;
    canonicalAlias?: string;
    type?: string;
    enabled?: boolean;
    allowedGroupIds?: string[];
    artifactDelivery?: string;
  }): MatrixRoomAccessRecord {
    return this.mutatePayload((payload) => {
      const now = new Date().toISOString();
      const roomId = normalizeMatrixId(input.roomId);
      if (!roomId) {
        throw new Error("Matrix room id is required.");
      }
      const homeserver = normalizeMatrixId(input.homeserver);
      const existing = payload.matrixRooms.find((room) => room.roomId === roomId && room.homeserver === homeserver);
      const allowedGroupIds = normalizeGroupIds(payload, input.allowedGroupIds ?? [], null);
      if (existing) {
        existing.title = input.title ?? existing.title;
        existing.canonicalAlias = input.canonicalAlias ?? existing.canonicalAlias;
        existing.type = input.type ?? existing.type;
        existing.enabled = input.enabled ?? existing.enabled;
        existing.allowedGroupIds = allowedGroupIds;
        existing.artifactDelivery = normalizeArtifactDeliveryMode(input.artifactDelivery) ?? existing.artifactDelivery;
        existing.updatedAt = now;
        return existing;
      }
      const room: MatrixRoomAccessRecord = {
        id: randomId(),
        homeserver,
        roomId,
        title: input.title,
        canonicalAlias: input.canonicalAlias,
        type: input.type,
        enabled: input.enabled ?? true,
        allowedGroupIds,
        artifactDelivery: normalizeArtifactDeliveryMode(input.artifactDelivery),
        createdAt: now,
        updatedAt: now,
      };
      payload.matrixRooms.push(room);
      return room;
    });
  }

  updateMatrixRoom(id: string, patch: { enabled?: boolean; allowedGroupIds?: string[]; title?: string; artifactDelivery?: string | null }): MatrixRoomAccessRecord {
    return this.mutatePayload((payload) => {
      const room = payload.matrixRooms.find((candidate) => candidate.id === id);
      if (!room) {
        throw new Error("Matrix room not found.");
      }
      if (patch.enabled !== undefined) room.enabled = patch.enabled;
      if (patch.title !== undefined) room.title = patch.title;
      if (patch.allowedGroupIds !== undefined) room.allowedGroupIds = normalizeGroupIds(payload, patch.allowedGroupIds, null);
      if (patch.artifactDelivery !== undefined) room.artifactDelivery = normalizeArtifactDeliveryMode(patch.artifactDelivery) ?? undefined;
      room.updatedAt = new Date().toISOString();
      return room;
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

  isMatrixRoomAllowed(input: { homeserver?: string; roomId?: string; isDirectMessage?: boolean }, user: AuthenticatedUser): boolean {
    const roomId = normalizeMatrixId(input.roomId);
    if (!roomId) {
      return false;
    }
    if (input.isDirectMessage) {
      return this.canUseMatrixRoom(user, roomId);
    }
    const homeserver = normalizeMatrixId(input.homeserver);
    const payload = this.readPayload();
    const access = payload.matrixRooms.find((room) => room.roomId === roomId && (!room.homeserver || !homeserver || room.homeserver === homeserver));
    if (!access?.enabled) {
      return false;
    }
    if (access.allowedGroupIds.length === 0) {
      return this.canUseMatrixRoom(user, roomId);
    }
    const userGroupIds = new Set(user.groups.map((group) => group.id));
    return access.allowedGroupIds.some((groupId) => userGroupIds.has(groupId)) && this.canUseMatrixRoom(user, roomId);
  }

  hasPermission(user: AuthenticatedUser | null | undefined, permission: Permission | null | undefined): boolean {
    return Boolean(permission && user?.permissions.includes(permission));
  }

  canUseAgent(user: AuthenticatedUser | null | undefined, agentId: string | undefined): boolean {
    if (!user || !agentId) {
      return true;
    }
    const groupAllowed = user.groups.some((group) => group.agentIds.length === 0 || group.agentIds.includes(agentId));
    const tokenAllowed = !user.apiToken || user.apiToken.agentIds.length === 0 || user.apiToken.agentIds.includes(agentId);
    return groupAllowed && tokenAllowed;
  }

  canUseAgentStrict(user: AuthenticatedUser | null | undefined, agentId: string | undefined): boolean {
    return Boolean(user && agentId && this.canUseAgent(user, agentId));
  }

  canUseWorkspace(user: AuthenticatedUser | null | undefined, workspace: string | undefined): boolean {
    if (!user || !workspace) {
      return true;
    }
    const normalizedWorkspace = normalizeWorkspacePath(workspace);
    const groupAllowed = user.groups.some((group) => group.workspaceRoots.length === 0 ||
      group.workspaceRoots.some((root) => isPathInside(normalizedWorkspace, normalizeWorkspacePath(root))));
    const tokenAllowed = !user.apiToken || user.apiToken.workspaceRoots.length === 0 ||
      user.apiToken.workspaceRoots.some((root) => isPathInside(normalizedWorkspace, normalizeWorkspacePath(root)));
    return groupAllowed && tokenAllowed;
  }

  canUseWorkspaceStrict(user: AuthenticatedUser | null | undefined, workspace: string | undefined): boolean {
    return Boolean(user && workspace && this.canUseWorkspace(user, workspace));
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

  canUseMatrixRoom(user: AuthenticatedUser | null | undefined, roomId: string | undefined): boolean {
    const normalized = normalizeMatrixId(roomId);
    if (!user || !normalized) {
      return true;
    }
    return user.groups.some((group) => group.matrixRoomIds.length === 0 || group.matrixRoomIds.includes(normalized));
  }

  canUsePeer(user: AuthenticatedUser | null | undefined, peerId: string | undefined): boolean {
    const normalized = peerId?.trim();
    if (!user || !normalized) {
      return true;
    }
    const groupAllowed = user.groups.some((group) => group.peerIds.length === 0 || group.peerIds.includes(normalized));
    const tokenAllowed = !user.apiToken || user.apiToken.peerIds.length === 0 || user.apiToken.peerIds.includes(normalized);
    return groupAllowed && tokenAllowed;
  }

  canUsePeerStrict(user: AuthenticatedUser | null | undefined, peerId: string | undefined): boolean {
    return Boolean(user && peerId && this.canUsePeer(user, peerId));
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
    matrixRoomIds?: string[];
    peerIds?: string[];
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
        matrixRoomIds: normalizeStringList(input.matrixRoomIds ?? []),
        peerIds: normalizeStringList(input.peerIds ?? []),
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
    matrixRoomIds?: string[];
    peerIds?: string[];
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
      if (patch.matrixRoomIds !== undefined) group.matrixRoomIds = normalizeStringList(patch.matrixRoomIds);
      if (patch.peerIds !== undefined) group.peerIds = normalizeStringList(patch.peerIds);
      group.updatedAt = new Date().toISOString();
      return group;
    });
  }

  private authenticatedUser(payload: PersistedUsers, user: UserRecord): AuthenticatedUser {
    const groups = this.groupsForUser(payload, user.id);
    const permissions = Array.from(new Set(groups.flatMap((group) => group.permissions)));
    return { user, groups, permissions };
  }

  private mfaStatusInPayload(payload: PersistedUsers, userId: string): ReturnType<UserStore["mfaStatus"]> {
    return {
      totpEnabled: payload.totpCredentials.some((credential) => credential.userId === userId),
      recoveryCodesRemaining: payload.recoveryCodes.filter((code) => code.userId === userId && !code.usedAt).length,
      webAuthnCredentials: payload.webAuthnCredentials
        .filter((credential) => credential.userId === userId)
        .map(publicWebAuthnCredential),
    };
  }

  private replaceRecoveryCodesInPayload(payload: PersistedUsers, userId: string): string[] {
    const now = new Date().toISOString();
    const recoveryCodes = generateRecoveryCodes();
    payload.recoveryCodes = payload.recoveryCodes.filter((code) => code.userId !== userId);
    payload.recoveryCodes.push(...recoveryCodes.map((code): RecoveryCodeRecord => ({
      id: randomId(),
      userId,
      codeHash: hashToken(normalizeRecoveryCode(code)),
      createdAt: now,
    })));
    return recoveryCodes;
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

  private upsertMatrixIdentityInPayload(payload: PersistedUsers, userId: string, input: {
    matrixUserId: string;
    homeserver?: string;
    displayName?: string;
  }): MatrixIdentityRecord {
    const matrixUserId = normalizeMatrixId(input.matrixUserId);
    if (!matrixUserId) {
      throw new Error("Matrix user id is required.");
    }
    const homeserver = normalizeMatrixId(input.homeserver);
    const now = new Date().toISOString();
    for (const identity of payload.matrixIdentities) {
      if (identity.matrixUserId === matrixUserId && (identity.homeserver ?? "") === (homeserver ?? "") && identity.userId !== userId) {
        identity.active = false;
      }
    }
    const existing = payload.matrixIdentities.find((identity) =>
      identity.userId === userId &&
      identity.matrixUserId === matrixUserId &&
      (identity.homeserver ?? "") === (homeserver ?? "")
    );
    if (existing) {
      existing.displayName = input.displayName ?? existing.displayName;
      existing.active = true;
      existing.updatedAt = now;
      return existing;
    }
    const identity: MatrixIdentityRecord = {
      id: randomId(),
      userId,
      matrixUserId,
      homeserver,
      displayName: input.displayName,
      active: true,
      linkedAt: now,
      updatedAt: now,
    };
    payload.matrixIdentities.push(identity);
    return identity;
  }

  private pruneExpiredSessionsInPayload(payload: PersistedUsers): void {
    const now = Date.now();
    payload.webSessions = payload.webSessions.filter((session) => new Date(session.expiresAt).getTime() > now);
  }

  private revokeUserSessionsInPayload(payload: PersistedUsers, userId: string, keepSessionId?: string): void {
    payload.webSessions = payload.webSessions.filter((session) => session.userId !== userId || session.id === keepSessionId);
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

function mergeUserPreferences(current: UserPreferences | undefined, patch: UserPreferencePatch | undefined): UserPreferences | undefined {
  if (patch === undefined) {
    return normalizeUserPreferences(current);
  }
  const next: Record<string, unknown> = { ...(current ?? {}) };
  if (patch.theme !== undefined) {
    if (patch.theme) next.theme = patch.theme;
    else delete next.theme;
  }
  if (patch.artifactDelivery !== undefined) {
    const mode = normalizeArtifactDeliveryMode(patch.artifactDelivery);
    if (mode) next.artifactDelivery = mode;
    else delete next.artifactDelivery;
  }
  return normalizeUserPreferences(next);
}

export function publicUser(user: UserRecord): Omit<UserRecord, "passwordHash" | "passwordSalt"> {
  const { passwordHash: _passwordHash, passwordSalt: _passwordSalt, ...rest } = user;
  return rest;
}

export function publicWebSession(session: WebSessionRecord): PublicWebSessionRecord {
  const { tokenHash: _tokenHash, ...rest } = session;
  return rest;
}

export function publicWebAuthnCredential(credential: WebAuthnCredentialRecord): PublicWebAuthnCredentialRecord {
  const { publicKey: _publicKey, ...rest } = credential;
  return rest;
}

export function publicApiToken(token: ApiTokenRecord): PublicApiTokenRecord {
  const { tokenHash: _tokenHash, ...rest } = token;
  return rest;
}

function normalizeRecoveryCode(code: string): string {
  return String(code ?? "").trim().toUpperCase().replace(/\s+/g, "").replace(/-/g, "");
}

function normalizeFutureIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Invalid expiration date.");
  }
  if (timestamp <= Date.now()) {
    throw new Error("Expiration must be in the future.");
  }
  return new Date(timestamp).toISOString();
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
