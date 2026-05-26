import type { RelayRuntimeDelegate } from "./relay-runtime-delegate.js";

const QUEUE_DRAIN_LOCK_TTL_MS = 120_000;
const QUEUE_DRAIN_LOCK_RENEW_MS = 30_000;

export async function withQueueDrainLock(runtime: RelayRuntimeDelegate, task: () => Promise<void>): Promise<boolean> {
  if (!runtime.queueService.acquireDrainLock(runtime.queueDrainOwnerId, QUEUE_DRAIN_LOCK_TTL_MS)) {
    return false;
  }
  const renewTimer = setInterval(() => {
    runtime.queueService.renewDrainLock(runtime.queueDrainOwnerId, QUEUE_DRAIN_LOCK_TTL_MS);
  }, QUEUE_DRAIN_LOCK_RENEW_MS);
  renewTimer.unref?.();
  try {
    await task();
    return true;
  } finally {
    clearInterval(renewTimer);
    runtime.queueService.releaseDrainLock(runtime.queueDrainOwnerId);
  }
}
