import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import type { AgentPromptInput } from "./agent.js";
import type { TelegramContextKey } from "./context-key.js";
import { readJsonFileWithBackup, writeJsonFileAtomic } from "./persistence.js";

export interface PromptEnvelope {
  input: AgentPromptInput;
  description: string;
  artifactOutDir?: string;
}

export interface QueuedPrompt extends PromptEnvelope {
  id: string;
  contextKey: TelegramContextKey;
  createdAt: number;
  updatedAt?: number;
  attempts?: number;
  lastError?: string;
}

interface PersistedPromptStore {
  lastPrompts: Record<TelegramContextKey, PromptEnvelope>;
  queues: Record<TelegramContextKey, QueuedPrompt[]>;
  pausedContexts?: TelegramContextKey[];
}

export class PromptStore {
  private readonly persistPath: string;
  private lastPrompts = new Map<TelegramContextKey, PromptEnvelope>();
  private queues = new Map<TelegramContextKey, QueuedPrompt[]>();
  private pausedContexts = new Set<TelegramContextKey>();

  constructor(workspace: string) {
    this.persistPath = path.join(workspace, ".nordrelay", "prompts.json");
    this.load();
  }

  setLastPrompt(contextKey: TelegramContextKey, prompt: PromptEnvelope): void {
    this.lastPrompts.set(contextKey, prompt);
    this.persist();
  }

  getLastPrompt(contextKey: TelegramContextKey): PromptEnvelope | undefined {
    return this.lastPrompts.get(contextKey);
  }

  enqueue(contextKey: TelegramContextKey, prompt: PromptEnvelope): QueuedPrompt {
    const item: QueuedPrompt = {
      ...prompt,
      id: createQueueId(),
      contextKey,
      createdAt: Date.now(),
    };
    const queue = this.queues.get(contextKey) ?? [];
    queue.push(item);
    this.queues.set(contextKey, queue);
    this.persist();
    return item;
  }

  enqueueFront(contextKey: TelegramContextKey, prompt: QueuedPrompt): void {
    const queue = this.queues.get(contextKey) ?? [];
    queue.unshift(prompt);
    this.queues.set(contextKey, queue);
    this.persist();
  }

  dequeue(contextKey: TelegramContextKey): QueuedPrompt | undefined {
    const queue = this.queues.get(contextKey);
    const item = queue?.shift();
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

  list(contextKey: TelegramContextKey): QueuedPrompt[] {
    return [...(this.queues.get(contextKey) ?? [])];
  }

  listContextKeys(): TelegramContextKey[] {
    return [...new Set([...this.queues.keys(), ...this.pausedContexts])];
  }

  remove(contextKey: TelegramContextKey, id: string): QueuedPrompt | undefined {
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

  moveToTop(contextKey: TelegramContextKey, id: string): QueuedPrompt | undefined {
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

  moveUp(contextKey: TelegramContextKey, id: string): QueuedPrompt | undefined {
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

  moveDown(contextKey: TelegramContextKey, id: string): QueuedPrompt | undefined {
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

  markFailed(contextKey: TelegramContextKey, item: QueuedPrompt, error: string): void {
    item.lastError = error;
    item.updatedAt = Date.now();
    this.enqueueFront(contextKey, item);
  }

  clear(contextKey: TelegramContextKey): number {
    const count = this.queues.get(contextKey)?.length ?? 0;
    this.queues.delete(contextKey);
    this.persist();
    return count;
  }

  pause(contextKey: TelegramContextKey): void {
    this.pausedContexts.add(contextKey);
    this.persist();
  }

  resume(contextKey: TelegramContextKey): void {
    this.pausedContexts.delete(contextKey);
    this.persist();
  }

  isPaused(contextKey: TelegramContextKey): boolean {
    return this.pausedContexts.has(contextKey);
  }

  private persist(): void {
    try {
      mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const payload: PersistedPromptStore = {
        lastPrompts: Object.fromEntries(this.lastPrompts.entries()),
        queues: Object.fromEntries(this.queues.entries()),
        pausedContexts: [...this.pausedContexts],
      };
      writeJsonFileAtomic(this.persistPath, payload);
    } catch (error) {
      console.warn("Failed to persist prompt store:", error instanceof Error ? error.message : String(error));
    }
  }

  private load(): void {
    try {
      const payload = readJsonFileWithBackup<Partial<PersistedPromptStore>>(this.persistPath).value;
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

export function toPromptEnvelope(input: AgentPromptInput, artifactOutDir?: string): PromptEnvelope {
  return {
    input,
    artifactOutDir,
    description: describePromptInput(input),
  };
}

function createQueueId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

function isPromptEnvelope(value: unknown): value is PromptEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as PromptEnvelope;
  return isCodexPromptInput(candidate.input) && typeof candidate.description === "string";
}

function isQueuedPrompt(value: unknown): value is QueuedPrompt {
  return isPromptEnvelope(value) &&
    typeof (value as QueuedPrompt).id === "string" &&
    typeof (value as QueuedPrompt).contextKey === "string" &&
    typeof (value as QueuedPrompt).createdAt === "number" &&
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
