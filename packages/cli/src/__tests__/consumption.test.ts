import { describe, it, expect } from 'vitest';
import {
  checkConsumptionLimits,
  createSessionTracker,
  recordSessionUsage,
  formatPostReviewStats,
} from '../consumption.js';

describe('consumption', () => {
  describe('checkConsumptionLimits', () => {
    it('always returns allowed (consumption tracking removed)', async () => {
      const result = await checkConsumptionLimits('agent-1', null);
      expect(result.allowed).toBe(true);
    });

    it('returns allowed even with limits configured', async () => {
      const result = await checkConsumptionLimits('agent-1', {
        tokens_per_day: 50_000,
        tokens_per_month: 500_000,
        reviews_per_day: 20,
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe('createSessionTracker', () => {
    it('creates tracker with zero values', () => {
      const session = createSessionTracker();
      expect(session.tokens).toBe(0);
      expect(session.reviews).toBe(0);
    });
  });

  describe('recordSessionUsage', () => {
    it('increments tokens and reviews', () => {
      const session = createSessionTracker();
      recordSessionUsage(session, 1000);
      expect(session.tokens).toBe(1000);
      expect(session.reviews).toBe(1);
      recordSessionUsage(session, 500);
      expect(session.tokens).toBe(1500);
      expect(session.reviews).toBe(2);
    });
  });

  describe('formatPostReviewStats', () => {
    it('shows session stats', () => {
      const session = { tokens: 4521, reviews: 3 };
      const output = formatPostReviewStats(1523, session, null);
      expect(output).toContain('Session:');
      expect(output).toContain('4,521');
      expect(output).toContain('3 reviews');
    });

    it('shows session stats even with limits configured', () => {
      const session = { tokens: 4521, reviews: 3 };
      const output = formatPostReviewStats(1523, session, { tokens_per_day: 50_000 });
      expect(output).toContain('Session:');
      expect(output).toContain('4,521');
    });

    it('shows session stats even with daily stats provided', () => {
      const session = { tokens: 4521, reviews: 3 };
      const dailyStats = { tokens: 12_300, reviews: 5 };
      const output = formatPostReviewStats(1523, session, null, dailyStats);
      expect(output).toContain('Session:');
    });
  });
});
