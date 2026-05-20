import { randomUUID } from "node:crypto";
import type { AgentPromptInput } from "../agents/shared/agent.js";
import type { ChannelContextKey } from "../channels/shared/context-key.js";
import { createDocumentStore, type DocumentStore, type StateBackendKind } from "./state-backend.js";
import type { WebActivityActor } from "../web/web-state.js";

export interface PromptEnvelope {
  input: AgentPromptInput;
  description: string;
  displayText?: string;
  displayMeta?: string[];
  correlationId?: string;
  artifactOutDir?: string;
  activityActor?: WebActivityActor;
}

export interface QueuedPrompt extends PromptEnvelope {
  id: string;
  contextKey: ChannelContextKey;
  createdAt: number;
  notBefore?: number;
  updatedAt?: number;
  attempts?: number;
  lastError?: string;
}

interface PersistedPromptStore {
  lastPrompts: Record<ChannelContextKey, PromptEnvelope>;
  queues: Record<ChannelContextKey, QueuedPrompt[]>;
  pausedContexts?: ChannelContextKey[];
}

export class PromptStore {
  private readonly store: DocumentStore<PersistedPromptStore>;
  private lastPrompts = new Map<ChannelContextKey, PromptEnvelope>();
  private queues = new Map<ChannelContextKey, QueuedPrompt[]>();
  private pausedContexts = new Set<ChannelContextKey>();

  constructor(workspace: string, backend: StateBackendKind = "json") {
    this.store = createDocumentStore<PersistedPromptStore>({
      workspace,
      fileName: "prompts.json",
      sqliteKey: "prompts",
      backend,
    });
    this.load();
  }

  setLastPrompt(contextKey: ChannelContextKey, prompt: PromptEnvelope): void {
    this.lastPrompts.set(contextKey, prompt);
    this.persist();
  }

  getLastPrompt(contextKey: ChannelContextKey): PromptEnvelope | undefined {
    return this.lastPrompts.get(contextKey);
  }

  enqueue(contextKey: ChannelContextKey, prompt: PromptEnvelope, options: { notBefore?: number } = {}): QueuedPrompt {
    const item: QueuedPrompt = {
      ...prompt,
      id: createQueueId(),
      contextKey,
      createdAt: Date.now(),
      notBefore: options.notBefore,
    };
    const queue = this.queues.get(contextKey) ?? [];
    queue.push(item);
    this.queues.set(contextKey, queue);
    this.persist();
    return item;
  }

  enqueueFront(contextKey: ChannelContextKey, prompt: QueuedPrompt): void {
    const queue = this.queues.get(contextKey) ?? [];
    queue.unshift(prompt);
    this.queues.set(contextKey, queue);
    this.persist();
  }

  dequeue(contextKey: ChannelContextKey): QueuedPrompt | undefined {
    const queue = this.queues.get(contextKey);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const now = Date.now();
    const index = queue.findIndex((queued) => !queued.notBefore || queued.notBefore <= now);
    if (index === -1) {
      return undefined;
    }
    const [item] = queue.splice(index, 1);
    if (!queue || queue.length === 0) {
      this.queues.delete(contextKey);
    }
    if (item) {
      item.attempts = (item.attempts ?? 0) + 1;
      item.updatedAt = Date.now();
    }
    this.persist();
    return item;
  }

  list(contextKey: ChannelContextKey): QueuedPrompt[] {
    return [...(this.queues.get(contextKey) ?? [])];
  }

  get(contextKey: ChannelContextKey, id: string): QueuedPrompt | undefined {
    return this.queues.get(contextKey)?.find((item) => item.id === id);
  }

  nextRunnableAt(contextKey: ChannelContextKey): number | null {
    const timestamps = (this.queues.get(contextKey) ?? [])
      .map((item) => item.notBefore)
      .filter((value): value is number => typeof value === "number")
      .sort((left, right) => left - right);
    return timestamps[0] ?? null;
  }

  listContextKeys(): ChannelContextKey[] {
    return [...new Set([...this.queues.keys(), ...this.pausedContexts])];
  }

  remove(contextKey: ChannelContextKey, id: string): QueuedPrompt | undefined {
    const queue = this.queues.get(contextKey);
    if (!queue) {
      return undefined;
    }

    const index = queue.findIndex((item) => item.id === id);
    if (index === -1) {
      return undefined;
    }

    const [removed] = queue.splice(index, 1);
    if (queue.length === 0) {
      this.queues.delete(contextKey);
    }
    this.persist();
    return removed;
  }

  moveToTop(contextKey: ChannelContextKey, id: string): QueuedPrompt | undefined {
    const queue = this.queues.get(contextKey);
    if (!queue) {
      return undefined;
    }

    const index = queue.findIndex((item) => item.id === id);
    if (index === -1) {
      return undefined;
    }

    const [item] = queue.splice(index, 1);
    queue.unshift(item);
    this.persist();
    return item;
  }

  moveUp(contextKey: ChannelContextKey, id: string): QueuedPrompt | undefined {
    const queue = this.queues.get(contextKey);
    if (!queue) {
      return undefined;
    }
    const index = queue.findIndex((item) => item.id === id);
    if (index <= 0) {
      return queue[index];
    }
    const [item] = queue.splice(index, 1);
    queue.splice(index - 1, 0, item);
    item.updatedAt = Date.now();
    this.persist();
    return item;
  }

  moveDown(contextKey: ChannelContextKey, id: string): QueuedPrompt | undefined {
    const queue = this.queues.get(contextKey);
    if (!queue) {
      return undefined;
    }
    const index = queue.findIndex((item) => item.id === id);
    if (index === -1) {
      return undefined;
    }
    if (index >= queue.length - 1) {
      return queue[index];
    }
    const [item] = queue.splice(index, 1);
    queue.splice(index + 1, 0, item);
    item.updatedAt = Date.now();
    this.persist();
    return item;
  }

  markFailed(contextKey: ChannelContextKey, item: QueuedPrompt, error: string): void {
    item.lastError = error;
    item.updatedAt = Date.now();
    this.enqueueFront(contextKey, item);
  }

  clear(contextKey: ChannelContextKey): number {
    const count = this.queues.get(contextKey)?.length ?? 0;
    this.queues.delete(contextKey);
    this.persist();
    return count;
  }

  pause(contextKey: ChannelContextKey): void {
    this.pausedContexts.add(contextKey);
    this.persist();
  }

  resume(contextKey: ChannelContextKey): void {
    this.pausedContexts.delete(contextKey);
    this.persist();
  }

  isPaused(contextKey: ChannelContextKey): boolean {
    return this.pausedContexts.has(contextKey);
  }

  private persist(): void {
    try {
      const payload: PersistedPromptStore = {
        lastPrompts: Object.fromEntries(this.lastPrompts.entries()),
        queues: Object.fromEntries(this.queues.entries()),
        pausedContexts: [...this.pausedContexts],
      };
      this.store.write(payload);
    } catch (error) {
      console.warn("Failed to persist prompt store:", error instanceof Error ? error.message : String(error));
    }
  }

  private load(): void {
    try {
      const payload = this.store.read();
      if (!payload) {
        return;
      }
      for (const [contextKey, prompt] of Object.entries(payload.lastPrompts ?? {})) {
        if (isPromptEnvelope(prompt)) {
          this.lastPrompts.set(contextKey, prompt);
        }
      }
      for (const [contextKey, queue] of Object.entries(payload.queues ?? {})) {
        if (Array.isArray(queue)) {
          this.queues.set(contextKey, queue.filter(isQueuedPrompt));
        }
      }
      if (Array.isArray(payload.pausedContexts)) {
        this.pausedContexts = new Set(
          payload.pausedContexts.filter((contextKey): contextKey is string => typeof contextKey === "string"),
        );
      }
    } catch (error) {
      console.warn("Failed to load prompt store:", error instanceof Error ? error.message : String(error));
    }
  }
}

export function describePromptInput(input: AgentPromptInput): string {
  if (typeof input === "string") {
    return trimDescription(input);
  }

  const parts: string[] = [];
  if (input.text) {
    parts.push(trimDescription(input.text));
  }
  if (input.imagePaths?.length) {
    parts.push(`${input.imagePaths.length} image${input.imagePaths.length === 1 ? "" : "s"}`);
  }
  if (input.stagedFileInstructions) {
    parts.push("staged file input");
  }
  return parts.join(" · ") || "prompt";
}

export function displayTextForPromptInput(input: AgentPromptInput): string {
  if (typeof input === "string") {
    return input;
  }
  return input.text ?? "";
}

export function displayMetaForPromptInput(input: AgentPromptInput): string[] {
  if (typeof input === "string") {
    return [];
  }
  const meta: string[] = [];
  if (input.imagePaths?.length) {
    meta.push(`${input.imagePaths.length} image${input.imagePaths.length === 1 ? "" : "s"}`);
  }
  if (input.stagedFileInstructions) {
    meta.push("staged file input");
  }
  return meta;
}

export function displayTextForPromptEnvelope(envelope: PromptEnvelope): string {
  const text = envelope.displayText ?? displayTextForPromptInput(envelope.input);
  return text || envelope.description;
}

export function displayMetaForPromptEnvelope(envelope: PromptEnvelope): string[] {
  return envelope.displayMeta ?? displayMetaForPromptInput(envelope.input);
}

export function toPromptEnvelope(input: AgentPromptInput, artifactOutDir?: string): PromptEnvelope {
  return {
    input,
    artifactOutDir,
    description: describePromptInput(input),
    displayText: displayTextForPromptInput(input),
    displayMeta: displayMetaForPromptInput(input),
  };
}

export function createCorrelationId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

export function ensurePromptCorrelationId<T extends PromptEnvelope>(prompt: T): T & { correlationId: string } {
  const existing = prompt.correlationId?.trim();
  if (existing) {
    return { ...prompt, correlationId: existing };
  }
  return { ...prompt, correlationId: createCorrelationId() };
}

function createQueueId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

function isPromptEnvelope(value: unknown): value is PromptEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as PromptEnvelope;
  return isCodexPromptInput(candidate.input) &&
    typeof candidate.description === "string" &&
    (candidate.displayText === undefined || typeof candidate.displayText === "string") &&
    (candidate.displayMeta === undefined ||
      (Array.isArray(candidate.displayMeta) && candidate.displayMeta.every((item) => typeof item === "string"))) &&
    (candidate.correlationId === undefined || typeof candidate.correlationId === "string");
}

function isQueuedPrompt(value: unknown): value is QueuedPrompt {
  return isPromptEnvelope(value) &&
    typeof (value as QueuedPrompt).id === "string" &&
    typeof (value as QueuedPrompt).contextKey === "string" &&
    typeof (value as QueuedPrompt).createdAt === "number" &&
    ((value as QueuedPrompt).notBefore === undefined || typeof (value as QueuedPrompt).notBefore === "number") &&
    ((value as QueuedPrompt).updatedAt === undefined || typeof (value as QueuedPrompt).updatedAt === "number") &&
    ((value as QueuedPrompt).attempts === undefined || typeof (value as QueuedPrompt).attempts === "number") &&
    ((value as QueuedPrompt).lastError === undefined || typeof (value as QueuedPrompt).lastError === "string");
}

function isCodexPromptInput(value: unknown): value is AgentPromptInput {
  if (typeof value === "string") {
    return true;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { text?: unknown; imagePaths?: unknown; stagedFileInstructions?: unknown };
  return (
    (candidate.text === undefined || typeof candidate.text === "string") &&
    (candidate.stagedFileInstructions === undefined || typeof candidate.stagedFileInstructions === "string") &&
    (candidate.imagePaths === undefined ||
      (Array.isArray(candidate.imagePaths) && candidate.imagePaths.every((item) => typeof item === "string")))
  );
}

function trimDescription(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= 80 ? singleLine : `${singleLine.slice(0, 79)}…`;
}
