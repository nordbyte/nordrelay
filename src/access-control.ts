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
  | "logs.read"
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
  "logs.read",
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
  ["diagnostics", "logs.read"],
  ["logs", "logs.read"],
  ["audit", "audit.read"],
  ["restart", "system.restart"],
  ["update", "updates.run"],
  ["workspaces", "sessions.read"],
  ["session", "sessions.read"],
  ["sessions", "sessions.read"],
  ["pinned", "sessions.read"],
  ["locks", "sessions.read"],
  ["queue", "inspect"],
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
  ["clearqueue", "prompt.send"],
  ["cancel", "prompt.send"],
  ["abort", "prompt.abort"],
  ["stop", "prompt.abort"],
  ["register_chat", "users.write"],
  ["chat_access", "users.write"],
  ["link", "inspect"],
]);

export function permissionForCommand(command: string | undefined): Permission {
  if (!command) {
    return "inspect";
  }
  return COMMAND_PERMISSIONS.get(command.toLowerCase()) ?? "inspect";
}

export function permissionForCallbackData(callbackData: string | undefined): Permission {
  if (!callbackData) {
    return "inspect";
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
    return "prompt.send";
  }
  if (callbackData.startsWith("artifact_delete")) {
    return "files.write";
  }
  if (callbackData.startsWith("artifact_")) {
    return "files.read";
  }
  return "inspect";
}

export function permissionForWebRequest(method: string | undefined, pathname: string): Permission {
  const verb = (method ?? "GET").toUpperCase();
  if (pathname === "/api/bootstrap" || pathname === "/api/health" || pathname === "/api/snapshot" || pathname === "/api/tasks" || pathname === "/api/progress") {
    return "inspect";
  }
  if (pathname === "/api/version" || pathname === "/api/adapters/health" || pathname === "/api/diagnostics") {
    return "inspect";
  }
  if (pathname.startsWith("/api/users") || pathname.startsWith("/api/groups") || pathname.startsWith("/api/telegram-chats")) {
    return verb === "GET" ? "users.read" : "users.write";
  }
  if (pathname === "/api/permissions" || pathname === "/api/audit") {
    return pathname === "/api/audit" ? "audit.read" : "users.read";
  }
  if (pathname === "/api/settings") {
    return verb === "GET" ? "settings.read" : "settings.write";
  }
  if (pathname === "/api/update" || pathname.startsWith("/api/agent-update")) {
    return verb === "GET" ? "updates.run" : "updates.run";
  }
  if (pathname === "/api/logs" || pathname === "/api/logs/clear") {
    return "logs.read";
  }
  if (pathname === "/api/runtime/restart") {
    return "system.restart";
  }
  if (pathname.startsWith("/api/sessions") || pathname === "/api/agent" || pathname === "/api/sync" || pathname === "/api/handback" || pathname === "/api/locks") {
    return verb === "GET" ? "sessions.read" : "sessions.write";
  }
  if (pathname.startsWith("/api/auth/")) {
    return verb === "GET" ? "inspect" : "auth.manage";
  }
  if (pathname.startsWith("/api/models") || pathname.startsWith("/api/session/")) {
    return verb === "GET" ? "settings.read" : "settings.write";
  }
  if (pathname === "/api/prompt" || pathname === "/api/prompt/upload" || pathname === "/api/retry" || pathname === "/api/queue") {
    return verb === "GET" ? "inspect" : "prompt.send";
  }
  if (pathname === "/api/abort" || pathname === "/api/stop") {
    return "prompt.abort";
  }
  if (pathname.startsWith("/api/chat")) {
    return verb === "GET" ? "sessions.read" : "sessions.write";
  }
  if (pathname.startsWith("/api/activity")) {
    return "sessions.read";
  }
  if (pathname.startsWith("/api/artifacts")) {
    return verb === "GET" ? "files.read" : "files.write";
  }
  return "inspect";
}

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as string[]).includes(value);
}
