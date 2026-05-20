import { randomUUID } from "node:crypto";

import type { AgentId } from "../agents/shared/agent.js";
import { createDocumentStore, type DocumentStore, type StateBackendKind } from "./state-backend.js";

export type QueuePlanStatus =
  | "draft"
  | "review"
  | "approved"
  | "queued"
  | "in_progress"
  | "done"
  | "failed"
  | "aborted"
  | "archived";

export const QUEUE_PLAN_STATUSES: QueuePlanStatus[] = [
  "draft",
  "review",
  "approved",
  "queued",
  "in_progress",
  "done",
  "failed",
  "aborted",
  "archived",
];

export interface QueuePlan {
  id: string;
  title: string;
  prompt: string;
  status: QueuePlanStatus;
  labels: string[];
  priority: number;
  agentId?: AgentId;
  workspace?: string;
  threadId?: string;
  queueId?: string;
  correlationId?: string;
  ownerUserId?: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

interface PersistedQueuePlanStore {
  version: 1;
  plans: QueuePlan[];
}

export class QueuePlanStore {
  private readonly store: DocumentStore<PersistedQueuePlanStore>;

  constructor(workspace: string, backend: StateBackendKind = "json") {
    this.store = createDocumentStore<PersistedQueuePlanStore>({
      workspace,
      backend,
      fileName: "queue-plans.json",
      sqliteKey: "queue-plans",
    });
  }

  list(): QueuePlan[] {
    return this.payload().plans.sort(sortPlans);
  }

  get(id: string): QueuePlan | null {
    return this.payload().plans.find((plan) => plan.id === id) ?? null;
  }

  save(input: Partial<QueuePlan> & Pick<QueuePlan, "prompt">): QueuePlan {
    const payload = this.payload();
    const now = new Date().toISOString();
    const id = normalizeId(input.id) || createQueuePlanId();
    const existing = payload.plans.find((plan) => plan.id === id);
    const plan = normalizePlan({
      ...existing,
      ...input,
      id,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    });
    payload.plans = upsertById(payload.plans, plan);
    this.store.write(payload);
    return plan;
  }

  patch(id: string, patch: Partial<QueuePlan>): QueuePlan | null {
    const existing = this.get(id);
    if (!existing) return null;
    return this.save({ ...existing, ...patch, id, updatedAt: patch.updatedAt ?? new Date().toISOString() });
  }

  delete(id: string): boolean {
    const payload = this.payload();
    const next = payload.plans.filter((plan) => plan.id !== id);
    if (next.length === payload.plans.length) return false;
    payload.plans = next;
    this.store.write(payload);
    return true;
  }

  private payload(): PersistedQueuePlanStore {
    const payload = this.store.read();
    if (!payload || payload.version !== 1) {
      return { version: 1, plans: [] };
    }
    return {
      version: 1,
      plans: Array.isArray(payload.plans) ? payload.plans.map(normalizePlan).filter((plan) => plan.prompt) : [],
    };
  }
}

function normalizePlan(input: Partial<QueuePlan> & Pick<QueuePlan, "id" | "prompt">): QueuePlan {
  const now = new Date().toISOString();
  const prompt = String(input.prompt ?? "").trim();
  return {
    id: normalizeId(input.id) || createQueuePlanId(),
    title: cleanOptional(input.title) || promptTitle(prompt),
    prompt,
    status: normalizeStatus(input.status),
    labels: normalizeLabels(input.labels),
    priority: normalizePriority(input.priority),
    agentId: input.agentId,
    workspace: cleanOptional(input.workspace),
    threadId: cleanOptional(input.threadId),
    queueId: cleanOptional(input.queueId),
    correlationId: cleanOptional(input.correlationId),
    ownerUserId: cleanOptional(input.ownerUserId),
    approvedBy: cleanOptional(input.approvedBy),
    createdAt: validDate(input.createdAt) ?? now,
    updatedAt: validDate(input.updatedAt) ?? now,
    queuedAt: validDate(input.queuedAt),
    startedAt: validDate(input.startedAt),
    finishedAt: validDate(input.finishedAt),
    error: cleanOptional(input.error),
  };
}

function promptTitle(prompt: string): string {
  const firstLine = prompt.replace(/\s+/g, " ").trim();
  return firstLine.length <= 80 ? firstLine || "Untitled prompt" : `${firstLine.slice(0, 79)}…`;
}

function normalizeStatus(status: unknown): QueuePlanStatus {
  return QUEUE_PLAN_STATUSES.includes(status as QueuePlanStatus) ? status as QueuePlanStatus : "draft";
}

function normalizeLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return [...new Set(labels.map((label) => String(label).trim()).filter(Boolean))];
}

function normalizePriority(priority: unknown): number {
  const value = Number(priority);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

function normalizeId(id: unknown): string {
  return String(id ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function createQueuePlanId(): string {
  return `qp_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
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

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function sortPlans(left: QueuePlan, right: QueuePlan): number {
  return right.priority - left.priority || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}
