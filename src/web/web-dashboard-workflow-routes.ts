import type { IncomingMessage, ServerResponse } from "node:http";

import { ADMIN_GROUP_ID } from "../access/access-control.js";
import type { RelayRuntime } from "../runtime/relay-runtime.js";
import type { PromptTemplate, Workflow, WorkflowRun, WorkflowStep, WorkflowStepCondition, WorkflowRetryPolicy, WorkflowSchedule, WorkflowTriggerKind } from "../state/workflow-store.js";
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

export interface DashboardWorkflowRouteOptions {
  runtime: RelayRuntime;
  authUser: AuthenticatedUser;
  activityActor: WebActivityActor;
  assertPeerAccess?: (peerId: string) => void;
}

export async function handleDashboardWorkflowRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: DashboardWorkflowRouteOptions,
): Promise<boolean> {
  const service = options.runtime.workflowService;

  if (req.method === "GET" && url.pathname === "/api/templates") {
    sendJson(res, 200, { templates: service.list().templates.filter((template) => canReadScopedWorkflowEntity(options.authUser, template)) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/templates") {
    const body = await readJsonBody(req);
    sendJson(res, 201, { template: service.saveTemplate(parseTemplateBody(body, options.authUser.user.id), options.activityActor) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/templates/import") {
    const body = await readJsonBody(req);
    const template = service.importTemplate(importBody(body), options.activityActor);
    assertCanWriteScopedWorkflowEntity(options.authUser, template);
    sendJson(res, 201, { template });
    return true;
  }

  const templateHistoryMatch = url.pathname.match(/^\/api\/templates\/([^/]+)\/(versions|diff|export)(?:\/([^/]+))?(?:\/(rollback|run|preview|export))?$/);
  if (templateHistoryMatch?.[1]) {
    const id = decodeURIComponent(templateHistoryMatch[1]);
    const section = templateHistoryMatch[2];
    const version = versionParam(templateHistoryMatch[3]);
    const action = templateHistoryMatch[4];
    if (req.method === "GET" && section === "versions" && !version && !action) {
      assertCanReadTemplate(options, id);
      sendJson(res, 200, { versions: service.listTemplateVersions(id) });
      return true;
    }
    if (req.method === "GET" && section === "diff") {
      assertCanReadTemplate(options, id);
      sendJson(res, 200, service.diffTemplateVersions(id, queryVersion(url, "from"), queryVersion(url, "to")));
      return true;
    }
    if (req.method === "GET" && section === "export") {
      assertCanReadTemplate(options, id);
      sendJson(res, 200, service.exportTemplate(id, queryVersion(url, "version")));
      return true;
    }
    if (section === "versions" && version && req.method === "GET" && action === "export") {
      assertCanReadTemplate(options, id);
      sendJson(res, 200, service.exportTemplate(id, version));
      return true;
    }
    if (section === "versions" && version && req.method === "POST" && action === "rollback") {
      assertCanWriteTemplate(options, id);
      sendJson(res, 200, { template: service.restoreTemplateVersion(id, version, options.activityActor) });
      return true;
    }
    if (section === "versions" && version && req.method === "POST" && action === "preview") {
      assertCanReadTemplate(options, id);
      const body = await readJsonBody(req);
      sendJson(res, 200, service.previewTemplateVersion(id, version, variableRecord(body?.variables)));
      return true;
    }
    if (section === "versions" && version && req.method === "POST" && action === "run") {
      assertCanReadTemplate(options, id);
      const body = await readJsonBody(req);
      sendJson(res, 202, { run: await service.runTemplateVersion(id, version, variableRecord(body?.variables), options.activityActor) });
      return true;
    }
  }

  const templateMatch = url.pathname.match(/^\/api\/templates\/([^/]+)(?:\/(run|preview))?$/);
  if (templateMatch?.[1]) {
    const id = decodeURIComponent(templateMatch[1]);
    const action = templateMatch[2];
    if (req.method === "PUT" && !action) {
      const existing = assertCanWriteTemplate(options, id);
      const body = await readJsonBody(req);
      sendJson(res, 200, { template: service.saveTemplate({ ...parseTemplateBody(body, existing.ownerUserId ?? options.authUser.user.id), id }, options.activityActor) });
      return true;
    }
    if (req.method === "DELETE" && !action) {
      assertCanWriteTemplate(options, id);
      sendJson(res, 200, service.deleteTemplate(id, options.activityActor));
      return true;
    }
    if (req.method === "POST" && action === "preview") {
      assertCanReadTemplate(options, id);
      const body = await readJsonBody(req);
      sendJson(res, 200, service.previewTemplate(id, variableRecord(body?.variables)));
      return true;
    }
    if (req.method === "POST" && action === "run") {
      assertCanReadTemplate(options, id);
      const body = await readJsonBody(req);
      sendJson(res, 202, { run: await service.runTemplate(id, variableRecord(body?.variables), options.activityActor) });
      return true;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/workflows") {
    const list = service.list();
    sendJson(res, 200, {
      workflows: list.workflows.filter((workflow) => canReadWorkflowEntity(options, workflow)),
      runs: list.runs.filter((run) => canReadWorkflowRun(options, run)).slice(0, numberParam(url, "runs", 100)),
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/workflows") {
    const body = await readJsonBody(req);
    const parsed = parseWorkflowBody(body, options.authUser.user.id);
    assertWorkflowPeerScope(options, parsed);
    sendJson(res, 201, { workflow: service.saveWorkflow(parsed, options.activityActor) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/workflows/import") {
    const body = await readJsonBody(req);
    const workflow = service.importWorkflow(importBody(body), options.activityActor);
    try {
      assertCanWriteScopedWorkflowEntity(options.authUser, workflow);
      assertWorkflowPeerScope(options, workflow);
    } catch (error) {
      service.deleteWorkflow(workflow.id, options.activityActor);
      throw error;
    }
    sendJson(res, 201, { workflow });
    return true;
  }

  const workflowRunMatch = url.pathname.match(/^\/api\/workflow-runs\/([^/]+)(?:\/(cancel|rerun-failed|report))?$/);
  if (workflowRunMatch?.[1]) {
    const id = decodeURIComponent(workflowRunMatch[1]);
    const action = workflowRunMatch[2];
    if (req.method === "GET" && !action) {
      assertCanReadWorkflowRun(options, id);
      sendJson(res, 200, { run: options.runtime.workflowStore.getRun(id) });
      return true;
    }
    if (req.method === "GET" && action === "report") {
      assertCanReadWorkflowRun(options, id);
      sendJson(res, 200, service.runReport(id));
      return true;
    }
    if (req.method === "POST" && action === "cancel") {
      assertCanWriteWorkflowRun(options, id);
      sendJson(res, 200, { run: await service.cancelRun(id, options.activityActor) });
      return true;
    }
    if (req.method === "POST" && action === "rerun-failed") {
      assertCanWriteWorkflowRun(options, id);
      sendJson(res, 200, { run: service.rerunFromFailedStep(id, options.activityActor) });
      return true;
    }
  }

  const workflowHistoryMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/(versions|diff|export)(?:\/([^/]+))?(?:\/(rollback|run|preview|export))?$/);
  if (workflowHistoryMatch?.[1]) {
    const id = decodeURIComponent(workflowHistoryMatch[1]);
    const section = workflowHistoryMatch[2];
    const version = versionParam(workflowHistoryMatch[3]);
    const action = workflowHistoryMatch[4];
    if (req.method === "GET" && section === "versions" && !version && !action) {
      assertCanReadWorkflow(options, id);
      sendJson(res, 200, { versions: service.listWorkflowVersions(id) });
      return true;
    }
    if (req.method === "GET" && section === "diff") {
      assertCanReadWorkflow(options, id);
      sendJson(res, 200, service.diffWorkflowVersions(id, queryVersion(url, "from"), queryVersion(url, "to")));
      return true;
    }
    if (req.method === "GET" && section === "export") {
      assertCanReadWorkflow(options, id);
      sendJson(res, 200, service.exportWorkflow(id, queryVersion(url, "version")));
      return true;
    }
    if (section === "versions" && version && req.method === "GET" && action === "export") {
      assertCanReadWorkflow(options, id);
      sendJson(res, 200, service.exportWorkflow(id, version));
      return true;
    }
    if (section === "versions" && version && req.method === "POST" && action === "rollback") {
      assertCanWriteWorkflow(options, id);
      assertWorkflowVersionPeerScope(options, id, version);
      sendJson(res, 200, { workflow: service.restoreWorkflowVersion(id, version, options.activityActor) });
      return true;
    }
    if (section === "versions" && version && req.method === "POST" && action === "preview") {
      assertCanReadWorkflow(options, id);
      assertWorkflowVersionPeerScope(options, id, version);
      const body = await readJsonBody(req);
      sendJson(res, 200, service.previewWorkflowVersion(id, version, variableRecord(body?.variables)));
      return true;
    }
    if (section === "versions" && version && req.method === "POST" && action === "run") {
      assertCanReadWorkflow(options, id);
      assertWorkflowVersionPeerScope(options, id, version);
      const body = await readJsonBody(req);
      sendJson(res, 202, { run: service.runWorkflowVersion(id, version, variableRecord(body?.variables), options.activityActor) });
      return true;
    }
  }

  const workflowDryRunMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/dry-run$/);
  if (workflowDryRunMatch?.[1] && req.method === "POST") {
    const body = await readJsonBody(req);
    const id = decodeURIComponent(workflowDryRunMatch[1]);
    assertCanReadWorkflow(options, id);
    const version = versionParam(optionalStringField(objectRecord(body), "version"));
    if (version) {
      assertWorkflowVersionPeerScope(options, id, version);
    } else {
      assertWorkflowPeerScope(options, assertCanReadWorkflow(options, id));
    }
    sendJson(res, 200, service.dryRunWorkflow(id, variableRecord(body?.variables), version));
    return true;
  }

  const workflowTriggerMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/triggers(?:\/([^/]+))?$/);
  if (workflowTriggerMatch?.[1]) {
    const workflowId = decodeURIComponent(workflowTriggerMatch[1]);
    const triggerId = workflowTriggerMatch[2] ? decodeURIComponent(workflowTriggerMatch[2]) : undefined;
    if (req.method === "GET" && !triggerId) {
      assertCanReadWorkflow(options, workflowId);
      sendJson(res, 200, { triggers: service.listWorkflowTriggers(workflowId) });
      return true;
    }
    if (req.method === "POST" && !triggerId) {
      assertCanWriteWorkflow(options, workflowId);
      const body = await readJsonBody(req);
      sendJson(res, 201, service.createWorkflowTrigger(workflowId, {
        kind: parseTriggerKind(optionalStringField(body, "kind")),
        name: optionalStringField(body, "name"),
        enabled: body?.enabled !== false,
      }, options.activityActor));
      return true;
    }
    if (req.method === "DELETE" && triggerId) {
      assertCanWriteWorkflow(options, workflowId);
      sendJson(res, 200, service.deleteWorkflowTrigger(workflowId, triggerId, options.activityActor));
      return true;
    }
  }

  const workflowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)(?:\/(run|preview))?$/);
  if (workflowMatch?.[1]) {
    const id = decodeURIComponent(workflowMatch[1]);
    const action = workflowMatch[2];
    if (req.method === "PUT" && !action) {
      const existing = assertCanWriteWorkflow(options, id);
      const body = await readJsonBody(req);
      const parsed = { ...parseWorkflowBody(body, existing.ownerUserId ?? options.authUser.user.id), id };
      assertWorkflowPeerScope(options, parsed);
      sendJson(res, 200, { workflow: service.saveWorkflow(parsed, options.activityActor) });
      return true;
    }
    if (req.method === "DELETE" && !action) {
      assertCanWriteWorkflow(options, id);
      sendJson(res, 200, service.deleteWorkflow(id, options.activityActor));
      return true;
    }
    if (req.method === "POST" && action === "preview") {
      assertWorkflowPeerScope(options, assertCanReadWorkflow(options, id));
      const body = await readJsonBody(req);
      sendJson(res, 200, service.previewWorkflow(id, variableRecord(body?.variables)));
      return true;
    }
    if (req.method === "POST" && action === "run") {
      assertWorkflowPeerScope(options, assertCanReadWorkflow(options, id));
      const body = await readJsonBody(req);
      sendJson(res, 202, { run: service.runWorkflow(id, variableRecord(body?.variables), options.activityActor) });
      return true;
    }
  }

  return false;
}

function parseTriggerKind(value: string | undefined): WorkflowTriggerKind {
  return value === "webhook" ? "webhook" : "api";
}

function isWorkflowAdmin(authUser: AuthenticatedUser): boolean {
  return authUser.groups.some((group) => group.id === ADMIN_GROUP_ID);
}

function ownsWorkflowEntity(authUser: AuthenticatedUser, entity: Pick<PromptTemplate | Workflow, "ownerUserId">): boolean {
  return Boolean(entity.ownerUserId && entity.ownerUserId === authUser.user.id);
}

export function canReadScopedWorkflowEntity(authUser: AuthenticatedUser, entity: Pick<PromptTemplate | Workflow, "scope" | "ownerUserId">): boolean {
  return entity.scope === "shared" || ownsWorkflowEntity(authUser, entity) || isWorkflowAdmin(authUser);
}

function canReadWorkflowEntity(options: DashboardWorkflowRouteOptions, workflow: Workflow): boolean {
  if (!canReadScopedWorkflowEntity(options.authUser, workflow)) {
    return false;
  }
  try {
    assertWorkflowPeerScope(options, workflow);
    return true;
  } catch {
    return false;
  }
}

function assertWorkflowPeerScope(
  options: DashboardWorkflowRouteOptions,
  workflow: Pick<Workflow, "steps">,
  seenWorkflowIds = new Set<string>(),
): void {
  for (const step of workflow.steps ?? []) {
    const peerId = peerIdFromWorkflowTarget(step.target);
    if (peerId) {
      options.assertPeerAccess?.(peerId);
    }
    if (step.type === "workflow" && step.workflowId && !seenWorkflowIds.has(step.workflowId)) {
      seenWorkflowIds.add(step.workflowId);
      const child = options.runtime.workflowStore.getWorkflow(step.workflowId);
      if (child) {
        assertWorkflowPeerScope(options, child, seenWorkflowIds);
      }
    }
  }
}

function assertWorkflowVersionPeerScope(options: DashboardWorkflowRouteOptions, id: string, version: number): void {
  const exported = options.runtime.workflowService.exportWorkflow(id, version);
  const workflow = (exported.version?.snapshot ?? exported.workflow) as Workflow | undefined;
  if (workflow) {
    assertWorkflowPeerScope(options, workflow);
  }
}

function peerIdFromWorkflowTarget(target: WorkflowStep["target"] | undefined): string | null {
  return target?.startsWith("peer:") ? target.slice("peer:".length).trim() || null : null;
}

function assertCanWriteScopedWorkflowEntity(authUser: AuthenticatedUser, entity: Pick<PromptTemplate | Workflow, "scope" | "ownerUserId">): void {
  if (!canReadScopedWorkflowEntity(authUser, entity)) {
    throw new WebAccessDeniedError("Access denied: workflow item is private to another user.");
  }
}

function assertCanReadTemplate(options: DashboardWorkflowRouteOptions, id: string): PromptTemplate {
  const template = options.runtime.workflowStore.getTemplate(id);
  if (!template) throw new Error(`Template not found: ${id}`);
  if (!canReadScopedWorkflowEntity(options.authUser, template)) {
    throw new WebAccessDeniedError("Access denied: template is private to another user.");
  }
  return template;
}

function assertCanWriteTemplate(options: DashboardWorkflowRouteOptions, id: string): PromptTemplate {
  const template = assertCanReadTemplate(options, id);
  assertCanWriteScopedWorkflowEntity(options.authUser, template);
  return template;
}

function assertCanReadWorkflow(options: DashboardWorkflowRouteOptions, id: string): Workflow {
  const workflow = options.runtime.workflowStore.getWorkflow(id);
  if (!workflow) throw new Error(`Workflow not found: ${id}`);
  if (!canReadWorkflowEntity(options, workflow)) {
    throw new WebAccessDeniedError("Access denied: workflow is private to another user.");
  }
  return workflow;
}

function assertCanWriteWorkflow(options: DashboardWorkflowRouteOptions, id: string): Workflow {
  const workflow = assertCanReadWorkflow(options, id);
  assertCanWriteScopedWorkflowEntity(options.authUser, workflow);
  return workflow;
}

function canReadWorkflowRun(options: DashboardWorkflowRouteOptions, run: WorkflowRun): boolean {
  if (isWorkflowAdmin(options.authUser)) return true;
  if (run.ownerUserId && run.ownerUserId === options.authUser.user.id) return true;
  if (run.templateSnapshot && canReadScopedWorkflowEntity(options.authUser, run.templateSnapshot)) return true;
  if (run.workflowSnapshot && canReadWorkflowEntity(options, run.workflowSnapshot)) return true;
  if (run.templateId) {
    const template = options.runtime.workflowStore.getTemplate(run.templateId);
    if (template && canReadScopedWorkflowEntity(options.authUser, template)) return true;
  }
  if (run.workflowId) {
    const workflow = options.runtime.workflowStore.getWorkflow(run.workflowId);
    if (workflow && canReadWorkflowEntity(options, workflow)) return true;
  }
  return false;
}

function assertCanReadWorkflowRun(options: DashboardWorkflowRouteOptions, id: string) {
  const run = options.runtime.workflowStore.getRun(id);
  if (!run) throw new Error(`Workflow run not found: ${id}`);
  if (!canReadWorkflowRun(options, run)) {
    throw new WebAccessDeniedError("Access denied: workflow run is private to another user.");
  }
  return run;
}

function assertCanWriteWorkflowRun(options: DashboardWorkflowRouteOptions, id: string) {
  const run = assertCanReadWorkflowRun(options, id);
  if (!isWorkflowAdmin(options.authUser) && run.ownerUserId !== options.authUser.user.id) {
    throw new WebAccessDeniedError("Access denied: workflow run is owned by another user.");
  }
  return run;
}

function importBody(body: unknown): unknown {
  const record = objectRecord(body);
  return record.bundle ?? body;
}

function versionParam(value: string | undefined): number | undefined {
  const version = Number(value);
  return Number.isFinite(version) && version > 0 ? Math.floor(version) : undefined;
}

function queryVersion(url: URL, key: string): number | undefined {
  return versionParam(url.searchParams.get(key) ?? undefined);
}

function parseTemplateBody(body: unknown, ownerUserId: string): Partial<PromptTemplate> & Pick<PromptTemplate, "name" | "prompt"> {
  const record = objectRecord(body);
  return {
    name: stringField(record, "name"),
    description: optionalStringField(record, "description"),
    tags: stringList(record.tags),
    prompt: stringField(record, "prompt"),
    variables: Array.isArray(record.variables) ? record.variables.map((variable) => {
      const variableRecord = objectRecord(variable) as Record<string, unknown>;
      return {
        name: stringField(variableRecord, "name"),
        label: optionalStringField(variableRecord, "label"),
        required: variableRecord.required !== false,
        defaultValue: optionalStringField(variableRecord, "defaultValue"),
      };
    }) : undefined,
    defaultAgentId: optionalStringField(record, "defaultAgentId") as PromptTemplate["defaultAgentId"],
    defaultWorkspace: optionalStringField(record, "defaultWorkspace"),
    defaultModel: optionalStringField(record, "defaultModel"),
    defaultReasoning: optionalStringField(record, "defaultReasoning"),
    defaultLaunchProfile: optionalStringField(record, "defaultLaunchProfile"),
    scope: record.scope === "shared" ? "shared" : "private",
    ownerUserId,
  };
}

function parseWorkflowBody(body: unknown, ownerUserId: string): Partial<Workflow> & Pick<Workflow, "name" | "steps"> {
  const record = objectRecord(body);
  return {
    name: stringField(record, "name"),
    description: optionalStringField(record, "description"),
    tags: stringList(record.tags),
    steps: Array.isArray(record.steps) ? record.steps.map(parseWorkflowStep) : [],
    schedule: parseWorkflowSchedule(record.schedule),
    scope: record.scope === "shared" ? "shared" : "private",
    ownerUserId,
  };
}

function parseWorkflowStep(value: unknown): WorkflowStep {
  const record = objectRecord(value);
  return {
    id: optionalStringField(record, "id") ?? "",
    name: optionalStringField(record, "name") ?? "Step",
    type: record.type === "workflow" ? "workflow" : "prompt",
    prompt: optionalStringField(record, "prompt"),
    templateId: optionalStringField(record, "templateId"),
    workflowId: optionalStringField(record, "workflowId"),
    condition: parseWorkflowCondition(record.condition),
    retryPolicy: parseRetryPolicy(record.retryPolicy),
    agentId: optionalStringField(record, "agentId") as WorkflowStep["agentId"],
    workspace: optionalStringField(record, "workspace"),
    workspaceMode: parseWorkspaceMode(optionalStringField(record, "workspaceMode")),
    model: optionalStringField(record, "model"),
    reasoningEffort: optionalStringField(record, "reasoningEffort"),
    launchProfileId: optionalStringField(record, "launchProfileId"),
    sessionMode: record.sessionMode === "new" || record.sessionMode === "attach" ? record.sessionMode : "current",
    threadId: optionalStringField(record, "threadId"),
    target: optionalStringField(record, "target") as WorkflowStep["target"] ?? "local",
    requiresApproval: Boolean(record.requiresApproval),
    continueOnError: Boolean(record.continueOnError),
  };
}

function parseWorkspaceMode(value: string | undefined): WorkflowStep["workspaceMode"] {
  return value === "shared" || value === "worktree" || value === "attached" ? value : undefined;
}

function parseWorkflowCondition(value: unknown): WorkflowStepCondition | undefined {
  const record = objectRecord(value);
  const variable = optionalStringField(record, "variable");
  if (!variable) return undefined;
  const operator = ["exists", "equals", "not_equals", "contains", "not_contains"].includes(String(record.operator))
    ? String(record.operator) as WorkflowStepCondition["operator"]
    : "exists";
  return { variable, operator, value: optionalStringField(record, "value") };
}

function parseRetryPolicy(value: unknown): WorkflowRetryPolicy | undefined {
  const record = objectRecord(value);
  const maxAttempts = Number(record.maxAttempts);
  const delayMs = Number(record.delayMs);
  if (!Number.isFinite(maxAttempts) && !Number.isFinite(delayMs)) return undefined;
  return {
    maxAttempts: Number.isFinite(maxAttempts) ? Math.max(1, Math.min(10, Math.floor(maxAttempts))) : 1,
    delayMs: Number.isFinite(delayMs) ? Math.max(0, Math.floor(delayMs)) : 0,
  };
}

function parseWorkflowSchedule(value: unknown): WorkflowSchedule | undefined {
  const record = objectRecord(value);
  if (!Object.keys(record).length) return undefined;
  return {
    enabled: Boolean(record.enabled),
    runAt: optionalStringField(record, "runAt"),
    intervalMinutes: Number.isFinite(Number(record.intervalMinutes)) ? Math.max(0, Math.floor(Number(record.intervalMinutes))) : undefined,
    cron: optionalStringField(record, "cron"),
    timezone: optionalStringField(record, "timezone"),
    nextRunAt: optionalStringField(record, "nextRunAt"),
    lastRunAt: optionalStringField(record, "lastRunAt"),
  };
}

function variableRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(objectRecord(value)).map(([key, raw]) => [key, String(raw ?? "")]),
  );
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}
