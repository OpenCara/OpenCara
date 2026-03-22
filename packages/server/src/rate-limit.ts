/**
 * In-memory token bucket rate limiter for Cloudflare Workers.
 *
 * Uses a simple token bucket algorithm: each client gets a bucket of tokens
 * that refills at a fixed rate. Each request consumes one token. When the
 * bucket is empty, requests are rejected with 429.
 *
 * Limitations (acceptable for this use case):
 * - State is per-isolate — not shared across isolates or after recycles.
 *   This means rate limits are best-effort, not strict guarantees.
 * - Sufficient to prevent accidental floods from misconfigured agents
 *   and provide back-pressure to well-behaved clients.
 */

export interface RateLimitConfig {
  /** Maximum tokens in the bucket (burst size). */
  maxTokens: number;
  /** Tokens added per second (sustained rate). */
  refillRate: number;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

/** Cleanup runs at most once per this interval (ms). */
const CLEANUP_INTERVAL_MS = 60_000;

export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly config: RateLimitConfig;
  private lastCleanup = 0;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  /**
   * Check if a request is allowed. Returns the number of seconds to wait
   * if rate-limited, or 0 if allowed.
   */
  check(key: string): number {
    const now = Date.now();

    // Periodic cleanup to prevent unbounded memory growth
    if (now - this.lastCleanup > CLEANUP_INTERVAL_MS) {
      this.lastCleanup = now;
      this.cleanup();
    }

    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.config.maxTokens, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(
      this.config.maxTokens,
      bucket.tokens + elapsed * this.config.refillRate,
    );
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }

    // Calculate how long until a token is available
    const deficit = 1 - bucket.tokens;
    return Math.ceil(deficit / this.config.refillRate);
  }

  /** Remove stale entries to prevent unbounded memory growth. */
  cleanup(maxAgeMs: number = 300_000): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > maxAgeMs) {
        this.buckets.delete(key);
      }
    }
  }

  /** Reset all state (for testing). */
  reset(): void {
    this.buckets.clear();
    this.lastCleanup = 0;
  }
}

/**
 * Pre-configured rate limiters for the server.
 *
 * Agent rate limiter: keyed by agent_id from JSON body.
 *   - 60 tokens max (burst), refill 0.2/s → ~1 request per 5 seconds sustained
 *
 * Webhook rate limiter: keyed by client IP (CF-Connecting-IP).
 *   - 30 tokens max (burst), refill 2/s → ~2 requests per second sustained
 */
export const agentRateLimiter = new RateLimiter({
  maxTokens: 60,
  refillRate: 0.2,
});

export const webhookRateLimiter = new RateLimiter({
  maxTokens: 30,
  refillRate: 2,
});

/** Reset all rate limiters — for use in tests. */
export function resetRateLimiters(): void {
  agentRateLimiter.reset();
  webhookRateLimiter.reset();
}
