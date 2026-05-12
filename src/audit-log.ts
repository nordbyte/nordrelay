import { randomUUID } from "node:crypto";

import type { AgentId } from "./agent.js";
import type { TelegramContextKey } from "./context-key.js";
import { createDocumentStore, type DocumentStore, type StateBackendKind } from "./state-backend.js";

export type AuditAction =
  | "prompt_queued"
  | "prompt_started"
  | "prompt_completed"
  | "prompt_failed"
  | "queue_updated"
  | "lock_updated"
  | "command";

export interface AuditEvent {
  id: string;
  timestamp: string;
  action: AuditAction;
  status: "ok" | "failed" | "denied";
  contextKey: TelegramContextKey;
  channelId: "telegram";
  actorId?: number;
  actorRole?: string;
  agentId?: AgentId;
  threadId?: string | null;
  workspace?: string;
  promptId?: string;
  description?: string;
  detail?: string;
}

interface PersistedAuditLog {
  version: 1;
  events: AuditEvent[];
}

export class AuditLogStore {
  private readonly store: DocumentStore<PersistedAuditLog>;
  private readonly maxEvents: number;

  constructor(workspace: string, backend: StateBackendKind = "json", maxEvents = 1000) {
    this.store = createDocumentStore<PersistedAuditLog>({
      workspace,
      fileName: "audit.json",
      sqliteKey: "audit",
      backend,
    });
    this.maxEvents = maxEvents;
  }

  append(event: Omit<AuditEvent, "id" | "timestamp" | "channelId">): AuditEvent {
    const payload = this.readPayload();
    const next: AuditEvent = {
      id: randomUUID().replace(/-/g, "").slice(0, 12),
      timestamp: new Date().toISOString(),
      channelId: "telegram",
      ...event,
    };
    payload.events.push(next);
    if (payload.events.length > this.maxEvents) {
      payload.events.splice(0, payload.events.length - this.maxEvents);
    }
    this.store.write(payload);
    return next;
  }

  list(limit = 20): AuditEvent[] {
    return this.readPayload().events.slice(-Math.max(1, Math.min(200, limit))).reverse();
  }

  private readPayload(): PersistedAuditLog {
    const payload = this.store.read();
    if (!payload || payload.version !== 1 || !Array.isArray(payload.events)) {
      return { version: 1, events: [] };
    }
    return {
      version: 1,
      events: payload.events.filter(isAuditEvent),
    };
  }
}

function isAuditEvent(value: unknown): value is AuditEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as AuditEvent;
  return typeof candidate.id === "string" &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.action === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.contextKey === "string";
}
