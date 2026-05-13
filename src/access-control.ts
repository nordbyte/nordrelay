import { permissionForWebRequestFromContract } from "./web-api-contract.js";

export type Permission =
  | "inspect"
  | "sessions.read"
  | "sessions.write"
  | "prompt.send"
  | "prompt.abort"
  | "files.read"
  | "files.write"
  | "settings.read"
  | "settings.write"
  | "auth.manage"
  | "diagnostics.read"
  | "logs.read"
  | "logs.clear"
  | "queue.read"
  | "queue.write"
  | "updates.run"
  | "system.restart"
  | "users.read"
  | "users.write"
  | "audit.read";

export const ALL_PERMISSIONS: Permission[] = [
  "inspect",
  "sessions.read",
  "sessions.write",
  "prompt.send",
  "prompt.abort",
  "files.read",
  "files.write",
  "settings.read",
  "settings.write",
  "auth.manage",
  "diagnostics.read",
  "logs.read",
  "logs.clear",
  "queue.read",
  "queue.write",
  "updates.run",
  "system.restart",
  "users.read",
  "users.write",
  "audit.read",
];

export const ADMIN_GROUP_ID = "admin";
export const USER_GROUP_ID = "user";
export const READONLY_GROUP_ID = "readonly";

export interface GroupDefinition {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  system: boolean;
}

export const BUILTIN_GROUPS: GroupDefinition[] = [
  {
    id: ADMIN_GROUP_ID,
    name: "Admin",
    description: "Full access to every NordRelay feature, user management, updates, and system controls.",
    permissions: ALL_PERMISSIONS,
    system: true,
  },
  {
    id: USER_GROUP_ID,
    name: "User",
    description: "Normal read/write use of agents, sessions, prompts, files, and personal agent auth.",
    permissions: [
      "inspect",
      "sessions.read",
      "sessions.write",
      "prompt.send",
      "prompt.abort",
      "files.read",
      "files.write",
      "settings.read",
      "auth.manage",
      "queue.read",
      "queue.write",
    ],
    system: true,
  },
  {
    id: READONLY_GROUP_ID,
    name: "Read Only",
    description: "Read-only access to status, sessions, activity, and artifacts.",
    permissions: [
      "inspect",
      "sessions.read",
      "files.read",
      "settings.read",
    ],
    system: true,
  },
];

const COMMAND_PERMISSIONS = new Map<string, Permission>([
  ["start", "inspect"],
  ["help", "inspect"],
  ["status", "inspect"],
  ["health", "inspect"],
  ["version", "inspect"],
  ["channels", "inspect"],
  ["agents", "inspect"],
  ["tasks", "inspect"],
  ["progress", "inspect"],
  ["activity", "sessions.read"],
  ["auth", "inspect"],
  ["voice", "inspect"],
  ["whoami", "inspect"],
  ["diagnostics", "diagnostics.read"],
  ["logs", "logs.read"],
  ["audit", "audit.read"],
  ["restart", "system.restart"],
  ["update", "updates.run"],
  ["workspaces", "sessions.read"],
  ["session", "sessions.read"],
  ["sessions", "sessions.read"],
  ["pinned", "sessions.read"],
  ["locks", "sessions.read"],
  ["queue", "queue.read"],
  ["artifacts", "files.read"],
  ["agent", "settings.write"],
  ["mirror", "settings.write"],
  ["notify", "settings.write"],
  ["launch", "settings.write"],
  ["launch_profiles", "settings.write"],
  ["launch-profiles", "settings.write"],
  ["fast", "settings.write"],
  ["model", "settings.write"],
  ["reasoning", "settings.write"],
  ["effort", "settings.write"],
  ["login", "auth.manage"],
  ["logout", "auth.manage"],
  ["new", "sessions.write"],
  ["switch", "sessions.write"],
  ["attach", "sessions.write"],
  ["handback", "sessions.write"],
  ["sync", "sessions.write"],
  ["pin", "sessions.write"],
  ["unpin", "sessions.write"],
  ["lock", "sessions.write"],
  ["unlock", "sessions.write"],
  ["retry", "prompt.send"],
  ["clearqueue", "queue.write"],
  ["cancel", "queue.write"],
  ["abort", "prompt.abort"],
  ["stop", "prompt.abort"],
  ["register_chat", "users.write"],
  ["chat_access", "users.write"],
  ["link", "inspect"],
]);

export function permissionForCommand(command: string | undefined): Permission | null {
  if (!command) {
    return null;
  }
  return COMMAND_PERMISSIONS.get(command.toLowerCase()) ?? null;
}

export function permissionForCallbackData(callbackData: string | undefined): Permission | null {
  if (!callbackData) {
    return null;
  }
  if (callbackData === "noop_page") {
    return "inspect";
  }
  if (/^(sess_|ws_)/.test(callbackData)) {
    return "sessions.write";
  }
  if (/^(launch_|launchconfirm_|model_|effort_|agent_)/.test(callbackData)) {
    return "settings.write";
  }
  if (callbackData.startsWith("upd_")) {
    return "updates.run";
  }
  if (callbackData.startsWith("approval_") || callbackData.startsWith("codex_abort:") || callbackData.startsWith("agent_abort:")) {
    return "prompt.abort";
  }
  if (callbackData.startsWith("queue_")) {
    return "queue.write";
  }
  if (callbackData.startsWith("artifact_delete")) {
    return "files.write";
  }
  if (callbackData.startsWith("artifact_")) {
    return "files.read";
  }
  return null;
}

export function permissionForWebRequest(method: string | undefined, pathname: string): Permission | null {
  return permissionForWebRequestFromContract(method, pathname);
}

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as string[]).includes(value);
}
