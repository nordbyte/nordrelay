import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canSendSystemMessagesToDiscordContext,
  isUnauthenticatedDiscordCommandAllowed,
  permissionForDiscordAction,
  requiredPermissionForDiscordCommand,
} from "../src/channels/discord/discord-bot.js";
import { discordCommands, parseDiscordMessageCommand } from "../src/channels/discord/discord-command-surface.js";
import { capDiscordCommandReplyChunks, renderDiscordSessionPageAction, renderDiscordSessionList } from "../src/channels/discord/discord-sessions.js";
import { discordContextKey } from "../src/channels/shared/context-key.js";
import { USER_GROUP_ID } from "../src/access/access-control.js";
import { UserStore } from "../src/access/user-management.js";

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
    expect(permissionForDiscordAction("discord_peer_queue_cancel:peer:abc")).toBe("queue.write");
    expect(permissionForDiscordAction("discord_abort:ctx")).toBe("prompt.abort");
    expect(permissionForDiscordAction("discord_sessions_page:pick:next")).toBe("sessions.read");
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

  it("truncates Discord session lists and command replies to prevent message floods", () => {
    const longPrompt = "old session message ".repeat(500);
    const rendered = renderDiscordSessionList("Sessions", [{
      id: "019e20f7-e05b-7df3-8c1c-80d1f99850ab",
      title: longPrompt,
      cwd: `/workspace/${"deep-path/".repeat(80)}`,
      firstUserMessage: longPrompt,
    }]);

    expect(rendered).toContain("Sessions:");
    expect(rendered).toContain("old session message");
    expect(rendered.length).toBeLessThan(500);
    expect(rendered).not.toContain(longPrompt);

    const capped = capDiscordCommandReplyChunks(Array.from({ length: 100 }, (_, index) => `chunk-${index}`), 5);
    expect(capped).toHaveLength(5);
    expect(capped[4]).toContain("Output truncated");
    expect(capped.join("\n")).not.toContain("chunk-99");
  });

  it("renders paginated Discord session controls within component limits", () => {
    const records = Array.from({ length: 50 }, (_, index) => ({
      id: `thread-${index + 1}`,
      title: `Session ${index + 1}`,
      cwd: `/workspace/project-${index + 1}`,
      firstUserMessage: `Prompt ${index + 1}`,
    }));

    const first = renderDiscordSessionPageAction("Sessions", records, "pick123", 0, 10);
    expect(first.text).toContain("Sessions (1-10 of 50, page 1/5):");
    expect(first.text).toContain("1. Session 1");
    expect(first.text).not.toContain("11. Session 11");
    expect(first.buttons.length).toBeLessThanOrEqual(5);
    expect(first.buttons.flat()).toContainEqual({ label: "Next", action: "discord_sessions_page:pick123:next" });
    expect(first.buttons.flat()).not.toContainEqual({ label: "Previous", action: "discord_sessions_page:pick123:prev" });
    expect(first.buttons.flat()).toContainEqual({ label: "Session 10", action: "discord_pick:pick123:9" });

    const second = renderDiscordSessionPageAction("Sessions", records, "pick123", 1, 10);
    expect(second.text).toContain("Sessions (11-20 of 50, page 2/5):");
    expect(second.buttons.flat()).toContainEqual({ label: "Previous", action: "discord_sessions_page:pick123:prev" });
    expect(second.buttons.flat()).toContainEqual({ label: "Refresh", action: "discord_sessions_page:pick123:refresh" });
    expect(second.buttons.flat()).toContainEqual({ label: "Next", action: "discord_sessions_page:pick123:next" });
    expect(second.buttons.flat()).toContainEqual({ label: "Session 11", action: "discord_pick:pick123:10" });
  });
});
