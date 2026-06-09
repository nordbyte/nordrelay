import type { AgentSessionInfo } from "../agents/shared/agent.js";
import type { RelayRuntimeDelegate } from "./relay-runtime-delegate.js";
import type { RelayEvent } from "./relay-runtime-types.js";

const MAX_RELAY_EVENT_HISTORY = 500;

export function relayRuntimePrepareEvent(runtime: RelayRuntimeDelegate, event: RelayEvent): RelayEvent {
  if (event.seq && event.eventId) return event;
  const seq = runtime.eventSeq + 1;
  runtime.eventSeq = seq;
  const prepared = { ...event, seq, eventId: String(seq), emittedAt: new Date().toISOString() } as RelayEvent;
  runtime.eventHistory.push(prepared);
  if (runtime.eventHistory.length > MAX_RELAY_EVENT_HISTORY) {
    runtime.eventHistory.splice(0, runtime.eventHistory.length - MAX_RELAY_EVENT_HISTORY);
  }
  return prepared;
}

export function relayRuntimeReplayEvents(runtime: RelayRuntimeDelegate, afterEventId?: string | number | null): RelayEvent[] {
  const after = Number.parseInt(String(afterEventId ?? ""), 10);
  if (!Number.isFinite(after) || after < 1) return [];
  return runtime.eventHistory.filter((event) => Number(event.seq ?? 0) > after);
}

export function relayRuntimeBroadcastQueueStatus(
  runtime: RelayRuntimeDelegate,
  status: "updated" | "started" | "completed" | "paused" | "resumed",
  options: { queueId?: string; info?: AgentSessionInfo } = {},
): void {
  const info = options.info;
  runtime.broadcast({
    type: "queue_status_changed",
    status,
    queue: runtime.queue(),
    paused: runtime.queuePaused(),
    queueId: options.queueId,
    at: new Date().toISOString(),
    contextKey: info ? runtime.contextKey : undefined,
    agentId: info?.agentId,
    threadId: info?.threadId,
    workspace: info?.workspace,
  });
}
