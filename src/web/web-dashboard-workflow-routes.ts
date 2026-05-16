import type { IncomingMessage, ServerResponse } from "node:http";

import type { RelayRuntime } from "../runtime/relay-runtime.js";
import type { PromptTemplate, Workflow, WorkflowStep } from "../state/workflow-store.js";
import type { AuthenticatedUser } from "../access/user-management.js";
import type { WebActivityActor } from "./web-state.js";
import {
  numberParam,
  objectRecord,
  optionalStringField,
  readJsonBody,
  sendJson,
  stringField,
} from "./web-dashboard-http.js";

export interface DashboardWorkflowRouteOptions {
  runtime: RelayRuntime;
  authUser: AuthenticatedUser;
  activityActor: WebActivityActor;
}

export async function handleDashboardWorkflowRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: DashboardWorkflowRouteOptions,
): Promise<boolean> {
  const service = options.runtime.workflowService;

  if (req.method === "GET" && url.pathname === "/api/templates") {
    sendJson(res, 200, { templates: service.list().templates });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/templates") {
    const body = await readJsonBody(req);
    sendJson(res, 201, { template: service.saveTemplate(parseTemplateBody(body, options.authUser.user.id), options.activityActor) });
    return true;
  }

  const templateMatch = url.pathname.match(/^\/api\/templates\/([^/]+)(?:\/(run|preview))?$/);
  if (templateMatch?.[1]) {
    const id = decodeURIComponent(templateMatch[1]);
    const action = templateMatch[2];
    if (req.method === "PUT" && !action) {
      const body = await readJsonBody(req);
      sendJson(res, 200, { template: service.saveTemplate({ ...parseTemplateBody(body, options.authUser.user.id), id }, options.activityActor) });
      return true;
    }
    if (req.method === "DELETE" && !action) {
      sendJson(res, 200, service.deleteTemplate(id, options.activityActor));
      return true;
    }
    if (req.method === "POST" && action === "preview") {
      const body = await readJsonBody(req);
      sendJson(res, 200, service.previewTemplate(id, variableRecord(body?.variables)));
      return true;
    }
    if (req.method === "POST" && action === "run") {
      const body = await readJsonBody(req);
      sendJson(res, 202, { run: await service.runTemplate(id, variableRecord(body?.variables), options.activityActor) });
      return true;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/workflows") {
    const list = service.list();
    sendJson(res, 200, { workflows: list.workflows, runs: list.runs.slice(0, numberParam(url, "runs", 100)) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/workflows") {
    const body = await readJsonBody(req);
    sendJson(res, 201, { workflow: service.saveWorkflow(parseWorkflowBody(body, options.authUser.user.id), options.activityActor) });
    return true;
  }

  const workflowRunMatch = url.pathname.match(/^\/api\/workflow-runs\/([^/]+)(?:\/cancel)?$/);
  if (workflowRunMatch?.[1]) {
    const id = decodeURIComponent(workflowRunMatch[1]);
    if (req.method === "GET" && !url.pathname.endsWith("/cancel")) {
      sendJson(res, 200, { run: options.runtime.workflowStore.getRun(id) });
      return true;
    }
    if (req.method === "POST" && url.pathname.endsWith("/cancel")) {
      sendJson(res, 200, { run: await service.cancelRun(id, options.activityActor) });
      return true;
    }
  }

  const workflowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)(?:\/(run|preview))?$/);
  if (workflowMatch?.[1]) {
    const id = decodeURIComponent(workflowMatch[1]);
    const action = workflowMatch[2];
    if (req.method === "PUT" && !action) {
      const body = await readJsonBody(req);
      sendJson(res, 200, { workflow: service.saveWorkflow({ ...parseWorkflowBody(body, options.authUser.user.id), id }, options.activityActor) });
      return true;
    }
    if (req.method === "DELETE" && !action) {
      sendJson(res, 200, service.deleteWorkflow(id, options.activityActor));
      return true;
    }
    if (req.method === "POST" && action === "preview") {
      const body = await readJsonBody(req);
      sendJson(res, 200, service.previewWorkflow(id, variableRecord(body?.variables)));
      return true;
    }
    if (req.method === "POST" && action === "run") {
      const body = await readJsonBody(req);
      sendJson(res, 202, { run: service.runWorkflow(id, variableRecord(body?.variables), options.activityActor) });
      return true;
    }
  }

  return false;
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
    scope: record.scope === "shared" ? "shared" : "private",
    ownerUserId,
  };
}

function parseWorkflowStep(value: unknown): WorkflowStep {
  const record = objectRecord(value);
  return {
    id: optionalStringField(record, "id") ?? "",
    name: optionalStringField(record, "name") ?? "Step",
    type: "prompt",
    prompt: optionalStringField(record, "prompt"),
    templateId: optionalStringField(record, "templateId"),
    agentId: optionalStringField(record, "agentId") as WorkflowStep["agentId"],
    workspace: optionalStringField(record, "workspace"),
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

function variableRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(objectRecord(value)).map(([key, raw]) => [key, String(raw ?? "")]),
  );
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}
