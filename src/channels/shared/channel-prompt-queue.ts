import type { AuditEvent } from "../../access/audit-log.js";
import type { PromptStore, PromptEnvelope, QueuedPrompt } from "../../state/prompt-store.js";
import type { ChannelBusyReason } from "./channel-bridge-state.js";
import type { ChannelActivityInput, ChannelAuditInput, ChannelBridgeRequestBase } from "./channel-bridge-controller.js";

export const QUEUE_DRAIN_FOLLOW_UP_DELAY_MS = 500;
export const QUEUE_PROMPT_LEASE_TTL_MS = 30 * 60 * 1000;
const QUEUE_PROMPT_LEASE_RENEW_MS = 60 * 1000;

export async function runLeasedQueuedPrompt(options: {
  renew: () => unknown;
  complete: () => unknown;
  fail: (message: string) => unknown;
  run: () => Promise<unknown>;
  renewMs?: number;
}): Promise<void> {
  const renewTimer = setInterval(() => { options.renew(); }, options.renewMs ?? QUEUE_PROMPT_LEASE_RENEW_MS);
  renewTimer.unref?.();
  try {
    await options.run();
    options.complete();
  } catch (error) {
    options.fail(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    clearInterval(renewTimer);
  }
}

export async function queueChannelPromptIfBusy<Request extends ChannelBridgeRequestBase>(options: {
  request: Request;
  envelope: PromptEnvelope;
  fromQueue?: boolean;
  promptStore: PromptStore;
  busy: ChannelBusyReason<{ agentLabel: string }>;
  actionPrefix: string;
  reply: (request: Request, text: string, options?: { buttons?: Array<Array<{ label: string; action: string }>> }) => Promise<unknown>;
  appendActivity: (request: Request, input: ChannelActivityInput) => unknown;
  audit: (request: Request, input: ChannelAuditInput) => unknown;
}): Promise<boolean> {
  if (!options.busy.busy) {
    return false;
  }
  const item = options.fromQueue && isQueuedPrompt(options.envelope)
    ? options.envelope
    : options.promptStore.enqueue(options.request.contextKey, options.envelope);
  if (options.fromQueue && isQueuedPrompt(options.envelope)) {
    options.promptStore.enqueueFront(options.request.contextKey, options.envelope);
  }
  const position = options.promptStore.list(options.request.contextKey).findIndex((queued) => queued.id === item.id) + 1;
  const text = options.busy.kind === "external"
    ? `Queued prompt ${item.id} at position ${position}. The ${options.busy.agentLabel} session is still active and is processing a previous task.`
    : `Queued prompt ${item.id} at position ${position}.`;
  await options.reply(options.request, text, {
    buttons: [[{ label: "Cancel queued message", action: `${options.actionPrefix}_queue_cancel:${options.request.contextKey}:${item.id}` }]],
  });
  options.appendActivity(options.request, {
    status: "queued",
    type: "prompt_queued",
    prompt: item.description,
    detail: text,
    correlationId: item.correlationId,
  });
  options.audit(options.request, {
    action: "prompt_queued" as AuditEvent["action"],
    status: "ok",
    promptId: item.id,
    correlationId: item.correlationId,
    description: item.description,
  });
  return true;
}

export async function drainOneQueuedChannelPrompt<Request extends ChannelBridgeRequestBase>(options: {
  request: Request;
  promptStore: PromptStore;
  draining: Set<string>;
  isPaused?: (request: Request) => boolean;
  isBusy: (request: Request) => boolean | Promise<boolean>;
  onPaused?: (request: Request, queued: number) => Promise<unknown>;
  onBusy?: (request: Request) => Promise<unknown>;
  onScheduled?: (request: Request, nextRunnableAt: number, queued: number) => Promise<unknown>;
  onProcessing: (request: Request, item: QueuedPrompt, totalBeforeRun: number) => Promise<unknown>;
  runPrompt: (request: Request, item: QueuedPrompt) => Promise<unknown>;
  scheduleNext?: (request: Request) => void;
}): Promise<void> {
  const contextKey = options.request.contextKey;
  if (options.draining.has(contextKey)) {
    return;
  }

  options.draining.add(contextKey);
  let startedPrompt = false;
  try {
    if (options.isPaused?.(options.request)) {
      await options.onPaused?.(options.request, options.promptStore.list(contextKey).length);
      return;
    }

    if (await options.isBusy(options.request)) {
      await options.onBusy?.(options.request);
      return;
    }

    const leaseOwner = `channel:${contextKey}`;
    const next = options.promptStore.leaseNext(contextKey, leaseOwner, QUEUE_PROMPT_LEASE_TTL_MS);
    if (!next) {
      const nextRunnableAt = options.promptStore.nextRunnableAt(contextKey);
      const queued = options.promptStore.list(contextKey).length;
      if (nextRunnableAt && queued > 0) {
        await options.onScheduled?.(options.request, nextRunnableAt, queued);
      }
      return;
    }

    startedPrompt = true;
    const totalBeforeRun = options.promptStore.list(contextKey).length;
    await options.onProcessing(options.request, next, totalBeforeRun);
    await runLeasedQueuedPrompt({
      renew: () => options.promptStore.renewLease(contextKey, next, leaseOwner, QUEUE_PROMPT_LEASE_TTL_MS),
      complete: () => options.promptStore.completeLease(contextKey, next, leaseOwner),
      fail: (message) => options.promptStore.failLease(contextKey, next, leaseOwner, message),
      run: () => options.runPrompt(options.request, next),
    });
  } finally {
    options.draining.delete(contextKey);
  }

  if (
    startedPrompt
    && options.promptStore.list(contextKey).length > 0
    && !options.isPaused?.(options.request)
  ) {
    options.scheduleNext?.(options.request);
  }
}

export function scheduleQueuedDrain(callback: () => void, delayMs = 0): void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
}

function isQueuedPrompt(value: unknown): value is QueuedPrompt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as QueuedPrompt;
  return typeof candidate.id === "string" && typeof candidate.createdAt === "number" && typeof candidate.description === "string";
}
