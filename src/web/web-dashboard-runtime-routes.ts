import type { IncomingMessage, ServerResponse } from "node:http";

import type { Permission } from "../access/access-control.js";
import type { AgentId } from "../agents/shared/agent.js";
import type { ActiveSessionsDto, RelayRuntime, WebTasksDto } from "../runtime/relay-runtime.js";
import type { AuthenticatedUser, UserStore } from "../access/user-management.js";
import type { WebActivityActor } from "./web-state.js";
import { applyDoctorFixes, collectDoctorReport } from "../support/doctor.js";
import {
  numberParam,
  optionalStringField,
  parseAgentUpdateOperation,
  parseLogTarget,
  readJsonBody,
  sendFile,
  sendJson,
  stringField,
} from "./web-dashboard-http.js";

export interface DashboardRuntimeRouteOptions {
  runtime: RelayRuntime;
  users: UserStore;
  home: string;
  authUser: AuthenticatedUser;
  parseAgentIdRequired: (value: string) => AgentId;
  assertScopedAgent: (authUser: AuthenticatedUser, agentId?: AgentId) => void;
  assertAgentUpdateJobScope: (authUser: AuthenticatedUser, id: string) => void;
  assertCurrentSessionScope: (authUser: AuthenticatedUser) => Promise<void>;
  scopedTasks: (authUser: AuthenticatedUser, tasks: WebTasksDto) => Promise<WebTasksDto>;
  scopedActiveSessions: (authUser: AuthenticatedUser, active: ActiveSessionsDto) => ActiveSessionsDto;
  activityActor: WebActivityActor;
}

export async function handleDashboardRuntimeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: DashboardRuntimeRouteOptions,
): Promise<boolean> {
  const { runtime, users, authUser } = options;

  if (req.method === "GET" && url.pathname === "/api/health") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.status());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/version") {
    const forceRefresh = url.searchParams.get("force") === "true" || url.searchParams.get("fresh") === "true";
    sendJson(res, 200, await runtime.version({ forceRefresh }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/update") {
    sendJson(res, 202, runtime.updateConnector(options.activityActor));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/agent-updates") {
    sendJson(res, 200, { jobs: runtime.agentUpdateJobs().filter((job) => users.canUseAgent(authUser, job.agentId)) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/agent-update") {
    const body = await readJsonBody(req);
    const agentId = options.parseAgentIdRequired(stringField(body, "agentId"));
    const operation = parseAgentUpdateOperation(optionalStringField(body, "operation"));
    options.assertScopedAgent(authUser, agentId);
    const runningJob = runtime.agentUpdateJobs().find((job) => job.agentId === agentId && job.status === "running");
    if (runningJob) {
      sendJson(res, 409, {
        error: `${runningJob.agentLabel} ${runningJob.operation} is already running.`,
        job: runningJob,
      });
      return true;
    }
    sendJson(res, 202, { job: runtime.startAgentUpdate(agentId, operation, options.activityActor) });
    return true;
  }

  const agentUpdateLogMatch = url.pathname.match(/^\/api\/agent-update\/([^/]+)\/log$/);
  if (req.method === "GET" && agentUpdateLogMatch?.[1]) {
    const id = decodeURIComponent(agentUpdateLogMatch[1]);
    options.assertAgentUpdateJobScope(authUser, id);
    sendJson(res, 200, runtime.agentUpdateLog(id));
    return true;
  }

  if (req.method === "DELETE" && agentUpdateLogMatch?.[1]) {
    const id = decodeURIComponent(agentUpdateLogMatch[1]);
    options.assertAgentUpdateJobScope(authUser, id);
    sendJson(res, 200, { deletedId: id, job: runtime.deleteAgentUpdateLog(id, options.activityActor) });
    return true;
  }

  const agentUpdateInputMatch = url.pathname.match(/^\/api\/agent-update\/([^/]+)\/input$/);
  if (req.method === "POST" && agentUpdateInputMatch?.[1]) {
    const body = await readJsonBody(req);
    const id = decodeURIComponent(agentUpdateInputMatch[1]);
    options.assertAgentUpdateJobScope(authUser, id);
    sendJson(res, 200, { job: runtime.sendAgentUpdateInput(id, stringField(body, "input"), options.activityActor) });
    return true;
  }

  const agentUpdateCancelMatch = url.pathname.match(/^\/api\/agent-update\/([^/]+)\/cancel$/);
  if (req.method === "POST" && agentUpdateCancelMatch?.[1]) {
    const id = decodeURIComponent(agentUpdateCancelMatch[1]);
    options.assertAgentUpdateJobScope(authUser, id);
    sendJson(res, 200, { job: runtime.cancelAgentUpdate(id, options.activityActor) });
    return true;
  }

  if (req.method === "GET" && (url.pathname === "/api/tasks" || url.pathname === "/api/progress")) {
    sendJson(res, 200, await options.scopedTasks(authUser, runtime.tasks()));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/metrics") {
    sendJson(res, 200, await runtime.metrics());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/metrics/history") {
    sendJson(res, 200, {
      samples: runtime.metricsHistory(numberParam(url, "limit", 240)),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/metrics/observability") {
    sendJson(res, 200, runtime.observability());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/jobs") {
    sendJson(res, 200, await runtime.jobs({
      limit: numberParam(url, "limit", 100),
      cursor: url.searchParams.get("cursor") || undefined,
    }));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/trace") {
    sendJson(res, 200, await runtime.trace(stringField(Object.fromEntries(url.searchParams), "correlationId")));
    return true;
  }

  const jobLogMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/log$/);
  if (req.method === "GET" && jobLogMatch?.[1]) {
    sendJson(res, 200, await runtime.jobLog(decodeURIComponent(jobLogMatch[1])));
    return true;
  }

  const jobActionMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/action$/);
  if (req.method === "POST" && jobActionMatch?.[1]) {
    const body = await readJsonBody(req);
    const id = decodeURIComponent(jobActionMatch[1]);
    const action = stringField(body, "action");
    if (action !== "cancel" && action !== "retry") {
      throw new Error("Unsupported job action.");
    }
    const permission = permissionForJobAction(id, action);
    if (!users.hasPermission(authUser, permission)) {
      sendJson(res, 403, { error: `Access denied: ${permission} permission required.` });
      return true;
    }
    sendJson(res, 200, await runtime.jobAction(id, action, options.activityActor));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/active-sessions") {
    sendJson(res, 200, options.scopedActiveSessions(authUser, await runtime.activeSessions()));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/adapters/health") {
    sendJson(res, 200, { adapters: (await runtime.adapterHealth()).filter((adapter) => users.canUseAgent(authUser, adapter.id)) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/logs") {
    const target = parseLogTarget(url.searchParams.get("target") ?? undefined);
    sendJson(res, 200, await runtime.logs(target, {
      limit: numberParam(url, "limit", numberParam(url, "lines", 100)),
      cursor: url.searchParams.get("cursor"),
      level: url.searchParams.get("level"),
      search: url.searchParams.get("search"),
      since: url.searchParams.get("since"),
    }));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/logs/clear") {
    const body = await readJsonBody(req);
    const target = parseLogTarget(optionalStringField(body, "target"));
    sendJson(res, 200, runtime.clearLogs(target, options.activityActor));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/diagnostics") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.diagnostics());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/diagnostics/voice/refresh") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.refreshVoiceDiagnostics());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/doctor") {
    sendJson(res, 200, await collectDoctorReport(runtime.config, options.home));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/doctor/fix") {
    const body = await readJsonBody(req);
    const rawFixIds = Array.isArray(body.fixIds) ? body.fixIds : [];
    const fixIds = rawFixIds.map((value) => String(value)).filter(Boolean);
    sendJson(res, 200, await applyDoctorFixes(runtime.config, options.home, fixIds));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/diagnostics/bundle") {
    await options.assertCurrentSessionScope(authUser);
    const bundle = await runtime.supportBundle(options.activityActor);
    sendFile(res, bundle.path, bundle.name);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/runtime/restart") {
    sendJson(res, 202, runtime.restartConnector(options.activityActor));
    return true;
  }

  return false;
}

function permissionForJobAction(id: string, action: "cancel" | "retry"): Permission {
  if (id === "web:current" && action === "cancel") {
    return "prompt.abort";
  }
  if (id.startsWith("queue:")) {
    return "queue.write";
  }
  if (id.startsWith("support-bundle:")) {
    return "diagnostics.read";
  }
  if (id.startsWith("workflow-run:")) {
    return action === "cancel" ? "workflows.run" : "workflows.run";
  }
  return "updates.run";
}
