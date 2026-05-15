import { describe, expect, it } from "vitest";

import { buildRuntimeMetrics } from "../src/metrics.js";
import { recordWebApiMetric } from "../src/web-performance.js";

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
    expect(metrics.process.eventLoop).toHaveProperty("delayP95Ms");
    expect(metrics.web.routes.some((route) => route.path === "/api/version" && route.averageMs >= 42)).toBe(true);
    expect(metrics.web.slowest.some((sample) => sample.path === "/api/version")).toBe(true);
  });
});
