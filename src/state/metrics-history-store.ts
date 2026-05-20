import type { RuntimeMetricHistorySample } from "../runtime/metrics.js";
import { createDocumentStore, type DocumentStore, type StateBackendKind } from "./state-backend.js";

interface PersistedMetricsHistory {
  version: 1;
  samples: RuntimeMetricHistorySample[];
}

const DEFAULT_MAX_SAMPLES = 24 * 60;

export class MetricsHistoryStore {
  private readonly store: DocumentStore<PersistedMetricsHistory>;

  constructor(
    workspace: string,
    backend: StateBackendKind = "json",
    private readonly maxSamples = DEFAULT_MAX_SAMPLES,
  ) {
    this.store = createDocumentStore<PersistedMetricsHistory>({
      workspace,
      backend,
      fileName: "metrics-history.json",
      sqliteKey: "metrics-history",
    });
  }

  list(limit = 240): RuntimeMetricHistorySample[] {
    return this.payload().samples.slice(-Math.max(1, Math.min(this.maxSamples, limit))).reverse();
  }

  append(sample: RuntimeMetricHistorySample): RuntimeMetricHistorySample {
    const payload = this.payload();
    const normalized = normalizeSample(sample);
    payload.samples = [...payload.samples, normalized]
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
      .slice(-this.maxSamples);
    this.store.write(payload);
    return normalized;
  }

  private payload(): PersistedMetricsHistory {
    const payload = this.store.read();
    if (!payload || payload.version !== 1 || !Array.isArray(payload.samples)) {
      return { version: 1, samples: [] };
    }
    return {
      version: 1,
      samples: payload.samples.map(normalizeSample).slice(-this.maxSamples),
    };
  }
}

function normalizeSample(input: RuntimeMetricHistorySample): RuntimeMetricHistorySample {
  return {
    at: validDate(input.at) ?? new Date().toISOString(),
    queueLength: number(input.queueLength),
    queuePaused: Boolean(input.queuePaused),
    activeTurns: number(input.activeTurns),
    failedTurns: number(input.failedTurns),
    runningJobs: number(input.runningJobs),
    failedJobs: number(input.failedJobs),
    rssBytes: number(input.rssBytes),
    heapUsedBytes: number(input.heapUsedBytes),
    cpuPercent: nullableNumber(input.cpuPercent),
    eventLoopP95Ms: nullableNumber(input.eventLoopP95Ms),
    webAverageMs: nullableNumber(input.webAverageMs),
    webMaxMs: nullableNumber(input.webMaxMs),
    rateLimitHits: {
      telegram: number(input.rateLimitHits?.telegram),
      discord: number(input.rateLimitHits?.discord),
      slack: number(input.rateLimitHits?.slack),
    },
  };
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validDate(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}
