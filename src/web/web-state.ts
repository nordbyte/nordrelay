import { randomUUID } from "node:crypto";

import type { AgentId } from "../agents/shared/agent.js";
import {
  activityActorLabel,
  activityCategoryForType,
  type WebActivityActor,
  type WebActivityCategory,
} from "../core/activity-events.js";
import { cursorPage, normalizeCursorLimit, type CursorPage } from "../core/pagination.js";
import { createDocumentStore, type DocumentStore, type StateBackendKind } from "../state/state-backend.js";

export type WebChatRole = "user" | "agent" | "system" | "tool";
export type WebActivitySource = "web" | "telegram" | "discord" | "slack" | "cli";
export type WebActivityStatus = "queued" | "running" | "completed" | "failed" | "aborted" | "info";

export interface WebChatMessage {
  id: string;
  threadId: string;
  role: WebChatRole;
  text: string;
  timestamp: string;
  source: WebActivitySource;
  correlationId?: string;
  turnId?: string;
  key?: string;
}

export interface WebActivityEvent {
  id: string;
  timestamp: string;
  source: WebActivitySource;
  category?: WebActivityCategory;
  status: WebActivityStatus;
  type: string;
  contextKey?: string;
  threadId: string | null;
  workspace?: string;
  agentId?: AgentId;
  actor?: WebActivityActor;
  correlationId?: string;
  prompt?: string;
  detail?: string;
  durationMs?: number;
}

interface PersistedWebChat {
  version: 1;
  messagesByThread: Record<string, WebChatMessage[]>;
}

interface PersistedWebActivity {
  version: 1;
  events: WebActivityEvent[];
}

const DEFAULT_CHAT_LIMIT = 300;
const DEFAULT_ACTIVITY_LIMIT = 1000;
const CROSS_SOURCE_AGENT_DEDUPE_MS = 10 * 60 * 1000;
const CROSS_SOURCE_AGENT_DEDUPE_MIN_CHARS = 120;

export class WebChatStore {
  private readonly store: DocumentStore<PersistedWebChat>;
  private readonly maxMessages: number;

  constructor(workspace: string, backend: StateBackendKind = "json", maxMessages = DEFAULT_CHAT_LIMIT) {
    this.store = createDocumentStore<PersistedWebChat>({
      workspace,
      fileName: "web-chat.json",
      sqliteKey: "web-chat",
      backend,
    });
    this.maxMessages = maxMessages;
  }

  append(input: Omit<WebChatMessage, "id" | "timestamp"> & { timestamp?: string }): WebChatMessage {
    return this.appendWithResult(input).message;
  }

  appendWithResult(input: Omit<WebChatMessage, "id" | "timestamp"> & { timestamp?: string }): { message: WebChatMessage; inserted: boolean } {
    const payload = this.readPayload();
    const threadId = input.threadId || "pending";
    const messages = payload.messagesByThread[threadId] ?? [];
    const duplicate = findDuplicateWebChatMessage(messages, { ...input, threadId });
    if (duplicate) {
      return { message: duplicate, inserted: false };
    }
    const message: WebChatMessage = {
      id: randomId(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      ...input,
      threadId,
    };
    messages.push(message);
    if (messages.length > this.maxMessages) {
      messages.splice(0, messages.length - this.maxMessages);
    }
    payload.messagesByThread[threadId] = messages;
    this.store.write(payload);
    return { message, inserted: true };
  }

  upsertByKey(input: Omit<WebChatMessage, "id" | "timestamp"> & { timestamp?: string; key: string }): { message: WebChatMessage; inserted: boolean; updated: boolean } {
    const payload = this.readPayload();
    const threadId = input.threadId || "pending";
    const messages = payload.messagesByThread[threadId] ?? [];
    const now = new Date().toISOString();
    const existing = messages.find((message) => message.key === input.key);
    if (existing) {
      existing.role = input.role;
      existing.text = input.text;
      existing.source = input.source;
      existing.correlationId = input.correlationId;
      existing.turnId = input.turnId;
      existing.timestamp = input.timestamp ?? now;
      existing.key = input.key;
      this.store.write(payload);
      return { message: existing, inserted: false, updated: true };
    }
    const message: WebChatMessage = {
      id: randomId(),
      timestamp: input.timestamp ?? now,
      ...input,
      threadId,
    };
    messages.push(message);
    if (messages.length > this.maxMessages) {
      messages.splice(0, messages.length - this.maxMessages);
    }
    payload.messagesByThread[threadId] = messages;
    this.store.write(payload);
    return { message, inserted: true, updated: false };
  }

  list(threadId: string | null | undefined, limit = 200): WebChatMessage[] {
    const messages = this.readPayload().messagesByThread[threadId || "pending"] ?? [];
    return messages.slice(-Math.max(1, Math.min(this.maxMessages, limit)));
  }

  findByCorrelationId(correlationId: string, limit = 100): WebChatMessage[] {
    const needle = correlationId.trim();
    if (!needle) {
      return [];
    }
    return Object.values(this.readPayload().messagesByThread)
      .flat()
      .filter((message) => message.correlationId === needle)
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
      .slice(-Math.max(1, Math.min(this.maxMessages, limit)));
  }

  clear(threadId: string | null | undefined): number {
    const payload = this.readPayload();
    const key = threadId || "pending";
    const count = payload.messagesByThread[key]?.length ?? 0;
    delete payload.messagesByThread[key];
    this.store.write(payload);
    return count;
  }

  private readPayload(): PersistedWebChat {
    const payload = this.store.read();
    if (!payload || payload.version !== 1 || !payload.messagesByThread || typeof payload.messagesByThread !== "object") {
      return { version: 1, messagesByThread: {} };
    }

    const messagesByThread: Record<string, WebChatMessage[]> = {};
    for (const [threadId, messages] of Object.entries(payload.messagesByThread)) {
      if (Array.isArray(messages)) {
        messagesByThread[threadId] = dedupeWebChatMessages(messages.filter(isWebChatMessage)).slice(-this.maxMessages);
      }
    }
    return { version: 1, messagesByThread };
  }
}

export class WebActivityStore {
  private readonly store: DocumentStore<PersistedWebActivity>;
  private readonly maxEvents: number;

  constructor(workspace: string, backend: StateBackendKind = "json", maxEvents = DEFAULT_ACTIVITY_LIMIT) {
    this.store = createDocumentStore<PersistedWebActivity>({
      workspace,
      fileName: "web-activity.json",
      sqliteKey: "web-activity",
      backend,
    });
    this.maxEvents = maxEvents;
  }

  append(input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }): WebActivityEvent {
    const payload = this.readPayload();
    const event: WebActivityEvent = {
      id: randomId(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      ...input,
      category: input.category ?? activityCategoryForType(input.type),
    };
    payload.events.push(event);
    if (payload.events.length > this.maxEvents) {
      payload.events.splice(0, payload.events.length - this.maxEvents);
    }
    this.store.write(payload);
    return event;
  }

  list(options: {
    limit?: number;
    source?: WebActivitySource | "all";
    status?: WebActivityStatus | "all";
    category?: WebActivityCategory | "all";
    actor?: string;
    agentId?: AgentId | "all" | string;
    threadId?: string;
    workspace?: string;
    type?: string;
    since?: string | number;
  } = {}): WebActivityEvent[] {
    return this.listPage(options).items;
  }

  listPage(options: {
    limit?: number;
    cursor?: string;
    source?: WebActivitySource | "all";
    status?: WebActivityStatus | "all";
    category?: WebActivityCategory | "all";
    actor?: string;
    agentId?: AgentId | "all" | string;
    threadId?: string;
    workspace?: string;
    type?: string;
    since?: string | number;
  } = {}): CursorPage<WebActivityEvent> {
    const limit = normalizeCursorLimit(options.limit, 100, 500);
    const events = this.filteredEvents(options)
      .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
    return cursorPage(events, options.cursor, limit, (event) => event.id);
  }

  findByCorrelationId(correlationId: string, limit = 100): WebActivityEvent[] {
    const needle = correlationId.trim();
    if (!needle) {
      return [];
    }
    return this.readPayload().events
      .filter((event) => event.correlationId === needle)
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
      .slice(-Math.max(1, Math.min(500, limit)));
  }

  private filteredEvents(options: {
    source?: WebActivitySource | "all";
    status?: WebActivityStatus | "all";
    category?: WebActivityCategory | "all";
    actor?: string;
    agentId?: AgentId | "all" | string;
    threadId?: string;
    workspace?: string;
    type?: string;
    since?: string | number;
  }): WebActivityEvent[] {
    const since = normalizeSince(options.since);
    return this.readPayload().events
      .filter((event) => !options.source || options.source === "all" || event.source === options.source)
      .filter((event) => !options.status || options.status === "all" || event.status === options.status)
      .filter((event) => !options.category || options.category === "all" || (event.category ?? activityCategoryForType(event.type)) === options.category)
      .filter((event) => !options.agentId || options.agentId === "all" || event.agentId === options.agentId)
      .filter((event) => !options.threadId || event.threadId === options.threadId)
      .filter((event) => !options.workspace || event.workspace === options.workspace)
      .filter((event) => !options.type || event.type.toLowerCase().includes(options.type.toLowerCase()))
      .filter((event) => !options.actor || activityActorMatches(event.actor, options.actor))
      .filter((event) => !since || Date.parse(event.timestamp) >= since);
  }

  private readPayload(): PersistedWebActivity {
    const payload = this.store.read();
    if (!payload || payload.version !== 1 || !Array.isArray(payload.events)) {
      return { version: 1, events: [] };
    }
    return {
      version: 1,
      events: payload.events.filter(isWebActivityEvent).slice(-this.maxEvents),
    };
  }
}

function isWebChatMessage(value: unknown): value is WebChatMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as WebChatMessage;
  return typeof candidate.id === "string" &&
    typeof candidate.threadId === "string" &&
    typeof candidate.text === "string" &&
    typeof candidate.timestamp === "string" &&
    (candidate.key === undefined || typeof candidate.key === "string") &&
    ["user", "agent", "system", "tool"].includes(candidate.role) &&
    ["web", "telegram", "discord", "slack", "cli"].includes(candidate.source);
}

function isWebActivityEvent(value: unknown): value is WebActivityEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as WebActivityEvent;
  return typeof candidate.id === "string" &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.type === "string" &&
    ["web", "telegram", "discord", "slack", "cli"].includes(candidate.source) &&
    ["queued", "running", "completed", "failed", "aborted", "info"].includes(candidate.status);
}

function normalizeSince(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function activityActorMatches(actor: WebActivityActor | undefined, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [
    activityActorLabel(actor),
    actor?.id,
    actor?.username,
    actor?.channelUserId,
    actor?.channel,
  ].some((value) => String(value ?? "").toLowerCase().includes(needle));
}

function randomId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function dedupeWebChatMessages(messages: WebChatMessage[]): WebChatMessage[] {
  const seen = new Set<string>();
  const deduped: WebChatMessage[] = [];
  for (const message of messages) {
    const key = webChatDedupKey(message);
    if (key && seen.has(key)) {
      continue;
    }
    const duplicate = findCrossSourceAgentDuplicate(deduped, message);
    if (duplicate) {
      if (shouldPreferWebChatMessage(message, duplicate)) {
        const index = deduped.indexOf(duplicate);
        if (index >= 0) {
          deduped[index] = message;
        }
      }
      continue;
    }
    if (key) {
      seen.add(key);
    }
    deduped.push(message);
  }
  return deduped;
}

function findDuplicateWebChatMessage(
  messages: WebChatMessage[],
  input: Omit<WebChatMessage, "id" | "timestamp"> & { timestamp?: string },
): WebChatMessage | undefined {
  const key = webChatDedupKey(input);
  const exact = key ? messages.find((message) => webChatDedupKey(message) === key) : undefined;
  return exact ?? findCrossSourceAgentDuplicate(messages, input);
}

function findCrossSourceAgentDuplicate(
  messages: WebChatMessage[],
  input: Omit<WebChatMessage, "id" | "timestamp"> & { timestamp?: string },
): WebChatMessage | undefined {
  if (input.role !== "agent") {
    return undefined;
  }
  return [...messages].reverse().find((message) =>
    message.role === "agent" &&
    message.threadId === (input.threadId || "pending") &&
    message.source !== input.source &&
    isRecentWebChatDuplicate(message.timestamp, input.timestamp) &&
    hasOverlappingAgentText(message.text, input.text),
  );
}

function isRecentWebChatDuplicate(leftTimestamp: string | undefined, rightTimestamp: string | undefined): boolean {
  const left = leftTimestamp ? Date.parse(leftTimestamp) : Number.NaN;
  const right = rightTimestamp ? Date.parse(rightTimestamp) : Date.now();
  return !Number.isFinite(left) || !Number.isFinite(right) || Math.abs(left - right) <= CROSS_SOURCE_AGENT_DEDUPE_MS;
}

function hasOverlappingAgentText(left: string, right: string): boolean {
  const normalizedLeft = normalizeAgentChatText(left);
  const normalizedRight = normalizeAgentChatText(right);
  const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = normalizedLeft.length > normalizedRight.length ? normalizedLeft : normalizedRight;
  return shorter.length >= CROSS_SOURCE_AGENT_DEDUPE_MIN_CHARS && (shorter === longer || longer.includes(shorter));
}

function normalizeAgentChatText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function shouldPreferWebChatMessage(candidate: WebChatMessage, existing: WebChatMessage): boolean {
  if (existing.source === "cli" && candidate.source !== "cli") {
    return true;
  }
  if (candidate.source === existing.source) {
    return candidate.text.length > existing.text.length;
  }
  return false;
}

function webChatDedupKey(message: Omit<WebChatMessage, "id" | "timestamp"> & { timestamp?: string }): string | null {
  const threadId = message.threadId || "pending";
  if (message.key) {
    return [threadId, message.key].join("\0");
  }
  if (message.turnId) {
    return [threadId, message.role, message.source, message.turnId, message.text].join("\0");
  }
  if (message.timestamp) {
    return [threadId, message.role, message.source, message.timestamp, message.text].join("\0");
  }
  return null;
}

export {
  activityActorLabel,
  activityCategoryForType,
  auditCategoryForAction,
  type WebActivityActor,
  type WebActivityCategory,
} from "../core/activity-events.js";
