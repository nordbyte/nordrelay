import { randomUUID } from "node:crypto";

import type { AgentId } from "../agents/shared/agent.js";
import {
  auditCategoryForAction,
  type WebActivityActor,
  type WebActivityCategory,
} from "../core/activity-events.js";
import { cursorPage, normalizeCursorLimit, type CursorPage } from "../core/pagination.js";
import type { ChannelContextKey } from "../channels/shared/context-key.js";
import { createDocumentStore, type DocumentStore, type StateBackendKind } from "../state/state-backend.js";

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
  | "telegram_chat_updated"
  | "discord_link_created"
  | "discord_linked"
  | "discord_unlinked"
  | "discord_channel_updated"
  | "slack_link_created"
  | "slack_linked"
  | "slack_unlinked"
  | "slack_channel_updated"
  | "matrix_link_created"
  | "matrix_linked"
  | "matrix_unlinked"
  | "matrix_room_updated"
  | "peer_invite_created"
  | "peer_invite_deleted"
  | "peer_paired"
  | "peer_updated"
  | "peer_revoked"
  | "peer_probe"
  | "peer_health_checked"
  | "peer_discovery_started"
  | "peer_discovery_cancelled"
  | "peer_relay_cancelled"
  | "peer_relay_retried"
  | "peer_relay_expired_drained"
  | "peer_tls_repinned"
  | "peer_rotation_invite_created"
  | "peer_identity_backup_exported"
  | "peer_identity_restored";

export interface AuditEvent {
  id: string;
  timestamp: string;
  action: AuditAction;
  category?: WebActivityCategory;
  status: "ok" | "failed" | "denied";
  contextKey: ChannelContextKey;
  channelId: "telegram" | "discord" | "slack" | "matrix" | "web";
  actor?: WebActivityActor;
  actorId?: number | string;
  actorRole?: string;
  agentId?: AgentId;
  threadId?: string | null;
  workspace?: string;
  promptId?: string;
  correlationId?: string;
  description?: string;
  detail?: string;
}

interface PersistedAuditLog {
  version: 1;
  events: AuditEvent[];
}

export interface AuditListOptions {
  limit?: number;
  cursor?: string;
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
    const next: AuditEvent = {
      id: randomUUID().replace(/-/g, "").slice(0, 12),
      timestamp: new Date().toISOString(),
      ...event,
      category: event.category ?? auditCategoryForAction(event.action),
      channelId: event.channelId ?? "telegram",
    };
    this.store.update((current) => {
      const payload = this.normalizePayload(current);
      payload.events.push(next);
      if (payload.events.length > this.maxEvents) {
        payload.events.splice(0, payload.events.length - this.maxEvents);
      }
      return payload;
    });
    return next;
  }

  list(options: number | AuditListOptions = 20): AuditEvent[] {
    const resolved = typeof options === "number" ? { limit: options } : options;
    return this.listPage(resolved).items;
  }

  listPage(options: AuditListOptions = {}): CursorPage<AuditEvent> {
    const limit = normalizeCursorLimit(options.limit, 20, 500);
    const events = this.filteredEvents(options)
      .map((event, index) => ({ event, index }))
      .sort((left, right) => {
        const timestampDiff = Date.parse(right.event.timestamp) - Date.parse(left.event.timestamp);
        return timestampDiff || right.index - left.index;
      })
      .map((entry) => entry.event);
    return cursorPage(events, options.cursor, limit, (event) => event.id);
  }

  findByCorrelationId(correlationId: string, limit = 100): AuditEvent[] {
    const needle = correlationId.trim();
    if (!needle) {
      return [];
    }
    return this.readPayload().events
      .filter((event) => event.correlationId === needle)
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
      .slice(-Math.max(1, Math.min(500, limit)));
  }

  private filteredEvents(options: AuditListOptions): AuditEvent[] {
    const since = normalizeSince(options.since);
    return this.readPayload().events
      .filter((event) => !options.channelId || options.channelId === "all" || event.channelId === options.channelId)
      .filter((event) => !options.status || options.status === "all" || event.status === options.status)
      .filter((event) => !options.action || options.action === "all" || event.action === options.action)
      .filter((event) => !options.category || options.category === "all" || (event.category ?? auditCategoryForAction(event.action)) === options.category)
      .filter((event) => !options.agentId || options.agentId === "all" || event.agentId === options.agentId)
      .filter((event) => !options.threadId || event.threadId === options.threadId)
      .filter((event) => !options.workspace || event.workspace === options.workspace)
      .filter((event) => !options.actor || auditActorMatches(event, options.actor))
      .filter((event) => !since || Date.parse(event.timestamp) >= since);
  }

  private readPayload(): PersistedAuditLog {
    return this.normalizePayload(this.store.read());
  }

  private normalizePayload(payload: PersistedAuditLog | undefined): PersistedAuditLog {
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
