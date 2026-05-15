import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canSendSystemMessagesToDiscordContext,
  isUnauthenticatedDiscordCommandAllowed,
  permissionForDiscordAction,
  requiredPermissionForDiscordCommand,
} from "../src/discord-bot.js";
import { discordCommands, parseDiscordMessageCommand } from "../src/discord-command-surface.js";
import { discordContextKey } from "../src/context-key.js";
import { USER_GROUP_ID } from "../src/access-control.js";
import { UserStore } from "../src/user-management.js";

describe("Discord security boundaries", () => {
  let home: string;
  let store: UserStore;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "nordrelay-discord-security-"));
    store = new UserStore(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("does not allow system mirror or typing messages before an admin exists", () => {
    const contextKey = discordContextKey({ guildId: "guild", channelId: "general" });

    expect(canSendSystemMessagesToDiscordContext(store, contextKey)).toBe(false);
  });

  it("allows Discord DM system messages only for linked active users", () => {
    store.createAdmin({ email: "admin@example.com", displayName: "Admin", password: "password123" });
    const dmContext = discordContextKey({ guildId: "dm-100", channelId: "dm-channel" });

    expect(canSendSystemMessagesToDiscordContext(store, dmContext)).toBe(false);

    store.createUser({
      email: "user@example.com",
      displayName: "User",
      password: "password123",
      groupIds: [USER_GROUP_ID],
      discordUserId: "100",
    });

    expect(canSendSystemMessagesToDiscordContext(store, dmContext)).toBe(true);
  });

  it("allows Discord guild system messages only for registered enabled channels", () => {
    store.createAdmin({ email: "admin@example.com", displayName: "Admin", password: "password123" });
    const contextKey = discordContextKey({ guildId: "guild", channelId: "general" });

    expect(canSendSystemMessagesToDiscordContext(store, contextKey)).toBe(false);

    store.registerDiscordChannel({ guildId: "guild", channelId: "general", enabled: true });

    expect(canSendSystemMessagesToDiscordContext(store, contextKey)).toBe(true);

    const registered = store.snapshot().discordChannels[0];
    store.updateDiscordChannel(registered.id, { enabled: false });

    expect(canSendSystemMessagesToDiscordContext(store, contextKey)).toBe(false);
  });

  it("keeps /link as the only unauthenticated Discord command", () => {
    expect(isUnauthenticatedDiscordCommandAllowed("link")).toBe(true);
    for (const command of ["start", "help", "prompt", "session", "queue", "register_channel"]) {
      expect(isUnauthenticatedDiscordCommandAllowed(command)).toBe(false);
    }
  });

  it("uses the shared channel parser without accepting Telegram bot mentions", () => {
    expect(parseDiscordMessageCommand("/queue cancel abc")).toEqual({ command: "queue", argument: "cancel abc" });
    expect(parseDiscordMessageCommand("/queue@NordRelayBot cancel abc")).toBeNull();
  });

  it("maps Discord commands and button actions to write permissions", () => {
    expect(requiredPermissionForDiscordCommand("prompt", "")).toBe("prompt.send");
    expect(requiredPermissionForDiscordCommand("queue", "")).toBe("queue.read");
    expect(requiredPermissionForDiscordCommand("queue", "cancel abc")).toBe("queue.write");
    expect(permissionForDiscordAction("discord_queue_cancel:ctx:abc")).toBe("queue.write");
    expect(permissionForDiscordAction("discord_abort:ctx")).toBe("prompt.abort");
    expect(permissionForDiscordAction("discord_artifact_send:ctx:turn")).toBe("files.read");
    expect(permissionForDiscordAction("discord_artifact_delete:ctx:turn")).toBe("files.write");
    expect(permissionForDiscordAction("agent-update:cancel:job")).toBe("updates.run");
    expect(permissionForDiscordAction("discord_unknown:ctx")).toBeNull();
  });

  it("registers the shared Discord command surface for Telegram-parity commands", () => {
    const names = new Set(discordCommands().map((command) => String(command.name)));

    for (const command of [
      "auth",
      "login",
      "logout",
      "restart",
      "audit",
      "workspaces",
      "pin",
      "unpin",
      "pinned",
      "handback",
      "progress",
      "launch_profiles",
    ]) {
      expect(names.has(command)).toBe(true);
    }
  });
});
