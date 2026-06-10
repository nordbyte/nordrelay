import type { IncomingMessage, ServerResponse } from "node:http";

import { isAgentId, type AgentId } from "../agents/shared/agent.js";
import type { RelayRuntime } from "../runtime/relay-runtime.js";
import type { ProjectRunOptions } from "../runtime/relay-project-service.js";
import {
  normalizeProjectLanguage,
  normalizeProjectPlanHorizon,
  normalizeProjectPlanMode,
  normalizeProjectPlanRiskLevel,
  type ProjectRecord,
  type ProjectSessionLink,
  type ProjectTarget,
} from "../state/project-store.js";
import type { AuthenticatedUser } from "../access/user-management.js";
import type { WebActivityActor } from "./web-state.js";
import {
  numberParam,
  objectRecord,
  optionalStringField,
  readJsonBody,
  sendJson,
  stringField,
  WebAccessDeniedError,
} from "./web-dashboard-http.js";

export interface DashboardProjectRouteOptions {
  runtime: RelayRuntime;
  authUser: AuthenticatedUser;
  activityActor: WebActivityActor;
  assertPeerAccess?: (peerId: string) => void;
}

export async function handleDashboardProjectRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: DashboardProjectRouteOptions,
): Promise<boolean> {
  const service = options.runtime.projectService;

  if (req.method === "GET" && url.pathname === "/api/projects") {
    const limit = numberParam(url, "jobs", 100);
    sendJson(res, 200, {
      ...service.list(),
      jobs: service.listJobs(undefined, limit),
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/projects") {
    const body = await readJsonBody(req);
    const parsed = parseProjectBody(body, options.authUser.user.id);
    assertProjectPeerScope(options, parsed.target);
    sendJson(res, 201, { project: service.saveProject(parsed, options.activityActor) });
    return true;
  }

  const jobMatch = url.pathname.match(/^\/api\/projects\/jobs\/([^/]+)(?:\/(cancel))?$/);
  if (jobMatch?.[1]) {
    const jobId = decodeURIComponent(jobMatch[1]);
    const action = jobMatch[2];
    if (req.method === "POST" && action === "cancel") {
      sendJson(res, 200, { job: await service.cancelJob(jobId, options.activityActor) });
      return true;
    }
  }

  const sessionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions(?:\/([^/]+))?$/);
  if (sessionMatch?.[1]) {
    const projectId = decodeURIComponent(sessionMatch[1]);
    const linkId = sessionMatch[2] ? decodeURIComponent(sessionMatch[2]) : "";
    if (req.method === "POST" && !linkId) {
      const body = await readJsonBody(req);
      const link = parseSessionLinkBody(body);
      if (link.peerId) assertPeerAccess(options, link.peerId);
      sendJson(res, 200, { project: service.linkSession(projectId, link, options.activityActor) });
      return true;
    }
    if (req.method === "DELETE" && linkId) {
      sendJson(res, 200, { project: service.unlinkSession(projectId, linkId, options.activityActor) });
      return true;
    }
  }

  const projectActionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/(summary|plan)(?:\/(run))?$/);
  if (projectActionMatch?.[1]) {
    const id = decodeURIComponent(projectActionMatch[1]);
    const section = projectActionMatch[2];
    const action = projectActionMatch[3];
    if (req.method === "PATCH" && !action) {
      const body = await readJsonBody(req);
      const markdown = stringField(body, "markdown");
      const project = section === "plan"
        ? service.updatePlan(id, markdown, options.activityActor)
        : service.updateSummary(id, markdown, options.activityActor);
      sendJson(res, 200, { project });
      return true;
    }
    if (req.method === "POST" && action === "run") {
      const body = await readJsonBody(req);
      const runOptions = parseProjectRunBody(body, section);
      const job = section === "plan"
        ? service.runPlan(id, runOptions, options.activityActor)
        : service.runSummary(id, runOptions, options.activityActor);
      sendJson(res, 202, { job });
      return true;
    }
  }

  const jobsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/jobs$/);
  if (jobsMatch?.[1] && req.method === "GET") {
    const id = decodeURIComponent(jobsMatch[1]);
    sendJson(res, 200, { jobs: service.listJobs(id, numberParam(url, "limit", 100)) });
    return true;
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch?.[1]) {
    const id = decodeURIComponent(projectMatch[1]);
    if (req.method === "GET") {
      const project = service.get(id);
      if (!project) throw new Error(`Project not found: ${id}`);
      assertProjectPeerScope(options, project.target);
      sendJson(res, 200, { project });
      return true;
    }
    if (req.method === "PATCH") {
      const existing = service.get(id);
      if (!existing) throw new Error(`Project not found: ${id}`);
      const body = await readJsonBody(req);
      const patch = parseProjectPatchBody(body);
      assertProjectPeerScope(options, patch.target ?? existing.target);
      sendJson(res, 200, { project: service.patchProject(id, patch, options.activityActor) });
      return true;
    }
    if (req.method === "DELETE") {
      sendJson(res, 200, service.deleteProject(id, options.activityActor));
      return true;
    }
  }

  return false;
}

function parseProjectBody(body: Record<string, unknown>, ownerUserId: string): Partial<ProjectRecord> & Pick<ProjectRecord, "name" | "workspacePath"> {
  return {
    name: stringField(body, "name").slice(0, 120),
    description: optionalStringField(body, "description"),
    workspacePath: stringField(body, "workspacePath"),
    target: parseProjectTarget(optionalStringField(body, "target")),
    defaultAgentId: parseOptionalAgentId(optionalStringField(body, "defaultAgentId")),
    status: optionalStringField(body, "status") === "archived" ? "archived" : "active",
    ownerUserId,
  };
}

function parseProjectPatchBody(body: Record<string, unknown>): Partial<ProjectRecord> {
  const record = objectRecord(body);
  return {
    name: optionalStringField(record, "name"),
    description: optionalStringField(record, "description"),
    workspacePath: optionalStringField(record, "workspacePath"),
    target: optionalStringField(record, "target") ? parseProjectTarget(optionalStringField(record, "target")) : undefined,
    defaultAgentId: parseOptionalAgentId(optionalStringField(record, "defaultAgentId")),
    status: optionalStringField(record, "status") === "archived" ? "archived" : optionalStringField(record, "status") === "active" ? "active" : undefined,
  };
}

function parseProjectRunBody(body: Record<string, unknown>, section: string): ProjectRunOptions {
  const record = objectRecord(body);
  const options: ProjectRunOptions = {
    agentId: parseOptionalAgentId(optionalStringField(record, "agentId")),
    instructions: optionalStringField(record, "instructions"),
    language: normalizeProjectLanguage(optionalStringField(record, "language")),
  };
  if (section === "plan") {
    options.planMode = normalizeProjectPlanMode(optionalStringField(record, "planMode"));
    options.planningHorizon = normalizeProjectPlanHorizon(optionalStringField(record, "planningHorizon"));
    options.riskLevel = normalizeProjectPlanRiskLevel(optionalStringField(record, "riskLevel"));
  }
  return options;
}

function parseSessionLinkBody(body: Record<string, unknown>): Partial<ProjectSessionLink> & Pick<ProjectSessionLink, "threadId"> {
  return {
    threadId: stringField(body, "threadId"),
    agentId: parseOptionalAgentId(optionalStringField(body, "agentId")),
    peerId: optionalStringField(body, "peerId"),
    label: optionalStringField(body, "label"),
    workspace: optionalStringField(body, "workspace"),
  };
}

function parseOptionalAgentId(value: string | undefined): AgentId | undefined {
  return value && isAgentId(value) ? value : undefined;
}

function parseProjectTarget(value: string | undefined): ProjectTarget {
  const target = (value ?? "local").trim();
  if (target === "local") return "local";
  if (target.startsWith("peer:") && target.length > 5) return target as ProjectTarget;
  return "local";
}

function assertProjectPeerScope(options: DashboardProjectRouteOptions, target: ProjectTarget | undefined): void {
  if (!target?.startsWith("peer:")) return;
  assertPeerAccess(options, target.slice(5));
}

function assertPeerAccess(options: DashboardProjectRouteOptions, peerId: string): void {
  if (!peerId) return;
  try {
    options.assertPeerAccess?.(peerId);
  } catch {
    throw new WebAccessDeniedError(`Access denied: peer ${peerId} is outside your group scope.`);
  }
}
