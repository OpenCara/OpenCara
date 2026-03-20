import { describe, it, expect } from 'vitest';
import { createSessionTracker, recordSessionUsage, formatPostReviewStats } from '../consumption.js';

describe('consumption', () => {
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
      const output = formatPostReviewStats(session);
      expect(output).toContain('Session:');
      expect(output).toContain('4,521');
      expect(output).toContain('3 reviews');
    });
  });
});
