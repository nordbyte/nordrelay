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
  cron?: string;
  timezone?: string;
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

export type WorkflowVersionKind = "template" | "workflow";

export interface WorkflowVersionRecord {
  id: string;
  kind: WorkflowVersionKind;
  entityId: string;
  version: number;
  name: string;
  createdAt: string;
  createdByUserId?: string;
  snapshot: PromptTemplate | Workflow;
}

export interface WorkflowVersionDiffEntry {
  path: string;
  type: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

export interface WorkflowVersionDiff {
  kind: WorkflowVersionKind;
  entityId: string;
  fromVersion?: number;
  toVersion?: number;
  changes: WorkflowVersionDiffEntry[];
}

export interface WorkflowExportBundle {
  kind: WorkflowVersionKind;
  exportedAt: string;
  template?: PromptTemplate;
  workflow?: Workflow;
  version?: WorkflowVersionRecord;
}

export interface WorkflowStepRun {
  stepId: string;
  name: string;
  status: WorkflowStepRunStatus;
  prompt?: string;
  correlationId?: string;
  target?: WorkflowTarget;
  sessionMode?: WorkflowSessionMode;
  agentId?: AgentId;
  workspace?: string;
  workspaceMode?: SessionWorkspaceMode;
  model?: string;
  reasoningEffort?: string;
  launchProfileId?: string;
  requiresApproval?: boolean;
  continueOnError?: boolean;
  retryPolicy?: WorkflowRetryPolicy;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  attempts?: number;
  attemptHistory?: WorkflowStepAttempt[];
  approvedAt?: string;
  skippedReason?: string;
  pauseReason?: string;
  inputPreview?: string;
  outputSummary?: string;
}

export interface WorkflowStepAttempt {
  attempt: number;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  correlationId?: string;
  error?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId?: string;
  templateId?: string;
  workflowVersion?: number;
  templateVersion?: number;
  workflowSnapshot?: Workflow;
  templateSnapshot?: PromptTemplate;
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
  logs?: WorkflowRunLogEntry[];
}

export interface WorkflowRunLogEntry {
  id: string;
  at: string;
  level: "info" | "warn" | "error";
  scope: "run" | "step";
  stepId?: string;
  message: string;
  detail?: string;
}

export interface WorkflowRunReport {
  generatedAt: string;
  run: WorkflowRun;
  summary: {
    status: WorkflowRunStatus;
    totalSteps: number;
    completedSteps: number;
    failedSteps: number;
    skippedSteps: number;
    durationMs: number | null;
  };
  steps: WorkflowStepRun[];
  logs: WorkflowRunLogEntry[];
}

interface PersistedWorkflowStore {
  version: 1;
  templates: PromptTemplate[];
  workflows: Workflow[];
  runs: WorkflowRun[];
  versions: WorkflowVersionRecord[];
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
    payload.versions = appendVersion(payload.versions ?? [], "template", template, input.ownerUserId);
    this.store.write(payload);
    return template;
  }

  deleteTemplate(id: string): boolean {
    const payload = this.payload();
    const next = payload.templates.filter((template) => template.id !== id);
    if (next.length === payload.templates.length) return false;
    payload.templates = next;
    payload.versions = (payload.versions ?? []).filter((version) => !(version.kind === "template" && version.entityId === id));
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
    payload.versions = appendVersion(payload.versions ?? [], "workflow", workflow, input.ownerUserId);
    this.store.write(payload);
    return workflow;
  }

  deleteWorkflow(id: string): boolean {
    const payload = this.payload();
    const next = payload.workflows.filter((workflow) => workflow.id !== id);
    if (next.length === payload.workflows.length) return false;
    payload.workflows = next;
    payload.versions = (payload.versions ?? []).filter((version) => !(version.kind === "workflow" && version.entityId === id));
    this.store.write(payload);
    return true;
  }

  listVersions(kind: WorkflowVersionKind, entityId: string): WorkflowVersionRecord[] {
    return this.payload().versions
      .filter((version) => version.kind === kind && version.entityId === entityId)
      .sort((left, right) => right.version - left.version);
  }

  getVersion(kind: WorkflowVersionKind, entityId: string, version: number): WorkflowVersionRecord | null {
    return this.payload().versions.find((item) => item.kind === kind && item.entityId === entityId && item.version === version) ?? null;
  }

  latestVersion(kind: WorkflowVersionKind, entityId: string): WorkflowVersionRecord | null {
    return this.listVersions(kind, entityId)[0] ?? null;
  }

  restoreVersion(kind: WorkflowVersionKind, entityId: string, version: number, ownerUserId?: string): PromptTemplate | Workflow | null {
    const record = this.getVersion(kind, entityId, version);
    if (!record) return null;
    if (kind === "template") {
      return this.saveTemplate({ ...(record.snapshot as PromptTemplate), id: entityId, ownerUserId });
    }
    return this.saveWorkflow({ ...(record.snapshot as Workflow), id: entityId, ownerUserId });
  }

  diffVersions(kind: WorkflowVersionKind, entityId: string, fromVersion?: number, toVersion?: number): WorkflowVersionDiff {
    const versions = this.listVersions(kind, entityId).slice().reverse();
    const to = toVersion ? this.getVersion(kind, entityId, toVersion) : versions.at(-1) ?? null;
    const from = fromVersion ? this.getVersion(kind, entityId, fromVersion) : versions.at(-2) ?? null;
    return {
      kind,
      entityId,
      fromVersion: from?.version,
      toVersion: to?.version,
      changes: diffObjects(from?.snapshot, to?.snapshot),
    };
  }

  exportTemplate(id: string, version?: number): WorkflowExportBundle | null {
    const versionRecord = version ? this.getVersion("template", id, version) : this.latestVersion("template", id);
    const template = (versionRecord?.snapshot as PromptTemplate | undefined) ?? this.getTemplate(id) ?? undefined;
    return template ? { kind: "template", exportedAt: new Date().toISOString(), template, version: versionRecord ?? undefined } : null;
  }

  exportWorkflow(id: string, version?: number): WorkflowExportBundle | null {
    const versionRecord = version ? this.getVersion("workflow", id, version) : this.latestVersion("workflow", id);
    const workflow = (versionRecord?.snapshot as Workflow | undefined) ?? this.getWorkflow(id) ?? undefined;
    return workflow ? { kind: "workflow", exportedAt: new Date().toISOString(), workflow, version: versionRecord ?? undefined } : null;
  }

  importTemplate(input: unknown, ownerUserId?: string): PromptTemplate {
    const raw = importedRecord<PromptTemplate>(input, "template");
    return this.saveTemplate({
      ...raw,
      id: randomId(),
      ownerUserId,
      createdAt: undefined,
      updatedAt: undefined,
      name: raw.name ? String(raw.name) : "Imported template",
      prompt: raw.prompt ?? "",
    });
  }

  importWorkflow(input: unknown, ownerUserId?: string): Workflow {
    const raw = importedRecord<Workflow>(input, "workflow");
    return this.saveWorkflow({
      ...raw,
      id: randomId(),
      ownerUserId,
      createdAt: undefined,
      updatedAt: undefined,
      name: raw.name ? String(raw.name) : "Imported workflow",
      steps: raw.steps ?? [],
    });
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

  appendRunLog(id: string, input: Omit<WorkflowRunLogEntry, "id" | "at"> & { id?: string; at?: string }): WorkflowRun | null {
    const existing = this.getRun(id);
    if (!existing) return null;
    const entry = normalizeRunLog({
      id: input.id ?? randomId(),
      at: input.at ?? new Date().toISOString(),
      level: input.level,
      scope: input.scope,
      stepId: input.stepId,
      message: input.message,
      detail: input.detail,
    });
    return this.saveRun({
      ...existing,
      logs: [...(existing.logs ?? []), entry].slice(-500),
      updatedAt: new Date().toISOString(),
    });
  }

  private payload(): PersistedWorkflowStore {
    const payload = this.store.read();
    if (!payload || payload.version !== 1) {
      return { version: 1, templates: [], workflows: [], runs: [], versions: [] };
    }
    return {
      version: 1,
      templates: Array.isArray(payload.templates) ? payload.templates.map(normalizeTemplate) : [],
      workflows: Array.isArray(payload.workflows) ? payload.workflows.map(normalizeWorkflow) : [],
      runs: Array.isArray(payload.runs) ? payload.runs.map(normalizeRun).slice(0, this.maxRuns) : [],
      versions: normalizeVersions(payload.versions),
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
  const workflowSnapshot = input.workflowSnapshot ? normalizeWorkflow(input.workflowSnapshot) : undefined;
  const templateSnapshot = input.templateSnapshot ? normalizeTemplate(input.templateSnapshot) : undefined;
  return {
    ...input,
    id: normalizeId(input.id) || randomId(),
    workflowVersion: normalizePositiveNumber(input.workflowVersion),
    templateVersion: normalizePositiveNumber(input.templateVersion),
    workflowSnapshot,
    templateSnapshot,
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
    logs: normalizeRunLogs(input.logs),
  };
}

function normalizeStepRun(input: WorkflowStepRun): WorkflowStepRun {
  return {
    stepId: normalizeId(input.stepId) || randomId(),
    name: String(input.name ?? "Step").trim() || "Step",
    status: normalizeStepRunStatus(input.status),
    prompt: cleanOptional(input.prompt),
    correlationId: cleanOptional(input.correlationId),
    target: normalizeTarget(input.target),
    sessionMode: input.sessionMode === "new" || input.sessionMode === "attach" ? input.sessionMode : input.sessionMode === "current" ? "current" : undefined,
    agentId: input.agentId,
    workspace: cleanOptional(input.workspace),
    workspaceMode: normalizeWorkspaceMode(input.workspaceMode),
    model: cleanOptional(input.model),
    reasoningEffort: cleanOptional(input.reasoningEffort),
    launchProfileId: cleanOptional(input.launchProfileId),
    requiresApproval: input.requiresApproval === undefined ? undefined : Boolean(input.requiresApproval),
    continueOnError: input.continueOnError === undefined ? undefined : Boolean(input.continueOnError),
    retryPolicy: normalizeRetryPolicy(input.retryPolicy),
    startedAt: validDate(input.startedAt),
    finishedAt: validDate(input.finishedAt),
    error: cleanOptional(input.error),
    attempts: Math.max(0, Number.isFinite(input.attempts) ? input.attempts! : 0) || undefined,
    attemptHistory: normalizeAttemptHistory(input.attemptHistory),
    approvedAt: validDate(input.approvedAt),
    skippedReason: cleanOptional(input.skippedReason),
    pauseReason: cleanOptional(input.pauseReason),
    inputPreview: cleanOptional(input.inputPreview),
    outputSummary: cleanOptional(input.outputSummary),
  };
}

function normalizeRunLogs(input: unknown): WorkflowRunLogEntry[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const logs = input
    .map((item): WorkflowRunLogEntry | null => {
      if (!item || typeof item !== "object") return null;
      return normalizeRunLog(item as WorkflowRunLogEntry);
    })
    .filter((item): item is WorkflowRunLogEntry => Boolean(item));
  return logs.length ? logs.slice(-500) : undefined;
}

function normalizeRunLog(input: WorkflowRunLogEntry): WorkflowRunLogEntry {
  return {
    id: normalizeId(input.id) || randomId(),
    at: validDate(input.at) ?? new Date().toISOString(),
    level: input.level === "warn" || input.level === "error" ? input.level : "info",
    scope: input.scope === "step" ? "step" : "run",
    stepId: cleanOptional(input.stepId),
    message: String(input.message ?? "").trim() || "Workflow event",
    detail: cleanOptional(input.detail),
  };
}

function normalizeVersions(input: unknown): WorkflowVersionRecord[] {
  if (!Array.isArray(input)) return [];
  return input
    .map(normalizeVersionRecord)
    .filter((version): version is WorkflowVersionRecord => Boolean(version))
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
      if (left.entityId !== right.entityId) return left.entityId.localeCompare(right.entityId);
      return left.version - right.version;
    })
    .slice(-2_000);
}

function normalizeVersionRecord(input: unknown): WorkflowVersionRecord | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const kind = normalizeVersionKind(record.kind);
  const entityId = normalizeId(record.entityId);
  const version = normalizePositiveNumber(record.version);
  const snapshot = normalizeVersionSnapshot(kind, record.snapshot);
  if (!kind || !entityId || !version || !snapshot) return null;
  return {
    id: normalizeId(record.id) || `${kind}_${entityId}_v${version}`,
    kind,
    entityId,
    version,
    name: String(record.name ?? snapshot.name ?? `${kind} ${version}`).trim(),
    createdAt: validDate(record.createdAt) ?? new Date().toISOString(),
    createdByUserId: cleanOptional(record.createdByUserId),
    snapshot,
  };
}

function normalizeVersionKind(value: unknown): WorkflowVersionKind | null {
  return value === "template" || value === "workflow" ? value : null;
}

function normalizeVersionSnapshot(kind: WorkflowVersionKind | null, snapshot: unknown): PromptTemplate | Workflow | null {
  if (!kind || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const record = snapshot as Record<string, unknown>;
  if (kind === "template") {
    return normalizeTemplate({
      id: normalizeId(record.id),
      name: String(record.name ?? "Untitled template"),
      prompt: String(record.prompt ?? ""),
      description: cleanOptional(record.description),
      tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
      variables: Array.isArray(record.variables) ? record.variables as PromptTemplateVariable[] : undefined,
      defaultAgentId: cleanOptional(record.defaultAgentId) as AgentId | undefined,
      defaultWorkspace: cleanOptional(record.defaultWorkspace),
      defaultModel: cleanOptional(record.defaultModel),
      defaultReasoning: cleanOptional(record.defaultReasoning),
      defaultLaunchProfile: cleanOptional(record.defaultLaunchProfile),
      scope: record.scope === "shared" ? "shared" : "private",
      ownerUserId: cleanOptional(record.ownerUserId),
      createdAt: validDate(record.createdAt),
      updatedAt: validDate(record.updatedAt),
    });
  }
  return normalizeWorkflow({
    id: normalizeId(record.id),
    name: String(record.name ?? "Untitled workflow"),
    description: cleanOptional(record.description),
    tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
    steps: Array.isArray(record.steps) ? record.steps as WorkflowStep[] : [],
    schedule: record.schedule as WorkflowSchedule | undefined,
    scope: record.scope === "shared" ? "shared" : "private",
    ownerUserId: cleanOptional(record.ownerUserId),
    createdAt: validDate(record.createdAt),
    updatedAt: validDate(record.updatedAt),
  });
}

function appendVersion(versions: WorkflowVersionRecord[], kind: WorkflowVersionKind, snapshot: PromptTemplate | Workflow, userId?: string): WorkflowVersionRecord[] {
  const normalized = normalizeVersionSnapshot(kind, snapshot);
  if (!normalized) return versions;
  const entityVersions = versions
    .filter((version) => version.kind === kind && version.entityId === normalized.id)
    .sort((left, right) => right.version - left.version);
  const latest = entityVersions[0];
  if (latest && snapshotFingerprint(latest.snapshot) === snapshotFingerprint(normalized)) {
    return versions;
  }
  const nextVersion = (latest?.version ?? 0) + 1;
  const record: WorkflowVersionRecord = {
    id: `${kind}_${normalized.id}_v${nextVersion}`,
    kind,
    entityId: normalized.id,
    version: nextVersion,
    name: normalized.name,
    createdAt: new Date().toISOString(),
    createdByUserId: cleanOptional(userId),
    snapshot: cloneJson(normalized),
  };
  return [...versions, record]
    .filter((item) => item.kind !== kind || item.entityId !== normalized.id || item.version > nextVersion - 50)
    .slice(-2_000);
}

function snapshotFingerprint(snapshot: PromptTemplate | Workflow): string {
  const copy = cloneJson(snapshot);
  delete (copy as { updatedAt?: string }).updatedAt;
  return JSON.stringify(copy);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function diffObjects(before: unknown, after: unknown, basePath = ""): WorkflowVersionDiffEntry[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const beforeRecord = objectDiffRecord(before);
  const afterRecord = objectDiffRecord(after);
  if (!beforeRecord || !afterRecord) {
    return [{ path: basePath || "$", type: before === undefined ? "added" : after === undefined ? "removed" : "changed", before, after }];
  }
  const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort();
  return keys.flatMap((key) => {
    const path = basePath ? `${basePath}.${key}` : key;
    if (!(key in beforeRecord)) return [{ path, type: "added" as const, after: afterRecord[key] }];
    if (!(key in afterRecord)) return [{ path, type: "removed" as const, before: beforeRecord[key] }];
    return diffObjects(beforeRecord[key], afterRecord[key], path);
  }).slice(0, 200);
}

function objectDiffRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function importedRecord<T extends PromptTemplate | Workflow>(input: unknown, kind: WorkflowVersionKind): T {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const bundleKind = normalizeVersionKind(record.kind);
  const bundled = kind === "template" ? record.template : record.workflow;
  const version = record.version && typeof record.version === "object" ? record.version as WorkflowVersionRecord : null;
  const snapshot = version?.snapshot ?? bundled ?? input;
  if (bundleKind && bundleKind !== kind) {
    throw new Error(`Import bundle is for ${bundleKind}, not ${kind}.`);
  }
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error(`Invalid ${kind} import bundle.`);
  }
  return cloneJson(snapshot) as T;
}

function normalizeAttemptHistory(input: unknown): WorkflowStepAttempt[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const attempts = input.map((item): WorkflowStepAttempt | null => {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    const attempt = Math.max(1, Math.floor(Number(record.attempt) || 1));
    const startedAt = validDate(record.startedAt);
    if (!startedAt) return null;
    const status = record.status === "completed" || record.status === "failed" ? record.status : "running";
    return {
      attempt,
      status,
      startedAt,
      finishedAt: validDate(record.finishedAt),
      correlationId: cleanOptional(record.correlationId),
      error: cleanOptional(record.error),
    };
  }).filter((item): item is WorkflowStepAttempt => Boolean(item));
  return attempts.length ? attempts.slice(-20) : undefined;
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
  const cron = cleanOptional(record.cron);
  const timezone = cleanOptional(record.timezone);
  const runAt = validDate(record.runAt);
  const nextRunAt = validDate(record.nextRunAt) ?? runAt ?? (Boolean(record.enabled) && intervalMinutes ? new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString() : undefined);
  const schedule = {
    enabled: Boolean(record.enabled),
    runAt,
    intervalMinutes,
    cron,
    timezone,
    nextRunAt,
    lastRunAt: validDate(record.lastRunAt),
  };
  return schedule.enabled || runAt || intervalMinutes || cron ? schedule : undefined;
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

function normalizePositiveNumber(value: unknown): number | undefined {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function randomId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}
