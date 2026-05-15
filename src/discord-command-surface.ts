import type { APIApplicationCommandOption, ChatInputCommandInteraction } from "discord.js";

import { permissionForCommand, type Permission } from "./access-control.js";
import { discordCommandCatalog } from "./channel-command-catalog.js";
import { normalizeChannelCommandName, parseChannelCommand, type ParsedChannelCommand } from "./channel-runtime.js";

export function parseDiscordMessageCommand(text: string): ParsedChannelCommand | null {
  return parseChannelCommand(text, { allowBotMention: false });
}

export function argumentFromDiscordInteraction(interaction: ChatInputCommandInteraction): string {
  if (interaction.commandName === "prompt") {
    return interaction.options.getString("text") ?? "";
  }
  if (interaction.commandName === "queue") {
    return [interaction.options.getString("action"), interaction.options.getString("id")].filter(Boolean).join(" ");
  }
  if (interaction.commandName === "update") {
    return [interaction.options.getString("target"), interaction.options.getString("agent"), interaction.options.getString("input")].filter(Boolean).join(" ");
  }
  return interaction.options.getString("value") ?? interaction.options.getString("query") ?? interaction.options.getString("thread_id") ?? "";
}

export function requiredPermissionForDiscordCommand(command: string, argument: string): Permission | null {
  const normalized = normalizeChannelCommandName(command);
  if (normalized === "prompt") return "prompt.send";
  if (normalized === "queue") return argument.trim() ? "queue.write" : "queue.read";
  return permissionForCommand(normalized);
}

export function isUnauthenticatedDiscordCommandAllowed(command: string): boolean {
  return normalizeChannelCommandName(command) === "link";
}

export function permissionForDiscordAction(action: string): Permission | null {
  if (action.startsWith("discord_queue_")) return "queue.write";
  if (action.startsWith("discord_abort:")) return "prompt.abort";
  if (action.startsWith("discord_pick:")) return "sessions.write";
  if (action.startsWith("discord_artifact_delete:")) return "files.write";
  if (action.startsWith("discord_artifact_")) return "files.read";
  if (action.startsWith("agent-update:")) return "updates.run";
  return null;
}

export function discordCommands(): Array<Record<string, unknown>> {
  return discordCommandCatalog()
    .map((entry) => command(entry.name, entry.description, entry.options as APIApplicationCommandOption[]));
}

function command(name: string, description: string, options: APIApplicationCommandOption[] = []): Record<string, unknown> {
  return {
    name,
    description,
    type: 1,
    dm_permission: true,
    options,
  };
}
