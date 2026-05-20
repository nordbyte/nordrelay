import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuditEvent } from "../access/audit-log.js";
import {
  type AuthenticatedUser,
  type GroupRecord,
  type PublicWebSessionRecord,
  type TelegramIdentityRecord,
  type DiscordIdentityRecord,
  type MatrixIdentityRecord,
  type SlackIdentityRecord,
  type UserPreferences,
  type UserStore,
} from "../access/user-management.js";
import { optionalStringField, readJsonBody, sendJson, stringField } from "./web-dashboard-http.js";

export interface DashboardProfileRouteOptions {
  users: UserStore;
  authUser: AuthenticatedUser;
  sessionToken?: string;
  auditUserAction: (authUser: AuthenticatedUser, action: AuditEvent["action"], description: string) => void;
}

export interface WebProfileDto {
  user: Omit<AuthenticatedUser["user"], "passwordHash" | "passwordSalt">;
  groups: GroupRecord[];
  permissions: AuthenticatedUser["permissions"];
  telegramIdentities: TelegramIdentityRecord[];
  discordIdentities: DiscordIdentityRecord[];
  slackIdentities: SlackIdentityRecord[];
  matrixIdentities: MatrixIdentityRecord[];
  webSessions: PublicWebSessionRecord[];
  currentSessionId?: string;
}

export async function handleDashboardProfileRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: DashboardProfileRouteOptions,
): Promise<boolean> {
  const { users, authUser, sessionToken } = options;

  if (req.method === "GET" && url.pathname === "/api/profile") {
    sendJson(res, 200, profileDto(users, authUser, sessionToken));
    return true;
  }

  if (req.method === "PATCH" && url.pathname === "/api/profile") {
    const body = await readJsonBody(req);
    let preferences: UserPreferences | undefined;
    try {
      preferences = parsePreferences(body);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      return true;
    }
    const updated = users.updateProfile(authUser.user.id, {
      displayName: optionalStringField(body, "displayName"),
      preferences,
    });
    options.auditUserAction(updated, "user_updated", `Profile updated: ${updated.user.email}`);
    sendJson(res, 200, profileDto(users, updated, sessionToken));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/profile/password") {
    const body = await readJsonBody(req);
    let currentPassword: string;
    let nextPassword: string;
    try {
      currentPassword = stringField(body, "currentPassword");
      nextPassword = optionalStringField(body, "newPassword") ?? stringField(body, "password");
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      return true;
    }
    if (nextPassword.length < 12) {
      sendJson(res, 400, { error: "New password must be at least 12 characters." });
      return true;
    }
    try {
      users.changePassword(authUser.user.id, currentPassword, nextPassword, currentSessionId(users, sessionToken));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      return true;
    }
    options.auditUserAction(authUser, "user_password_changed", `Own password changed: ${authUser.user.email}`);
    sendJson(res, 200, { ok: true, profile: profileDto(users, authUser, sessionToken) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/profile/logout-other-sessions") {
    const revoked = users.revokeOtherUserSessions(authUser.user.id, currentSessionId(users, sessionToken));
    options.auditUserAction(authUser, "user_session_revoked", `Own other web sessions revoked: ${revoked}`);
    sendJson(res, 200, { revoked, profile: profileDto(users, authUser, sessionToken) });
    return true;
  }

  return false;
}

function profileDto(users: UserStore, authUser: AuthenticatedUser, sessionToken?: string): WebProfileDto {
  const snapshot = users.snapshot();
  const entry = snapshot.users.find((user) => user.id === authUser.user.id);
  const current = users.webSessionForToken(sessionToken);
  if (!entry) {
    const { passwordHash: _passwordHash, passwordSalt: _passwordSalt, ...user } = authUser.user;
    return {
      user,
      groups: authUser.groups,
      permissions: authUser.permissions,
      telegramIdentities: [],
      discordIdentities: [],
      slackIdentities: [],
      matrixIdentities: [],
      webSessions: current ? [current] : [],
      currentSessionId: current?.id,
    };
  }
  const {
    passwordHash: _passwordHash,
    passwordSalt: _passwordSalt,
    groups,
    telegramIdentities,
    discordIdentities,
    slackIdentities,
    matrixIdentities,
    webSessions,
    ...user
  } = entry;
  return {
    user,
    groups,
    permissions: authUser.permissions,
    telegramIdentities,
    discordIdentities,
    slackIdentities,
    matrixIdentities,
    webSessions,
    currentSessionId: current?.id,
  };
}

function currentSessionId(users: UserStore, sessionToken?: string): string | undefined {
  return users.webSessionForToken(sessionToken)?.id;
}

function parsePreferences(body: Record<string, unknown>): UserPreferences | undefined {
  const rawPreferences = body.preferences && typeof body.preferences === "object" && !Array.isArray(body.preferences)
    ? body.preferences as Record<string, unknown>
    : {};
  const theme = optionalStringField(rawPreferences, "theme") ?? optionalStringField(body, "theme");
  if (theme === undefined) {
    return undefined;
  }
  if (theme !== "light" && theme !== "dark" && theme !== "system") {
    throw new Error("theme must be light, dark, or system");
  }
  return { theme };
}
