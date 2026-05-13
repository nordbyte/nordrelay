import type { Permission } from "./access-control.js";

export type WebHttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

type WebPermissionRule =
  | Permission
  | {
      read: Permission;
      write: Permission;
    };

export interface WebApiRouteRule {
  path?: string;
  prefix?: string;
  permissions: WebPermissionRule;
}

export const WEB_API_ROUTES: WebApiRouteRule[] = [
  ...exact(["/api/bootstrap", "/api/health", "/api/snapshot", "/api/tasks", "/api/progress"], "inspect"),
  ...exact(["/api/version", "/api/adapters/health"], "inspect"),
  ...exact(["/api/diagnostics"], "diagnostics.read"),
  ...prefix(["/api/users", "/api/groups", "/api/telegram-chats"], readWrite("users.read", "users.write")),
  ...exact(["/api/permissions"], "users.read"),
  ...exact(["/api/audit"], "audit.read"),
  ...exact(["/api/control-options"], "settings.read"),
  ...exact(["/api/settings"], readWrite("settings.read", "settings.write")),
  ...exact(["/api/update"], "updates.run"),
  ...prefix(["/api/agent-update"], "updates.run"),
  ...exact(["/api/logs"], "logs.read"),
  ...exact(["/api/logs/clear"], "logs.clear"),
  ...exact(["/api/runtime/restart"], "system.restart"),
  ...prefix(["/api/sessions"], readWrite("sessions.read", "sessions.write")),
  ...exact(["/api/agent", "/api/sync", "/api/handback", "/api/locks"], readWrite("sessions.read", "sessions.write")),
  ...prefix(["/api/auth/"], readWrite("inspect", "auth.manage")),
  ...prefix(["/api/models", "/api/session/"], readWrite("settings.read", "settings.write")),
  ...exact(["/api/queue"], readWrite("queue.read", "queue.write")),
  ...exact(["/api/prompt", "/api/prompt/upload", "/api/retry"], readWrite("inspect", "prompt.send")),
  ...exact(["/api/abort", "/api/stop"], "prompt.abort"),
  ...prefix(["/api/chat"], readWrite("sessions.read", "sessions.write")),
  ...prefix(["/api/activity"], "sessions.read"),
  ...prefix(["/api/artifacts"], readWrite("files.read", "files.write")),
];

export function permissionForWebRequestFromContract(method: string | undefined, pathname: string): Permission | null {
  const verb = normalizeMethod(method);
  const rule = WEB_API_ROUTES.find((candidate) =>
    (candidate.path !== undefined && candidate.path === pathname) ||
    (candidate.prefix !== undefined && pathname.startsWith(candidate.prefix))
  );
  if (!rule) {
    return null;
  }
  return resolvePermission(rule.permissions, verb);
}

function exact(paths: string[], permissions: WebPermissionRule): WebApiRouteRule[] {
  return paths.map((path) => ({ path, permissions }));
}

function prefix(prefixes: string[], permissions: WebPermissionRule): WebApiRouteRule[] {
  return prefixes.map((pathPrefix) => ({ prefix: pathPrefix, permissions }));
}

function readWrite(read: Permission, write: Permission): WebPermissionRule {
  return { read, write };
}

function resolvePermission(rule: WebPermissionRule, verb: WebHttpMethod): Permission {
  if (typeof rule === "string") {
    return rule;
  }
  return verb === "GET" ? rule.read : rule.write;
}

function normalizeMethod(method: string | undefined): WebHttpMethod {
  const upper = (method ?? "GET").toUpperCase();
  if (upper === "GET" || upper === "POST" || upper === "PATCH" || upper === "PUT" || upper === "DELETE") {
    return upper;
  }
  return "GET";
}
