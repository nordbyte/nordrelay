import { getDiscordRateLimitMetrics } from "./discord-rate-limit.js";
import type { UnifiedJobDto } from "./relay-runtime-types.js";
import { getTelegramRateLimitMetrics } from "./telegram-rate-limit.js";
import type { WebActivityEvent } from "./web-state.js";

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
  adapters: {
    telegram: ReturnType<typeof getTelegramRateLimitMetrics>;
    discord: ReturnType<typeof getDiscordRateLimitMetrics>;
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
    adapters: {
      telegram: getTelegramRateLimitMetrics(),
      discord: getDiscordRateLimitMetrics(),
    },
  };
}

function countJobs(jobs: UnifiedJobDto[], status: UnifiedJobDto["status"]): number {
  return jobs.filter((job) => job.status === status).length;
}

function countActivity(events: WebActivityEvent[], status: WebActivityEvent["status"]): number {
  return events.filter((event) => event.category === "prompt" && event.status === status).length;
}
