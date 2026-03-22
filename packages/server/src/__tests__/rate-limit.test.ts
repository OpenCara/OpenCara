import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkRateLimit, resetRateLimits } from '../middleware/rate-limit.js';

describe('Rate Limiter', () => {
  beforeEach(() => {
    resetRateLimits();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('checkRateLimit', () => {
    it('allows requests under the limit', () => {
      const config = { maxRequests: 3, windowMs: 60_000 };
      expect(checkRateLimit('key1', config)).toBeNull();
      expect(checkRateLimit('key1', config)).toBeNull();
      expect(checkRateLimit('key1', config)).toBeNull();
    });

    it('returns Retry-After when limit exceeded', () => {
      const config = { maxRequests: 2, windowMs: 60_000 };
      expect(checkRateLimit('key1', config)).toBeNull();
      expect(checkRateLimit('key1', config)).toBeNull();
      const retryAfter = checkRateLimit('key1', config);
      expect(retryAfter).not.toBeNull();
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
    });

    it('isolates keys independently', () => {
      const config = { maxRequests: 1, windowMs: 60_000 };
      expect(checkRateLimit('key-a', config)).toBeNull();
      expect(checkRateLimit('key-b', config)).toBeNull();
      // key-a is now limited, key-b is still under
      expect(checkRateLimit('key-a', config)).not.toBeNull();
    });

    it('resets after resetRateLimits', () => {
      const config = { maxRequests: 1, windowMs: 60_000 };
      expect(checkRateLimit('key1', config)).toBeNull();
      expect(checkRateLimit('key1', config)).not.toBeNull();
      resetRateLimits();
      expect(checkRateLimit('key1', config)).toBeNull();
    });

    it('allows requests after window expires', () => {
      const config = { maxRequests: 1, windowMs: 1_000 };
      expect(checkRateLimit('key1', config)).toBeNull();
      expect(checkRateLimit('key1', config)).not.toBeNull();

      // Advance past the window
      vi.advanceTimersByTime(1_100);
      expect(checkRateLimit('key1', config)).toBeNull();
    });

    it('rejects new keys when at MAX_TRACKED_KEYS capacity', () => {
      const config = { maxRequests: 100, windowMs: 60_000 };
      // Fill up to capacity (10,000 keys)
      for (let i = 0; i < 10_000; i++) {
        expect(checkRateLimit(`flood-${i}`, config)).toBeNull();
      }
      // New key should be rejected
      const retryAfter = checkRateLimit('new-key', config);
      expect(retryAfter).not.toBeNull();
      expect(retryAfter).toBe(60); // windowMs / 1000
    });
  });
});
