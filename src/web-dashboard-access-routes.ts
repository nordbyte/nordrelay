import type { IncomingMessage, ServerResponse } from "node:http";

import { ALL_PERMISSIONS } from "./access-control.js";
import type { AuditEvent } from "./audit-log.js";
import type { RelayRuntime } from "./relay-runtime.js";
import {
  publicUser,
  publicUserSnapshot,
  type AuthenticatedUser,
  type UserStore,
} from "./user-management.js";
import {
  arrayNumberField,
  arrayStringField,
  numberField,
  numberParam,
  optionalBooleanField,
  optionalNumberField,
  optionalStringField,
  readJsonBody,
  sendJson,
  stringField,
} from "./web-dashboard-http.js";

export interface DashboardAccessRouteOptions {
  users: UserStore;
  runtime: RelayRuntime;
  authUser: AuthenticatedUser;
  auditUserAction: (authUser: AuthenticatedUser, action: AuditEvent["action"], description: string) => void;
}

export async function handleDashboardAccessRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: DashboardAccessRouteOptions,
): Promise<boolean> {
  const { users, runtime, authUser } = options;

  if (req.method === "GET" && url.pathname === "/api/permissions") {
    sendJson(res, 200, { ...publicUserSnapshot(users.snapshot()), permissions: ALL_PERMISSIONS });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/users") {
    sendJson(res, 200, { ...publicUserSnapshot(users.snapshot()), permissions: ALL_PERMISSIONS });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/users") {
    const body = await readJsonBody(req);
    const user = users.createUser({
      email: stringField(body, "email"),
      displayName: optionalStringField(body, "displayName") ?? stringField(body, "email"),
      password: stringField(body, "password"),
      groupIds: arrayStringField(body, "groupIds"),
      active: optionalBooleanField(body, "active") ?? true,
      telegramUserId: optionalNumberField(body, "telegramUserId"),
    });
    options.auditUserAction(authUser, "user_created", user.user.email);
    sendJson(res, 201, { user: publicUser(user.user), groups: user.groups });
    return true;
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch?.[1] && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const user = users.updateUser(decodeURIComponent(userMatch[1]), {
      email: optionalStringField(body, "email"),
      displayName: optionalStringField(body, "displayName"),
      active: optionalBooleanField(body, "active"),
      groupIds: body.groupIds === undefined ? undefined : arrayStringField(body, "groupIds"),
    });
    options.auditUserAction(authUser, "user_updated", user.user.email);
    sendJson(res, 200, { user: publicUser(user.user), groups: user.groups });
    return true;
  }

  const passwordMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/password$/);
  if (passwordMatch?.[1] && req.method === "POST") {
    const body = await readJsonBody(req);
    const userId = decodeURIComponent(passwordMatch[1]);
    users.setPassword(userId, stringField(body, "password"));
    options.auditUserAction(authUser, "user_password_changed", userId);
    sendJson(res, 200, { ok: true });
    return true;
  }

  const userSessionsMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/sessions$/);
  if (userSessionsMatch?.[1] && req.method === "GET") {
    sendJson(res, 200, { sessions: users.listWebSessions(decodeURIComponent(userSessionsMatch[1])) });
    return true;
  }

  if (userSessionsMatch?.[1] && req.method === "DELETE") {
    const userId = decodeURIComponent(userSessionsMatch[1]);
    const revoked = users.revokeUserSessions(userId);
    options.auditUserAction(authUser, "user_session_revoked", `${userId}: ${revoked} sessions`);
    sendJson(res, 200, { revoked });
    return true;
  }

  const userSessionMatch = url.pathname.match(/^\/api\/users\/[^/]+\/sessions\/([^/]+)$/);
  if (userSessionMatch?.[1] && req.method === "DELETE") {
    const sessionId = decodeURIComponent(userSessionMatch[1]);
    const revoked = users.revokeWebSession(sessionId);
    options.auditUserAction(authUser, "user_session_revoked", sessionId);
    sendJson(res, 200, { revoked });
    return true;
  }

  const telegramLinkMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/telegram$/);
  if (telegramLinkMatch?.[1] && req.method === "POST") {
    const body = await readJsonBody(req);
    if (body.createCode === true) {
      const userId = decodeURIComponent(telegramLinkMatch[1]);
      const linkCode = users.createTelegramLinkCode(userId);
      options.auditUserAction(authUser, "telegram_link_created", userId);
      sendJson(res, 201, { linkCode });
      return true;
    }
    const identity = users.linkTelegramUser(decodeURIComponent(telegramLinkMatch[1]), {
      telegramUserId: numberField(body, "telegramUserId"),
      username: optionalStringField(body, "username"),
    });
    options.auditUserAction(authUser, "telegram_linked", String(identity.telegramUserId));
    sendJson(res, 201, { identity });
    return true;
  }

  const telegramUnlinkMatch = url.pathname.match(/^\/api\/users\/[^/]+\/telegram\/([^/]+)$/);
  if (telegramUnlinkMatch?.[1] && req.method === "DELETE") {
    const identityId = decodeURIComponent(telegramUnlinkMatch[1]);
    const removed = users.unlinkTelegramIdentity(identityId);
    options.auditUserAction(authUser, "telegram_unlinked", identityId);
    sendJson(res, 200, { removed });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/groups") {
    sendJson(res, 200, { groups: users.listGroups() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/groups") {
    const body = await readJsonBody(req);
    const group = users.createGroup({
      name: stringField(body, "name"),
      description: optionalStringField(body, "description"),
      permissions: arrayStringField(body, "permissions"),
      agentIds: arrayStringField(body, "agentIds"),
      workspaceRoots: arrayStringField(body, "workspaceRoots"),
      telegramChatIds: arrayNumberField(body, "telegramChatIds"),
    });
    options.auditUserAction(authUser, "group_created", group.id);
    sendJson(res, 201, { group });
    return true;
  }

  const groupMatch = url.pathname.match(/^\/api\/groups\/([^/]+)$/);
  if (groupMatch?.[1] && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const group = users.updateGroup(decodeURIComponent(groupMatch[1]), {
      name: optionalStringField(body, "name"),
      description: optionalStringField(body, "description"),
      permissions: body.permissions === undefined ? undefined : arrayStringField(body, "permissions"),
      agentIds: body.agentIds === undefined ? undefined : arrayStringField(body, "agentIds"),
      workspaceRoots: body.workspaceRoots === undefined ? undefined : arrayStringField(body, "workspaceRoots"),
      telegramChatIds: body.telegramChatIds === undefined ? undefined : arrayNumberField(body, "telegramChatIds"),
    });
    options.auditUserAction(authUser, "group_updated", group.id);
    sendJson(res, 200, { group });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/telegram-chats") {
    sendJson(res, 200, { chats: users.snapshot().telegramChats });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/telegram-chats") {
    const body = await readJsonBody(req);
    const chat = users.registerTelegramChat({
      chatId: numberField(body, "chatId"),
      title: optionalStringField(body, "title"),
      type: optionalStringField(body, "type"),
      enabled: optionalBooleanField(body, "enabled") ?? true,
      allowedGroupIds: arrayStringField(body, "allowedGroupIds"),
    });
    options.auditUserAction(authUser, "telegram_chat_updated", String(chat.chatId));
    sendJson(res, 201, { chat });
    return true;
  }

  const chatMatch = url.pathname.match(/^\/api\/telegram-chats\/([^/]+)$/);
  if (chatMatch?.[1] && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const chat = users.updateTelegramChat(decodeURIComponent(chatMatch[1]), {
      enabled: optionalBooleanField(body, "enabled"),
      title: optionalStringField(body, "title"),
      allowedGroupIds: body.allowedGroupIds === undefined ? undefined : arrayStringField(body, "allowedGroupIds"),
    });
    options.auditUserAction(authUser, "telegram_chat_updated", String(chat.chatId));
    sendJson(res, 200, { chat });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    sendJson(res, 200, { events: runtime.audit(numberParam(url, "limit", 50)) });
    return true;
  }

  return false;
}
