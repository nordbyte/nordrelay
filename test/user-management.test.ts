import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ADMIN_GROUP_ID, ALL_PERMISSIONS, READONLY_GROUP_ID, USER_GROUP_ID } from "../src/access-control.js";
import { publicUserSnapshot, UserStore } from "../src/user-management.js";

describe("UserStore", () => {
  let home: string;
  let store: UserStore;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "nordrelay-users-"));
    store = new UserStore(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("creates an admin user with full permissions and verifies passwords", () => {
    const admin = store.createAdmin({
      email: "Admin@Example.com",
      displayName: "Admin",
      password: "password123",
      telegramUserId: 123,
    });

    expect(store.hasAdminUser()).toBe(true);
    expect(admin.user.email).toBe("admin@example.com");
    expect(admin.groups.map((group) => group.id)).toEqual([ADMIN_GROUP_ID]);
    expect(admin.permissions).toContain("users.write");
    expect(store.verifyPassword("admin@example.com", "wrong")).toBeNull();
    expect(store.verifyPassword("ADMIN@example.com", "password123")?.user.email).toBe("admin@example.com");
  });

  it("creates web sessions without exposing password hashes in public snapshots", () => {
    const user = store.createUser({
      email: "user@example.com",
      displayName: "User",
      password: "password123",
      groupIds: [USER_GROUP_ID],
    });
    const { token } = store.createWebSession(user.user.id);

    expect(store.resolveWebSession(token)?.user.email).toBe("user@example.com");

    const snapshot = publicUserSnapshot(store.snapshot());
    expect(snapshot.users[0]).not.toHaveProperty("passwordHash");
    expect(snapshot.users[0]).not.toHaveProperty("passwordSalt");
    expect(snapshot.users[0].webSessions[0]).not.toHaveProperty("tokenHash");
  });

  it("links Telegram users with expiring link codes", () => {
    const user = store.createUser({
      email: "telegram@example.com",
      displayName: "Telegram User",
      password: "password123",
    });
    const code = store.createTelegramLinkCode(user.user.id);
    const linked = store.consumeTelegramLinkCode(code.code.toLowerCase(), {
      telegramUserId: 456,
      username: "telegramuser",
    });

    expect(linked.user.email).toBe("telegram@example.com");
    expect(store.resolveTelegramUser(456)?.user.email).toBe("telegram@example.com");
    expect(() => store.consumeTelegramLinkCode(code.code, { telegramUserId: 789 })).toThrow("Invalid or expired link code.");
  });

  it("links Discord users with expiring link codes", () => {
    const user = store.createUser({
      email: "discord@example.com",
      displayName: "Discord User",
      password: "password123",
    });
    const code = store.createDiscordLinkCode(user.user.id);
    const linked = store.consumeDiscordLinkCode(code.code.toLowerCase(), {
      discordUserId: "112233445566",
      username: "discorduser",
    });

    expect(linked.user.email).toBe("discord@example.com");
    expect(store.resolveDiscordUser("112233445566")?.user.email).toBe("discord@example.com");
    expect(() => store.consumeDiscordLinkCode(code.code, { discordUserId: "778899" })).toThrow("Invalid or expired link code.");
  });

  it("links Slack users with expiring link codes", () => {
    const user = store.createUser({
      email: "slack@example.com",
      displayName: "Slack User",
      password: "password123",
    });
    const code = store.createSlackLinkCode(user.user.id);
    const linked = store.consumeSlackLinkCode(code.code.toLowerCase(), {
      slackUserId: "U123",
      teamId: "T123",
      username: "slackuser",
    });

    expect(linked.user.email).toBe("slack@example.com");
    expect(store.resolveSlackUser({ slackUserId: "U123", teamId: "T123" })?.user.email).toBe("slack@example.com");
    expect(() => store.consumeSlackLinkCode(code.code, { slackUserId: "U456", teamId: "T123" })).toThrow("Invalid or expired link code.");
  });

  it("uses groups and chat access for Telegram group authorization", () => {
    const readonly = store.createUser({
      email: "read@example.com",
      displayName: "Read Only",
      password: "password123",
      groupIds: [READONLY_GROUP_ID],
      telegramUserId: 789,
    });
    const operator = store.createUser({
      email: "operator@example.com",
      displayName: "Operator",
      password: "password123",
      groupIds: [USER_GROUP_ID],
      telegramUserId: 790,
    });

    expect(store.hasPermission(readonly, "sessions.read")).toBe(true);
    expect(store.hasPermission(readonly, "prompt.send")).toBe(false);
    expect(store.hasPermission(operator, "prompt.send")).toBe(true);

    store.registerTelegramChat({ chatId: -101, type: "group" });
    expect(store.isTelegramChatAllowed(-101, "group", operator)).toBe(true);
    expect(store.isTelegramChatAllowed(-101, "group", readonly)).toBe(true);

    store.registerTelegramChat({
      chatId: -100,
      type: "supergroup",
      allowedGroupIds: [USER_GROUP_ID],
    });

    expect(store.isTelegramChatAllowed(-100, "supergroup", operator)).toBe(true);
    expect(store.isTelegramChatAllowed(-100, "supergroup", readonly)).toBe(false);
    expect(store.isTelegramChatAllowed(789, "private", readonly)).toBe(true);
  });

  it("protects the last active admin and revokes sessions on permission changes", () => {
    const admin = store.createAdmin({
      email: "owner@example.com",
      displayName: "Owner",
      password: "password123",
    });
    const { token } = store.createWebSession(admin.user.id);

    expect(() => store.updateUser(admin.user.id, { active: false })).toThrow("Cannot remove or disable the last active admin user.");
    expect(() => store.updateUser(admin.user.id, { groupIds: [USER_GROUP_ID] })).toThrow("Cannot remove or disable the last active admin user.");
    expect(store.resolveWebSession(token)).not.toBeNull();

    const second = store.createAdmin({
      email: "second@example.com",
      displayName: "Second",
      password: "password123",
    });
    store.updateUser(admin.user.id, { groupIds: [USER_GROUP_ID] });
    expect(store.resolveWebSession(token)).toBeNull();
    expect(store.hasAdminUser()).toBe(true);
    expect(second.permissions).toContain("users.write");
  });

  it("normalizes legacy admin groups to the current full permission set", () => {
    const now = new Date().toISOString();
    writeFileSync(path.join(home, "users.json"), JSON.stringify({
      version: 1,
      users: [{
        id: "legacy-admin",
        email: "legacy@example.com",
        displayName: "Legacy Admin",
        passwordHash: "hash",
        passwordSalt: "salt",
        active: true,
        createdAt: now,
        updatedAt: now,
      }],
      groups: [{
        id: ADMIN_GROUP_ID,
        name: "Admin",
        description: "Old admin group",
        permissions: ["inspect", "sessions.read"],
        system: true,
        agentIds: [],
        workspaceRoots: [],
        telegramChatIds: [],
        discordChannelIds: [],
        slackChannelIds: [],
        createdAt: now,
        updatedAt: now,
      }],
      userGroups: [{ userId: "legacy-admin", groupId: ADMIN_GROUP_ID }],
      telegramIdentities: [],
      telegramChats: [],
      discordIdentities: [],
      discordChannels: [],
      slackIdentities: [],
      slackChannels: [],
      webSessions: [],
      telegramLinkCodes: [],
      discordLinkCodes: [],
      slackLinkCodes: [],
    }), "utf8");

    const admin = store.getUserByEmail("legacy@example.com");
    expect(admin?.permissions.sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it("supports group scopes for agents, workspaces, and Telegram chats", () => {
    const group = store.createGroup({
      name: "Scoped Operators",
      permissions: ["inspect", "sessions.read"],
      agentIds: ["codex"],
      workspaceRoots: [home],
      telegramChatIds: [-100],
      discordChannelIds: ["123"],
      slackChannelIds: ["C123"],
    });
    const user = store.createUser({
      email: "scoped@example.com",
      displayName: "Scoped",
      password: "password123",
      groupIds: [group.id],
    });

    expect(store.canUseAgent(user, "codex")).toBe(true);
    expect(store.canUseAgent(user, "pi")).toBe(false);
    expect(store.canUseWorkspace(user, path.join(home, "repo"))).toBe(true);
    expect(store.canUseWorkspace(user, path.join(tmpdir(), "other"))).toBe(false);
    expect(store.canUseTelegramChat(user, -100)).toBe(true);
    expect(store.canUseTelegramChat(user, -101)).toBe(false);
    expect(store.canUseDiscordChannel(user, "123")).toBe(true);
    expect(store.canUseDiscordChannel(user, "456")).toBe(false);
    expect(store.canUseSlackChannel(user, "C123")).toBe(true);
    expect(store.canUseSlackChannel(user, "C456")).toBe(false);
    expect(() => store.createGroup({ name: "Bad", permissions: ["not.real"] })).toThrow("Unknown permission");
  });

  it("uses groups and channel access for Discord guild authorization", () => {
    const readonly = store.createUser({
      email: "discord-read@example.com",
      displayName: "Discord Read",
      password: "password123",
      groupIds: [READONLY_GROUP_ID],
      discordUserId: "100",
    });
    const operator = store.createUser({
      email: "discord-operator@example.com",
      displayName: "Discord Operator",
      password: "password123",
      groupIds: [USER_GROUP_ID],
      discordUserId: "101",
    });

    store.registerDiscordChannel({ guildId: "guild", channelId: "general" });
    expect(store.isDiscordChannelAllowed({ guildId: "guild", channelId: "general" }, operator)).toBe(true);
    expect(store.isDiscordChannelAllowed({ guildId: "guild", channelId: "general" }, readonly)).toBe(true);

    store.registerDiscordChannel({
      guildId: "guild",
      channelId: "ops",
      allowedGroupIds: [USER_GROUP_ID],
    });

    expect(store.isDiscordChannelAllowed({ guildId: "guild", channelId: "ops" }, operator)).toBe(true);
    expect(store.isDiscordChannelAllowed({ guildId: "guild", channelId: "ops" }, readonly)).toBe(false);
    expect(store.isDiscordChannelAllowed({ channelId: "dm", isDirectMessage: true }, readonly)).toBe(true);
  });

  it("uses groups and channel access for Slack channel authorization", () => {
    const readonly = store.createUser({
      email: "slack-read@example.com",
      displayName: "Slack Read",
      password: "password123",
      groupIds: [READONLY_GROUP_ID],
      slackUserId: "U100",
      slackTeamId: "T123",
    });
    const operator = store.createUser({
      email: "slack-operator@example.com",
      displayName: "Slack Operator",
      password: "password123",
      groupIds: [USER_GROUP_ID],
      slackUserId: "U101",
      slackTeamId: "T123",
    });

    store.registerSlackChannel({ teamId: "T123", channelId: "CGENERAL" });
    expect(store.isSlackChannelAllowed({ teamId: "T123", channelId: "CGENERAL" }, operator)).toBe(true);
    expect(store.isSlackChannelAllowed({ teamId: "T123", channelId: "CGENERAL" }, readonly)).toBe(true);

    store.registerSlackChannel({
      teamId: "T123",
      channelId: "COPS",
      allowedGroupIds: [USER_GROUP_ID],
    });

    expect(store.isSlackChannelAllowed({ teamId: "T123", channelId: "COPS" }, operator)).toBe(true);
    expect(store.isSlackChannelAllowed({ teamId: "T123", channelId: "COPS" }, readonly)).toBe(false);
    expect(store.isSlackChannelAllowed({ channelId: "D123", isDirectMessage: true }, readonly)).toBe(true);
  });
});
