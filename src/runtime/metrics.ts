import { monitorEventLoopDelay } from "node:perf_hooks";

import { getDiscordRateLimitMetrics } from "../channels/discord/discord-rate-limit.js";
import type { UnifiedJobDto } from "./relay-runtime-types.js";
import { getSlackRateLimitMetrics } from "../channels/slack/slack-rate-limit.js";
import { getMatrixRateLimitMetrics } from "../channels/matrix/matrix-rate-limit.js";
import { getTelegramRateLimitMetrics } from "../channels/telegram/telegram-rate-limit.js";
import { getWebApiPerformanceMetrics } from "../web/web-performance.js";
import type { WebActivityEvent } from "../web/web-state.js";

const startedAt = Date.now();
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

export interface RuntimeMetricsDto {
  generatedAt: string;
  queue: {
    length: number;
    paused: boolean;
  };
  turns: {
    active: number;
    completed: number;
    failed: number;
    aborted: number;
    averageDurationMs: number | null;
  };
  jobs: {
    total: number;
    queued: number;
    running: number;
    completed: number;
    failed: number;
    aborted: number;
  };
  process: {
    pid: number;
    nodeVersion: string;
    platform: string;
    arch: string;
    uptimeMs: number;
    startedAt: string;
    memory: {
      rssBytes: number;
      heapTotalBytes: number;
      heapUsedBytes: number;
      externalBytes: number;
      arrayBuffersBytes: number;
    };
    cpu: {
      userMs: number;
      systemMs: number;
      totalMs: number;
      percentSinceStart: number | null;
    };
    eventLoop: {
      delayMeanMs: number | null;
      delayMaxMs: number | null;
      delayP95Ms: number | null;
    };
  };
  adapters: {
    telegram: ReturnType<typeof getTelegramRateLimitMetrics>;
    discord: ReturnType<typeof getDiscordRateLimitMetrics>;
    slack: ReturnType<typeof getSlackRateLimitMetrics>;
    matrix: ReturnType<typeof getMatrixRateLimitMetrics>;
  };
  web: ReturnType<typeof getWebApiPerformanceMetrics>;
}

export interface RuntimeMetricHistorySample {
  at: string;
  queueLength: number;
  queuePaused: boolean;
  activeTurns: number;
  failedTurns: number;
  runningJobs: number;
  failedJobs: number;
  rssBytes: number;
  heapUsedBytes: number;
  cpuPercent: number | null;
  eventLoopP95Ms: number | null;
  webAverageMs: number | null;
  webMaxMs: number | null;
  rateLimitHits: {
    telegram: number;
    discord: number;
    slack: number;
    matrix: number;
  };
}

export function buildRuntimeMetrics(input: {
  queueLength: number;
  queuePaused: boolean;
  activeTurnCount: number;
  jobs: UnifiedJobDto[];
  activity: WebActivityEvent[];
}): RuntimeMetricsDto {
  const completedPromptDurations = input.activity
    .filter((event) => event.category === "prompt" && event.status === "completed" && typeof event.durationMs === "number")
    .map((event) => event.durationMs as number);
  return {
    generatedAt: new Date().toISOString(),
    queue: {
      length: input.queueLength,
      paused: input.queuePaused,
    },
    turns: {
      active: input.activeTurnCount,
      completed: countActivity(input.activity, "completed"),
      failed: countActivity(input.activity, "failed"),
      aborted: countActivity(input.activity, "aborted"),
      averageDurationMs: completedPromptDurations.length
        ? Math.round(completedPromptDurations.reduce((sum, value) => sum + value, 0) / completedPromptDurations.length)
        : null,
    },
    jobs: {
      total: input.jobs.length,
      queued: countJobs(input.jobs, "queued"),
      running: countJobs(input.jobs, "running"),
      completed: countJobs(input.jobs, "completed"),
      failed: countJobs(input.jobs, "failed"),
      aborted: countJobs(input.jobs, "aborted"),
    },
    process: processMetrics(),
    adapters: {
      telegram: getTelegramRateLimitMetrics(),
      discord: getDiscordRateLimitMetrics(),
      slack: getSlackRateLimitMetrics(),
      matrix: getMatrixRateLimitMetrics(),
    },
    web: getWebApiPerformanceMetrics(),
  };
}

export function runtimeMetricHistorySample(metrics: RuntimeMetricsDto): RuntimeMetricHistorySample {
  const webRoutes = metrics.web?.routes ?? [];
  const webAverageMs = webRoutes.length
    ? roundMetric(webRoutes.reduce((sum, route) => sum + Number(route.averageMs || 0), 0) / webRoutes.length)
    : null;
  const webMaxMs = webRoutes.length
    ? Math.max(...webRoutes.map((route) => Number(route.maxMs || 0)))
    : null;
  return {
    at: metrics.generatedAt,
    queueLength: metrics.queue.length,
    queuePaused: metrics.queue.paused,
    activeTurns: metrics.turns.active,
    failedTurns: metrics.turns.failed,
    runningJobs: metrics.jobs.running,
    failedJobs: metrics.jobs.failed,
    rssBytes: metrics.process.memory.rssBytes,
    heapUsedBytes: metrics.process.memory.heapUsedBytes,
    cpuPercent: metrics.process.cpu.percentSinceStart,
    eventLoopP95Ms: metrics.process.eventLoop.delayP95Ms,
    webAverageMs,
    webMaxMs,
    rateLimitHits: {
      telegram: Number(metrics.adapters.telegram?.rateLimitHits ?? 0),
      discord: Number(metrics.adapters.discord?.rateLimitHits ?? 0),
      slack: Number(metrics.adapters.slack?.rateLimitHits ?? 0),
      matrix: Number(metrics.adapters.matrix?.rateLimitHits ?? 0),
    },
  };
}

function processMetrics(): RuntimeMetricsDto["process"] {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const uptimeMs = Math.max(0, Math.round(process.uptime() * 1000));
  const totalMs = Math.round((cpu.user + cpu.system) / 1000);
  return {
    pid: process.pid,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    uptimeMs,
    startedAt: new Date(startedAt).toISOString(),
    memory: {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    },
    cpu: {
      userMs: Math.round(cpu.user / 1000),
      systemMs: Math.round(cpu.system / 1000),
      totalMs,
      percentSinceStart: uptimeMs > 0 ? roundMetric((totalMs / uptimeMs) * 100) : null,
    },
    eventLoop: {
      delayMeanMs: nanosecondsToMilliseconds(eventLoopDelay.mean),
      delayMaxMs: nanosecondsToMilliseconds(eventLoopDelay.max),
      delayP95Ms: nanosecondsToMilliseconds(eventLoopDelay.percentile(95)),
    },
  };
}

function nanosecondsToMilliseconds(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return roundMetric(value / 1_000_000);
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function countJobs(jobs: UnifiedJobDto[], status: UnifiedJobDto["status"]): number {
  return jobs.filter((job) => job.status === status).length;
}

function countActivity(events: WebActivityEvent[], status: WebActivityEvent["status"]): number {
  return events.filter((event) => event.category === "prompt" && event.status === status).length;
}
