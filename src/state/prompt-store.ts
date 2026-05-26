import { randomUUID } from "node:crypto";
import type { AgentPromptInput } from "../agents/shared/agent.js";
import type { StagedFile } from "../artifacts/attachments.js";
import type { ChannelContextKey } from "../channels/shared/context-key.js";
import { createDocumentStore, type DocumentStore, type StateBackendKind } from "./state-backend.js";
import type { WebActivityActor, WebChatAttachment } from "../web/web-state.js";

export interface PromptEnvelope {
  input: AgentPromptInput;
  description: string;
  displayText?: string;
  displayMeta?: string[];
  attachments?: WebChatAttachment[];
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

export interface QueueDrainLock {
  owner: string;
  acquiredAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface PersistedPromptStore {
  lastPrompts: Record<ChannelContextKey, PromptEnvelope>;
  queues: Record<ChannelContextKey, QueuedPrompt[]>;
  pausedContexts?: ChannelContextKey[];
  drainLocks?: Record<ChannelContextKey, QueueDrainLock>;
}

interface PromptStoreState {
  lastPrompts: Map<ChannelContextKey, PromptEnvelope>;
  queues: Map<ChannelContextKey, QueuedPrompt[]>;
  pausedContexts: Set<ChannelContextKey>;
  drainLocks: Map<ChannelContextKey, QueueDrainLock>;
}

export class PromptStore {
  private readonly store: DocumentStore<PersistedPromptStore>;
  private lastPrompts = new Map<ChannelContextKey, PromptEnvelope>();
  private queues = new Map<ChannelContextKey, QueuedPrompt[]>();
  private pausedContexts = new Set<ChannelContextKey>();
  private drainLocks = new Map<ChannelContextKey, QueueDrainLock>();

  constructor(workspace: string, backend: StateBackendKind = "json") {
    this.store = createDocumentStore<PersistedPromptStore>({
      workspace,
      fileName: "prompts.json",
      sqliteKey: "prompts",
      backend,
    });
    this.refresh();
  }

  setLastPrompt(contextKey: ChannelContextKey, prompt: PromptEnvelope): void {
    this.updateState((state) => {
      state.lastPrompts.set(contextKey, prompt);
    });
  }

  getLastPrompt(contextKey: ChannelContextKey): PromptEnvelope | undefined {
    this.refresh();
    return this.lastPrompts.get(contextKey);
  }

  enqueue(contextKey: ChannelContextKey, prompt: PromptEnvelope, options: { notBefore?: number } = {}): QueuedPrompt {
    return this.updateState((state) => {
      const item: QueuedPrompt = {
        ...prompt,
        id: createQueueId(),
        contextKey,
        createdAt: Date.now(),
        notBefore: options.notBefore,
      };
      const queue = state.queues.get(contextKey) ?? [];
      queue.push(item);
      state.queues.set(contextKey, queue);
      return item;
    });
  }

  enqueueFront(contextKey: ChannelContextKey, prompt: QueuedPrompt): void {
    this.updateState((state) => {
      const queue = (state.queues.get(contextKey) ?? []).filter((item) => item.id !== prompt.id);
      queue.unshift({ ...prompt, updatedAt: Date.now() });
      state.queues.set(contextKey, queue);
    });
  }

  dequeue(contextKey: ChannelContextKey): QueuedPrompt | undefined {
    return this.updateState((state) => {
      const queue = state.queues.get(contextKey);
      if (!queue || queue.length === 0) {
        return undefined;
      }
      const now = Date.now();
      const index = queue.findIndex((queued) => !queued.notBefore || queued.notBefore <= now);
      if (index === -1) {
        return undefined;
      }
      const [item] = queue.splice(index, 1);
      if (queue.length === 0) {
        state.queues.delete(contextKey);
      }
      if (item) {
        item.attempts = (item.attempts ?? 0) + 1;
        item.updatedAt = Date.now();
      }
      return item;
    });
  }

  list(contextKey: ChannelContextKey): QueuedPrompt[] {
    this.refresh();
    return [...(this.queues.get(contextKey) ?? [])];
  }

  get(contextKey: ChannelContextKey, id: string): QueuedPrompt | undefined {
    this.refresh();
    return this.queues.get(contextKey)?.find((item) => item.id === id);
  }

  nextRunnableAt(contextKey: ChannelContextKey): number | null {
    this.refresh();
    const timestamps = (this.queues.get(contextKey) ?? [])
      .map((item) => item.notBefore)
      .filter((value): value is number => typeof value === "number")
      .sort((left, right) => left - right);
    return timestamps[0] ?? null;
  }

  listContextKeys(): ChannelContextKey[] {
    this.refresh();
    return [...new Set([...this.queues.keys(), ...this.pausedContexts])];
  }

  remove(contextKey: ChannelContextKey, id: string): QueuedPrompt | undefined {
    return this.updateState((state) => {
      const queue = state.queues.get(contextKey);
      if (!queue) {
        return undefined;
      }

      const index = queue.findIndex((item) => item.id === id);
      if (index === -1) {
        return undefined;
      }

      const [removed] = queue.splice(index, 1);
      if (queue.length === 0) {
        state.queues.delete(contextKey);
      }
      return removed;
    });
  }

  moveToTop(contextKey: ChannelContextKey, id: string): QueuedPrompt | undefined {
    return this.updateState((state) => {
      const queue = state.queues.get(contextKey);
      if (!queue) {
        return undefined;
      }

      const index = queue.findIndex((item) => item.id === id);
      if (index === -1) {
        return undefined;
      }

      const [item] = queue.splice(index, 1);
      item.updatedAt = Date.now();
      queue.unshift(item);
      return item;
    });
  }

  moveUp(contextKey: ChannelContextKey, id: string): QueuedPrompt | undefined {
    return this.updateState((state) => {
      const queue = state.queues.get(contextKey);
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
      return item;
    });
  }

  moveDown(contextKey: ChannelContextKey, id: string): QueuedPrompt | undefined {
    return this.updateState((state) => {
      const queue = state.queues.get(contextKey);
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
      return item;
    });
  }

  markFailed(contextKey: ChannelContextKey, item: QueuedPrompt, error: string): void {
    this.updateState((state) => {
      const queue = (state.queues.get(contextKey) ?? []).filter((queued) => queued.id !== item.id);
      queue.unshift({ ...item, lastError: error, updatedAt: Date.now() });
      state.queues.set(contextKey, queue);
    });
  }

  clear(contextKey: ChannelContextKey): number {
    return this.updateState((state) => {
      const count = state.queues.get(contextKey)?.length ?? 0;
      state.queues.delete(contextKey);
      return count;
    });
  }

  pause(contextKey: ChannelContextKey): void {
    this.updateState((state) => {
      state.pausedContexts.add(contextKey);
    });
  }

  resume(contextKey: ChannelContextKey): void {
    this.updateState((state) => {
      state.pausedContexts.delete(contextKey);
    });
  }

  isPaused(contextKey: ChannelContextKey): boolean {
    this.refresh();
    return this.pausedContexts.has(contextKey);
  }

  acquireDrainLock(contextKey: ChannelContextKey, owner: string, ttlMs: number): boolean {
    return this.updateState((state) => {
      const now = Date.now();
      const existing = state.drainLocks.get(contextKey);
      if (existing && existing.owner !== owner && existing.expiresAt > now) {
        return false;
      }
      state.drainLocks.set(contextKey, {
        owner,
        acquiredAt: existing?.owner === owner ? existing.acquiredAt : now,
        updatedAt: now,
        expiresAt: now + Math.max(1_000, ttlMs),
      });
      return true;
    });
  }

  renewDrainLock(contextKey: ChannelContextKey, owner: string, ttlMs: number): boolean {
    return this.updateState((state) => {
      const now = Date.now();
      const existing = state.drainLocks.get(contextKey);
      if (!existing || existing.owner !== owner) {
        return false;
      }
      state.drainLocks.set(contextKey, {
        ...existing,
        updatedAt: now,
        expiresAt: now + Math.max(1_000, ttlMs),
      });
      return true;
    });
  }

  releaseDrainLock(contextKey: ChannelContextKey, owner: string): boolean {
    return this.updateState((state) => {
      const existing = state.drainLocks.get(contextKey);
      if (!existing || existing.owner !== owner) {
        return false;
      }
      state.drainLocks.delete(contextKey);
      return true;
    });
  }

  getDrainLock(contextKey: ChannelContextKey): QueueDrainLock | undefined {
    this.refresh();
    const lock = this.drainLocks.get(contextKey);
    return lock ? { ...lock } : undefined;
  }

  private updateState<TResult>(mutator: (state: PromptStoreState) => TResult): TResult {
    let result: TResult;
    try {
      const payload = this.store.update((current) => {
        const state = stateFromPayload(current);
        result = mutator(state);
        return payloadFromState(state);
      });
      this.applyState(stateFromPayload(payload));
      return result!;
    } catch (error) {
      console.warn("Failed to persist prompt store:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private refresh(): void {
    try {
      this.applyState(stateFromPayload(this.store.read()));
    } catch (error) {
      console.warn("Failed to load prompt store:", error instanceof Error ? error.message : String(error));
    }
  }

  private applyState(state: PromptStoreState): void {
    this.lastPrompts = state.lastPrompts;
    this.queues = state.queues;
    this.pausedContexts = state.pausedContexts;
    this.drainLocks = state.drainLocks;
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

export function webChatAttachmentsForStagedFiles(files: readonly StagedFile[], turnId: string): WebChatAttachment[] {
  return files.map((file) => ({
    id: file.safeName,
    kind: attachmentKind(file.mimeType),
    name: file.safeName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    turnId,
  }));
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

function stateFromPayload(payload: PersistedPromptStore | undefined): PromptStoreState {
  const state: PromptStoreState = {
    lastPrompts: new Map(),
    queues: new Map(),
    pausedContexts: new Set(),
    drainLocks: new Map(),
  };
  if (!payload) {
    return state;
  }
  for (const [contextKey, prompt] of Object.entries(payload.lastPrompts ?? {})) {
    if (isPromptEnvelope(prompt)) {
      state.lastPrompts.set(contextKey, prompt);
    }
  }
  for (const [contextKey, queue] of Object.entries(payload.queues ?? {})) {
    if (Array.isArray(queue)) {
      const items = queue.filter(isQueuedPrompt);
      if (items.length > 0) {
        state.queues.set(contextKey, items);
      }
    }
  }
  if (Array.isArray(payload.pausedContexts)) {
    state.pausedContexts = new Set(
      payload.pausedContexts.filter((contextKey): contextKey is string => typeof contextKey === "string"),
    );
  }
  for (const [contextKey, lock] of Object.entries(payload.drainLocks ?? {})) {
    if (isQueueDrainLock(lock)) {
      state.drainLocks.set(contextKey, lock);
    }
  }
  return state;
}

function payloadFromState(state: PromptStoreState): PersistedPromptStore {
  return {
    lastPrompts: Object.fromEntries(state.lastPrompts.entries()),
    queues: Object.fromEntries([...state.queues.entries()].filter(([, queue]) => queue.length > 0)),
    pausedContexts: [...state.pausedContexts],
    drainLocks: Object.fromEntries(state.drainLocks.entries()),
  };
}

function isQueueDrainLock(value: unknown): value is QueueDrainLock {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as QueueDrainLock;
  return typeof candidate.owner === "string" &&
    typeof candidate.acquiredAt === "number" &&
    typeof candidate.updatedAt === "number" &&
    typeof candidate.expiresAt === "number";
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
    (candidate.attachments === undefined ||
      (Array.isArray(candidate.attachments) && candidate.attachments.every(isWebChatAttachmentLike))) &&
    (candidate.correlationId === undefined || typeof candidate.correlationId === "string");
}

function isWebChatAttachmentLike(value: unknown): value is WebChatAttachment {
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

function attachmentKind(mimeType: string): WebChatAttachment["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}
