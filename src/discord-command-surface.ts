import type { APIApplicationCommandOption, ChatInputCommandInteraction } from "discord.js";

import { permissionForCommand, type Permission } from "./access-control.js";

export function parseDiscordMessageCommand(text: string): { command: string; argument: string } | null {
  const match = text.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  return match?.[1] ? { command: match[1].toLowerCase(), argument: match[2]?.trim() ?? "" } : null;
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
  if (command === "prompt") return "prompt.send";
  if (command === "queue") return argument.trim() ? "queue.write" : "queue.read";
  return permissionForCommand(command);
}

export function isUnauthenticatedDiscordCommandAllowed(command: string): boolean {
  return command === "link";
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
  const textOption = (name = "value", description = "Value", required = false): APIApplicationCommandOption => ({
    type: 3,
    name,
    description,
    required,
  });
  return [
    command("start", "Start or inspect the current NordRelay context"),
    command("help", "Show Discord adapter help"),
    command("prompt", "Send a prompt to the selected agent", [textOption("text", "Prompt text", true)]),
    command("agent", "Select or show the active agent", [textOption("value", "Agent id")]),
    command("auth", "Show selected agent auth status"),
    command("login", "Start selected agent login"),
    command("logout", "Sign out of the selected agent"),
    command("session", "Show the active session"),
    command("sessions", "Browse recent sessions", [textOption("query", "Search query")]),
    command("new", "Create a new session", [textOption("value", "Workspace path")]),
    command("switch", "Switch to a session", [textOption("thread_id", "Thread id", true)]),
    command("attach", "Attach a session", [textOption("thread_id", "Thread id", true)]),
    command("handback", "Hand the active session back to the native CLI"),
    command("model", "Select or show models", [textOption("value", "Model id")]),
    command("reasoning", "Select reasoning effort", [textOption("value", "Reasoning value")]),
    command("effort", "Select reasoning effort", [textOption("value", "Reasoning value")]),
    command("fast", "Toggle fast mode", [textOption("value", "on/off")]),
    command("launch", "Select launch profile", [textOption("value", "Launch profile id")]),
    command("launch_profiles", "Select launch profile", [textOption("value", "Launch profile id")]),
    command("workspaces", "List allowed workspaces"),
    command("pin", "Pin current or given thread", [textOption("value", "Thread id")]),
    command("unpin", "Unpin current or given thread", [textOption("value", "Thread id")]),
    command("pinned", "Show pinned threads"),
    command("queue", "Show or manage queue", [textOption("action", "pause/resume/clear/run/cancel/top/up/down"), textOption("id", "Queue id")]),
    command("clearqueue", "Clear queue"),
    command("cancel", "Cancel queued prompt", [textOption("value", "Queue id", true)]),
    command("abort", "Abort the active task"),
    command("stop", "Abort the active task"),
    command("retry", "Retry the last prompt"),
    command("sync", "Sync from local agent state"),
    command("activity", "Show recent activity", [textOption("value", "Limit")]),
    command("tasks", "Show recent tasks", [textOption("value", "Limit")]),
    command("progress", "Show current turn progress"),
    command("audit", "Show recent audit events", [textOption("value", "Limit")]),
    command("artifacts", "List or send artifacts", [textOption("value", "zip <turn-id>")]),
    command("logs", "Show logs", [textOption("value", "Target and line count")]),
    command("version", "Show versions"),
    command("status", "Show status"),
    command("health", "Show health"),
    command("diagnostics", "Show diagnostics"),
    command("support", "Show support diagnostics"),
    command("restart", "Restart NordRelay"),
    command("update", "Update NordRelay or agents", [
      textOption("target", "jobs, install, log, cancel, input, or agent id"),
      textOption("agent", "Agent id or job id"),
      textOption("input", "Text for update input"),
    ]),
    command("lock", "Lock this context"),
    command("unlock", "Unlock this context"),
    command("locks", "List locks"),
    command("mirror", "Set mirror mode", [textOption("value", "off/status/final/full")]),
    command("notify", "Set notification mode", [textOption("value", "off/minimal/all")]),
    command("voice", "Show or change voice settings", [textOption("value", "transcribe-only on/off")]),
    command("register_channel", "Enable this Discord channel for NordRelay"),
    command("link", "Link this Discord account with a NordRelay code", [textOption("value", "Link code", true)]),
    command("whoami", "Show linked NordRelay user"),
    command("channels", "Show channel adapters"),
    command("agents", "Show agent adapters"),
  ];
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
