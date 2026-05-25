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
export type WebActivitySource = "web" | "telegram" | "discord" | "slack" | "matrix" | "cli";
export type WebActivityStatus = "queued" | "running" | "completed" | "failed" | "aborted" | "info";

export interface WebChatAction {
  label: string;
  action: string;
  style?: "primary" | "secondary" | "danger";
  title?: string;
}

export interface WebChatActionResolution {
  actionId: string;
  label: string;
  resolvedAt: string;
}

export interface WebChatAttachment {
  id: string;
  kind: "image" | "audio" | "file";
  name: string;
  mimeType: string;
  sizeBytes: number;
  turnId: string;
}

export interface WebChatMessage {
  id: string;
  threadId: string;
  role: WebChatRole;
  text: string;
  meta?: string[];
  attachments?: WebChatAttachment[];
  timestamp: string;
  source: WebActivitySource;
  correlationId?: string;
  turnId?: string;
  key?: string;
  actions?: WebChatAction[];
  actionResolution?: WebChatActionResolution;
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
    const threadId = input.threadId || "pending";
    let result: { message: WebChatMessage; inserted: boolean };
    this.store.update((current) => {
      const payload = this.normalizePayload(current);
      const messages = payload.messagesByThread[threadId] ?? [];
      const duplicate = findDuplicateWebChatMessage(messages, { ...input, threadId });
      if (duplicate) {
        result = { message: duplicate, inserted: false };
        return payload;
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
      result = { message, inserted: true };
      return payload;
    });
    return result!;
  }

  upsertByKey(input: Omit<WebChatMessage, "id" | "timestamp"> & { timestamp?: string; key: string }): { message: WebChatMessage; inserted: boolean; updated: boolean } {
    const threadId = input.threadId || "pending";
    const now = new Date().toISOString();
    let result: { message: WebChatMessage; inserted: boolean; updated: boolean };
    this.store.update((current) => {
      const payload = this.normalizePayload(current);
      const messages = payload.messagesByThread[threadId] ?? [];
      const existing = messages.find((message) => message.key === input.key);
      if (existing) {
        existing.role = input.role;
        existing.text = input.text;
        existing.source = input.source;
        existing.correlationId = input.correlationId;
        existing.turnId = input.turnId;
        existing.timestamp = input.timestamp ?? now;
        existing.key = input.key;
        if (input.meta !== undefined) {
          existing.meta = input.meta;
        }
        existing.actionResolution = input.actionResolution ?? existing.actionResolution;
        existing.actions = filterResolvedWebChatActions(input.actions, existing.actionResolution);
        result = { message: existing, inserted: false, updated: true };
        return payload;
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
      result = { message, inserted: true, updated: false };
      return payload;
    });
    return result!;
  }

  resolveAction(input: { actionId: string; label: string; actionPrefix?: string; threadId?: string; resolvedAt?: string }): number {
    const actionId = input.actionId.trim();
    if (!actionId) {
      return 0;
    }
    const actionPrefix = input.actionPrefix?.trim();
    const actionSuffix = `:${actionId}`;
    const resolvedAt = input.resolvedAt ?? new Date().toISOString();
    let updated = 0;
    this.store.update((current) => {
      const payload = this.normalizePayload(current);
      for (const [threadId, messages] of Object.entries(payload.messagesByThread)) {
        if (input.threadId && threadId !== input.threadId) {
          continue;
        }
        for (const message of messages) {
          const actions = message.actions ?? [];
          if (!actions.some((action) => isMatchingWebChatAction(action, actionSuffix, actionPrefix))) {
            continue;
          }
          const remaining = actions.filter((action) => !isMatchingWebChatAction(action, actionSuffix, actionPrefix));
          message.actions = remaining.length ? remaining : undefined;
          message.actionResolution = { actionId, label: input.label, resolvedAt };
          updated += 1;
        }
      }
      return payload;
    });
    return updated;
  }

  list(threadId: string | null | undefined, limit = 200): WebChatMessage[] {
    const messages = this.readPayload().messagesByThread[threadId || "pending"] ?? [];
    return messages.slice(-Math.max(1, Math.min(this.maxMessages, limit)));
  }

  listPage(threadId: string | null | undefined, options: { limit?: number; cursor?: string | null } = {}): CursorPage<WebChatMessage> {
    const limit = normalizeCursorLimit(options.limit, 80, this.maxMessages);
    const messages = this.readPayload().messagesByThread[threadId || "pending"] ?? [];
    const newestFirst = [...messages].sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
    const page = cursorPage(newestFirst, options.cursor, limit, (message) => message.id);
    return {
      items: page.items.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)),
      pagination: page.pagination,
    };
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
    const key = threadId || "pending";
    let count = 0;
    this.store.update((current) => {
      const payload = this.normalizePayload(current);
      count = payload.messagesByThread[key]?.length ?? 0;
      delete payload.messagesByThread[key];
      return payload;
    });
    return count;
  }

  private readPayload(): PersistedWebChat {
    return this.normalizePayload(this.store.read());
  }

  private normalizePayload(payload: PersistedWebChat | undefined): PersistedWebChat {
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
    const event: WebActivityEvent = {
      id: randomId(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      ...input,
      category: input.category ?? activityCategoryForType(input.type),
    };
    this.store.update((current) => {
      const payload = this.normalizePayload(current);
      payload.events.push(event);
      if (payload.events.length > this.maxEvents) {
        payload.events.splice(0, payload.events.length - this.maxEvents);
      }
      return payload;
    });
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
    return this.normalizePayload(this.store.read());
  }

  private normalizePayload(payload: PersistedWebActivity | undefined): PersistedWebActivity {
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
    (candidate.meta === undefined || (Array.isArray(candidate.meta) && candidate.meta.every((item) => typeof item === "string"))) &&
    (candidate.attachments === undefined ||
      (Array.isArray(candidate.attachments) && candidate.attachments.every(isWebChatAttachment))) &&
    (candidate.key === undefined || typeof candidate.key === "string") &&
    (candidate.actions === undefined || (Array.isArray(candidate.actions) && candidate.actions.every(isWebChatAction))) &&
    (candidate.actionResolution === undefined || isWebChatActionResolution(candidate.actionResolution)) &&
    ["user", "agent", "system", "tool"].includes(candidate.role) &&
    ["web", "telegram", "discord", "slack", "matrix", "cli"].includes(candidate.source);
}

function isWebChatAttachment(value: unknown): value is WebChatAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as WebChatAttachment;
  return typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.mimeType === "string" &&
    typeof candidate.sizeBytes === "number" &&
    typeof candidate.turnId === "string" &&
    ["image", "audio", "file"].includes(candidate.kind);
}

function isWebChatAction(value: unknown): value is WebChatAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as WebChatAction;
  return typeof candidate.label === "string" &&
    typeof candidate.action === "string" &&
    (candidate.style === undefined || ["primary", "secondary", "danger"].includes(candidate.style)) &&
    (candidate.title === undefined || typeof candidate.title === "string");
}

function isWebChatActionResolution(value: unknown): value is WebChatActionResolution {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as WebChatActionResolution;
  return typeof candidate.actionId === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.resolvedAt === "string";
}

function filterResolvedWebChatActions(actions: WebChatAction[] | undefined, resolution: WebChatActionResolution | undefined): WebChatAction[] | undefined {
  if (!actions?.length) {
    return undefined;
  }
  if (!resolution?.actionId) {
    return actions;
  }
  const suffix = `:${resolution.actionId}`;
  const filtered = actions.filter((action) => !action.action.endsWith(suffix));
  return filtered.length ? filtered : undefined;
}

function isMatchingWebChatAction(action: WebChatAction, actionSuffix: string, actionPrefix: string | undefined): boolean {
  return action.action.endsWith(actionSuffix) && (!actionPrefix || action.action.startsWith(actionPrefix));
}

function isWebActivityEvent(value: unknown): value is WebActivityEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as WebActivityEvent;
  return typeof candidate.id === "string" &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.type === "string" &&
    ["web", "telegram", "discord", "slack", "matrix", "cli"].includes(candidate.source) &&
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
