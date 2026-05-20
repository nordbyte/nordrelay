import { permissionForCommand, type Permission } from "../../access/access-control.js";
import { normalizeChannelCommandName, parseChannelCommand, type ParsedChannelCommand } from "../shared/channel-runtime.js";

export function parseMatrixMessageCommand(text: string, prefix = "!nr"): ParsedChannelCommand | null {
  const trimmed = text.trimStart();
  const slash = parseChannelCommand(trimmed, { allowBotMention: false });
  if (slash) {
    return slash;
  }

  const normalizedPrefix = prefix.trim() || "!nr";
  if (trimmed.toLowerCase().startsWith(`${normalizedPrefix.toLowerCase()} `)) {
    return parsePrefixedCommand(trimmed.slice(normalizedPrefix.length).trim());
  }
  if (trimmed.toLowerCase() === normalizedPrefix.toLowerCase()) {
    return { command: "help", argument: "" };
  }

  const bang = trimmed.match(/^!([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (bang?.[1]) {
    return {
      command: normalizeChannelCommandName(bang[1]),
      argument: bang[2]?.trim() ?? "",
    };
  }
  return null;
}

export function parseMatrixSlashCommand(text: string): ParsedChannelCommand {
  const trimmed = text.trim();
  const parsed = parseMatrixMessageCommand(trimmed);
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

function parsePrefixedCommand(text: string): ParsedChannelCommand {
  if (!text.trim()) {
    return { command: "help", argument: "" };
  }
  const [command = "prompt", ...rest] = text.trim().split(/\s+/);
  return {
    command: normalizeChannelCommandName(command),
    argument: rest.join(" ").trim(),
  };
}

export function requiredPermissionForMatrixCommand(command: string, argument: string): Permission | null {
  const normalized = normalizeChannelCommandName(command);
  if (normalized === "prompt") return "prompt.send";
  if (normalized === "queue") return argument.trim() ? "queue.write" : "queue.read";
  return permissionForCommand(normalized);
}

export function isUnauthenticatedMatrixCommandAllowed(command: string): boolean {
  return normalizeChannelCommandName(command) === "link";
}

export function permissionForMatrixAction(action: string): Permission | null {
  if (action.startsWith("matrix_queue_") || action.startsWith("matrix_peer_queue_")) return "queue.write";
  if (action.startsWith("matrix_abort:")) return "prompt.abort";
  if (action.startsWith("matrix_pick:")) return "sessions.write";
  if (action.startsWith("matrix_artifact_delete:")) return "files.write";
  if (action.startsWith("matrix_artifact_")) return "files.read";
  if (action.startsWith("agent-update:")) return "updates.run";
  return null;
}
