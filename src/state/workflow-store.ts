import { randomUUID } from "node:crypto";

import type { AgentId } from "../agents/shared/agent.js";
import type { SessionWorkspaceMode } from "../worktrees/worktree-types.js";
import { createDocumentStore, type DocumentStore, type StateBackendKind } from "./state-backend.js";

export type WorkflowScope = "private" | "shared";
export type WorkflowStepType = "prompt" | "workflow";
export type WorkflowSessionMode = "current" | "new" | "attach";
export type WorkflowTarget = "local" | `peer:${string}`;
export type WorkflowRunStatus = "queued" | "running" | "completed" | "failed" | "aborted" | "paused";
export type WorkflowStepRunStatus = WorkflowRunStatus | "pending" | "skipped";
export type WorkflowConditionOperator = "exists" | "equals" | "not_equals" | "contains" | "not_contains";

export interface WorkflowStepCondition {
  variable: string;
  operator: WorkflowConditionOperator;
  value?: string;
}

export interface WorkflowRetryPolicy {
  maxAttempts: number;
  delayMs: number;
}

export interface WorkflowSchedule {
  enabled: boolean;
  runAt?: string;
  intervalMinutes?: number;
  nextRunAt?: string;
  lastRunAt?: string;
}

export interface PromptTemplateVariable {
  name: string;
  label?: string;
  required?: boolean;
  defaultValue?: string;
}

export interface PromptTemplate {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  prompt: string;
  variables: PromptTemplateVariable[];
  defaultAgentId?: AgentId;
  defaultWorkspace?: string;
  defaultModel?: string;
  defaultReasoning?: string;
  defaultLaunchProfile?: string;
  scope: WorkflowScope;
  ownerUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStep {
  id: string;
  name: string;
  type: WorkflowStepType;
  prompt?: string;
  templateId?: string;
  workflowId?: string;
  condition?: WorkflowStepCondition;
  retryPolicy?: WorkflowRetryPolicy;
  agentId?: AgentId;
  workspace?: string;
  workspaceMode?: SessionWorkspaceMode;
  model?: string;
  reasoningEffort?: string;
  launchProfileId?: string;
  sessionMode: WorkflowSessionMode;
  threadId?: string;
  target: WorkflowTarget;
  requiresApproval: boolean;
  continueOnError: boolean;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  steps: WorkflowStep[];
  schedule?: WorkflowSchedule;
  scope: WorkflowScope;
  ownerUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStepRun {
  stepId: string;
  name: string;
  status: WorkflowStepRunStatus;
  prompt?: string;
  correlationId?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  attempts?: number;
  approvedAt?: string;
  skippedReason?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId?: string;
  templateId?: string;
  name: string;
  status: WorkflowRunStatus;
  ownerUserId?: string;
  variables: Record<string, string>;
  steps: WorkflowStepRun[];
  currentStepIndex: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

interface PersistedWorkflowStore {
  version: 1;
  templates: PromptTemplate[];
  workflows: Workflow[];
  runs: WorkflowRun[];
}

const DEFAULT_MAX_RUNS = 500;

export class WorkflowStore {
  private readonly store: DocumentStore<PersistedWorkflowStore>;

  constructor(workspace: string, backend: StateBackendKind = "json", private readonly maxRuns = DEFAULT_MAX_RUNS) {
    this.store = createDocumentStore<PersistedWorkflowStore>({
      workspace,
      backend,
      fileName: "workflows.json",
      sqliteKey: "workflows",
    });
  }

  listTemplates(): PromptTemplate[] {
    return this.payload().templates.sort(sortByUpdated);
  }

  getTemplate(id: string): PromptTemplate | null {
    return this.payload().templates.find((template) => template.id === id) ?? null;
  }

  saveTemplate(input: Partial<PromptTemplate> & Pick<PromptTemplate, "name" | "prompt">): PromptTemplate {
    const payload = this.payload();
    const now = new Date().toISOString();
    const id = normalizeId(input.id) || randomId();
    const existing = payload.templates.find((template) => template.id === id);
    const template = normalizeTemplate({
      ...existing,
      ...input,
      id,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    });
    payload.templates = upsertById(payload.templates, template);
    this.store.write(payload);
    return template;
  }

  deleteTemplate(id: string): boolean {
    const payload = this.payload();
    const next = payload.templates.filter((template) => template.id !== id);
    if (next.length === payload.templates.length) return false;
    payload.templates = next;
    this.store.write(payload);
    return true;
  }

  listWorkflows(): Workflow[] {
    return this.payload().workflows.sort(sortByUpdated);
  }

  getWorkflow(id: string): Workflow | null {
    return this.payload().workflows.find((workflow) => workflow.id === id) ?? null;
  }

  saveWorkflow(input: Partial<Workflow> & Pick<Workflow, "name" | "steps">): Workflow {
    const payload = this.payload();
    const now = new Date().toISOString();
    const id = normalizeId(input.id) || randomId();
    const existing = payload.workflows.find((workflow) => workflow.id === id);
    const workflow = normalizeWorkflow({
      ...existing,
      ...input,
      id,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    });
    payload.workflows = upsertById(payload.workflows, workflow);
    this.store.write(payload);
    return workflow;
  }

  deleteWorkflow(id: string): boolean {
    const payload = this.payload();
    const next = payload.workflows.filter((workflow) => workflow.id !== id);
    if (next.length === payload.workflows.length) return false;
    payload.workflows = next;
    this.store.write(payload);
    return true;
  }

  listRuns(limit = 100): WorkflowRun[] {
    return this.payload().runs
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, Math.max(1, Math.min(this.maxRuns, limit)));
  }

  getRun(id: string): WorkflowRun | null {
    return this.payload().runs.find((run) => run.id === id) ?? null;
  }

  saveRun(input: WorkflowRun): WorkflowRun {
    const payload = this.payload();
    const run = normalizeRun(input);
    payload.runs = upsertById(payload.runs, run)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, this.maxRuns);
    this.store.write(payload);
    return run;
  }

  patchRun(id: string, patch: Partial<WorkflowRun>): WorkflowRun | null {
    const existing = this.getRun(id);
    if (!existing) return null;
    return this.saveRun({ ...existing, ...patch, id, updatedAt: patch.updatedAt ?? new Date().toISOString() });
  }

  private payload(): PersistedWorkflowStore {
    const payload = this.store.read();
    if (!payload || payload.version !== 1) {
      return { version: 1, templates: [], workflows: [], runs: [] };
    }
    return {
      version: 1,
      templates: Array.isArray(payload.templates) ? payload.templates.map(normalizeTemplate) : [],
      workflows: Array.isArray(payload.workflows) ? payload.workflows.map(normalizeWorkflow) : [],
      runs: Array.isArray(payload.runs) ? payload.runs.map(normalizeRun).slice(0, this.maxRuns) : [],
    };
  }
}

export function extractTemplateVariables(prompt: string): PromptTemplateVariable[] {
  const names = new Set<string>();
  for (const match of prompt.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*\}\}/g)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names].map((name) => ({ name, required: true }));
}

export function renderTemplateText(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*\}\}/g, (_match, name: string) => variables[name] ?? "");
}

function normalizeTemplate(input: Partial<PromptTemplate> & Pick<PromptTemplate, "id" | "name" | "prompt">): PromptTemplate {
  const now = new Date().toISOString();
  const variables = input.variables?.length ? input.variables : extractTemplateVariables(input.prompt);
  return {
    id: normalizeId(input.id) || randomId(),
    name: String(input.name ?? "Untitled template").trim() || "Untitled template",
    description: cleanOptional(input.description),
    tags: normalizeTags(input.tags),
    prompt: String(input.prompt ?? "").trim(),
    variables: variables.map(normalizeVariable),
    defaultAgentId: input.defaultAgentId,
    defaultWorkspace: cleanOptional(input.defaultWorkspace),
    defaultModel: cleanOptional(input.defaultModel),
    defaultReasoning: cleanOptional(input.defaultReasoning),
    defaultLaunchProfile: cleanOptional(input.defaultLaunchProfile),
    scope: input.scope === "shared" ? "shared" : "private",
    ownerUserId: cleanOptional(input.ownerUserId),
    createdAt: validDate(input.createdAt) ?? now,
    updatedAt: validDate(input.updatedAt) ?? now,
  };
}

function normalizeWorkflow(input: Partial<Workflow> & Pick<Workflow, "id" | "name" | "steps">): Workflow {
  const now = new Date().toISOString();
  return {
    id: normalizeId(input.id) || randomId(),
    name: String(input.name ?? "Untitled workflow").trim() || "Untitled workflow",
    description: cleanOptional(input.description),
    tags: normalizeTags(input.tags),
    steps: (input.steps ?? []).map(normalizeStep),
    schedule: normalizeSchedule(input.schedule),
    scope: input.scope === "shared" ? "shared" : "private",
    ownerUserId: cleanOptional(input.ownerUserId),
    createdAt: validDate(input.createdAt) ?? now,
    updatedAt: validDate(input.updatedAt) ?? now,
  };
}

function normalizeStep(input: Partial<WorkflowStep>): WorkflowStep {
  const id = normalizeId(input.id) || randomId();
  return {
    id,
    name: String(input.name ?? `Step ${id.slice(0, 4)}`).trim() || "Step",
    type: input.type === "workflow" ? "workflow" : "prompt",
    prompt: cleanOptional(input.prompt),
    templateId: cleanOptional(input.templateId),
    workflowId: cleanOptional(input.workflowId),
    condition: normalizeCondition(input.condition),
    retryPolicy: normalizeRetryPolicy(input.retryPolicy),
    agentId: input.agentId,
    workspace: cleanOptional(input.workspace),
    workspaceMode: normalizeWorkspaceMode(input.workspaceMode),
    model: cleanOptional(input.model),
    reasoningEffort: cleanOptional(input.reasoningEffort),
    launchProfileId: cleanOptional(input.launchProfileId),
    sessionMode: input.sessionMode === "new" || input.sessionMode === "attach" ? input.sessionMode : "current",
    threadId: cleanOptional(input.threadId),
    target: normalizeTarget(input.target),
    requiresApproval: Boolean(input.requiresApproval),
    continueOnError: Boolean(input.continueOnError),
  };
}

function normalizeRun(input: WorkflowRun): WorkflowRun {
  const now = new Date().toISOString();
  return {
    ...input,
    id: normalizeId(input.id) || randomId(),
    name: String(input.name ?? "Workflow run").trim() || "Workflow run",
    status: normalizeRunStatus(input.status),
    variables: input.variables && typeof input.variables === "object" ? input.variables : {},
    steps: Array.isArray(input.steps) ? input.steps.map(normalizeStepRun) : [],
    currentStepIndex: Math.max(0, Number.isFinite(input.currentStepIndex) ? input.currentStepIndex : 0),
    createdAt: validDate(input.createdAt) ?? now,
    updatedAt: validDate(input.updatedAt) ?? now,
    startedAt: validDate(input.startedAt),
    finishedAt: validDate(input.finishedAt),
    error: cleanOptional(input.error),
  };
}

function normalizeStepRun(input: WorkflowStepRun): WorkflowStepRun {
  return {
    stepId: normalizeId(input.stepId) || randomId(),
    name: String(input.name ?? "Step").trim() || "Step",
    status: normalizeStepRunStatus(input.status),
    prompt: cleanOptional(input.prompt),
    correlationId: cleanOptional(input.correlationId),
    startedAt: validDate(input.startedAt),
    finishedAt: validDate(input.finishedAt),
    error: cleanOptional(input.error),
    attempts: Math.max(0, Number.isFinite(input.attempts) ? input.attempts! : 0) || undefined,
    approvedAt: validDate(input.approvedAt),
    skippedReason: cleanOptional(input.skippedReason),
  };
}

function normalizeVariable(input: PromptTemplateVariable): PromptTemplateVariable {
  return {
    name: String(input.name ?? "").trim(),
    label: cleanOptional(input.label),
    required: input.required !== false,
    defaultValue: cleanOptional(input.defaultValue),
  };
}

function normalizeTags(tags: unknown): string[] {
  return Array.isArray(tags)
    ? [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))]
    : [];
}

function normalizeTarget(target: unknown): WorkflowTarget {
  const value = String(target ?? "local").trim();
  return value.startsWith("peer:") ? value as WorkflowTarget : "local";
}

function normalizeWorkspaceMode(value: unknown): SessionWorkspaceMode | undefined {
  return value === "shared" || value === "worktree" || value === "attached" ? value : undefined;
}

function normalizeRunStatus(status: unknown): WorkflowRunStatus {
  return status === "queued" || status === "running" || status === "completed" || status === "failed" || status === "aborted" || status === "paused"
    ? status
    : "queued";
}

function normalizeStepRunStatus(status: unknown): WorkflowStepRunStatus {
  return status === "pending" || status === "skipped" ? status : normalizeRunStatus(status);
}

function normalizeCondition(input: unknown): WorkflowStepCondition | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const variable = cleanOptional(record.variable);
  if (!variable) return undefined;
  const operator = ["exists", "equals", "not_equals", "contains", "not_contains"].includes(String(record.operator))
    ? String(record.operator) as WorkflowConditionOperator
    : "exists";
  return { variable, operator, value: cleanOptional(record.value) };
}

function normalizeRetryPolicy(input: unknown): WorkflowRetryPolicy | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const maxAttempts = Math.max(1, Math.min(10, Math.floor(Number(record.maxAttempts) || 1)));
  const delayMs = Math.max(0, Math.min(60 * 60 * 1000, Math.floor(Number(record.delayMs) || 0)));
  return maxAttempts > 1 || delayMs > 0 ? { maxAttempts, delayMs } : undefined;
}

function normalizeSchedule(input: unknown): WorkflowSchedule | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const intervalMinutes = Math.max(0, Math.floor(Number(record.intervalMinutes) || 0)) || undefined;
  const runAt = validDate(record.runAt);
  const nextRunAt = validDate(record.nextRunAt) ?? runAt ?? (Boolean(record.enabled) && intervalMinutes ? new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString() : undefined);
  const schedule = {
    enabled: Boolean(record.enabled),
    runAt,
    intervalMinutes,
    nextRunAt,
    lastRunAt: validDate(record.lastRunAt),
  };
  return schedule.enabled || runAt || intervalMinutes ? schedule : undefined;
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function sortByUpdated(left: { updatedAt: string }, right: { updatedAt: string }): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function normalizeId(value: unknown): string {
  return String(value ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function cleanOptional(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function validDate(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function randomId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}
