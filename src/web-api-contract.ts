import type { Permission } from "./access-control.js";

export type WebHttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

type WebPermissionRule =
  | Permission
  | {
      read: Permission;
      write: Permission;
    };

export interface WebApiRouteDefinition<
  Path extends string = string,
  Methods extends readonly WebHttpMethod[] = readonly WebHttpMethod[],
> {
  path: Path;
  methods: Methods;
  permissions: WebPermissionRule;
  pattern?: string;
  dynamicType?: string;
}

const stringToken = "${string}";

export const WEB_API_ROUTE_DEFINITIONS = [
  exact("/api/auth/me", ["GET"], "inspect"),
  exact("/api/dashboard/logout", ["POST"], "inspect"),
  exact("/api/bootstrap", ["GET"], "inspect"),
  exact("/api/health", ["GET"], "inspect"),
  exact("/api/snapshot", ["GET"], "inspect"),
  exact("/api/tasks", ["GET"], "inspect"),
  exact("/api/progress", ["GET"], "inspect"),
  exact("/api/version", ["GET"], "inspect"),
  exact("/api/update", ["POST"], "updates.run"),
  exact("/api/agent-updates", ["GET"], "updates.run"),
  exact("/api/agent-update", ["POST"], "updates.run"),
  dynamic("/api/agent-update/:id/log", "^/api/agent-update/[^/]+/log$", ["GET", "DELETE"], "updates.run", `/api/agent-update/${stringToken}/log`),
  dynamic("/api/agent-update/:id/input", "^/api/agent-update/[^/]+/input$", ["POST"], "updates.run", `/api/agent-update/${stringToken}/input`),
  dynamic("/api/agent-update/:id/cancel", "^/api/agent-update/[^/]+/cancel$", ["POST"], "updates.run", `/api/agent-update/${stringToken}/cancel`),
  exact("/api/adapters/health", ["GET"], "inspect"),
  exact("/api/permissions", ["GET"], "users.read"),
  exact("/api/users", ["GET", "POST"], readWrite("users.read", "users.write")),
  dynamic("/api/users/:id", "^/api/users/[^/]+$", ["PATCH"], "users.write", `/api/users/${stringToken}`),
  dynamic("/api/users/:id/password", "^/api/users/[^/]+/password$", ["POST"], "users.write", `/api/users/${stringToken}/password`),
  dynamic("/api/users/:id/sessions", "^/api/users/[^/]+/sessions$", ["GET", "DELETE"], readWrite("users.read", "users.write"), `/api/users/${stringToken}/sessions`),
  dynamic("/api/users/:id/sessions/:sessionId", "^/api/users/[^/]+/sessions/[^/]+$", ["DELETE"], "users.write", `/api/users/${stringToken}/sessions/${stringToken}`),
  dynamic("/api/users/:id/telegram", "^/api/users/[^/]+/telegram$", ["POST"], "users.write", `/api/users/${stringToken}/telegram`),
  dynamic("/api/users/:id/telegram/:identityId", "^/api/users/[^/]+/telegram/[^/]+$", ["DELETE"], "users.write", `/api/users/${stringToken}/telegram/${stringToken}`),
  exact("/api/groups", ["GET", "POST"], readWrite("users.read", "users.write")),
  dynamic("/api/groups/:id", "^/api/groups/[^/]+$", ["PATCH"], "users.write", `/api/groups/${stringToken}`),
  exact("/api/telegram-chats", ["GET", "POST"], readWrite("users.read", "users.write")),
  dynamic("/api/telegram-chats/:id", "^/api/telegram-chats/[^/]+$", ["PATCH"], "users.write", `/api/telegram-chats/${stringToken}`),
  exact("/api/audit", ["GET"], "audit.read"),
  exact("/api/locks", ["GET", "POST", "DELETE"], readWrite("sessions.read", "sessions.write")),
  exact("/api/auth/status", ["GET"], "inspect"),
  exact("/api/auth/login", ["POST"], "auth.manage"),
  exact("/api/auth/logout", ["POST"], "auth.manage"),
  exact("/api/settings", ["GET", "PATCH"], readWrite("settings.read", "settings.write")),
  exact("/api/control-options", ["GET"], "settings.read"),
  exact("/api/sessions", ["GET"], "sessions.read"),
  exact("/api/sessions/new", ["POST"], "sessions.write"),
  exact("/api/sessions/switch", ["POST"], "sessions.write"),
  exact("/api/sessions/attach", ["POST"], "sessions.write"),
  exact("/api/sessions/detail", ["GET"], "sessions.read"),
  exact("/api/agent", ["POST"], "sessions.write"),
  exact("/api/models", ["GET"], "settings.read"),
  exact("/api/session/model", ["POST"], "settings.write"),
  exact("/api/session/reasoning", ["POST"], "settings.write"),
  exact("/api/session/fast", ["POST"], "settings.write"),
  exact("/api/session/launch", ["POST"], "settings.write"),
  exact("/api/prompt", ["POST"], "prompt.send"),
  exact("/api/prompt/upload", ["POST"], "prompt.send"),
  exact("/api/abort", ["POST"], "prompt.abort"),
  exact("/api/stop", ["POST"], "prompt.abort"),
  exact("/api/handback", ["POST"], "sessions.write"),
  exact("/api/retry", ["POST"], "prompt.send"),
  exact("/api/sync", ["POST"], "sessions.write"),
  exact("/api/queue", ["GET", "POST"], readWrite("queue.read", "queue.write")),
  exact("/api/chat/history", ["GET", "DELETE"], readWrite("sessions.read", "sessions.write")),
  exact("/api/activity", ["GET"], "sessions.read"),
  exact("/api/artifacts", ["GET", "DELETE"], readWrite("files.read", "files.write")),
  exact("/api/artifacts/bulk", ["POST"], "files.write"),
  exact("/api/artifacts/zip", ["GET"], "files.read"),
  exact("/api/artifacts/file", ["GET"], "files.read"),
  exact("/api/artifacts/preview", ["GET"], "files.read"),
  exact("/api/logs", ["GET"], "logs.read"),
  exact("/api/logs/clear", ["POST"], "logs.clear"),
  exact("/api/diagnostics", ["GET"], "diagnostics.read"),
  exact("/api/diagnostics/bundle", ["GET"], "diagnostics.read"),
  exact("/api/runtime/restart", ["POST"], "system.restart"),
] as const satisfies readonly WebApiRouteDefinition[];

export const WEB_API_STATIC_PATHS = WEB_API_ROUTE_DEFINITIONS
  .filter((route) => !route.pattern)
  .map((route) => route.path);

export const WEB_API_DYNAMIC_TYPE_PATHS = WEB_API_ROUTE_DEFINITIONS
  .flatMap((route) => route.dynamicType ? [route.dynamicType] : []);

type WebApiRouteFromContract = typeof WEB_API_ROUTE_DEFINITIONS[number];

export type WebApiStaticPathFromContract = Extract<WebApiRouteFromContract, { pattern?: undefined }>["path"];
export type WebApiDynamicPathFromContract = NonNullable<WebApiRouteFromContract["dynamicType"]>;

export function permissionForWebRequestFromContract(method: string | undefined, pathname: string): Permission | null {
  const verb = normalizeMethod(method);
  const rule = WEB_API_ROUTE_DEFINITIONS.find((candidate) =>
    (candidate.pattern ? new RegExp(candidate.pattern).test(pathname) : candidate.path === pathname)
  );
  const methods: readonly WebHttpMethod[] = rule?.methods ?? [];
  if (!rule || !methods.includes(verb)) {
    return null;
  }
  return resolvePermission(rule.permissions, verb);
}

function exact<const Path extends string, const Methods extends readonly WebHttpMethod[]>(
  path: Path,
  methods: Methods,
  permissions: WebPermissionRule,
): {
  path: Path;
  methods: Methods;
  permissions: WebPermissionRule;
  pattern?: undefined;
  dynamicType?: undefined;
} {
  return { path, methods, permissions };
}

function dynamic<
  const Path extends string,
  const Pattern extends string,
  const Methods extends readonly WebHttpMethod[],
  const DynamicType extends string,
>(
  path: Path,
  pattern: Pattern,
  methods: Methods,
  permissions: WebPermissionRule,
  dynamicType: DynamicType,
): {
  path: Path;
  pattern: Pattern;
  methods: Methods;
  permissions: WebPermissionRule;
  dynamicType: DynamicType;
} {
  return { path, pattern, methods, permissions, dynamicType };
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
