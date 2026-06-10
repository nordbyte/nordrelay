import { randomUUID } from "node:crypto";

import type { AgentId } from "../agents/shared/agent.js";
import { createDocumentStore, type DocumentStore, type StateBackendKind } from "./state-backend.js";

export type ProjectTarget = "local" | `peer:${string}`;
export type ProjectStatus = "active" | "archived";
export type ProjectJobKind = "summary" | "plan" | "refresh";
export type ProjectJobStatus = "queued" | "running" | "completed" | "failed" | "aborted";
export type ProjectPlanItemStatus = "proposed" | "accepted" | "queued" | "in_progress" | "done" | "rejected";
export type ProjectPlanExistenceCheck = "not_found" | "partial" | "existing" | "uncertain";
export type ProjectPlanMode = "balanced" | "features" | "bugfixes" | "refactor" | "performance" | "security" | "ux" | "tests" | "release";
export type ProjectPlanHorizon = "next-sprint" | "next-release" | "long-term";
export type ProjectPlanRiskLevel = "conservative" | "balanced" | "ambitious";

export interface ProjectSessionLink {
  id: string;
  agentId?: AgentId;
  threadId: string;
  peerId?: string;
  label?: string;
  workspace?: string;
  linkedAt: string;
}

export interface ProjectPlanItem {
  id: string;
  title: string;
  description: string;
  priority: number;
  category?: string;
  mode?: ProjectPlanMode;
  targetArea?: string;
  impact?: string;
  effort?: string;
  risk?: string;
  userValue?: string;
  blockedBy: string[];
  confidence?: number;
  status: ProjectPlanItemStatus;
  evidence: string[];
  alreadyExistsCheck: ProjectPlanExistenceCheck;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  description?: string;
  workspacePath: string;
  target: ProjectTarget;
  defaultAgentId?: AgentId;
  linkedSessions: ProjectSessionLink[];
  summaryMarkdown?: string;
  summaryUpdatedAt?: string;
  planMarkdown?: string;
  planUpdatedAt?: string;
  planItems: ProjectPlanItem[];
  status: ProjectStatus;
  ownerUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectAnalysisJob {
  id: string;
  projectId: string;
  kind: ProjectJobKind;
  status: ProjectJobStatus;
  agentId?: AgentId;
  planMode?: ProjectPlanMode;
  planningHorizon?: ProjectPlanHorizon;
  riskLevel?: ProjectPlanRiskLevel;
  threadId?: string;
  correlationId?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
  log: string[];
  outputMarkdown?: string;
  error?: string;
}

interface PersistedProjectStore {
  version: 1;
  projects: ProjectRecord[];
  jobs: ProjectAnalysisJob[];
}

export class ProjectStore {
  private readonly store: DocumentStore<PersistedProjectStore>;

  constructor(workspace: string, backend: StateBackendKind = "json") {
    this.store = createDocumentStore<PersistedProjectStore>({
      workspace,
      backend,
      fileName: "projects.json",
      sqliteKey: "projects",
    });
  }

  list(): ProjectRecord[] {
    return [...this.payload().projects].sort(sortProjects);
  }

  get(id: string): ProjectRecord | null {
    return this.payload().projects.find((project) => project.id === id) ?? null;
  }

  save(input: Partial<ProjectRecord> & Pick<ProjectRecord, "name" | "workspacePath">): ProjectRecord {
    const now = new Date().toISOString();
    const id = normalizeId(input.id) || createProjectId();
    let project: ProjectRecord;
    this.store.update((current) => {
      const payload = this.normalizePayload(current);
      const existing = payload.projects.find((candidate) => candidate.id === id);
      project = normalizeProject({
        ...existing,
        ...input,
        id,
        createdAt: existing?.createdAt ?? input.createdAt ?? now,
        updatedAt: now,
      });
      payload.projects = upsertById(payload.projects, project);
      return payload;
    });
    return project!;
  }

  patch(id: string, patch: Partial<ProjectRecord>): ProjectRecord | null {
    let updated: ProjectRecord | null = null;
    this.store.update((current) => {
      const payload = this.normalizePayload(current);
      const existing = payload.projects.find((project) => project.id === id);
      if (!existing) return payload;
      updated = normalizeProject({
        ...existing,
        ...patch,
        id,
        updatedAt: patch.updatedAt ?? new Date().toISOString(),
      });
      payload.projects = upsertById(payload.projects, updated);
      return payload;
    });
    return updated;
  }

  delete(id: string): boolean {
    let removed = false;
    this.store.update((current) => {
      const payload = this.normalizePayload(current);
      const projects = payload.projects.filter((project) => project.id !== id);
      removed = projects.length !== payload.projects.length;
      payload.projects = projects;
      if (removed) payload.jobs = payload.jobs.filter((job) => job.projectId !== id);
      return payload;
    });
    return removed;
  }

  linkSession(id: string, link: Partial<ProjectSessionLink> & Pick<ProjectSessionLink, "threadId">): ProjectRecord | null {
    const project = this.get(id);
    if (!project) return null;
    const normalized = normalizeSessionLink(link);
    return this.patch(id, {
      linkedSessions: upsertById(project.linkedSessions, normalized),
    });
  }

  unlinkSession(id: string, linkId: string): ProjectRecord | null {
    const project = this.get(id);
    if (!project) return null;
    return this.patch(id, {
      linkedSessions: project.linkedSessions.filter((link) => link.id !== linkId),
    });
  }

  listJobs(projectId?: string, limit = 100): ProjectAnalysisJob[] {
    return [...this.payload().jobs]
      .filter((job) => !projectId || job.projectId === projectId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, Math.max(1, Math.min(500, limit)));
  }

  getJob(id: string): ProjectAnalysisJob | null {
    return this.payload().jobs.find((job) => job.id === id) ?? null;
  }

  saveJob(input: Partial<ProjectAnalysisJob> & Pick<ProjectAnalysisJob, "projectId" | "kind">): ProjectAnalysisJob {
    const now = new Date().toISOString();
    const id = normalizeId(input.id) || createProjectJobId();
    let job: ProjectAnalysisJob;
    this.store.update((current) => {
      const payload = this.normalizePayload(current);
      const existing = payload.jobs.find((candidate) => candidate.id === id);
      job = normalizeJob({
        ...existing,
        ...input,
        id,
        createdAt: existing?.createdAt ?? input.createdAt ?? now,
        updatedAt: now,
      });
      payload.jobs = upsertById(payload.jobs, job).slice(-500);
      return payload;
    });
    return job!;
  }

  patchJob(id: string, patch: Partial<ProjectAnalysisJob>): ProjectAnalysisJob | null {
    let updated: ProjectAnalysisJob | null = null;
    this.store.update((current) => {
      const payload = this.normalizePayload(current);
      const existing = payload.jobs.find((job) => job.id === id);
      if (!existing) return payload;
      updated = normalizeJob({
        ...existing,
        ...patch,
        id,
        updatedAt: patch.updatedAt ?? new Date().toISOString(),
      });
      payload.jobs = upsertById(payload.jobs, updated);
      return payload;
    });
    return updated;
  }

  private payload(): PersistedProjectStore {
    return this.normalizePayload(this.store.read());
  }

  private normalizePayload(payload: PersistedProjectStore | undefined): PersistedProjectStore {
    if (!payload || payload.version !== 1) {
      return { version: 1, projects: [], jobs: [] };
    }
    return {
      version: 1,
      projects: Array.isArray(payload.projects) ? payload.projects.map(normalizeProject).filter((project) => project.name && project.workspacePath) : [],
      jobs: Array.isArray(payload.jobs) ? payload.jobs.map(normalizeJob).filter((job) => job.projectId) : [],
    };
  }
}

function normalizeProject(input: Partial<ProjectRecord> & Pick<ProjectRecord, "id" | "name" | "workspacePath">): ProjectRecord {
  const now = new Date().toISOString();
  return {
    id: normalizeId(input.id) || createProjectId(),
    name: cleanRequired(input.name, "Untitled project").slice(0, 120),
    description: cleanOptional(input.description),
    workspacePath: cleanRequired(input.workspacePath, ""),
    target: normalizeTarget(input.target),
    defaultAgentId: cleanOptional(input.defaultAgentId) as AgentId | undefined,
    linkedSessions: Array.isArray(input.linkedSessions) ? input.linkedSessions.map(normalizeSessionLink).filter((link) => link.threadId) : [],
    summaryMarkdown: cleanOptional(input.summaryMarkdown),
    summaryUpdatedAt: validDate(input.summaryUpdatedAt),
    planMarkdown: cleanOptional(input.planMarkdown),
    planUpdatedAt: validDate(input.planUpdatedAt),
    planItems: Array.isArray(input.planItems) ? input.planItems.map(normalizePlanItem).filter((item) => item.title) : [],
    status: input.status === "archived" ? "archived" : "active",
    ownerUserId: cleanOptional(input.ownerUserId),
    createdAt: validDate(input.createdAt) ?? now,
    updatedAt: validDate(input.updatedAt) ?? now,
  };
}

function normalizeSessionLink(input: Partial<ProjectSessionLink> & Pick<ProjectSessionLink, "threadId">): ProjectSessionLink {
  const threadId = String(input.threadId ?? "").trim();
  const peerId = cleanOptional(input.peerId);
  const agentId = cleanOptional(input.agentId) as AgentId | undefined;
  const id = normalizeId(input.id) || sessionLinkId(peerId, agentId, threadId);
  return {
    id,
    agentId,
    threadId,
    peerId,
    label: cleanOptional(input.label),
    workspace: cleanOptional(input.workspace),
    linkedAt: validDate(input.linkedAt) ?? new Date().toISOString(),
  };
}

function normalizePlanItem(input: Partial<ProjectPlanItem>): ProjectPlanItem {
  const now = new Date().toISOString();
  return {
    id: normalizeId(input.id) || createProjectPlanItemId(),
    title: cleanRequired(input.title, "Untitled plan item").slice(0, 180),
    description: cleanOptional(input.description) ?? "",
    priority: normalizePriority(input.priority),
    category: cleanOptional(input.category),
    mode: normalizePlanMode(input.mode),
    targetArea: cleanOptional(input.targetArea),
    impact: cleanOptional(input.impact),
    effort: cleanOptional(input.effort),
    risk: cleanOptional(input.risk),
    userValue: cleanOptional(input.userValue),
    blockedBy: normalizeStringList(input.blockedBy),
    confidence: normalizeConfidence(input.confidence),
    status: normalizePlanItemStatus(input.status),
    evidence: normalizeStringList(input.evidence),
    alreadyExistsCheck: normalizeExistenceCheck(input.alreadyExistsCheck),
    createdAt: validDate(input.createdAt) ?? now,
    updatedAt: validDate(input.updatedAt) ?? now,
  };
}

function normalizeJob(input: Partial<ProjectAnalysisJob> & Pick<ProjectAnalysisJob, "id" | "projectId" | "kind">): ProjectAnalysisJob {
  const now = new Date().toISOString();
  return {
    id: normalizeId(input.id) || createProjectJobId(),
    projectId: normalizeId(input.projectId),
    kind: normalizeJobKind(input.kind),
    status: normalizeJobStatus(input.status),
    agentId: cleanOptional(input.agentId) as AgentId | undefined,
    planMode: normalizePlanMode(input.planMode),
    planningHorizon: normalizePlanHorizon(input.planningHorizon),
    riskLevel: normalizePlanRiskLevel(input.riskLevel),
    threadId: cleanOptional(input.threadId),
    correlationId: cleanOptional(input.correlationId),
    startedAt: validDate(input.startedAt),
    finishedAt: validDate(input.finishedAt),
    createdAt: validDate(input.createdAt) ?? now,
    updatedAt: validDate(input.updatedAt) ?? now,
    log: normalizeStringList(input.log).slice(-200),
    outputMarkdown: cleanOptional(input.outputMarkdown),
    error: cleanOptional(input.error),
  };
}

function normalizeTarget(target: unknown): ProjectTarget {
  const value = String(target ?? "local").trim();
  if (value === "local") return "local";
  if (value.startsWith("peer:") && value.length > 5) return value as ProjectTarget;
  return "local";
}

function normalizeJobKind(kind: unknown): ProjectJobKind {
  return kind === "plan" || kind === "refresh" ? kind : "summary";
}

function normalizeJobStatus(status: unknown): ProjectJobStatus {
  return status === "running" || status === "completed" || status === "failed" || status === "aborted" ? status : "queued";
}

function normalizePlanItemStatus(status: unknown): ProjectPlanItemStatus {
  return status === "accepted" || status === "queued" || status === "in_progress" || status === "done" || status === "rejected" ? status : "proposed";
}

export function normalizeProjectPlanMode(value: unknown): ProjectPlanMode {
  return normalizePlanMode(value) ?? "balanced";
}

export function normalizeProjectPlanHorizon(value: unknown): ProjectPlanHorizon {
  return normalizePlanHorizon(value) ?? "next-release";
}

export function normalizeProjectPlanRiskLevel(value: unknown): ProjectPlanRiskLevel {
  return normalizePlanRiskLevel(value) ?? "balanced";
}

function normalizePlanMode(value: unknown): ProjectPlanMode | undefined {
  return value === "features"
    || value === "bugfixes"
    || value === "refactor"
    || value === "performance"
    || value === "security"
    || value === "ux"
    || value === "tests"
    || value === "release"
    || value === "balanced"
    ? value
    : undefined;
}

function normalizePlanHorizon(value: unknown): ProjectPlanHorizon | undefined {
  return value === "next-sprint" || value === "long-term" || value === "next-release" ? value : undefined;
}

function normalizePlanRiskLevel(value: unknown): ProjectPlanRiskLevel | undefined {
  return value === "conservative" || value === "ambitious" || value === "balanced" ? value : undefined;
}

function normalizeExistenceCheck(value: unknown): ProjectPlanExistenceCheck {
  return value === "partial" || value === "existing" || value === "uncertain" ? value : "not_found";
}

function normalizePriority(priority: unknown): number {
  const value = Number(priority);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 50;
}

function normalizeConfidence(confidence: unknown): number | undefined {
  if (confidence === undefined || confidence === null || confidence === "") return undefined;
  const value = Number(confidence);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : undefined;
}

function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function normalizeId(id: unknown): string {
  return String(id ?? "").trim().replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 96);
}

function cleanRequired(value: unknown, fallback: string): string {
  return String(value ?? "").trim() || fallback;
}

function cleanOptional(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function validDate(value: unknown): string | undefined {
  const text = cleanOptional(value);
  if (!text) return undefined;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function createProjectId(): string {
  return `proj_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function createProjectJobId(): string {
  return `project-job-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function createProjectPlanItemId(): string {
  return `project-plan-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function sessionLinkId(peerId: string | undefined, agentId: string | undefined, threadId: string): string {
  return [peerId || "local", agentId || "agent", threadId].join(":").replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 96);
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function sortProjects(left: ProjectRecord, right: ProjectRecord): number {
  return Number(left.status === "archived") - Number(right.status === "archived")
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}
