import type { WebHttpMethod } from "../web/web-api-contract.js";

export type PeerWebRouteGroup =
  | "core"
  | "agentUpdates"
  | "jobs"
  | "workflows"
  | "sessions"
  | "queue"
  | "chat"
  | "activity"
  | "artifacts"
  | "operations";

export interface PeerWebRouteDefinition {
  method: WebHttpMethod | "*";
  path?: string;
  pattern?: RegExp;
  group: PeerWebRouteGroup;
}

export interface MatchedPeerWebRoute {
  definition: PeerWebRouteDefinition;
  params: string[];
}

const corePaths: Array<[WebHttpMethod, string]> = [
  ["GET", "/api/bootstrap"],
  ["GET", "/api/health"],
  ["GET", "/api/snapshot"],
  ["GET", "/api/version"],
  ["POST", "/api/update"],
  ["GET", "/api/tasks"],
  ["GET", "/api/progress"],
  ["GET", "/api/trace"],
  ["GET", "/api/metrics"],
  ["GET", "/api/metrics/history"],
  ["GET", "/api/active-sessions"],
  ["GET", "/api/adapters/health"],
  ["GET", "/api/adapters/conformance"],
  ["GET", "/api/diagnostics"],
  ["POST", "/api/diagnostics/voice/refresh"],
  ["GET", "/api/diagnostics/bundle"],
  ["GET", "/api/control-options"],
  ["GET", "/api/locks"],
  ["POST", "/api/locks"],
  ["DELETE", "/api/locks"],
  ["GET", "/api/auth/status"],
  ["POST", "/api/auth/login"],
  ["POST", "/api/auth/logout"],
];

const sessionPaths: Array<[WebHttpMethod, string]> = [
  ["GET", "/api/sessions"],
  ["GET", "/api/sessions/detail"],
  ["POST", "/api/agent"],
  ["POST", "/api/sessions/new"],
  ["GET", "/api/sessions/worktrees"],
  ["POST", "/api/sessions/worktrees/fork"],
  ["POST", "/api/sessions/worktrees/integrate"],
  ["POST", "/api/sessions/worktrees/integrate/preview"],
  ["POST", "/api/sessions/worktrees/integrate/patch"],
  ["POST", "/api/sessions/worktrees/cleanup"],
  ["POST", "/api/sessions/switch"],
  ["POST", "/api/sessions/attach"],
  ["GET", "/api/models"],
  ["POST", "/api/session/model"],
  ["POST", "/api/session/reasoning"],
  ["POST", "/api/session/fast"],
  ["POST", "/api/session/launch"],
  ["POST", "/api/prompt"],
  ["POST", "/api/prompt/upload"],
  ["POST", "/api/abort"],
  ["POST", "/api/stop"],
  ["POST", "/api/handback"],
  ["POST", "/api/retry"],
  ["POST", "/api/sync"],
];

const queuePaths: Array<[WebHttpMethod, string]> = [
  ["GET", "/api/queue"],
  ["POST", "/api/queue"],
  ["GET", "/api/queue/plans"],
  ["POST", "/api/queue/plans"],
];

const chatPaths: Array<[WebHttpMethod, string]> = [
  ["GET", "/api/chat/history"],
  ["DELETE", "/api/chat/history"],
  ["GET", "/api/chat/mirror"],
  ["POST", "/api/chat/mirror"],
];

const artifactPaths: Array<[WebHttpMethod, string]> = [
  ["GET", "/api/artifacts"],
  ["GET", "/api/artifacts/usage"],
  ["POST", "/api/artifacts/cleanup/preview"],
  ["POST", "/api/artifacts/cleanup/run"],
  ["GET", "/api/artifacts/preview"],
  ["GET", "/api/artifacts/diff"],
  ["DELETE", "/api/artifacts"],
  ["POST", "/api/artifacts/bulk"],
  ["GET", "/api/artifacts/zip"],
  ["GET", "/api/artifacts/file"],
];

export const PEER_WEB_ROUTES: PeerWebRouteDefinition[] = [
  ...corePaths.map(([method, path]) => exact(method, path, "core")),
  exact("GET", "/api/agent-updates", "agentUpdates"),
  exact("POST", "/api/agent-update", "agentUpdates"),
  pattern("*", /^\/api\/agent-update\/([^/]+)\/(?:log|input|cancel)$/, "agentUpdates"),
  exact("GET", "/api/jobs", "jobs"),
  pattern("*", /^\/api\/jobs\/([^/]+)\/(?:log|action)$/, "jobs"),
  exact("GET", "/api/templates", "workflows"),
  exact("POST", "/api/templates", "workflows"),
  exact("POST", "/api/templates/import", "workflows"),
  pattern("*", /^\/api\/templates\/([^/]+)\/(?:versions|diff|export)(?:\/([^/]+))?(?:\/(rollback|run|preview|export))?$/, "workflows"),
  pattern("*", /^\/api\/templates\/([^/]+)(?:\/(run|preview))?$/, "workflows"),
  exact("GET", "/api/workflows", "workflows"),
  exact("POST", "/api/workflows", "workflows"),
  exact("POST", "/api/workflows/import", "workflows"),
  pattern("*", /^\/api\/workflow-runs\/([^/]+)(?:\/(cancel|rerun-failed|report))?$/, "workflows"),
  pattern("*", /^\/api\/workflows\/([^/]+)\/(?:versions|diff|export)(?:\/([^/]+))?(?:\/(rollback|run|preview|export))?$/, "workflows"),
  pattern("*", /^\/api\/workflows\/([^/]+)\/(dry-run|triggers)(?:\/([^/]+))?$/, "workflows"),
  pattern("POST", /^\/api\/workflow-triggers\/([^/]+)\/run$/, "workflows"),
  pattern("*", /^\/api\/workflows\/([^/]+)(?:\/(run|preview))?$/, "workflows"),
  ...sessionPaths.map(([method, path]) => exact(method, path, "sessions")),
  pattern("POST", /^\/api\/approvals\/([^/]+)\/respond$/, "sessions"),
  pattern("*", /^\/api\/sessions\/worktrees\/integrations\/([^/]+)\/finalize$/, "sessions"),
  pattern("*", /^\/api\/sessions\/worktrees\/([^/]+)(?:\/(diff|update|commit))?$/, "sessions"),
  ...queuePaths.map(([method, path]) => exact(method, path, "queue")),
  pattern("*", /^\/api\/queue\/plans\/([^/]+)(?:\/(move|approve|enqueue))?$/, "queue"),
  ...chatPaths.map(([method, path]) => exact(method, path, "chat")),
  exact("GET", "/api/activity", "activity"),
  ...artifactPaths.map(([method, path]) => exact(method, path, "artifacts")),
  exact("GET", "/api/logs", "operations"),
  exact("POST", "/api/logs/clear", "operations"),
  exact("POST", "/api/runtime/restart", "operations"),
];

export const PEER_WEB_ROUTE_CONTRACT_PATHS = new Set([
  ...PEER_WEB_ROUTES.map((route) => route.path).filter((path): path is string => Boolean(path)),
  "/api/agent-update/:id/log",
  "/api/agent-update/:id/input",
  "/api/agent-update/:id/cancel",
  "/api/jobs/:id/log",
  "/api/jobs/:id/action",
  "/api/templates/:id",
  "/api/templates/import",
  "/api/templates/:id/versions",
  "/api/templates/:id/diff",
  "/api/templates/:id/export",
  "/api/templates/:id/versions/:version/export",
  "/api/templates/:id/versions/:version/rollback",
  "/api/templates/:id/versions/:version/run",
  "/api/templates/:id/versions/:version/preview",
  "/api/templates/:id/run",
  "/api/templates/:id/preview",
  "/api/workflow-runs/:id",
  "/api/workflow-runs/:id/cancel",
  "/api/workflow-runs/:id/rerun-failed",
  "/api/workflow-runs/:id/report",
  "/api/workflows/:id",
  "/api/workflows/import",
  "/api/workflows/:id/versions",
  "/api/workflows/:id/diff",
  "/api/workflows/:id/export",
  "/api/workflows/:id/versions/:version/export",
  "/api/workflows/:id/versions/:version/rollback",
  "/api/workflows/:id/versions/:version/run",
  "/api/workflows/:id/versions/:version/preview",
  "/api/workflows/:id/dry-run",
  "/api/workflows/:id/triggers",
  "/api/workflows/:id/triggers/:triggerId",
  "/api/workflows/:id/run",
  "/api/workflows/:id/preview",
  "/api/workflow-triggers/:token/run",
  "/api/sessions/worktrees/:id",
  "/api/sessions/worktrees/integrations/:id/finalize",
  "/api/sessions/worktrees/:id/diff",
  "/api/sessions/worktrees/:id/update",
  "/api/sessions/worktrees/:id/commit",
  "/api/approvals/:id/respond",
  "/api/queue/plans/:id",
  "/api/queue/plans/:id/move",
  "/api/queue/plans/:id/approve",
  "/api/queue/plans/:id/enqueue",
]);

export function matchPeerWebRoute(method: WebHttpMethod, path: string): MatchedPeerWebRoute | null {
  for (const definition of PEER_WEB_ROUTES) {
    if (definition.method !== "*" && definition.method !== method) {
      continue;
    }
    if (definition.path && definition.path === path) {
      return { definition, params: [] };
    }
    if (definition.pattern) {
      const match = path.match(definition.pattern);
      if (match) {
        return { definition, params: match.slice(1).map((value) => value ? decodeURIComponent(value) : "") };
      }
    }
  }
  return null;
}

function exact(method: WebHttpMethod, path: string, group: PeerWebRouteGroup): PeerWebRouteDefinition {
  return { method, path, group };
}

function pattern(method: WebHttpMethod | "*", pattern: RegExp, group: PeerWebRouteGroup): PeerWebRouteDefinition {
  return { method, pattern, group };
}
