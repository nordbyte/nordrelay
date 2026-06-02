import type { AgentId } from "../agents/shared/agent.js";
import type { AuditEvent } from "../access/audit-log.js";
import { createCorrelationId, toPromptEnvelope } from "../state/prompt-store.js";
import { QUEUE_PLAN_STATUSES, type QueuePlan, type QueuePlanStatus } from "../state/queue-plan-store.js";
import type { WebActivityActor, WebActivityEvent } from "../web/web-state.js";
import type { QueuePlanDto, QueuePlannerSnapshotDto, WebTaskDto } from "./relay-runtime-types.js";
import type { RelayRuntimeDelegate } from "./relay-runtime-delegate.js";
import { isQueuedPromptWaiting } from "./relay-queue-service.js";

export interface QueuePlanInput {
  title?: string;
  prompt: string;
  status?: QueuePlanStatus;
  labels?: string[];
  priority?: number;
  agentId?: AgentId;
  workspace?: string;
  threadId?: string;
}

export function relayRuntimeQueuePlannerSnapshot(runtime: RelayRuntimeDelegate): QueuePlannerSnapshotDto {
  const queue = runtime.queueService.rawList().filter(isQueuedPromptWaiting);
  const queuePositions = new Map(queue.map((item, index) => [item.id, index + 1]));
  const inProgress = [runtime.currentProgress, runtime.externalActivityMonitor.task()]
    .filter((task): task is WebTaskDto => Boolean(task));
  const plans = runtime.queuePlanStore.list().map((plan) => queuePlanDto(runtime, plan, queuePositions, inProgress));
  const columns = Object.fromEntries(QUEUE_PLAN_STATUSES.map((status) => [status, [] as QueuePlanDto[]])) as Record<QueuePlanStatus, QueuePlanDto[]>;
  for (const plan of plans) {
    columns[plan.effectiveStatus].push(plan);
  }
  return {
    plans,
    columns,
    queue: runtime.queue(),
    paused: runtime.queuePaused(),
    inProgress,
    updatedAt: new Date().toISOString(),
  };
}

export async function relayRuntimeCreateQueuePlan(runtime: RelayRuntimeDelegate, input: QueuePlanInput, actor?: WebActivityActor): Promise<QueuePlanDto> {
  const session = await runtime.getSession(true);
  const info = runtime.publicInfo(session);
  const plan = runtime.queuePlanStore.save({
    ...input,
    status: input.status ?? "draft",
    ownerUserId: actor?.id,
    agentId: input.agentId ?? info.agentId,
    workspace: input.workspace ?? info.workspace,
    threadId: input.threadId ?? info.threadId ?? undefined,
  });
  recordQueuePlan(runtime, "queue_plan_created", plan, actor);
  return relayRuntimeQueuePlannerSnapshot(runtime).plans.find((candidate) => candidate.id === plan.id) ?? queuePlanDto(runtime, plan, new Map(), []);
}

export function relayRuntimeUpdateQueuePlan(runtime: RelayRuntimeDelegate, id: string, input: Partial<QueuePlanInput>, actor?: WebActivityActor): QueuePlanDto {
  const existing = requireQueuePlan(runtime, id);
  if (isRuntimeOwnedStatus(existing.status)) {
    throw new Error("Queued and running plans can only be changed through queue actions.");
  }
  const plan = runtime.queuePlanStore.patch(id, input);
  if (!plan) throw new Error("Queue plan not found.");
  recordQueuePlan(runtime, "queue_plan_updated", plan, actor);
  return relayRuntimeQueuePlannerSnapshot(runtime).plans.find((candidate) => candidate.id === id) ?? queuePlanDto(runtime, plan, new Map(), []);
}

export function relayRuntimeDeleteQueuePlan(runtime: RelayRuntimeDelegate, id: string, actor?: WebActivityActor): { removed: boolean; snapshot: QueuePlannerSnapshotDto } {
  const existing = runtime.queuePlanStore.get(id);
  if (existing?.queueId && runtime.queueService.rawList().some((item) => item.id === existing.queueId)) {
    throw new Error("Cancel the queued prompt before deleting the plan.");
  }
  const removed = runtime.queuePlanStore.delete(id);
  if (existing) recordQueuePlan(runtime, "queue_plan_deleted", existing, actor);
  return { removed, snapshot: relayRuntimeQueuePlannerSnapshot(runtime) };
}

export async function relayRuntimeMoveQueuePlan(runtime: RelayRuntimeDelegate, id: string, status: QueuePlanStatus, actor?: WebActivityActor): Promise<QueuePlanDto> {
  const existing = requireQueuePlan(runtime, id);
  if (status === "queued") {
    return relayRuntimeEnqueueQueuePlan(runtime, id, actor);
  }
  if (isDerivedRuntimeStatus(status)) {
    throw new Error("Runtime statuses are updated automatically from queue activity.");
  }
  if (isRuntimeOwnedStatus(existing.status) && status !== "archived") {
    throw new Error("Queued and running plans are controlled by the runtime queue.");
  }
  const plan = runtime.queuePlanStore.patch(id, { status, error: undefined });
  if (!plan) throw new Error("Queue plan not found.");
  recordQueuePlan(runtime, "queue_plan_moved", plan, actor, status);
  return relayRuntimeQueuePlannerSnapshot(runtime).plans.find((candidate) => candidate.id === id) ?? queuePlanDto(runtime, plan, new Map(), []);
}

export function relayRuntimeApproveQueuePlan(runtime: RelayRuntimeDelegate, id: string, actor?: WebActivityActor): QueuePlanDto {
  const existing = requireQueuePlan(runtime, id);
  if (isRuntimeOwnedStatus(existing.status)) {
    throw new Error("Queued and running plans are already past approval.");
  }
  const plan = runtime.queuePlanStore.patch(id, {
    status: "approved",
    approvedBy: actor?.id,
    error: undefined,
  });
  if (!plan) throw new Error("Queue plan not found.");
  recordQueuePlan(runtime, "queue_plan_approved", plan, actor);
  return relayRuntimeQueuePlannerSnapshot(runtime).plans.find((candidate) => candidate.id === id) ?? queuePlanDto(runtime, plan, new Map(), []);
}

export async function relayRuntimeEnqueueQueuePlan(runtime: RelayRuntimeDelegate, id: string, actor?: WebActivityActor): Promise<QueuePlanDto> {
  const existing = requireQueuePlan(runtime, id);
  if (existing.status !== "approved" && existing.status !== "queued") {
    throw new Error("Queue plan must be approved before it can be queued.");
  }
  if (existing.queueId && runtime.queueService.rawList().some((item) => item.id === existing.queueId)) {
    return relayRuntimeQueuePlannerSnapshot(runtime).plans.find((candidate) => candidate.id === id) ?? queuePlanDto(runtime, existing, new Map(), []);
  }

  await alignCurrentSessionToPlan(runtime, existing, actor);
  const session = await runtime.getSession(false);
  const info = runtime.publicInfo(session);
  const correlationId = existing.correlationId || createCorrelationId();
  const queued = runtime.queueService.enqueue({
    ...toPromptEnvelope(existing.prompt),
    correlationId,
    activityActor: actor,
  });
  const plan = runtime.queuePlanStore.patch(id, {
    status: "queued",
    queueId: queued.id,
    correlationId,
    queuedAt: new Date().toISOString(),
    agentId: existing.agentId ?? info.agentId,
    workspace: existing.workspace ?? info.workspace,
    threadId: existing.threadId ?? info.threadId ?? undefined,
    error: undefined,
  });
  if (!plan) throw new Error("Queue plan not found.");
  runtime.appendActivity({
    source: "web",
    status: "queued",
    type: "queue_plan_queued",
    threadId: info.threadId,
    workspace: info.workspace,
    agentId: info.agentId,
    actor,
    correlationId,
    prompt: plan.prompt,
    detail: `${plan.title} -> queued prompt ${queued.id}`,
  });
  runtime.appendAudit({
    action: "queue_updated",
    status: "ok",
    contextKey: runtime.contextKey,
    agentId: info.agentId,
    threadId: info.threadId,
    workspace: info.workspace,
    actor,
    correlationId,
    promptId: queued.id,
    description: `queue plan enqueued: ${plan.title}`,
  });
  runtime.broadcastQueue();
  void runtime.drainQueue().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    runtime.broadcastStatus(message, "error");
  });
  return relayRuntimeQueuePlannerSnapshot(runtime).plans.find((candidate) => candidate.id === id) ?? queuePlanDto(runtime, plan, new Map(), []);
}

async function alignCurrentSessionToPlan(runtime: RelayRuntimeDelegate, plan: QueuePlan, actor?: WebActivityActor): Promise<void> {
  let session = await runtime.getSession(false);
  let info = runtime.publicInfo(session);
  if (plan.agentId && info.agentId !== plan.agentId) {
    await runtime.setAgent(plan.agentId, actor);
    session = await runtime.getSession(false);
    info = runtime.publicInfo(session);
  }
  if (plan.threadId && info.threadId !== plan.threadId) {
    await runtime.attachSession(plan.threadId, actor);
    return;
  }
  if (!plan.threadId && plan.workspace && info.workspace !== plan.workspace) {
    await runtime.newSession({ agentId: plan.agentId ?? info.agentId, workspace: plan.workspace }, actor);
  }
}

function queuePlanDto(
  runtime: RelayRuntimeDelegate,
  plan: QueuePlan,
  queuePositions: Map<string, number>,
  inProgress: WebTaskDto[],
): QueuePlanDto {
  const trace = plan.correlationId ? runtime.activityStore.findByCorrelationId(plan.correlationId, 50) : [];
  const status = effectiveStatus(plan, queuePositions, inProgress, trace);
  persistDerivedStatus(runtime, plan, status, trace, inProgress);
  return {
    ...plan,
    status,
    effectiveStatus: status,
    queuePosition: plan.queueId ? queuePositions.get(plan.queueId) : undefined,
    traceEvents: trace.length,
  };
}

function effectiveStatus(
  plan: QueuePlan,
  queuePositions: Map<string, number>,
  inProgress: WebTaskDto[],
  trace: WebActivityEvent[],
): QueuePlanStatus {
  if (plan.status === "archived") return "archived";
  if (plan.queueId && queuePositions.has(plan.queueId)) return "queued";
  if (plan.correlationId && inProgress.some((task) => task.correlationId === plan.correlationId)) return "in_progress";
  const latest = trace.at(-1);
  if (latest?.type === "prompt_completed") return "done";
  if (latest?.type === "prompt_failed") return "failed";
  if (latest?.status === "aborted") return "aborted";
  if (latest?.type === "prompt_started" || latest?.type.startsWith("tool_") || latest?.status === "running") return "in_progress";
  if (plan.status === "queued" && plan.queueId && !queuePositions.has(plan.queueId)) return "aborted";
  return plan.status;
}

function persistDerivedStatus(
  runtime: RelayRuntimeDelegate,
  plan: QueuePlan,
  status: QueuePlanStatus,
  trace: WebActivityEvent[],
  inProgress: WebTaskDto[],
): void {
  if (status === plan.status && (status !== "in_progress" || plan.startedAt)) return;
  const latest = trace.at(-1);
  const running = plan.correlationId ? inProgress.find((task) => task.correlationId === plan.correlationId) : undefined;
  const patch: Partial<QueuePlan> = { status };
  if (status === "in_progress") patch.startedAt = plan.startedAt ?? running?.startedAt ?? latest?.timestamp ?? new Date().toISOString();
  if (status === "done" || status === "failed" || status === "aborted") {
    patch.finishedAt = plan.finishedAt ?? latest?.timestamp ?? new Date().toISOString();
    patch.error = status === "failed" ? latest?.detail ?? plan.error : undefined;
  }
  runtime.queuePlanStore.patch(plan.id, patch);
}

function requireQueuePlan(runtime: RelayRuntimeDelegate, id: string): QueuePlan {
  const plan = runtime.queuePlanStore.get(id);
  if (!plan) throw new Error("Queue plan not found.");
  return plan;
}

function isRuntimeOwnedStatus(status: QueuePlanStatus): boolean {
  return status === "queued" || status === "in_progress";
}

function isDerivedRuntimeStatus(status: QueuePlanStatus): boolean {
  return status === "in_progress" || status === "done" || status === "failed" || status === "aborted";
}

function recordQueuePlan(
  runtime: RelayRuntimeDelegate,
  type: string,
  plan: QueuePlan,
  actor?: WebActivityActor,
  detail?: string,
): void {
  runtime.appendActivity({
    source: "web",
    status: "info",
    type,
    threadId: plan.threadId ?? null,
    workspace: plan.workspace,
    agentId: plan.agentId,
    actor,
    correlationId: plan.correlationId,
    prompt: plan.prompt,
    detail: detail ?? plan.title,
  });
  runtime.appendAudit({
    action: "queue_updated" as AuditEvent["action"],
    status: "ok",
    contextKey: runtime.contextKey,
    agentId: plan.agentId,
    threadId: plan.threadId ?? null,
    workspace: plan.workspace,
    actor,
    correlationId: plan.correlationId,
    promptId: plan.queueId ?? plan.id,
    description: `${type}: ${plan.title}`,
  });
}
