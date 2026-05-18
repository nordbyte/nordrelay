export interface AdaptiveExternalMonitorOptions {
  baseMs: number;
  run: () => Promise<boolean>;
}

export interface AdaptiveExternalMonitorHandle {
  close(): void;
}

export function startAdaptiveExternalMonitor(options: AdaptiveExternalMonitorOptions): AdaptiveExternalMonitorHandle {
  let closed = false;
  let idleTicks = 0;
  let timer: NodeJS.Timeout | undefined;
  const schedule = (delayMs: number) => {
    timer = setTimeout(async () => {
      try {
        const active = await options.run();
        idleTicks = active ? 0 : Math.min(idleTicks + 1, 4);
      } catch {
        idleTicks = Math.min(idleTicks + 1, 4);
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
    close() {
      closed = true;
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
