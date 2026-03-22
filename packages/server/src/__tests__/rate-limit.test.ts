import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, resetRateLimits } from '../middleware/rate-limit.js';

describe('Rate Limiter', () => {
  beforeEach(() => {
    resetRateLimits();
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
      const config = { maxRequests: 1, windowMs: 100 }; // 100ms window
      expect(checkRateLimit('key1', config)).toBeNull();
      expect(checkRateLimit('key1', config)).not.toBeNull();

      // Wait for window to expire (use a real short window)
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(checkRateLimit('key1', config)).toBeNull();
          resolve();
        }, 150);
      });
    });
  });
});
