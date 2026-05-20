import type { IncomingMessage, ServerResponse } from "node:http";

import { ALL_PERMISSIONS } from "../access/access-control.js";
import type { AuditEvent } from "../access/audit-log.js";
import type { RelayRuntime } from "../runtime/relay-runtime.js";
import {
  publicUser,
  publicUserSnapshot,
  type AuthenticatedUser,
  type UserStore,
} from "../access/user-management.js";
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
      discordUserId: optionalStringField(body, "discordUserId"),
      slackUserId: optionalStringField(body, "slackUserId"),
      slackTeamId: optionalStringField(body, "slackTeamId"),
      matrixUserId: optionalStringField(body, "matrixUserId"),
      matrixHomeserver: optionalStringField(body, "matrixHomeserver"),
      preferences: body.preferences && typeof body.preferences === "object" && !Array.isArray(body.preferences)
        ? { artifactDelivery: optionalStringField(body.preferences as Record<string, unknown>, "artifactDelivery") }
        : body.artifactDelivery !== undefined ? { artifactDelivery: optionalStringField(body, "artifactDelivery") } : undefined,
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
      preferences: body.preferences && typeof body.preferences === "object" && !Array.isArray(body.preferences)
        ? { artifactDelivery: optionalStringField(body.preferences as Record<string, unknown>, "artifactDelivery") }
        : body.artifactDelivery !== undefined ? { artifactDelivery: optionalStringField(body, "artifactDelivery") } : undefined,
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

  const discordLinkMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/discord$/);
  if (discordLinkMatch?.[1] && req.method === "POST") {
    const body = await readJsonBody(req);
    if (body.createCode === true) {
      const userId = decodeURIComponent(discordLinkMatch[1]);
      const linkCode = users.createDiscordLinkCode(userId);
      options.auditUserAction(authUser, "discord_link_created", userId);
      sendJson(res, 201, { linkCode });
      return true;
    }
    const identity = users.linkDiscordUser(decodeURIComponent(discordLinkMatch[1]), {
      discordUserId: stringField(body, "discordUserId"),
      username: optionalStringField(body, "username"),
      globalName: optionalStringField(body, "globalName"),
    });
    options.auditUserAction(authUser, "discord_linked", identity.discordUserId);
    sendJson(res, 201, { identity });
    return true;
  }

  const discordUnlinkMatch = url.pathname.match(/^\/api\/users\/[^/]+\/discord\/([^/]+)$/);
  if (discordUnlinkMatch?.[1] && req.method === "DELETE") {
    const identityId = decodeURIComponent(discordUnlinkMatch[1]);
    const removed = users.unlinkDiscordIdentity(identityId);
    options.auditUserAction(authUser, "discord_unlinked", identityId);
    sendJson(res, 200, { removed });
    return true;
  }

  const slackLinkMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/slack$/);
  if (slackLinkMatch?.[1] && req.method === "POST") {
    const body = await readJsonBody(req);
    if (body.createCode === true) {
      const userId = decodeURIComponent(slackLinkMatch[1]);
      const linkCode = users.createSlackLinkCode(userId);
      options.auditUserAction(authUser, "slack_link_created", userId);
      sendJson(res, 201, { linkCode });
      return true;
    }
    const identity = users.linkSlackUser(decodeURIComponent(slackLinkMatch[1]), {
      slackUserId: stringField(body, "slackUserId"),
      teamId: optionalStringField(body, "teamId"),
      username: optionalStringField(body, "username"),
      realName: optionalStringField(body, "realName"),
    });
    options.auditUserAction(authUser, "slack_linked", identity.slackUserId);
    sendJson(res, 201, { identity });
    return true;
  }

  const slackUnlinkMatch = url.pathname.match(/^\/api\/users\/[^/]+\/slack\/([^/]+)$/);
  if (slackUnlinkMatch?.[1] && req.method === "DELETE") {
    const identityId = decodeURIComponent(slackUnlinkMatch[1]);
    const removed = users.unlinkSlackIdentity(identityId);
    options.auditUserAction(authUser, "slack_unlinked", identityId);
    sendJson(res, 200, { removed });
    return true;
  }

  const matrixLinkMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/matrix$/);
  if (matrixLinkMatch?.[1] && req.method === "POST") {
    const body = await readJsonBody(req);
    if (body.createCode === true) {
      const userId = decodeURIComponent(matrixLinkMatch[1]);
      const linkCode = users.createMatrixLinkCode(userId);
      options.auditUserAction(authUser, "matrix_link_created", userId);
      sendJson(res, 201, { linkCode });
      return true;
    }
    const identity = users.linkMatrixUser(decodeURIComponent(matrixLinkMatch[1]), {
      matrixUserId: stringField(body, "matrixUserId"),
      homeserver: optionalStringField(body, "homeserver"),
      displayName: optionalStringField(body, "displayName"),
    });
    options.auditUserAction(authUser, "matrix_linked", identity.matrixUserId);
    sendJson(res, 201, { identity });
    return true;
  }

  const matrixUnlinkMatch = url.pathname.match(/^\/api\/users\/[^/]+\/matrix\/([^/]+)$/);
  if (matrixUnlinkMatch?.[1] && req.method === "DELETE") {
    const identityId = decodeURIComponent(matrixUnlinkMatch[1]);
    const removed = users.unlinkMatrixIdentity(identityId);
    options.auditUserAction(authUser, "matrix_unlinked", identityId);
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
      discordChannelIds: arrayStringField(body, "discordChannelIds"),
      slackChannelIds: arrayStringField(body, "slackChannelIds"),
      matrixRoomIds: arrayStringField(body, "matrixRoomIds"),
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
      discordChannelIds: body.discordChannelIds === undefined ? undefined : arrayStringField(body, "discordChannelIds"),
      slackChannelIds: body.slackChannelIds === undefined ? undefined : arrayStringField(body, "slackChannelIds"),
      matrixRoomIds: body.matrixRoomIds === undefined ? undefined : arrayStringField(body, "matrixRoomIds"),
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
      artifactDelivery: optionalStringField(body, "artifactDelivery"),
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
      artifactDelivery: body.artifactDelivery === undefined ? undefined : optionalStringField(body, "artifactDelivery") ?? null,
    });
    options.auditUserAction(authUser, "telegram_chat_updated", String(chat.chatId));
    sendJson(res, 200, { chat });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/discord-channels") {
    sendJson(res, 200, { channels: users.snapshot().discordChannels });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/discord-channels") {
    const body = await readJsonBody(req);
    const channel = users.registerDiscordChannel({
      guildId: optionalStringField(body, "guildId"),
      channelId: stringField(body, "channelId"),
      title: optionalStringField(body, "title"),
      type: optionalStringField(body, "type"),
      enabled: optionalBooleanField(body, "enabled") ?? true,
      allowedGroupIds: arrayStringField(body, "allowedGroupIds"),
      artifactDelivery: optionalStringField(body, "artifactDelivery"),
    });
    options.auditUserAction(authUser, "discord_channel_updated", channel.channelId);
    sendJson(res, 201, { channel });
    return true;
  }

  const discordChannelMatch = url.pathname.match(/^\/api\/discord-channels\/([^/]+)$/);
  if (discordChannelMatch?.[1] && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const channel = users.updateDiscordChannel(decodeURIComponent(discordChannelMatch[1]), {
      enabled: optionalBooleanField(body, "enabled"),
      title: optionalStringField(body, "title"),
      allowedGroupIds: body.allowedGroupIds === undefined ? undefined : arrayStringField(body, "allowedGroupIds"),
      artifactDelivery: body.artifactDelivery === undefined ? undefined : optionalStringField(body, "artifactDelivery") ?? null,
    });
    options.auditUserAction(authUser, "discord_channel_updated", channel.channelId);
    sendJson(res, 200, { channel });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/slack-channels") {
    sendJson(res, 200, { channels: users.snapshot().slackChannels });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/slack-channels") {
    const body = await readJsonBody(req);
    const channel = users.registerSlackChannel({
      teamId: optionalStringField(body, "teamId"),
      channelId: stringField(body, "channelId"),
      title: optionalStringField(body, "title"),
      type: optionalStringField(body, "type"),
      enabled: optionalBooleanField(body, "enabled") ?? true,
      allowedGroupIds: arrayStringField(body, "allowedGroupIds"),
      artifactDelivery: optionalStringField(body, "artifactDelivery"),
    });
    options.auditUserAction(authUser, "slack_channel_updated", channel.channelId);
    sendJson(res, 201, { channel });
    return true;
  }

  const slackChannelMatch = url.pathname.match(/^\/api\/slack-channels\/([^/]+)$/);
  if (slackChannelMatch?.[1] && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const channel = users.updateSlackChannel(decodeURIComponent(slackChannelMatch[1]), {
      enabled: optionalBooleanField(body, "enabled"),
      title: optionalStringField(body, "title"),
      allowedGroupIds: body.allowedGroupIds === undefined ? undefined : arrayStringField(body, "allowedGroupIds"),
      artifactDelivery: body.artifactDelivery === undefined ? undefined : optionalStringField(body, "artifactDelivery") ?? null,
    });
    options.auditUserAction(authUser, "slack_channel_updated", channel.channelId);
    sendJson(res, 200, { channel });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/matrix-rooms") {
    sendJson(res, 200, { rooms: users.snapshot().matrixRooms });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/matrix-rooms") {
    const body = await readJsonBody(req);
    const room = users.registerMatrixRoom({
      homeserver: optionalStringField(body, "homeserver"),
      roomId: stringField(body, "roomId"),
      title: optionalStringField(body, "title"),
      canonicalAlias: optionalStringField(body, "canonicalAlias"),
      type: optionalStringField(body, "type"),
      enabled: optionalBooleanField(body, "enabled") ?? true,
      allowedGroupIds: arrayStringField(body, "allowedGroupIds"),
      artifactDelivery: optionalStringField(body, "artifactDelivery"),
    });
    options.auditUserAction(authUser, "matrix_room_updated", room.roomId);
    sendJson(res, 201, { room });
    return true;
  }

  const matrixRoomMatch = url.pathname.match(/^\/api\/matrix-rooms\/([^/]+)$/);
  if (matrixRoomMatch?.[1] && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const room = users.updateMatrixRoom(decodeURIComponent(matrixRoomMatch[1]), {
      enabled: optionalBooleanField(body, "enabled"),
      title: optionalStringField(body, "title"),
      allowedGroupIds: body.allowedGroupIds === undefined ? undefined : arrayStringField(body, "allowedGroupIds"),
      artifactDelivery: body.artifactDelivery === undefined ? undefined : optionalStringField(body, "artifactDelivery") ?? null,
    });
    options.auditUserAction(authUser, "matrix_room_updated", room.roomId);
    sendJson(res, 200, { room });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    const page = runtime.auditPage({
      limit: numberParam(url, "limit", 50),
      cursor: url.searchParams.get("cursor") || undefined,
      channelId: (url.searchParams.get("channel") || "all") as never,
      category: (url.searchParams.get("category") || "all") as never,
      status: (url.searchParams.get("status") || "all") as never,
      action: url.searchParams.get("action") || "all",
      actor: url.searchParams.get("actor") || undefined,
      agentId: url.searchParams.get("agent") || "all",
      threadId: url.searchParams.get("thread") || undefined,
      workspace: url.searchParams.get("workspace") || undefined,
      since: url.searchParams.get("since") || undefined,
    });
    sendJson(res, 200, {
      events: page.items,
      pagination: page.pagination,
    });
    return true;
  }

  return false;
}
