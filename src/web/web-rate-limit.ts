export interface RateLimitBucket {
  count: number;
  resetAt: number;
  blockedUntil?: number;
}

export function consumeRateLimit(
  buckets: Map<string, RateLimitBucket>,
  key: string,
  maxAttempts: number,
  windowMs: number,
  blockMs: number,
  now = Date.now(),
): { limited: boolean; retryAfterMs?: number } {
  const existing = buckets.get(key);
  if (existing?.blockedUntil && existing.blockedUntil > now) {
    return { limited: true, retryAfterMs: existing.blockedUntil - now };
  }
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { limited: false };
  }
  existing.count += 1;
  if (existing.count > maxAttempts) {
    existing.blockedUntil = now + blockMs;
    return { limited: true, retryAfterMs: blockMs };
  }
  return { limited: false };
}

export function rateLimitStatus(
  buckets: Map<string, RateLimitBucket>,
  key: string,
  now = Date.now(),
): { limited: boolean; retryAfterMs?: number } {
  const existing = buckets.get(key);
  if (existing?.blockedUntil && existing.blockedUntil > now) {
    return { limited: true, retryAfterMs: existing.blockedUntil - now };
  }
  return { limited: false };
}

export function resetRateLimit(buckets: Map<string, RateLimitBucket>, key: string): void {
  buckets.delete(key);
}
