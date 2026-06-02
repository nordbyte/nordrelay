import type { PromptEnvelope, PromptStore, QueuedPrompt } from "../state/prompt-store.js";
import type { QueueItemDto } from "./relay-runtime-types.js";

export type RelayQueueAction = "pause" | "resume" | "clear" | "cancel" | "top" | "up" | "down" | "run";

export class RelayQueueService {
  constructor(
    private readonly promptStore: PromptStore,
    private readonly contextKey: string,
  ) {}

  list(): QueueItemDto[] {
    return this.rawList().filter(isQueuedPromptWaiting).map(queueItemDto);
  }

  rawList(): QueuedPrompt[] {
    return this.promptStore.list(this.contextKey);
  }

  length(): number {
    return this.rawList().filter(isQueuedPromptWaiting).length;
  }

  isPaused(): boolean {
    return this.promptStore.isPaused(this.contextKey);
  }

  acquireDrainLock(owner: string, ttlMs: number): boolean {
    return this.promptStore.acquireDrainLock(this.contextKey, owner, ttlMs);
  }

  renewDrainLock(owner: string, ttlMs: number): boolean {
    return this.promptStore.renewDrainLock(this.contextKey, owner, ttlMs);
  }

  releaseDrainLock(owner: string): boolean {
    return this.promptStore.releaseDrainLock(this.contextKey, owner);
  }

  enqueue(envelope: PromptEnvelope): QueuedPrompt {
    return this.promptStore.enqueue(this.contextKey, envelope);
  }

  enqueueFront(item: QueuedPrompt): void {
    this.promptStore.enqueueFront(this.contextKey, item);
  }

  dequeue(): QueuedPrompt | undefined {
    return this.promptStore.dequeue(this.contextKey);
  }

  leaseNext(owner: string, ttlMs: number): QueuedPrompt | undefined {
    return this.promptStore.leaseNext(this.contextKey, owner, ttlMs);
  }

  renewLease(item: QueuedPrompt, owner: string, ttlMs: number): boolean {
    return this.promptStore.renewLease(this.contextKey, item, owner, ttlMs);
  }

  completeLease(item: QueuedPrompt, owner: string): QueuedPrompt | undefined {
    return this.promptStore.completeLease(this.contextKey, item, owner);
  }

  failLease(item: QueuedPrompt, owner: string, error: string): QueuedPrompt | undefined {
    return this.promptStore.failLease(this.contextKey, item, owner, error);
  }

  setLastPrompt(envelope: PromptEnvelope): void {
    this.promptStore.setLastPrompt(this.contextKey, envelope);
  }

  getLastPrompt(): PromptEnvelope | undefined {
    return this.promptStore.getLastPrompt(this.contextKey);
  }

  apply(action: RelayQueueAction, id?: string): void {
    if (action === "pause") this.promptStore.pause(this.contextKey);
    if (action === "resume") this.promptStore.resume(this.contextKey);
    if (action === "clear") this.promptStore.clear(this.contextKey);
    if (id && action === "cancel") this.promptStore.remove(this.contextKey, id);
    if (id && action === "top") this.promptStore.moveToTop(this.contextKey, id);
    if (id && action === "up") this.promptStore.moveUp(this.contextKey, id);
    if (id && action === "down") this.promptStore.moveDown(this.contextKey, id);
    if (id && action === "run") {
      const item = this.promptStore.remove(this.contextKey, id);
      if (item) this.promptStore.enqueueFront(this.contextKey, item);
    }
  }
}

export function isQueuedPromptWaiting(item: QueuedPrompt): boolean {
  return (item.status ?? "queued") === "queued";
}

export function queueItemDto(item: QueuedPrompt): QueueItemDto {
  return {
    id: item.id,
    description: item.description,
    status: item.status ?? "queued",
    createdAt: new Date(item.createdAt).toISOString(),
    updatedAt: item.updatedAt ? new Date(item.updatedAt).toISOString() : undefined,
    attempts: item.attempts ?? 0,
    correlationId: item.correlationId,
    idempotencyKey: item.idempotencyKey,
    notBefore: item.notBefore ? new Date(item.notBefore).toISOString() : undefined,
    lastError: item.lastError,
    leaseOwner: item.leaseOwner,
    leaseStartedAt: item.leaseStartedAt ? new Date(item.leaseStartedAt).toISOString() : undefined,
    leaseExpiresAt: item.leaseExpiresAt ? new Date(item.leaseExpiresAt).toISOString() : undefined,
  };
}
