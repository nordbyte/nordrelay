import { WEB_API_ROUTE_DEFINITIONS, type WebHttpMethod } from "../web/web-api-contract.js";

export interface PeerProxyRouteKey {
  method: WebHttpMethod;
  path: string;
}

const LOCAL_ONLY_ROUTE_PATHS = new Set([
  "/api/auth/me",
  "/api/dashboard/logout",
  "/api/profile",
  "/api/profile/password",
  "/api/profile/logout-other-sessions",
  "/api/permissions",
  "/api/settings",
  "/api/settings/wizard/test",
  "/api/peers",
  "/api/peers/invite",
  "/api/peers/pair",
  "/api/peers/probe",
  "/api/peers/discover",
  "/api/peers/discovery-jobs",
  "/api/peers/discovery-jobs/:id",
  "/api/peers/discovery-jobs/:id/cancel",
  "/api/peers/discovery-jobs/:id/log",
  "/api/peers/identity/backup",
  "/api/peers/identity/restore",
  "/api/peers/invitations/:id",
  "/api/peers/:id",
  "/api/peers/:id/repin",
  "/api/peers/:id/rotate",
  "/api/peers/:id/health",
  "/api/peers/:id/proxy",
  "/api/peers/:id/events",
  "/api/peers/global-sessions",
  "/api/users",
  "/api/users/:id",
  "/api/users/:id/password",
  "/api/users/:id/sessions",
  "/api/users/:id/sessions/:sessionId",
  "/api/users/:id/telegram",
  "/api/users/:id/telegram/:identityId",
  "/api/users/:id/discord",
  "/api/users/:id/discord/:identityId",
  "/api/users/:id/slack",
  "/api/users/:id/slack/:identityId",
  "/api/groups",
  "/api/groups/:id",
  "/api/telegram-chats",
  "/api/telegram-chats/:id",
  "/api/discord-channels",
  "/api/discord-channels/:id",
  "/api/slack-channels",
  "/api/slack-channels/:id",
  "/api/audit",
]);

const IMPLEMENTED_ROUTE_PATHS = new Set([
  "/api/bootstrap",
  "/api/health",
  "/api/snapshot",
  "/api/tasks",
  "/api/progress",
  "/api/metrics",
  "/api/jobs",
  "/api/trace",
  "/api/jobs/:id/log",
  "/api/jobs/:id/action",
  "/api/active-sessions",
  "/api/version",
  "/api/update",
  "/api/agent-updates",
  "/api/agent-update",
  "/api/agent-update/:id/log",
  "/api/agent-update/:id/input",
  "/api/agent-update/:id/cancel",
  "/api/adapters/health",
  "/api/adapters/conformance",
  "/api/templates",
  "/api/templates/:id",
  "/api/templates/:id/run",
  "/api/templates/:id/preview",
  "/api/workflows",
  "/api/workflows/:id",
  "/api/workflows/:id/run",
  "/api/workflows/:id/preview",
  "/api/workflow-runs/:id",
  "/api/workflow-runs/:id/cancel",
  "/api/locks",
  "/api/auth/status",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/control-options",
  "/api/sessions",
  "/api/sessions/new",
  "/api/sessions/worktrees",
  "/api/sessions/worktrees/fork",
  "/api/sessions/worktrees/integrate",
  "/api/sessions/worktrees/integrate/preview",
  "/api/sessions/worktrees/cleanup",
  "/api/sessions/worktrees/:id/diff",
  "/api/sessions/worktrees/:id/update",
  "/api/sessions/worktrees/:id/commit",
  "/api/sessions/worktrees/:id",
  "/api/sessions/switch",
  "/api/sessions/attach",
  "/api/sessions/detail",
  "/api/agent",
  "/api/models",
  "/api/session/model",
  "/api/session/reasoning",
  "/api/session/fast",
  "/api/session/launch",
  "/api/prompt",
  "/api/prompt/upload",
  "/api/abort",
  "/api/stop",
  "/api/handback",
  "/api/retry",
  "/api/sync",
  "/api/queue",
  "/api/queue/plans",
  "/api/queue/plans/:id",
  "/api/queue/plans/:id/move",
  "/api/queue/plans/:id/approve",
  "/api/queue/plans/:id/enqueue",
  "/api/chat/history",
  "/api/chat/mirror",
  "/api/activity",
  "/api/artifacts",
  "/api/artifacts/usage",
  "/api/artifacts/cleanup/preview",
  "/api/artifacts/cleanup/run",
  "/api/artifacts/bulk",
  "/api/artifacts/zip",
  "/api/artifacts/file",
  "/api/artifacts/preview",
  "/api/artifacts/diff",
  "/api/logs",
  "/api/logs/clear",
  "/api/diagnostics",
  "/api/diagnostics/bundle",
  "/api/runtime/restart",
]);

export function peerProxyCoverage(): {
  implemented: PeerProxyRouteKey[];
  localOnly: PeerProxyRouteKey[];
  missing: PeerProxyRouteKey[];
} {
  const implemented: PeerProxyRouteKey[] = [];
  const localOnly: PeerProxyRouteKey[] = [];
  const missing: PeerProxyRouteKey[] = [];
  for (const route of WEB_API_ROUTE_DEFINITIONS) {
    for (const method of route.methods) {
      const key = { method, path: route.path };
      if (IMPLEMENTED_ROUTE_PATHS.has(route.path)) {
        implemented.push(key);
      } else if (LOCAL_ONLY_ROUTE_PATHS.has(route.path)) {
        localOnly.push(key);
      } else {
        missing.push(key);
      }
    }
  }
  return { implemented, localOnly, missing };
}

export function isPeerProxyLocalOnlyPath(path: string): boolean {
  return LOCAL_ONLY_ROUTE_PATHS.has(path);
}
