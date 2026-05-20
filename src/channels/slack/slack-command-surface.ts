import { permissionForCommand, type Permission } from "../../access/access-control.js";
import { normalizeChannelCommandName, parseChannelCommand, type ParsedChannelCommand } from "../shared/channel-runtime.js";

export function parseSlackMessageCommand(text: string): ParsedChannelCommand | null {
  return parseChannelCommand(text, { allowBotMention: false });
}

export function parseSlackSlashCommand(text: string): ParsedChannelCommand {
  const trimmed = text.trim();
  const parsed = parseSlackMessageCommand(trimmed);
  if (parsed) {
    return parsed;
  }
  const [command = "prompt", ...rest] = trimmed.split(/\s+/);
  if (!trimmed) {
    return { command: "help", argument: "" };
  }
  return {
    command: normalizeChannelCommandName(command),
    argument: rest.join(" ").trim(),
  };
}

export function requiredPermissionForSlackCommand(command: string, argument: string): Permission | null {
  const normalized = normalizeChannelCommandName(command);
  if (normalized === "prompt") return "prompt.send";
  if (normalized === "queue") return argument.trim() ? "queue.write" : "queue.read";
  return permissionForCommand(normalized);
}

export function isUnauthenticatedSlackCommandAllowed(command: string): boolean {
  return normalizeChannelCommandName(command) === "link";
}

export function permissionForSlackAction(action: string): Permission | null {
  if (action.startsWith("slack_queue_") || action.startsWith("slack_peer_queue_")) return "queue.write";
  if (action.startsWith("slack_abort:")) return "prompt.abort";
  if (action.startsWith("slack_pick:")) return "sessions.write";
  if (action.startsWith("slack_artifact_delete:")) return "files.write";
  if (action.startsWith("slack_artifact_")) return "files.read";
  if (action.startsWith("agent-update:")) return "updates.run";
  return null;
}
