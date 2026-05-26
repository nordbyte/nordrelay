import type { PromptEnvelope, PromptStore, QueuedPrompt } from "../state/prompt-store.js";
import type { QueueItemDto } from "./relay-runtime-types.js";

export type RelayQueueAction = "pause" | "resume" | "clear" | "cancel" | "top" | "up" | "down" | "run";

export class RelayQueueService {
  constructor(
    private readonly promptStore: PromptStore,
    private readonly contextKey: string,
  ) {}

  list(): QueueItemDto[] {
    return this.rawList().map(queueItemDto);
  }

  rawList(): QueuedPrompt[] {
    return this.promptStore.list(this.contextKey);
  }

  length(): number {
    return this.rawList().length;
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

export function queueItemDto(item: QueuedPrompt): QueueItemDto {
  return {
    id: item.id,
    description: item.description,
    createdAt: new Date(item.createdAt).toISOString(),
    attempts: item.attempts ?? 0,
    correlationId: item.correlationId,
    notBefore: item.notBefore ? new Date(item.notBefore).toISOString() : undefined,
    lastError: item.lastError,
  };
}
