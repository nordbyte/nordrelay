import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ADMIN_GROUP_ID, READONLY_GROUP_ID, USER_GROUP_ID } from "../src/access-control.js";
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

  it("supports group scopes for agents, workspaces, and Telegram chats", () => {
    const group = store.createGroup({
      name: "Scoped Operators",
      permissions: ["inspect", "sessions.read"],
      agentIds: ["codex"],
      workspaceRoots: [home],
      telegramChatIds: [-100],
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
    expect(() => store.createGroup({ name: "Bad", permissions: ["not.real"] })).toThrow("Unknown permission");
  });
});
