import { randomUUID } from "node:crypto";

import type { AgentId } from "./agent.js";
import { createDocumentStore, type DocumentStore, type StateBackendKind } from "./state-backend.js";

export type WebChatRole = "user" | "agent" | "system" | "tool";
export type WebActivitySource = "web" | "telegram" | "cli";
export type WebActivityStatus = "queued" | "running" | "completed" | "failed" | "aborted" | "info";
export type WebActivityCategory =
  | "prompt"
  | "session"
  | "queue"
  | "agent-update"
  | "artifact"
  | "system"
  | "auth"
  | "security"
  | "tool";

export interface WebActivityActor {
  channel: "web" | "telegram" | "cli" | "system";
  id?: string;
  label?: string;
  username?: string;
}

export interface WebChatMessage {
  id: string;
  threadId: string;
  role: WebChatRole;
  text: string;
  timestamp: string;
  source: WebActivitySource;
  turnId?: string;
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
    const payload = this.readPayload();
    const threadId = input.threadId || "pending";
    const messages = payload.messagesByThread[threadId] ?? [];
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
    return message;
  }

  list(threadId: string | null | undefined, limit = 200): WebChatMessage[] {
    const messages = this.readPayload().messagesByThread[threadId || "pending"] ?? [];
    return messages.slice(-Math.max(1, Math.min(this.maxMessages, limit)));
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
        messagesByThread[threadId] = messages.filter(isWebChatMessage).slice(-this.maxMessages);
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

  list(options: { limit?: number; source?: WebActivitySource | "all"; status?: WebActivityStatus | "all"; category?: WebActivityCategory | "all" } = {}): WebActivityEvent[] {
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    return this.readPayload().events
      .filter((event) => !options.source || options.source === "all" || event.source === options.source)
      .filter((event) => !options.status || options.status === "all" || event.status === options.status)
      .filter((event) => !options.category || options.category === "all" || (event.category ?? activityCategoryForType(event.type)) === options.category)
      .slice(-limit)
      .reverse();
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
    ["user", "agent", "system", "tool"].includes(candidate.role) &&
    ["web", "telegram", "cli"].includes(candidate.source);
}

function isWebActivityEvent(value: unknown): value is WebActivityEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as WebActivityEvent;
  return typeof candidate.id === "string" &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.type === "string" &&
    ["web", "telegram", "cli"].includes(candidate.source) &&
    ["queued", "running", "completed", "failed", "aborted", "info"].includes(candidate.status);
}

export function activityCategoryForType(type: string): WebActivityCategory {
  if (/^(prompt|cli_turn|voice|upload|attachment)/.test(type)) return "prompt";
  if (/^(session|agent_switch|handback|model_|reasoning_|fast_|launch_)/.test(type)) return "session";
  if (/^queue_/.test(type)) return "queue";
  if (/^agent_(install|update)/.test(type)) return "agent-update";
  if (/^(artifact|artifacts)/.test(type)) return "artifact";
  if (/^(auth|login|logout)/.test(type)) return "auth";
  if (/^(user_|group_|telegram_chat_|telegram_link|permission_|access_|lock_)/.test(type)) return "security";
  if (/^(tool_|cli_tool)/.test(type)) return "tool";
  return "system";
}

function randomId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}
