export interface WebApiMetricSample {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  at: string;
}

export interface WebApiRouteMetric {
  method: string;
  path: string;
  count: number;
  averageMs: number;
  maxMs: number;
  lastMs: number;
  lastStatusCode: number;
  lastAt: string;
}

export interface WebApiPerformanceMetrics {
  recent: WebApiMetricSample[];
  slowest: WebApiMetricSample[];
  routes: WebApiRouteMetric[];
}

const recent: WebApiMetricSample[] = [];
const routeMetrics = new Map<string, WebApiRouteMetric & { totalMs: number }>();
const MAX_RECENT = 200;

export function recordWebApiMetric(sample: Omit<WebApiMetricSample, "at"> & { at?: string }): void {
  const next: WebApiMetricSample = {
    ...sample,
    durationMs: Math.max(0, Math.round(sample.durationMs)),
    at: sample.at ?? new Date().toISOString(),
  };
  recent.push(next);
  if (recent.length > MAX_RECENT) {
    recent.splice(0, recent.length - MAX_RECENT);
  }
  const key = `${next.method} ${routeKey(next.path)}`;
  const existing = routeMetrics.get(key);
  if (!existing) {
    routeMetrics.set(key, {
      method: next.method,
      path: routeKey(next.path),
      count: 1,
      averageMs: next.durationMs,
      maxMs: next.durationMs,
      lastMs: next.durationMs,
      lastStatusCode: next.statusCode,
      lastAt: next.at,
      totalMs: next.durationMs,
    });
    return;
  }
  existing.count += 1;
  existing.totalMs += next.durationMs;
  existing.averageMs = Math.round(existing.totalMs / existing.count);
  existing.maxMs = Math.max(existing.maxMs, next.durationMs);
  existing.lastMs = next.durationMs;
  existing.lastStatusCode = next.statusCode;
  existing.lastAt = next.at;
}

export function getWebApiPerformanceMetrics(): WebApiPerformanceMetrics {
  return {
    recent: [...recent].reverse().slice(0, 25),
    slowest: [...recent].sort((left, right) => right.durationMs - left.durationMs).slice(0, 10),
    routes: [...routeMetrics.values()]
      .map(({ totalMs: _totalMs, ...metric }) => ({ ...metric }))
      .sort((left, right) => right.averageMs - left.averageMs)
      .slice(0, 25),
  };
}

function routeKey(path: string): string {
  return path
    .replace(/\/api\/peers\/[^/]+\/proxy$/, "/api/peers/:id/proxy")
    .replace(/\/api\/peers\/[^/]+\/events$/, "/api/peers/:id/events")
    .replace(/\/api\/peers\/[^/]+\/health$/, "/api/peers/:id/health")
    .replace(/\/api\/peers\/[^/]+\/repin$/, "/api/peers/:id/repin")
    .replace(/\/api\/agent-update\/[^/]+\/(log|input|cancel)$/, "/api/agent-update/:id/$1")
    .replace(/\/api\/jobs\/[^/]+\/(log|action)$/, "/api/jobs/:id/$1")
    .replace(/\/api\/users\/[^/]+\/sessions\/[^/]+$/, "/api/users/:id/sessions/:sessionId")
    .replace(/\/api\/users\/[^/]+\/(password|telegram|discord|slack|sessions)$/, "/api/users/:id/$1")
    .replace(/\/api\/peers\/discovery-jobs\/[^/]+\/(cancel|log)$/, "/api/peers/discovery-jobs/:id/$1")
    .replace(/\/api\/peers\/discovery-jobs\/[^/]+$/, "/api/peers/discovery-jobs/:id");
}
