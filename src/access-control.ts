export type TelegramRole = "admin" | "operator" | "readonly";

export type TelegramPermission =
  | "inspect"
  | "sessions"
  | "prompt"
  | "files"
  | "settings"
  | "auth"
  | "admin";

export type TelegramRolePolicies = Record<TelegramRole, Set<TelegramPermission>>;

const ALL_PERMISSIONS: TelegramPermission[] = [
  "inspect",
  "sessions",
  "prompt",
  "files",
  "settings",
  "auth",
  "admin",
];

const COMMAND_PERMISSIONS = new Map<string, TelegramPermission>([
  ["start", "inspect"],
  ["help", "inspect"],
  ["status", "inspect"],
  ["health", "inspect"],
  ["version", "inspect"],
  ["diagnostics", "admin"],
  ["tasks", "inspect"],
  ["progress", "inspect"],
  ["activity", "inspect"],
  ["mirror", "settings"],
  ["notify", "settings"],
  ["workspaces", "sessions"],
  ["voice", "inspect"],
  ["session", "sessions"],
  ["sessions", "sessions"],
  ["switch", "sessions"],
  ["pinned", "sessions"],
  ["pin", "sessions"],
  ["unpin", "sessions"],
  ["attach", "sessions"],
  ["handback", "sessions"],
  ["new", "sessions"],
  ["sync", "sessions"],
  ["queue", "inspect"],
  ["cancel", "prompt"],
  ["clearqueue", "prompt"],
  ["retry", "prompt"],
  ["abort", "prompt"],
  ["stop", "prompt"],
  ["artifacts", "files"],
  ["launch", "settings"],
  ["launch_profiles", "settings"],
  ["launch-profiles", "settings"],
  ["fast", "settings"],
  ["model", "settings"],
  ["reasoning", "settings"],
  ["effort", "settings"],
  ["auth", "inspect"],
  ["login", "auth"],
  ["logout", "auth"],
  ["logs", "admin"],
  ["restart", "admin"],
  ["update", "admin"],
]);

export function createDefaultRolePolicies(): TelegramRolePolicies {
  return {
    admin: new Set(ALL_PERMISSIONS),
    operator: new Set(["inspect", "sessions", "prompt", "files", "settings", "auth"]),
    readonly: new Set(["inspect", "sessions"]),
  };
}

export function parseRolePoliciesJson(raw: string | undefined): TelegramRolePolicies {
  const policies = createDefaultRolePolicies();
  if (!raw) {
    return policies;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid TELEGRAM_ROLE_POLICIES_JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TELEGRAM_ROLE_POLICIES_JSON must be an object keyed by role");
  }

  for (const [role, rawPermissions] of Object.entries(parsed)) {
    if (!isTelegramRole(role)) {
      throw new Error(`Invalid TELEGRAM_ROLE_POLICIES_JSON role: ${role}`);
    }

    policies[role] = parsePermissionList(rawPermissions, role);
  }

  if (!policies.admin.has("admin")) {
    policies.admin.add("admin");
  }

  return policies;
}

export function hasTelegramPermission(
  policies: TelegramRolePolicies,
  role: TelegramRole,
  permission: TelegramPermission,
): boolean {
  return policies[role].has(permission) || policies[role].has("admin");
}

export function permissionForCommand(command: string | undefined): TelegramPermission {
  if (!command) {
    return "inspect";
  }

  return COMMAND_PERMISSIONS.get(command.toLowerCase()) ?? "inspect";
}

export function permissionForCallbackData(callbackData: string | undefined): TelegramPermission {
  if (!callbackData) {
    return "inspect";
  }

  if (callbackData === "noop_page") {
    return "inspect";
  }
  if (/^(sess_|ws_)/.test(callbackData)) {
    return "sessions";
  }
  if (/^(launch_|launchconfirm_|model_|effort_)/.test(callbackData)) {
    return "settings";
  }
  if (callbackData.startsWith("approval_") || callbackData.startsWith("codex_abort:")) {
    return "prompt";
  }
  if (callbackData.startsWith("queue_")) {
    return "prompt";
  }
  if (callbackData.startsWith("artifact_")) {
    return "files";
  }

  return "inspect";
}

export function isTelegramRole(value: string): value is TelegramRole {
  return value === "admin" || value === "operator" || value === "readonly";
}

function parsePermissionList(rawPermissions: unknown, role: TelegramRole): Set<TelegramPermission> {
  if (rawPermissions === "*") {
    return new Set(ALL_PERMISSIONS);
  }
  if (!Array.isArray(rawPermissions)) {
    throw new Error(`TELEGRAM_ROLE_POLICIES_JSON.${role} must be an array or "*"`);
  }

  const permissions = new Set<TelegramPermission>();
  for (const rawPermission of rawPermissions) {
    if (rawPermission === "*") {
      return new Set(ALL_PERMISSIONS);
    }
    if (typeof rawPermission !== "string" || !isTelegramPermission(rawPermission)) {
      throw new Error(`Invalid TELEGRAM_ROLE_POLICIES_JSON permission for ${role}: ${String(rawPermission)}`);
    }
    permissions.add(rawPermission);
  }

  return permissions;
}

function isTelegramPermission(value: string): value is TelegramPermission {
  return ALL_PERMISSIONS.includes(value as TelegramPermission);
}
