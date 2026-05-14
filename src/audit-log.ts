import { randomUUID } from "node:crypto";

import type { AgentId } from "./agent.js";
import {
  auditCategoryForAction,
  type WebActivityActor,
  type WebActivityCategory,
} from "./activity-events.js";
import type { TelegramContextKey } from "./context-key.js";
import { createDocumentStore, type DocumentStore, type StateBackendKind } from "./state-backend.js";

export type AuditAction =
  | "prompt_queued"
  | "prompt_started"
  | "prompt_completed"
  | "prompt_failed"
  | "queue_updated"
  | "lock_updated"
  | "command"
  | "auth_login"
  | "auth_logout"
  | "auth_login_failed"
  | "permission_denied"
  | "user_created"
  | "user_updated"
  | "user_password_changed"
  | "user_session_revoked"
  | "group_created"
  | "group_updated"
  | "telegram_link_created"
  | "telegram_linked"
  | "telegram_unlinked"
  | "telegram_chat_updated";

export interface AuditEvent {
  id: string;
  timestamp: string;
  action: AuditAction;
  category?: WebActivityCategory;
  status: "ok" | "failed" | "denied";
  contextKey: TelegramContextKey;
  channelId: "telegram" | "web";
  actor?: WebActivityActor;
  actorId?: number | string;
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

export interface AuditListOptions {
  limit?: number;
  channelId?: AuditEvent["channelId"] | "all";
  status?: AuditEvent["status"] | "all";
  action?: AuditAction | "all" | string;
  category?: WebActivityCategory | "all";
  actor?: string;
  agentId?: AgentId | "all" | string;
  threadId?: string;
  workspace?: string;
  since?: string | number;
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

  append(event: Omit<AuditEvent, "id" | "timestamp" | "channelId"> & { channelId?: AuditEvent["channelId"] }): AuditEvent {
    const payload = this.readPayload();
    const next: AuditEvent = {
      id: randomUUID().replace(/-/g, "").slice(0, 12),
      timestamp: new Date().toISOString(),
      ...event,
      category: event.category ?? auditCategoryForAction(event.action),
      channelId: event.channelId ?? "telegram",
    };
    payload.events.push(next);
    if (payload.events.length > this.maxEvents) {
      payload.events.splice(0, payload.events.length - this.maxEvents);
    }
    this.store.write(payload);
    return next;
  }

  list(options: number | AuditListOptions = 20): AuditEvent[] {
    const resolved = typeof options === "number" ? { limit: options } : options;
    const limit = Math.max(1, Math.min(500, resolved.limit ?? 20));
    const since = normalizeSince(resolved.since);
    return this.readPayload().events
      .filter((event) => !resolved.channelId || resolved.channelId === "all" || event.channelId === resolved.channelId)
      .filter((event) => !resolved.status || resolved.status === "all" || event.status === resolved.status)
      .filter((event) => !resolved.action || resolved.action === "all" || event.action === resolved.action)
      .filter((event) => !resolved.category || resolved.category === "all" || (event.category ?? auditCategoryForAction(event.action)) === resolved.category)
      .filter((event) => !resolved.agentId || resolved.agentId === "all" || event.agentId === resolved.agentId)
      .filter((event) => !resolved.threadId || event.threadId === resolved.threadId)
      .filter((event) => !resolved.workspace || event.workspace === resolved.workspace)
      .filter((event) => !resolved.actor || auditActorMatches(event, resolved.actor))
      .filter((event) => !since || Date.parse(event.timestamp) >= since)
      .slice(-limit)
      .reverse();
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

function normalizeSince(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function auditActorMatches(event: AuditEvent, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [
    event.actor?.id,
    event.actor?.label,
    event.actor?.username,
    event.actor?.channelUserId,
    event.actor?.channel,
    event.actorId,
    event.actorRole,
  ].some((value) => String(value ?? "").toLowerCase().includes(needle));
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
