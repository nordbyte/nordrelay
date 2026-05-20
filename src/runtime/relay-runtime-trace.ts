import type { AuditEvent } from "../access/audit-log.js";
import type { WebActivityEvent, WebChatMessage } from "../web/web-state.js";
import type { RelayRuntimeDelegate } from "./relay-runtime-delegate.js";
import type { QueueItemDto, TraceDetailDto, TraceTimelineItemDto, UnifiedJobDto } from "./relay-runtime-types.js";

export async function relayRuntimeTrace(runtime: RelayRuntimeDelegate, correlationId: string): Promise<TraceDetailDto> {
  const id = correlationId.trim();
  if (!id) {
    throw new Error("correlationId is required.");
  }
  const activity = runtime.activityStore.findByCorrelationId(id, 200).map((event) => runtime.enrichActivityEvent(event));
  const audit = runtime.auditStore.findByCorrelationId(id, 200);
  const chat = runtime.chatStore.findByCorrelationId(id, 200);
  const queue = runtime.queue().filter((item) => item.correlationId === id);
  const jobs = (await runtime.jobs({ limit: 500 })).jobs.filter((job) => job.correlationId === id);
  const timeline = traceTimeline({ activity, audit, chat, queue, jobs });
  const timestamps = timeline.map((item) => Date.parse(item.at)).filter(Number.isFinite);
  const lastStatus = [...activity].reverse().find((event) => event.status)?.status ??
    jobs.find((job) => job.status)?.status ??
    (queue.length ? "queued" : "unknown");
  return {
    correlationId: id,
    summary: {
      startedAt: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
      updatedAt: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
      status: lastStatus,
      sources: [...new Set(timeline.map((item) => item.source))],
      threadId: activity.find((event) => event.threadId)?.threadId ?? chat.find((message) => message.threadId)?.threadId ?? jobs.find((job) => job.threadId)?.threadId,
      workspace: activity.find((event) => event.workspace)?.workspace ?? jobs.find((job) => job.workspace)?.workspace,
      agentId: activity.find((event) => event.agentId)?.agentId ?? jobs.find((job) => job.agentId)?.agentId,
    },
    activity,
    audit,
    chat,
    queue,
    jobs,
    timeline,
  };
}

function traceTimeline(input: {
  activity: WebActivityEvent[];
  audit: AuditEvent[];
  chat: WebChatMessage[];
  queue: QueueItemDto[];
  jobs: UnifiedJobDto[];
}): TraceTimelineItemDto[] {
  return [
    ...input.activity.map((event): TraceTimelineItemDto => ({
      id: event.id,
      at: event.timestamp,
      source: "activity",
      status: event.status,
      type: event.type,
      title: `${event.source} ${event.type}`,
      detail: event.prompt || event.detail,
      threadId: event.threadId,
      workspace: event.workspace,
      agentId: event.agentId,
    })),
    ...input.audit.map((event): TraceTimelineItemDto => ({
      id: event.id,
      at: event.timestamp,
      source: "audit",
      status: event.status,
      type: event.action,
      title: `${event.channelId} ${event.action}`,
      detail: event.description || event.detail,
      threadId: event.threadId,
      workspace: event.workspace,
      agentId: event.agentId,
    })),
    ...input.chat.map((message): TraceTimelineItemDto => ({
      id: message.id,
      at: message.timestamp,
      source: "chat",
      type: message.role,
      title: `${message.source} ${message.role}`,
      detail: message.text,
      threadId: message.threadId,
    })),
    ...input.queue.map((item): TraceTimelineItemDto => ({
      id: item.id,
      at: item.createdAt,
      source: "queue",
      status: item.lastError ? "failed" : "queued",
      type: "queued_prompt",
      title: `Queued prompt ${item.id}`,
      detail: item.lastError || item.description,
    })),
    ...input.jobs.map((job): TraceTimelineItemDto => ({
      id: job.id,
      at: job.updatedAt,
      source: "job",
      status: job.status,
      type: job.kind,
      title: job.title,
      detail: job.summary || job.logTail,
      threadId: job.threadId,
      workspace: job.workspace,
      agentId: job.agentId,
    })),
  ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}
