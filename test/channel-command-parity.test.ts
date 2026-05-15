import { describe, expect, it } from "vitest";

import { permissionForCommand } from "../src/access-control.js";
import {
  discordCommands,
  isUnauthenticatedDiscordCommandAllowed,
  requiredPermissionForDiscordCommand,
} from "../src/discord-command-surface.js";
import { TELEGRAM_COMMANDS } from "../src/telegram-command-menu.js";

const DISCORD_ONLY_COMMANDS = new Set(["prompt"]);

function normalizeTransportCommand(command: string): string {
  return command === "register_channel" ? "register_chat" : command;
}

describe("channel command parity", () => {
  it("keeps Telegram and Discord command surfaces aligned", () => {
    const telegram = new Set(TELEGRAM_COMMANDS.map((command) => normalizeTransportCommand(command.command)));
    const discord = new Set(
      discordCommands()
        .map((command) => normalizeTransportCommand(String(command.name)))
        .filter((command) => !DISCORD_ONLY_COMMANDS.has(command)),
    );

    expect([...telegram].sort()).toEqual([...discord].sort());
  });

  it("has access-control permissions for every advertised channel command", () => {
    const advertised = new Set([
      ...TELEGRAM_COMMANDS.map((command) => command.command),
      ...discordCommands().map((command) => String(command.name)),
    ]);

    for (const command of advertised) {
      if (DISCORD_ONLY_COMMANDS.has(command)) {
        expect(requiredPermissionForDiscordCommand(command, "hello")).toBe("prompt.send");
      } else {
        expect(permissionForCommand(command), command).not.toBeNull();
      }
    }
  });

  it("keeps Discord command permissions and unauthenticated allow-list narrow", () => {
    for (const command of discordCommands().map((entry) => String(entry.name))) {
      if (command === "prompt") {
        expect(requiredPermissionForDiscordCommand(command, "hello")).toBe("prompt.send");
      } else if (command === "queue") {
        expect(requiredPermissionForDiscordCommand(command, "")).toBe("queue.read");
        expect(requiredPermissionForDiscordCommand(command, "cancel abc123")).toBe("queue.write");
      } else {
        expect(requiredPermissionForDiscordCommand(command, "")).toBe(permissionForCommand(command));
      }
      expect(isUnauthenticatedDiscordCommandAllowed(command)).toBe(command === "link");
    }
  });
});
