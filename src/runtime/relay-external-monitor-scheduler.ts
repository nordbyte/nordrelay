import { getObservabilityRegistry, type ObservedPollerHandle } from "../observability/observability-registry.js";

export interface AdaptiveExternalMonitorOptions {
  baseMs: number;
  run: () => Promise<boolean>;
  id?: string;
  owner?: string;
  kind?: string;
}

export interface AdaptiveExternalMonitorHandle {
  close(): void;
  poller?: ObservedPollerHandle;
}

export function startAdaptiveExternalMonitor(options: AdaptiveExternalMonitorOptions): AdaptiveExternalMonitorHandle {
  let closed = false;
  let idleTicks = 0;
  let timer: NodeJS.Timeout | undefined;
  const poller = getObservabilityRegistry().registerPoller({
    id: options.id ?? "runtime:external-activity-monitor",
    owner: options.owner ?? "runtime",
    kind: options.kind ?? "external-monitor",
    intervalMs: options.baseMs,
    currentDelayMs: options.baseMs,
    nextRunAt: Date.now() + options.baseMs,
  });
  const schedule = (delayMs: number) => {
    poller.update({ currentDelayMs: delayMs, nextRunAt: Date.now() + delayMs });
    timer = setTimeout(async () => {
      const finish = poller.start();
      try {
        const active = await options.run();
        idleTicks = active ? 0 : Math.min(idleTicks + 1, 4);
        finish();
      } catch (error) {
        idleTicks = Math.min(idleTicks + 1, 4);
        finish(error);
      } finally {
        if (!closed) {
          schedule(nextDelay(options.baseMs, idleTicks));
        }
      }
    }, delayMs);
    timer.unref?.();
  };
  schedule(options.baseMs);
  return {
    poller,
    close() {
      closed = true;
      poller.close();
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

function nextDelay(baseMs: number, idleTicks: number): number {
  return idleTicks > 0 ? Math.min(baseMs * (idleTicks + 1), Math.max(baseMs, 20_000)) : baseMs;
}
