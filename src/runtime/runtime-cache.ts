import { getObservabilityRegistry } from "../observability/observability-registry.js";

export interface RuntimeCacheSnapshot<T> {
  value: T;
  refreshedAt: string;
  stale: boolean;
}

interface RuntimeCacheEntry<T> {
  value?: T;
  refreshedAt: number;
  refresh?: Promise<T>;
  producer?: () => Promise<T>;
}

export class RuntimeSnapshotCache {
  private readonly entries = new Map<string, RuntimeCacheEntry<unknown>>();
  private readonly observability = getObservabilityRegistry();

  register<T>(key: string, producer: () => Promise<T>): void {
    const entry = this.entries.get(key) as RuntimeCacheEntry<T> | undefined;
    if (entry) {
      entry.producer = producer;
      return;
    }
    this.entries.set(key, { producer, refreshedAt: 0 });
  }

  async get<T>(
    key: string,
    ttlMs: number,
    producer?: () => Promise<T>,
  ): Promise<RuntimeCacheSnapshot<T>> {
    if (producer) {
      this.register(key, producer);
    }
    const now = Date.now();
    const entry = this.entries.get(key) as RuntimeCacheEntry<T> | undefined;
    const activeProducer = producer ?? entry?.producer;
    if (!activeProducer) {
      throw new Error(`Runtime cache producer is not registered for ${key}.`);
    }
    const hasFreshValue = entry?.value !== undefined && ttlMs > 0 && now - entry.refreshedAt <= ttlMs;
    if (hasFreshValue) {
      this.observability.recordCacheAccess(key, "fresh", ttlMs);
      return {
        value: entry.value as T,
        refreshedAt: new Date(entry.refreshedAt).toISOString(),
        stale: false,
      };
    }

    if (entry?.value !== undefined) {
      this.observability.recordCacheAccess(key, "stale", ttlMs);
      if (!entry.refresh) {
        const finishRefresh = this.observability.startCacheRefresh(key);
        entry.refresh = Promise.resolve()
          .then(activeProducer)
          .then((value) => {
            entry.value = value;
            entry.refreshedAt = Date.now();
            finishRefresh();
            return value;
          })
          .catch((error) => {
            finishRefresh(error);
            return entry.value as T;
          })
          .finally(() => {
            entry.refresh = undefined;
          });
      }
      return {
        value: entry.value as T,
        refreshedAt: new Date(entry.refreshedAt).toISOString(),
        stale: true,
      };
    }

    this.observability.recordCacheAccess(key, "miss", ttlMs);
    const finishRefresh = entry?.refresh ? undefined : this.observability.startCacheRefresh(key);
    const pending = entry?.refresh ?? Promise.resolve().then(activeProducer);
    this.entries.set(key, { ...entry, producer: activeProducer, refresh: pending, refreshedAt: now });
    try {
      const value = await pending;
      finishRefresh?.();
      const refreshedAt = Date.now();
      this.entries.set(key, { value, refreshedAt, producer: activeProducer });
      return {
        value,
        refreshedAt: new Date(refreshedAt).toISOString(),
        stale: false,
      };
    } catch (error) {
      finishRefresh?.(error);
      this.entries.delete(key);
      throw error;
    }
  }

  refresh<T>(key: string): Promise<RuntimeCacheSnapshot<T>> {
    const entry = this.entries.get(key) as RuntimeCacheEntry<T> | undefined;
    if (!entry?.producer) {
      throw new Error(`Runtime cache producer is not registered for ${key}.`);
    }
    if (!entry.refresh) {
      const finishRefresh = this.observability.startCacheRefresh(key);
      entry.refresh = Promise.resolve()
        .then(entry.producer)
        .then((value) => {
          entry.value = value;
          entry.refreshedAt = Date.now();
          finishRefresh();
          return value;
        })
        .catch((error) => {
          finishRefresh(error);
          throw error;
        })
        .finally(() => {
          entry.refresh = undefined;
        });
    }
    return entry.refresh.then((value) => ({
      value,
      refreshedAt: new Date(entry.refreshedAt).toISOString(),
      stale: false,
    }));
  }

  warm(keys?: readonly string[]): void {
    const targetKeys = keys ?? [...this.entries.keys()];
    for (const key of targetKeys) {
      if (!this.entries.get(key)?.producer) continue;
      this.observability.recordCacheWarm(key);
      void this.refresh(key).catch(() => {
        // Best-effort dashboard warm-up. Foreground requests will surface errors.
      });
    }
  }

  invalidate(key?: string): void {
    this.observability.recordCacheInvalidate(key);
    if (key) {
      const entry = this.entries.get(key);
      if (entry?.producer) {
        this.entries.set(key, { producer: entry.producer, refreshedAt: 0 });
      } else {
        this.entries.delete(key);
      }
      return;
    }
    for (const [entryKey, entry] of this.entries.entries()) {
      if (entry.producer) {
        this.entries.set(entryKey, { producer: entry.producer, refreshedAt: 0 });
      } else {
        this.entries.delete(entryKey);
      }
    }
  }
}
