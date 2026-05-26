import type { PluginService } from "./plugin-service.js";

interface CollectorRunState {
  key: string;
  nextRunAt: number;
  running: boolean;
  failures: number;
}

export interface PluginCollectorSchedulerOptions {
  refreshMs?: number;
  minIntervalMs?: number;
}

const DEFAULT_REFRESH_MS = 1_000;
const DEFAULT_MIN_INTERVAL_MS = 1_000;

export class PluginCollectorScheduler {
  private readonly states = new Map<string, CollectorRunState>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly service: PluginService,
    private readonly options: PluginCollectorSchedulerOptions = {},
  ) {}

  start(): void {
    if (this.timer || this.stopped) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, this.options.refreshMs ?? DEFAULT_REFRESH_MS);
    this.timer.unref?.();
    void this.tick(true).catch(() => {});
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(initial = false): Promise<void> {
    if (this.stopped || !this.service.isEnabled()) {
      return;
    }
    const catalog = await this.service.catalog();
    const now = Date.now();
    const activeKeys = new Set<string>();
    for (const collector of catalog.collectors) {
      const intervalMs = Math.max(this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS, Number(collector.intervalMs) || 60_000);
      const key = `${collector.pluginId}:${collector.collectorId}`;
      activeKeys.add(key);
      let state = this.states.get(key);
      if (!state) {
        state = {
          key,
          nextRunAt: collector.runOnStart || initial ? 0 : now + intervalMs,
          running: false,
          failures: 0,
        };
        this.states.set(key, state);
      }
      if (state.running || state.nextRunAt > now) {
        continue;
      }
      state.running = true;
      void this.runCollector(collector.pluginId, collector.collectorId, intervalMs, state);
    }
    for (const key of this.states.keys()) {
      if (!activeKeys.has(key)) {
        this.states.delete(key);
      }
    }
  }

  private async runCollector(pluginId: string, collectorId: string, intervalMs: number, state: CollectorRunState): Promise<void> {
    const startedAtMs = Date.now();
    try {
      const result = await this.service.invokeCollector(pluginId, collectorId, {
        scheduled: true,
        startedAt: new Date(startedAtMs).toISOString(),
      });
      state.failures = result.ok ? 0 : state.failures + 1;
    } catch {
      state.failures += 1;
    } finally {
      state.running = false;
      const backoff = state.failures > 0 ? Math.min(intervalMs * 6, intervalMs * 2 ** Math.min(state.failures, 4)) : intervalMs;
      const nextBase = state.failures > 0 ? Date.now() : startedAtMs;
      state.nextRunAt = nextBase + backoff;
    }
  }
}
