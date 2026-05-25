import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MetricsHistoryStore } from "../src/state/metrics-history-store.js";
import { buildRuntimeMetrics, runtimeMetricHistorySample, type RuntimeMetricHistorySample } from "../src/runtime/metrics.js";
import { getWebApiPerformanceMetrics, recordWebApiMetric } from "../src/web/web-performance.js";

describe("runtime metrics", () => {
  it("includes process, memory, cpu, and event-loop observability", () => {
    recordWebApiMetric({ method: "GET", path: "/api/version", statusCode: 200, durationMs: 42, at: "2026-05-15T10:00:00.000Z" });
    const metrics = buildRuntimeMetrics({
      queueLength: 2,
      queuePaused: false,
      activeTurnCount: 1,
      jobs: [],
      activity: [],
    });

    expect(metrics.queue).toEqual({ length: 2, paused: false });
    expect(metrics.turns.active).toBe(1);
    expect(metrics.process.pid).toBe(process.pid);
    expect(metrics.process.nodeVersion).toBe(process.version);
    expect(metrics.process.memory.rssBytes).toBeGreaterThan(0);
    expect(metrics.process.cpu.totalMs).toBeGreaterThanOrEqual(0);
    expect(metrics.process.cpu.percentSinceStart === null || metrics.process.cpu.percentSinceStart >= 0).toBe(true);
    expect(metrics.process.cpu.percentSinceLastSample === null || metrics.process.cpu.percentSinceLastSample >= 0).toBe(true);
    expect(metrics.process.eventLoop).toHaveProperty("delayP95Ms");
    expect(metrics.process.eventLoop).toHaveProperty("utilizationPercent");
    expect(metrics.observability.summary.status).toMatch(/^(ok|warn|error)$/);
    expect(metrics.web.routes.some((route) => route.path === "/api/version" && route.averageMs >= 42)).toBe(true);
    expect(metrics.web.slowest.some((sample) => sample.path === "/api/version")).toBe(true);
  });

  it("creates and persists compact history samples", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-metrics-"));
    try {
      const metrics = buildRuntimeMetrics({
        queueLength: 3,
        queuePaused: true,
        activeTurnCount: 2,
        jobs: [{
          id: "job-1",
          kind: "agent-update",
          title: "Update",
          status: "running",
          source: "web",
          threadId: null,
          startedAt: "2026-05-15T10:00:00.000Z",
          updatedAt: "2026-05-15T10:00:01.000Z",
          canCancel: true,
          canRetry: false,
          canReadLog: true,
        }],
        activity: [{ id: "a1", timestamp: "2026-05-15T10:00:00.000Z", source: "web", category: "prompt", status: "failed", type: "prompt_failed", threadId: "thread-1" }],
      });
      const sample = runtimeMetricHistorySample(metrics);
      expect(sample).toEqual(expect.objectContaining({
        at: metrics.generatedAt,
        queueLength: 3,
        queuePaused: true,
        activeTurns: 2,
        failedTurns: 1,
        runningJobs: 1,
      }));

      const store = new MetricsHistoryStore(workspace, "json", 2);
      store.append(makeHistorySample("2026-05-15T10:00:00.000Z", 1));
      store.append(makeHistorySample("2026-05-15T10:02:00.000Z", 3));
      store.append(makeHistorySample("2026-05-15T10:01:00.000Z", 2));

      const restored = new MetricsHistoryStore(workspace, "json", 2);
      expect(restored.list(10).map((item) => item.queueLength)).toEqual([3, 2]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("redacts workflow trigger tokens from web API metrics", () => {
    const secret = "nrt_super_secret_trigger";
    recordWebApiMetric({
      method: "POST",
      path: `/api/workflow-triggers/${secret}/run`,
      statusCode: 202,
      durationMs: 5,
      at: "2026-05-15T10:05:00.000Z",
    });

    const metrics = getWebApiPerformanceMetrics();
    const serialized = JSON.stringify(metrics);

    expect(serialized).not.toContain(secret);
    expect(metrics.recent[0]?.path).toBe("/api/workflow-triggers/:token/run");
    expect(metrics.slowest.some((sample) => sample.path === "/api/workflow-triggers/:token/run")).toBe(true);
    expect(metrics.routes.some((route) => route.path === "/api/workflow-triggers/:token/run")).toBe(true);
  });
});

function makeHistorySample(at: string, queueLength: number): RuntimeMetricHistorySample {
  return {
    at,
    queueLength,
    queuePaused: false,
    activeTurns: 0,
    failedTurns: 0,
    runningJobs: 0,
    failedJobs: 0,
    rssBytes: 1,
    heapUsedBytes: 1,
    cpuPercent: null,
    eventLoopP95Ms: null,
    eventLoopUtilizationPercent: null,
    webAverageMs: null,
    webMaxMs: null,
    rateLimitHits: { telegram: 0, discord: 0, slack: 0, matrix: 0 },
  };
}
