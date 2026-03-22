import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  RateLimiter,
  agentRateLimiter,
  webhookRateLimiter,
  resetRateLimiters,
} from '../rate-limit.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ maxTokens: 3, refillRate: 1 });
  });

  it('allows requests within the burst limit', () => {
    expect(limiter.check('key-1')).toBe(0);
    expect(limiter.check('key-1')).toBe(0);
    expect(limiter.check('key-1')).toBe(0);
  });

  it('rejects requests exceeding the burst limit', () => {
    limiter.check('key-1');
    limiter.check('key-1');
    limiter.check('key-1');
    const retryAfter = limiter.check('key-1');
    expect(retryAfter).toBeGreaterThan(0);
  });

  it('returns correct Retry-After value', () => {
    // refillRate=1 → 1 token per second
    limiter.check('key-1');
    limiter.check('key-1');
    limiter.check('key-1');
    const retryAfter = limiter.check('key-1');
    expect(retryAfter).toBe(1); // ceil(1 / 1) = 1
  });

  it('tracks keys independently', () => {
    limiter.check('key-1');
    limiter.check('key-1');
    limiter.check('key-1');
    // key-1 is exhausted
    expect(limiter.check('key-1')).toBeGreaterThan(0);
    // key-2 is fresh
    expect(limiter.check('key-2')).toBe(0);
  });

  it('refills tokens over time', () => {
    vi.useFakeTimers();
    try {
      limiter.check('key-1');
      limiter.check('key-1');
      limiter.check('key-1');
      expect(limiter.check('key-1')).toBeGreaterThan(0);

      // Advance 1 second — refillRate=1 → 1 token added
      vi.advanceTimersByTime(1000);
      expect(limiter.check('key-1')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not exceed maxTokens after long idle', () => {
    vi.useFakeTimers();
    try {
      limiter.check('key-1'); // 3 → 2

      // Advance 100 seconds — should refill to maxTokens (3), not 102
      vi.advanceTimersByTime(100_000);

      // Should get exactly maxTokens (3) requests, not more
      expect(limiter.check('key-1')).toBe(0);
      expect(limiter.check('key-1')).toBe(0);
      expect(limiter.check('key-1')).toBe(0);
      expect(limiter.check('key-1')).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleanup removes stale entries', () => {
    vi.useFakeTimers();
    try {
      limiter.check('stale-key');
      vi.advanceTimersByTime(400_000); // 400s, under default 300s maxAge

      // custom maxAge of 300s
      limiter.cleanup(300_000);

      // Should have been cleaned up — next check creates fresh bucket
      expect(limiter.check('stale-key')).toBe(0);
      expect(limiter.check('stale-key')).toBe(0);
      expect(limiter.check('stale-key')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reset clears all state', () => {
    limiter.check('key-1');
    limiter.check('key-1');
    limiter.check('key-1');
    expect(limiter.check('key-1')).toBeGreaterThan(0);

    limiter.reset();
    // All fresh again
    expect(limiter.check('key-1')).toBe(0);
  });
});

describe('pre-configured rate limiters', () => {
  afterEach(() => {
    resetRateLimiters();
  });

  it('agentRateLimiter allows burst of 60 then rejects', () => {
    for (let i = 0; i < 60; i++) {
      expect(agentRateLimiter.check('agent-test')).toBe(0);
    }
    expect(agentRateLimiter.check('agent-test')).toBeGreaterThan(0);
  });

  it('webhookRateLimiter allows burst of 30 then rejects', () => {
    for (let i = 0; i < 30; i++) {
      expect(webhookRateLimiter.check('1.2.3.4')).toBe(0);
    }
    expect(webhookRateLimiter.check('1.2.3.4')).toBeGreaterThan(0);
  });

  it('resetRateLimiters clears both limiters', () => {
    for (let i = 0; i < 60; i++) agentRateLimiter.check('agent-test');
    expect(agentRateLimiter.check('agent-test')).toBeGreaterThan(0);

    resetRateLimiters();
    expect(agentRateLimiter.check('agent-test')).toBe(0);
  });
});
