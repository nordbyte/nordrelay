export interface SlackRateLimiterOptions {
  minIntervalMs: number;
  editMinIntervalMs: number;
  typingMinIntervalMs: number;
  maxRetries: number;
}

export interface SlackRateLimitMetrics {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  retries: number;
  rateLimitHits: number;
  lastRateLimitAt?: string;
  lastRetryAfterSeconds?: number;
  buckets: Array<{
    bucket: string;
    queuedUntilMs: number;
    lastRunAtMs: number;
  }>;
}

type BucketState = {
  chain: Promise<void>;
  queuedUntilMs: number;
  lastRunAtMs: number;
};

const DEFAULT_OPTIONS: SlackRateLimiterOptions = {
  minIntervalMs: 250,
  editMinIntervalMs: 1_500,
  typingMinIntervalMs: 4_500,
  maxRetries: 5,
};

export class SlackRateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private queued = 0;
  private running = 0;
  private completed = 0;
  private failed = 0;
  private retries = 0;
  private rateLimitHits = 0;
  private lastRateLimitAt?: string;
  private lastRetryAfterSeconds?: number;

  constructor(private options: SlackRateLimiterOptions = DEFAULT_OPTIONS) {}

  configure(options: Partial<SlackRateLimiterOptions>): void {
    this.options = { ...this.options, ...options };
  }

  async run<T>(bucket: string, method: string, operation: () => Promise<T>): Promise<T> {
    const normalizedBucket = `${method}:${bucket}`;
    const state = this.getBucket(normalizedBucket);
    this.queued += 1;

    let releasePrevious: () => void;
    const previous = state.chain;
    state.chain = new Promise<void>((resolve) => {
      releasePrevious = resolve;
    });

    await previous.catch(() => {});
    this.queued = Math.max(0, this.queued - 1);
    this.running += 1;

    try {
      await this.waitForBucket(state, method);
      const result = await this.runWithRetries(operation);
      this.completed += 1;
      state.lastRunAtMs = Date.now();
      state.queuedUntilMs = Math.max(state.queuedUntilMs, state.lastRunAtMs + this.intervalForMethod(method));
      return result;
    } catch (error) {
      this.failed += 1;
      throw error;
    } finally {
      this.running = Math.max(0, this.running - 1);
      releasePrevious!();
    }
  }

  getMetrics(): SlackRateLimitMetrics {
    return {
      queued: this.queued,
      running: this.running,
      completed: this.completed,
      failed: this.failed,
      retries: this.retries,
      rateLimitHits: this.rateLimitHits,
      lastRateLimitAt: this.lastRateLimitAt,
      lastRetryAfterSeconds: this.lastRetryAfterSeconds,
      buckets: [...this.buckets.entries()]
        .filter(([, state]) => state.queuedUntilMs > Date.now() || state.lastRunAtMs > 0)
        .slice(0, 12)
        .map(([bucket, state]) => ({
          bucket,
          queuedUntilMs: state.queuedUntilMs,
          lastRunAtMs: state.lastRunAtMs,
        })),
    };
  }

  private getBucket(bucket: string): BucketState {
    let state = this.buckets.get(bucket);
    if (!state) {
      state = { chain: Promise.resolve(), queuedUntilMs: 0, lastRunAtMs: 0 };
      this.buckets.set(bucket, state);
    }
    return state;
  }

  private async waitForBucket(state: BucketState, method: string): Promise<void> {
    const interval = this.intervalForMethod(method);
    const now = Date.now();
    const earliest = Math.max(state.queuedUntilMs, state.lastRunAtMs + interval);
    if (earliest > now) {
      await delay(earliest - now);
    }
  }

  private async runWithRetries<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        const retryAfterSeconds = getRetryAfterSeconds(error);
        if (retryAfterSeconds === undefined || attempt >= this.options.maxRetries) {
          throw error;
        }
        attempt += 1;
        this.retries += 1;
        this.rateLimitHits += 1;
        this.lastRateLimitAt = new Date().toISOString();
        this.lastRetryAfterSeconds = retryAfterSeconds;
        await delay((retryAfterSeconds * 1000) + 250);
      }
    }
  }

  private intervalForMethod(method: string): number {
    if (method.startsWith("edit")) return this.options.editMinIntervalMs;
    if (method.startsWith("typing")) return this.options.typingMinIntervalMs;
    return this.options.minIntervalMs;
  }
}

export const slackRateLimiter = new SlackRateLimiter();

export function getSlackRateLimitMetrics(): SlackRateLimitMetrics {
  return slackRateLimiter.getMetrics();
}

function getRetryAfterSeconds(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const candidate = error as { data?: { retryAfter?: number }; retryAfter?: number; headers?: Record<string, string | string[] | undefined> };
  if (typeof candidate.retryAfter === "number") {
    return candidate.retryAfter;
  }
  if (typeof candidate.data?.retryAfter === "number") {
    return candidate.data.retryAfter;
  }
  const header = candidate.headers?.["retry-after"];
  const raw = Array.isArray(header) ? header[0] : header;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
