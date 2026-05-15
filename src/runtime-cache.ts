export interface RuntimeCacheSnapshot<T> {
  value: T;
  refreshedAt: string;
  stale: boolean;
}

interface RuntimeCacheEntry<T> {
  value?: T;
  refreshedAt: number;
  refresh?: Promise<T>;
}

export class RuntimeSnapshotCache {
  private readonly entries = new Map<string, RuntimeCacheEntry<unknown>>();

  async get<T>(
    key: string,
    ttlMs: number,
    producer: () => Promise<T>,
  ): Promise<RuntimeCacheSnapshot<T>> {
    const now = Date.now();
    const entry = this.entries.get(key) as RuntimeCacheEntry<T> | undefined;
    const hasFreshValue = entry?.value !== undefined && ttlMs > 0 && now - entry.refreshedAt <= ttlMs;
    if (hasFreshValue) {
      return {
        value: entry.value as T,
        refreshedAt: new Date(entry.refreshedAt).toISOString(),
        stale: false,
      };
    }

    if (entry?.value !== undefined) {
      if (!entry.refresh) {
        entry.refresh = producer()
          .then((value) => {
            entry.value = value;
            entry.refreshedAt = Date.now();
            return value;
          })
          .catch(() => entry.value as T)
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

    const pending = entry?.refresh ?? producer();
    this.entries.set(key, { refresh: pending, refreshedAt: now });
    try {
      const value = await pending;
      const refreshedAt = Date.now();
      this.entries.set(key, { value, refreshedAt });
      return {
        value,
        refreshedAt: new Date(refreshedAt).toISOString(),
        stale: false,
      };
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }

  invalidate(key?: string): void {
    if (key) {
      this.entries.delete(key);
      return;
    }
    this.entries.clear();
  }
}
