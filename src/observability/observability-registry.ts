export type ObservabilityStatus = "ok" | "warn" | "error";
export type CacheAccessOutcome = "fresh" | "stale" | "miss";

export interface ObservabilityPollerSnapshot {
  id: string;
  owner: string;
  kind: string;
  active: boolean;
  closed: boolean;
  intervalMs?: number;
  currentDelayMs?: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastFinishedAt?: string;
  lastDurationMs?: number;
  runCount: number;
  successCount: number;
  failureCount: number;
  skipCount: number;
  lastError?: string;
  lastSkipReason?: string;
  overdueMs: number;
  status: ObservabilityStatus;
}

export interface ObservabilityCacheSnapshot {
  key: string;
  ttlMs?: number;
  gets: number;
  hitsFresh: number;
  hitsStale: number;
  misses: number;
  hitRatePercent: number | null;
  staleRatePercent: number | null;
  refreshes: number;
  refreshFailures: number;
  invalidations: number;
  warmups: number;
  inFlight: number;
  lastAccessAt?: string;
  lastRefreshAt?: string;
  lastRefreshDurationMs?: number;
  ageMs?: number;
  lastError?: string;
  status: ObservabilityStatus;
}

export interface ObservabilityPeerRoundtripSnapshot {
  peerId: string;
  method: string;
  transport?: string;
  count: number;
  success: number;
  failed: number;
  timeouts: number;
  averageMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  lastMs: number | null;
  lastAt?: string;
  lastStatus: "ok" | "error";
  lastError?: string;
  status: ObservabilityStatus;
}

export interface ObservabilitySseConnectionSnapshot {
  id: string;
  route: string;
  target: string;
  peerId?: string;
  user?: string;
  openedAt: string;
  ageMs: number;
  lastEventAt?: string;
  eventsSent: number;
  bytesSent: number;
  heartbeatCount: number;
}

export interface ObservabilitySseSnapshot {
  active: ObservabilitySseConnectionSnapshot[];
  totals: {
    opened: number;
    closed: number;
    eventsSent: number;
    bytesSent: number;
    heartbeatCount: number;
  };
}

export interface ObservabilitySummary {
  status: ObservabilityStatus;
  pollers: {
    total: number;
    active: number;
    overdue: number;
    failures: number;
  };
  caches: {
    total: number;
    gets: number;
    hitRatePercent: number | null;
    staleRatePercent: number | null;
    inFlight: number;
    refreshFailures: number;
  };
  peers: {
    routes: number;
    failures: number;
    timeouts: number;
    maxP95Ms: number | null;
  };
  sse: {
    active: number;
    opened: number;
  };
}

export interface ObservabilitySnapshot {
  generatedAt: string;
  summary: ObservabilitySummary;
  pollers: ObservabilityPollerSnapshot[];
  caches: ObservabilityCacheSnapshot[];
  peerRoundtrips: ObservabilityPeerRoundtripSnapshot[];
  sse: ObservabilitySseSnapshot;
}

export interface ObservedPollerHandle {
  id: string;
  update(input: { intervalMs?: number; currentDelayMs?: number; nextRunAt?: number }): void;
  start(): (error?: unknown) => void;
  skip(reason?: string): void;
  close(): void;
}

export interface ObservedSseConnection {
  id: string;
  event(bytes?: number): void;
  heartbeat(bytes?: number): void;
  close(): void;
}

interface PollerRecord {
  id: string;
  owner: string;
  kind: string;
  active: boolean;
  closed: boolean;
  intervalMs?: number;
  currentDelayMs?: number;
  nextRunAt?: number;
  lastRunAt?: number;
  lastFinishedAt?: number;
  lastDurationMs?: number;
  runCount: number;
  successCount: number;
  failureCount: number;
  skipCount: number;
  currentStartedAt?: number;
  lastError?: string;
  lastSkipReason?: string;
}

interface CacheRecord {
  key: string;
  ttlMs?: number;
  gets: number;
  hitsFresh: number;
  hitsStale: number;
  misses: number;
  refreshes: number;
  refreshFailures: number;
  invalidations: number;
  warmups: number;
  inFlight: number;
  lastAccessAt?: number;
  lastRefreshAt?: number;
  lastRefreshDurationMs?: number;
  lastError?: string;
}

interface PeerRoundtripRecord {
  peerId: string;
  method: string;
  transport?: string;
  count: number;
  success: number;
  failed: number;
  timeouts: number;
  totalMs: number;
  maxMs: number;
  lastMs?: number;
  lastAt?: number;
  lastStatus: "ok" | "error";
  lastError?: string;
  samples: number[];
}

interface SseConnectionRecord {
  id: string;
  route: string;
  target: string;
  peerId?: string;
  user?: string;
  openedAt: number;
  lastEventAt?: number;
  eventsSent: number;
  bytesSent: number;
  heartbeatCount: number;
}

const MAX_PEER_SAMPLES = 80;
let sseCounter = 0;

export class ObservabilityRegistry {
  private readonly pollers = new Map<string, PollerRecord>();
  private readonly caches = new Map<string, CacheRecord>();
  private readonly peerRoundtrips = new Map<string, PeerRoundtripRecord>();
  private readonly sseConnections = new Map<string, SseConnectionRecord>();
  private readonly sseTotals = {
    opened: 0,
    closed: 0,
    eventsSent: 0,
    bytesSent: 0,
    heartbeatCount: 0,
  };

  registerPoller(input: { id: string; owner: string; kind: string; intervalMs?: number; currentDelayMs?: number; nextRunAt?: number }): ObservedPollerHandle {
    const existing = this.pollers.get(input.id);
    const record: PollerRecord = existing ?? {
      id: input.id,
      owner: input.owner,
      kind: input.kind,
      active: false,
      closed: false,
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      skipCount: 0,
    };
    record.owner = input.owner;
    record.kind = input.kind;
    record.closed = false;
    if (input.intervalMs !== undefined) record.intervalMs = input.intervalMs;
    if (input.currentDelayMs !== undefined) record.currentDelayMs = input.currentDelayMs;
    if (input.nextRunAt !== undefined) record.nextRunAt = input.nextRunAt;
    this.pollers.set(input.id, record);
    return {
      id: input.id,
      update: (update) => {
        if (update.intervalMs !== undefined) record.intervalMs = update.intervalMs;
        if (update.currentDelayMs !== undefined) record.currentDelayMs = update.currentDelayMs;
        if (update.nextRunAt !== undefined) record.nextRunAt = update.nextRunAt;
      },
      start: () => {
        const startedAt = Date.now();
        record.active = true;
        record.currentStartedAt = startedAt;
        record.lastRunAt = startedAt;
        record.runCount += 1;
        let finished = false;
        return (error?: unknown) => {
          if (finished) return;
          finished = true;
          record.active = false;
          record.currentStartedAt = undefined;
          record.lastFinishedAt = Date.now();
          record.lastDurationMs = Math.max(0, record.lastFinishedAt - startedAt);
          if (error) {
            record.failureCount += 1;
            record.lastError = errorText(error);
          } else {
            record.successCount += 1;
            record.lastError = undefined;
          }
        };
      },
      skip: (reason) => {
        record.skipCount += 1;
        record.lastSkipReason = reason;
      },
      close: () => {
        record.closed = true;
        record.active = false;
        record.currentStartedAt = undefined;
      },
    };
  }

  recordCacheAccess(key: string, outcome: CacheAccessOutcome, ttlMs?: number): void {
    const record = this.cacheRecord(key);
    record.ttlMs = ttlMs;
    record.gets += 1;
    record.lastAccessAt = Date.now();
    if (outcome === "fresh") record.hitsFresh += 1;
    else if (outcome === "stale") record.hitsStale += 1;
    else record.misses += 1;
  }

  recordCacheWarm(key: string): void {
    this.cacheRecord(key).warmups += 1;
  }

  recordCacheInvalidate(key?: string): void {
    const now = Date.now();
    if (key) {
      const record = this.cacheRecord(key);
      record.invalidations += 1;
      record.lastAccessAt = now;
      return;
    }
    for (const record of this.caches.values()) {
      record.invalidations += 1;
      record.lastAccessAt = now;
    }
  }

  startCacheRefresh(key: string): (error?: unknown) => void {
    const record = this.cacheRecord(key);
    const startedAt = Date.now();
    record.refreshes += 1;
    record.inFlight += 1;
    let finished = false;
    return (error?: unknown) => {
      if (finished) return;
      finished = true;
      record.inFlight = Math.max(0, record.inFlight - 1);
      record.lastRefreshAt = Date.now();
      record.lastRefreshDurationMs = Math.max(0, record.lastRefreshAt - startedAt);
      if (error) {
        record.refreshFailures += 1;
        record.lastError = errorText(error);
      } else {
        record.lastError = undefined;
      }
    };
  }

  recordPeerRoundtrip(input: {
    peerId: string;
    method: string;
    durationMs: number;
    ok: boolean;
    error?: unknown;
    transport?: string;
  }): void {
    const key = `${input.peerId} ${input.method}`;
    const record = this.peerRoundtrips.get(key) ?? {
      peerId: input.peerId,
      method: input.method,
      transport: input.transport,
      count: 0,
      success: 0,
      failed: 0,
      timeouts: 0,
      totalMs: 0,
      maxMs: 0,
      lastStatus: "ok" as const,
      samples: [],
    };
    const durationMs = Math.max(0, Math.round(input.durationMs));
    record.transport = input.transport ?? record.transport;
    record.count += 1;
    record.totalMs += durationMs;
    record.maxMs = Math.max(record.maxMs, durationMs);
    record.lastMs = durationMs;
    record.lastAt = Date.now();
    record.lastStatus = input.ok ? "ok" : "error";
    if (input.ok) {
      record.success += 1;
      record.lastError = undefined;
    } else {
      record.failed += 1;
      const message = errorText(input.error);
      record.lastError = message;
      if (/timed?\s*out|timeout/i.test(message)) {
        record.timeouts += 1;
      }
    }
    record.samples.push(durationMs);
    if (record.samples.length > MAX_PEER_SAMPLES) {
      record.samples.splice(0, record.samples.length - MAX_PEER_SAMPLES);
    }
    this.peerRoundtrips.set(key, record);
  }

  openSseConnection(input: { route: string; target: string; peerId?: string; user?: string }): ObservedSseConnection {
    const id = `sse-${Date.now().toString(36)}-${(++sseCounter).toString(36)}`;
    const record: SseConnectionRecord = {
      id,
      route: input.route,
      target: input.target,
      peerId: input.peerId,
      user: input.user,
      openedAt: Date.now(),
      eventsSent: 0,
      bytesSent: 0,
      heartbeatCount: 0,
    };
    this.sseConnections.set(id, record);
    this.sseTotals.opened += 1;
    return {
      id,
      event: (bytes = 0) => {
        record.eventsSent += 1;
        record.bytesSent += Math.max(0, Math.round(bytes));
        record.lastEventAt = Date.now();
        this.sseTotals.eventsSent += 1;
        this.sseTotals.bytesSent += Math.max(0, Math.round(bytes));
      },
      heartbeat: (bytes = 0) => {
        record.heartbeatCount += 1;
        record.bytesSent += Math.max(0, Math.round(bytes));
        this.sseTotals.heartbeatCount += 1;
        this.sseTotals.bytesSent += Math.max(0, Math.round(bytes));
      },
      close: () => {
        if (this.sseConnections.delete(id)) {
          this.sseTotals.closed += 1;
        }
      },
    };
  }

  snapshot(): ObservabilitySnapshot {
    const now = Date.now();
    const pollers = [...this.pollers.values()].map((record) => pollerSnapshot(record, now));
    const caches = [...this.caches.values()].map((record) => cacheSnapshot(record, now));
    const peerRoundtrips = [...this.peerRoundtrips.values()].map(peerRoundtripSnapshot);
    const sseActive = [...this.sseConnections.values()].map((record) => sseConnectionSnapshot(record, now));
    return {
      generatedAt: new Date(now).toISOString(),
      summary: summary(pollers, caches, peerRoundtrips, this.sseTotals.opened, sseActive.length),
      pollers: pollers.sort((left, right) => statusRank(right.status) - statusRank(left.status) || right.runCount - left.runCount || left.id.localeCompare(right.id)),
      caches: caches.sort((left, right) => statusRank(right.status) - statusRank(left.status) || right.gets - left.gets || left.key.localeCompare(right.key)),
      peerRoundtrips: peerRoundtrips.sort((left, right) => statusRank(right.status) - statusRank(left.status) || (right.p95Ms ?? 0) - (left.p95Ms ?? 0)),
      sse: {
        active: sseActive.sort((left, right) => right.ageMs - left.ageMs),
        totals: { ...this.sseTotals },
      },
    };
  }

  reset(): void {
    this.pollers.clear();
    this.caches.clear();
    this.peerRoundtrips.clear();
    this.sseConnections.clear();
    this.sseTotals.opened = 0;
    this.sseTotals.closed = 0;
    this.sseTotals.eventsSent = 0;
    this.sseTotals.bytesSent = 0;
    this.sseTotals.heartbeatCount = 0;
  }

  private cacheRecord(key: string): CacheRecord {
    const existing = this.caches.get(key);
    if (existing) return existing;
    const record: CacheRecord = {
      key,
      gets: 0,
      hitsFresh: 0,
      hitsStale: 0,
      misses: 0,
      refreshes: 0,
      refreshFailures: 0,
      invalidations: 0,
      warmups: 0,
      inFlight: 0,
    };
    this.caches.set(key, record);
    return record;
  }
}

const globalRegistry = new ObservabilityRegistry();

export function getObservabilityRegistry(): ObservabilityRegistry {
  return globalRegistry;
}

function pollerSnapshot(record: PollerRecord, now: number): ObservabilityPollerSnapshot {
  const overdueMs = record.nextRunAt && !record.active && !record.closed && record.nextRunAt < now
    ? now - record.nextRunAt
    : 0;
  const status: ObservabilityStatus = record.lastError || record.failureCount > 0 && record.successCount === 0
    ? "error"
    : overdueMs > 5_000
      ? "warn"
      : "ok";
  return {
    id: record.id,
    owner: record.owner,
    kind: record.kind,
    active: record.active,
    closed: record.closed,
    intervalMs: record.intervalMs,
    currentDelayMs: record.currentDelayMs,
    nextRunAt: iso(record.nextRunAt),
    lastRunAt: iso(record.lastRunAt),
    lastFinishedAt: iso(record.lastFinishedAt),
    lastDurationMs: record.lastDurationMs,
    runCount: record.runCount,
    successCount: record.successCount,
    failureCount: record.failureCount,
    skipCount: record.skipCount,
    lastError: record.lastError,
    lastSkipReason: record.lastSkipReason,
    overdueMs,
    status,
  };
}

function cacheSnapshot(record: CacheRecord, now: number): ObservabilityCacheSnapshot {
  const hitCount = record.hitsFresh + record.hitsStale;
  const hitRatePercent = record.gets > 0 ? round((hitCount / record.gets) * 100) : null;
  const staleRatePercent = record.gets > 0 ? round((record.hitsStale / record.gets) * 100) : null;
  const status: ObservabilityStatus = record.lastError
    ? "error"
    : record.inFlight > 0 || record.hitsStale > record.hitsFresh && record.gets > 5
      ? "warn"
      : "ok";
  return {
    key: record.key,
    ttlMs: record.ttlMs,
    gets: record.gets,
    hitsFresh: record.hitsFresh,
    hitsStale: record.hitsStale,
    misses: record.misses,
    hitRatePercent,
    staleRatePercent,
    refreshes: record.refreshes,
    refreshFailures: record.refreshFailures,
    invalidations: record.invalidations,
    warmups: record.warmups,
    inFlight: record.inFlight,
    lastAccessAt: iso(record.lastAccessAt),
    lastRefreshAt: iso(record.lastRefreshAt),
    lastRefreshDurationMs: record.lastRefreshDurationMs,
    ageMs: record.lastRefreshAt ? Math.max(0, now - record.lastRefreshAt) : undefined,
    lastError: record.lastError,
    status,
  };
}

function peerRoundtripSnapshot(record: PeerRoundtripRecord): ObservabilityPeerRoundtripSnapshot {
  const p95Ms = percentile(record.samples, 95);
  const status: ObservabilityStatus = record.lastStatus === "error"
    ? "error"
    : (p95Ms ?? 0) >= 2_000 || record.failed > 0
      ? "warn"
      : "ok";
  return {
    peerId: record.peerId,
    method: record.method,
    transport: record.transport,
    count: record.count,
    success: record.success,
    failed: record.failed,
    timeouts: record.timeouts,
    averageMs: record.count > 0 ? round(record.totalMs / record.count) : null,
    p95Ms,
    maxMs: record.count > 0 ? record.maxMs : null,
    lastMs: record.lastMs ?? null,
    lastAt: iso(record.lastAt),
    lastStatus: record.lastStatus,
    lastError: record.lastError,
    status,
  };
}

function sseConnectionSnapshot(record: SseConnectionRecord, now: number): ObservabilitySseConnectionSnapshot {
  return {
    id: record.id,
    route: record.route,
    target: record.target,
    peerId: record.peerId,
    user: record.user,
    openedAt: new Date(record.openedAt).toISOString(),
    ageMs: Math.max(0, now - record.openedAt),
    lastEventAt: iso(record.lastEventAt),
    eventsSent: record.eventsSent,
    bytesSent: record.bytesSent,
    heartbeatCount: record.heartbeatCount,
  };
}

function summary(
  pollers: ObservabilityPollerSnapshot[],
  caches: ObservabilityCacheSnapshot[],
  peers: ObservabilityPeerRoundtripSnapshot[],
  sseOpened: number,
  activeSse: number,
): ObservabilitySummary {
  const cacheGets = caches.reduce((sum, cache) => sum + cache.gets, 0);
  const cacheFresh = caches.reduce((sum, cache) => sum + cache.hitsFresh, 0);
  const cacheStale = caches.reduce((sum, cache) => sum + cache.hitsStale, 0);
  const failures = peers.reduce((sum, peer) => sum + peer.failed, 0);
  const timeouts = peers.reduce((sum, peer) => sum + peer.timeouts, 0);
  const maxP95Ms = peers.reduce<number | null>((max, peer) => {
    if (peer.p95Ms === null) return max;
    return max === null ? peer.p95Ms : Math.max(max, peer.p95Ms);
  }, null);
  const status: ObservabilityStatus = pollers.some((poller) => poller.status === "error") || caches.some((cache) => cache.status === "error") || peers.some((peer) => peer.status === "error")
    ? "error"
    : pollers.some((poller) => poller.status === "warn") || caches.some((cache) => cache.status === "warn") || peers.some((peer) => peer.status === "warn")
      ? "warn"
      : "ok";
  return {
    status,
    pollers: {
      total: pollers.filter((poller) => !poller.closed).length,
      active: pollers.filter((poller) => poller.active).length,
      overdue: pollers.filter((poller) => poller.overdueMs > 0).length,
      failures: pollers.reduce((sum, poller) => sum + poller.failureCount, 0),
    },
    caches: {
      total: caches.length,
      gets: cacheGets,
      hitRatePercent: cacheGets > 0 ? round(((cacheFresh + cacheStale) / cacheGets) * 100) : null,
      staleRatePercent: cacheGets > 0 ? round((cacheStale / cacheGets) * 100) : null,
      inFlight: caches.reduce((sum, cache) => sum + cache.inFlight, 0),
      refreshFailures: caches.reduce((sum, cache) => sum + cache.refreshFailures, 0),
    },
    peers: {
      routes: peers.length,
      failures,
      timeouts,
      maxP95Ms,
    },
    sse: {
      active: activeSse,
      opened: sseOpened,
    },
  };
}

function percentile(values: number[], percentileValue: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

function statusRank(status: ObservabilityStatus): number {
  return status === "error" ? 2 : status === "warn" ? 1 : 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function iso(value?: number): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

function errorText(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  return String(error);
}
