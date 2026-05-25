import type { Permission } from "../access/access-control.js";

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
  auth?: "authenticated" | "anonymous-token";
  pattern?: string;
  dynamicType?: string;
}

const stringToken = "${string}";

export const WEB_API_ROUTE_DEFINITIONS = [
  exact("/api/auth/me", ["GET"], "inspect"),
  exact("/api/dashboard/logout", ["POST"], "inspect"),
  exact("/api/profile", ["GET", "PATCH"], "inspect"),
  exact("/api/profile/password", ["POST"], "inspect"),
  exact("/api/profile/logout-other-sessions", ["POST"], "inspect"),
  exact("/api/profile/mfa/totp/setup", ["POST"], "auth.manage"),
  exact("/api/profile/mfa/totp/enable", ["POST"], "auth.manage"),
  exact("/api/profile/mfa/totp/disable", ["POST"], "auth.manage"),
  exact("/api/profile/mfa/recovery-codes", ["POST"], "auth.manage"),
  exact("/api/profile/webauthn/register/options", ["POST"], "auth.manage"),
  exact("/api/profile/webauthn/register/verify", ["POST"], "auth.manage"),
  dynamic("/api/profile/webauthn/:id", "^/api/profile/webauthn/[^/]+$", ["DELETE"], "auth.manage", `/api/profile/webauthn/${stringToken}`),
  exact("/api/profile/api-tokens", ["GET", "POST"], readWrite("inspect", "auth.manage")),
  dynamic("/api/profile/api-tokens/:id", "^/api/profile/api-tokens/[^/]+$", ["DELETE"], "auth.manage", `/api/profile/api-tokens/${stringToken}`),
  dynamic("/api/profile/sessions/:id", "^/api/profile/sessions/[^/]+$", ["DELETE"], "inspect", `/api/profile/sessions/${stringToken}`),
  exact("/api/bootstrap", ["GET"], "inspect"),
  exact("/api/health", ["GET"], "inspect"),
  exact("/api/snapshot", ["GET"], "inspect"),
  exact("/api/tasks", ["GET"], "inspect"),
  exact("/api/progress", ["GET"], "inspect"),
  exact("/api/metrics", ["GET"], "inspect"),
  exact("/api/metrics/history", ["GET"], "inspect"),
  exact("/api/metrics/observability", ["GET"], "inspect"),
  exact("/api/jobs", ["GET"], "inspect"),
  exact("/api/trace", ["GET"], "sessions.read"),
  dynamic("/api/jobs/:id/log", "^/api/jobs/[^/]+/log$", ["GET"], "inspect", `/api/jobs/${stringToken}/log`),
  dynamic("/api/jobs/:id/action", "^/api/jobs/[^/]+/action$", ["POST"], "inspect", `/api/jobs/${stringToken}/action`),
  exact("/api/active-sessions", ["GET"], "sessions.read"),
  exact("/api/version", ["GET"], "inspect"),
  exact("/api/update", ["POST"], "updates.run"),
  exact("/api/agent-updates", ["GET"], "updates.run"),
  exact("/api/agent-update", ["POST"], "updates.run"),
  dynamic("/api/agent-update/:id/log", "^/api/agent-update/[^/]+/log$", ["GET", "DELETE"], "updates.run", `/api/agent-update/${stringToken}/log`),
  dynamic("/api/agent-update/:id/input", "^/api/agent-update/[^/]+/input$", ["POST"], "updates.run", `/api/agent-update/${stringToken}/input`),
  dynamic("/api/agent-update/:id/cancel", "^/api/agent-update/[^/]+/cancel$", ["POST"], "updates.run", `/api/agent-update/${stringToken}/cancel`),
  exact("/api/adapters/health", ["GET"], "inspect"),
  exact("/api/adapters/conformance", ["GET"], "inspect"),
  exact("/api/peers", ["GET", "POST"], readWrite("peers.read", "peers.write")),
  exact("/api/peers/invite", ["POST"], "peers.write"),
  exact("/api/peers/pair", ["POST"], "peers.write"),
  exact("/api/peers/probe", ["POST"], "peers.connect"),
  exact("/api/peers/discover", ["GET"], "peers.connect"),
  exact("/api/peers/discovery-jobs", ["GET", "POST"], readWrite("peers.connect", "peers.connect")),
  exact("/api/peers/relay", ["GET", "POST"], readWrite("peers.read", "peers.write")),
  dynamic("/api/peers/discovery-jobs/:id", "^/api/peers/discovery-jobs/[^/]+$", ["GET"], "peers.connect", `/api/peers/discovery-jobs/${stringToken}`),
  dynamic("/api/peers/discovery-jobs/:id/cancel", "^/api/peers/discovery-jobs/[^/]+/cancel$", ["POST"], "peers.connect", `/api/peers/discovery-jobs/${stringToken}/cancel`),
  dynamic("/api/peers/discovery-jobs/:id/log", "^/api/peers/discovery-jobs/[^/]+/log$", ["GET"], "peers.connect", `/api/peers/discovery-jobs/${stringToken}/log`),
  exact("/api/peers/identity/backup", ["GET"], "peers.write"),
  exact("/api/peers/identity/restore", ["POST"], "peers.write"),
  exact("/api/peers/global-sessions", ["GET"], "sessions.read"),
  exact("/api/peers/sync", ["POST"], "peers.write"),
  dynamic("/api/peers/invitations/:id", "^/api/peers/invitations/[^/]+$", ["DELETE"], "peers.write", `/api/peers/invitations/${stringToken}`),
  dynamic("/api/peers/:id/sync-candidates", "^/api/peers/[^/]+/sync-candidates$", ["GET"], "peers.read", `/api/peers/${stringToken}/sync-candidates`),
  dynamic("/api/peers/:id/sync-invite", "^/api/peers/[^/]+/sync-invite$", ["POST"], "peers.write", `/api/peers/${stringToken}/sync-invite`),
  dynamic("/api/peers/:id/repin", "^/api/peers/[^/]+/repin$", ["POST"], "peers.write", `/api/peers/${stringToken}/repin`),
  dynamic("/api/peers/:id/rotate", "^/api/peers/[^/]+/rotate$", ["POST"], "peers.write", `/api/peers/${stringToken}/rotate`),
  dynamic("/api/peers/:id/health", "^/api/peers/[^/]+/health$", ["GET"], "peers.connect", `/api/peers/${stringToken}/health`),
  dynamic("/api/peers/:id/debug", "^/api/peers/[^/]+/debug$", ["GET"], "peers.connect", `/api/peers/${stringToken}/debug`),
  dynamic("/api/peers/:id/debug/probe", "^/api/peers/[^/]+/debug/probe$", ["POST"], "peers.connect", `/api/peers/${stringToken}/debug/probe`),
  dynamic("/api/peers/:id/effective-access", "^/api/peers/[^/]+/effective-access$", ["GET"], "peers.connect", `/api/peers/${stringToken}/effective-access`),
  dynamic("/api/peers/:id/health-history", "^/api/peers/[^/]+/health-history$", ["GET"], "peers.connect", `/api/peers/${stringToken}/health-history`),
  dynamic("/api/peers/:id/repair", "^/api/peers/[^/]+/repair$", ["POST"], "peers.write", `/api/peers/${stringToken}/repair`),
  dynamic("/api/peers/:id", "^/api/peers/[^/]+$", ["PATCH", "DELETE"], "peers.write", `/api/peers/${stringToken}`),
  dynamic("/api/peers/:id/proxy", "^/api/peers/[^/]+/proxy$", ["POST"], "peers.connect", `/api/peers/${stringToken}/proxy`),
  dynamic("/api/peers/:id/events", "^/api/peers/[^/]+/events$", ["GET"], "peers.connect", `/api/peers/${stringToken}/events`),
  exact("/api/permissions", ["GET"], "users.read"),
  exact("/api/users", ["GET", "POST"], readWrite("users.read", "users.write")),
  dynamic("/api/users/:id", "^/api/users/[^/]+$", ["PATCH"], "users.write", `/api/users/${stringToken}`),
  dynamic("/api/users/:id/password", "^/api/users/[^/]+/password$", ["POST"], "users.write", `/api/users/${stringToken}/password`),
  dynamic("/api/users/:id/sessions", "^/api/users/[^/]+/sessions$", ["GET", "DELETE"], readWrite("users.read", "users.write"), `/api/users/${stringToken}/sessions`),
  dynamic("/api/users/:id/sessions/:sessionId", "^/api/users/[^/]+/sessions/[^/]+$", ["DELETE"], "users.write", `/api/users/${stringToken}/sessions/${stringToken}`),
  dynamic("/api/users/:id/telegram", "^/api/users/[^/]+/telegram$", ["POST"], "users.write", `/api/users/${stringToken}/telegram`),
  dynamic("/api/users/:id/telegram/:identityId", "^/api/users/[^/]+/telegram/[^/]+$", ["DELETE"], "users.write", `/api/users/${stringToken}/telegram/${stringToken}`),
  dynamic("/api/users/:id/discord", "^/api/users/[^/]+/discord$", ["POST"], "users.write", `/api/users/${stringToken}/discord`),
  dynamic("/api/users/:id/discord/:identityId", "^/api/users/[^/]+/discord/[^/]+$", ["DELETE"], "users.write", `/api/users/${stringToken}/discord/${stringToken}`),
  dynamic("/api/users/:id/slack", "^/api/users/[^/]+/slack$", ["POST"], "users.write", `/api/users/${stringToken}/slack`),
  dynamic("/api/users/:id/slack/:identityId", "^/api/users/[^/]+/slack/[^/]+$", ["DELETE"], "users.write", `/api/users/${stringToken}/slack/${stringToken}`),
  dynamic("/api/users/:id/matrix", "^/api/users/[^/]+/matrix$", ["POST"], "users.write", `/api/users/${stringToken}/matrix`),
  dynamic("/api/users/:id/matrix/:identityId", "^/api/users/[^/]+/matrix/[^/]+$", ["DELETE"], "users.write", `/api/users/${stringToken}/matrix/${stringToken}`),
  exact("/api/groups", ["GET", "POST"], readWrite("users.read", "users.write")),
  dynamic("/api/groups/:id", "^/api/groups/[^/]+$", ["PATCH"], "users.write", `/api/groups/${stringToken}`),
  exact("/api/telegram-chats", ["GET", "POST"], readWrite("users.read", "users.write")),
  dynamic("/api/telegram-chats/:id", "^/api/telegram-chats/[^/]+$", ["PATCH"], "users.write", `/api/telegram-chats/${stringToken}`),
  exact("/api/discord-channels", ["GET", "POST"], readWrite("users.read", "users.write")),
  dynamic("/api/discord-channels/:id", "^/api/discord-channels/[^/]+$", ["PATCH"], "users.write", `/api/discord-channels/${stringToken}`),
  exact("/api/slack-channels", ["GET", "POST"], readWrite("users.read", "users.write")),
  dynamic("/api/slack-channels/:id", "^/api/slack-channels/[^/]+$", ["PATCH"], "users.write", `/api/slack-channels/${stringToken}`),
  exact("/api/matrix-rooms", ["GET", "POST"], readWrite("users.read", "users.write")),
  dynamic("/api/matrix-rooms/:id", "^/api/matrix-rooms/[^/]+$", ["PATCH"], "users.write", `/api/matrix-rooms/${stringToken}`),
  exact("/api/audit", ["GET"], "audit.read"),
  exact("/api/locks", ["GET", "POST", "DELETE"], readWrite("sessions.read", "sessions.write")),
  exact("/api/auth/status", ["GET"], "inspect"),
  exact("/api/auth/login", ["POST"], "auth.manage"),
  exact("/api/auth/logout", ["POST"], "auth.manage"),
  dynamic("/api/approvals/:id/respond", "^/api/approvals/[^/]+/respond$", ["POST"], "prompt.abort", `/api/approvals/${stringToken}/respond`),
  exact("/api/settings", ["GET", "PATCH"], readWrite("settings.read", "settings.write")),
  exact("/api/settings/wizard/test", ["POST"], "settings.write"),
  exact("/api/templates", ["GET", "POST"], readWrite("workflows.read", "workflows.write")),
  exact("/api/templates/import", ["POST"], "workflows.write"),
  dynamic("/api/templates/:id/versions", "^/api/templates/[^/]+/versions$", ["GET"], "workflows.read", `/api/templates/${stringToken}/versions`),
  dynamic("/api/templates/:id/diff", "^/api/templates/[^/]+/diff$", ["GET"], "workflows.read", `/api/templates/${stringToken}/diff`),
  dynamic("/api/templates/:id/export", "^/api/templates/[^/]+/export$", ["GET"], "workflows.read", `/api/templates/${stringToken}/export`),
  dynamic("/api/templates/:id/versions/:version/export", "^/api/templates/[^/]+/versions/[^/]+/export$", ["GET"], "workflows.read", `/api/templates/${stringToken}/versions/${stringToken}/export`),
  dynamic("/api/templates/:id/versions/:version/rollback", "^/api/templates/[^/]+/versions/[^/]+/rollback$", ["POST"], "workflows.write", `/api/templates/${stringToken}/versions/${stringToken}/rollback`),
  dynamic("/api/templates/:id/versions/:version/run", "^/api/templates/[^/]+/versions/[^/]+/run$", ["POST"], "workflows.run", `/api/templates/${stringToken}/versions/${stringToken}/run`),
  dynamic("/api/templates/:id/versions/:version/preview", "^/api/templates/[^/]+/versions/[^/]+/preview$", ["POST"], "workflows.read", `/api/templates/${stringToken}/versions/${stringToken}/preview`),
  dynamic("/api/templates/:id", "^/api/templates/[^/]+$", ["PUT", "DELETE"], "workflows.write", `/api/templates/${stringToken}`),
  dynamic("/api/templates/:id/run", "^/api/templates/[^/]+/run$", ["POST"], "workflows.run", `/api/templates/${stringToken}/run`),
  dynamic("/api/templates/:id/preview", "^/api/templates/[^/]+/preview$", ["POST"], "workflows.read", `/api/templates/${stringToken}/preview`),
  exact("/api/workflows", ["GET", "POST"], readWrite("workflows.read", "workflows.write")),
  exact("/api/workflows/import", ["POST"], "workflows.write"),
  dynamic("/api/workflows/:id/versions", "^/api/workflows/[^/]+/versions$", ["GET"], "workflows.read", `/api/workflows/${stringToken}/versions`),
  dynamic("/api/workflows/:id/diff", "^/api/workflows/[^/]+/diff$", ["GET"], "workflows.read", `/api/workflows/${stringToken}/diff`),
  dynamic("/api/workflows/:id/export", "^/api/workflows/[^/]+/export$", ["GET"], "workflows.read", `/api/workflows/${stringToken}/export`),
  dynamic("/api/workflows/:id/versions/:version/export", "^/api/workflows/[^/]+/versions/[^/]+/export$", ["GET"], "workflows.read", `/api/workflows/${stringToken}/versions/${stringToken}/export`),
  dynamic("/api/workflows/:id/versions/:version/rollback", "^/api/workflows/[^/]+/versions/[^/]+/rollback$", ["POST"], "workflows.write", `/api/workflows/${stringToken}/versions/${stringToken}/rollback`),
  dynamic("/api/workflows/:id/versions/:version/run", "^/api/workflows/[^/]+/versions/[^/]+/run$", ["POST"], "workflows.run", `/api/workflows/${stringToken}/versions/${stringToken}/run`),
  dynamic("/api/workflows/:id/versions/:version/preview", "^/api/workflows/[^/]+/versions/[^/]+/preview$", ["POST"], "workflows.read", `/api/workflows/${stringToken}/versions/${stringToken}/preview`),
  dynamic("/api/workflows/:id/dry-run", "^/api/workflows/[^/]+/dry-run$", ["POST"], "workflows.read", `/api/workflows/${stringToken}/dry-run`),
  dynamic("/api/workflows/:id/triggers", "^/api/workflows/[^/]+/triggers$", ["GET", "POST"], readWrite("workflows.read", "workflows.write"), `/api/workflows/${stringToken}/triggers`),
  dynamic("/api/workflows/:id/triggers/:triggerId", "^/api/workflows/[^/]+/triggers/[^/]+$", ["DELETE"], "workflows.write", `/api/workflows/${stringToken}/triggers/${stringToken}`),
  dynamic("/api/workflows/:id", "^/api/workflows/[^/]+$", ["PUT", "DELETE"], "workflows.write", `/api/workflows/${stringToken}`),
  dynamic("/api/workflows/:id/run", "^/api/workflows/[^/]+/run$", ["POST"], "workflows.run", `/api/workflows/${stringToken}/run`),
  dynamic("/api/workflows/:id/preview", "^/api/workflows/[^/]+/preview$", ["POST"], "workflows.read", `/api/workflows/${stringToken}/preview`),
  dynamic(
    "/api/workflow-triggers/:token/run",
    "^/api/workflow-triggers/[^/]+/run$",
    ["POST"],
    "workflows.run",
    `/api/workflow-triggers/${stringToken}/run`,
    "anonymous-token",
  ),
  dynamic("/api/workflow-runs/:id", "^/api/workflow-runs/[^/]+$", ["GET"], "workflows.read", `/api/workflow-runs/${stringToken}`),
  dynamic("/api/workflow-runs/:id/report", "^/api/workflow-runs/[^/]+/report$", ["GET"], "workflows.read", `/api/workflow-runs/${stringToken}/report`),
  dynamic("/api/workflow-runs/:id/cancel", "^/api/workflow-runs/[^/]+/cancel$", ["POST"], "workflows.run", `/api/workflow-runs/${stringToken}/cancel`),
  dynamic("/api/workflow-runs/:id/rerun-failed", "^/api/workflow-runs/[^/]+/rerun-failed$", ["POST"], "workflows.run", `/api/workflow-runs/${stringToken}/rerun-failed`),
  exact("/api/control-options", ["GET"], "settings.read"),
  exact("/api/sessions", ["GET"], "sessions.read"),
  exact("/api/sessions/new", ["POST"], "sessions.write"),
  exact("/api/sessions/worktrees", ["GET"], "sessions.read"),
  exact("/api/sessions/worktrees/fork", ["POST"], "sessions.write"),
  exact("/api/sessions/worktrees/compare", ["POST"], "sessions.read"),
  exact("/api/sessions/worktrees/integrate", ["POST"], "sessions.write"),
  exact("/api/sessions/worktrees/integrate/preview", ["POST"], "sessions.read"),
  exact("/api/sessions/worktrees/integrate/patch", ["POST"], "sessions.read"),
  exact("/api/sessions/worktrees/cleanup", ["POST"], "sessions.write"),
  dynamic("/api/sessions/worktrees/integrations/:id/finalize", "^/api/sessions/worktrees/integrations/[^/]+/finalize$", ["POST"], "sessions.write", `/api/sessions/worktrees/integrations/${stringToken}/finalize`),
  dynamic("/api/sessions/worktrees/:id/diff", "^/api/sessions/worktrees/[^/]+/diff$", ["GET"], "sessions.read", `/api/sessions/worktrees/${stringToken}/diff`),
  dynamic("/api/sessions/worktrees/:id/update", "^/api/sessions/worktrees/[^/]+/update$", ["POST"], "sessions.write", `/api/sessions/worktrees/${stringToken}/update`),
  dynamic("/api/sessions/worktrees/:id/commit", "^/api/sessions/worktrees/[^/]+/commit$", ["POST"], "sessions.write", `/api/sessions/worktrees/${stringToken}/commit`),
  dynamic("/api/sessions/worktrees/:id", "^/api/sessions/worktrees/[^/]+$", ["DELETE"], "sessions.write", `/api/sessions/worktrees/${stringToken}`),
  exact("/api/sessions/switch", ["POST"], "sessions.write"),
  exact("/api/sessions/attach", ["POST"], "sessions.write"),
  exact("/api/sessions/detail", ["GET"], "sessions.read"),
  exact("/api/sessions/name", ["POST"], "sessions.write"),
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
  exact("/api/queue/plans", ["GET", "POST"], readWrite("queue.plan.read", "queue.plan.write")),
  dynamic("/api/queue/plans/:id", "^/api/queue/plans/[^/]+$", ["PATCH", "DELETE"], "queue.plan.write", `/api/queue/plans/${stringToken}`),
  dynamic("/api/queue/plans/:id/move", "^/api/queue/plans/[^/]+/move$", ["POST"], "queue.plan.write", `/api/queue/plans/${stringToken}/move`),
  dynamic("/api/queue/plans/:id/approve", "^/api/queue/plans/[^/]+/approve$", ["POST"], "queue.plan.approve", `/api/queue/plans/${stringToken}/approve`),
  dynamic("/api/queue/plans/:id/enqueue", "^/api/queue/plans/[^/]+/enqueue$", ["POST"], "queue.plan.approve", `/api/queue/plans/${stringToken}/enqueue`),
  exact("/api/chat/history", ["GET", "DELETE"], readWrite("sessions.read", "sessions.write")),
  exact("/api/chat/attachment", ["GET"], "files.read"),
  exact("/api/chat/mirror", ["GET", "POST"], readWrite("sessions.read", "settings.write")),
  exact("/api/activity", ["GET"], "sessions.read"),
  exact("/api/artifacts", ["GET", "DELETE"], readWrite("files.read", "files.write")),
  exact("/api/artifacts/usage", ["GET"], "files.read"),
  exact("/api/artifacts/cleanup/preview", ["POST"], "files.write"),
  exact("/api/artifacts/cleanup/run", ["POST"], "files.write"),
  exact("/api/artifacts/bulk", ["POST"], "files.write"),
  exact("/api/artifacts/zip", ["GET"], "files.read"),
  exact("/api/artifacts/file", ["GET"], "files.read"),
  exact("/api/artifacts/preview", ["GET"], "files.read"),
  exact("/api/artifacts/diff", ["GET"], "files.read"),
  exact("/api/logs", ["GET"], "logs.read"),
  exact("/api/logs/clear", ["POST"], "logs.clear"),
  exact("/api/diagnostics", ["GET"], "diagnostics.read"),
  exact("/api/diagnostics/voice/refresh", ["POST"], "diagnostics.read"),
  exact("/api/diagnostics/bundle", ["GET"], "diagnostics.read"),
  exact("/api/doctor", ["GET"], "diagnostics.read"),
  exact("/api/doctor/fix", ["POST"], "settings.write"),
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

export function routeForWebRequest(method: string | undefined, pathname: string): WebApiRouteFromContract | null {
  const verb = normalizeMethod(method);
  const route = WEB_API_ROUTE_DEFINITIONS.find((candidate) =>
    (candidate.pattern ? new RegExp(candidate.pattern).test(pathname) : candidate.path === pathname)
  );
  const methods: readonly WebHttpMethod[] = route?.methods ?? [];
  return route && methods.includes(verb) ? route : null;
}

export function permissionForWebRequestFromContract(method: string | undefined, pathname: string): Permission | null {
  const verb = normalizeMethod(method);
  const rule = routeForWebRequest(verb, pathname);
  if (!rule) {
    return null;
  }
  if (rule.auth === "anonymous-token") {
    return null;
  }
  return resolvePermission(rule.permissions, verb);
}

function exact<const Path extends string, const Methods extends readonly WebHttpMethod[]>(
  path: Path,
  methods: Methods,
  permissions: WebPermissionRule,
  auth?: WebApiRouteDefinition["auth"],
): {
  path: Path;
  methods: Methods;
  permissions: WebPermissionRule;
  auth?: WebApiRouteDefinition["auth"];
  pattern?: undefined;
  dynamicType?: undefined;
} {
  return { path, methods, permissions, auth };
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
  auth?: WebApiRouteDefinition["auth"],
): {
  path: Path;
  pattern: Pattern;
  methods: Methods;
  permissions: WebPermissionRule;
  dynamicType: DynamicType;
  auth?: WebApiRouteDefinition["auth"];
} {
  return { path, pattern, methods, permissions, dynamicType, auth };
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
