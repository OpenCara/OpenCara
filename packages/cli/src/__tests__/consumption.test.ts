import { describe, it, expect } from 'vitest';
import { createSessionTracker, recordSessionUsage, formatPostReviewStats } from '../consumption.js';

describe('consumption', () => {
  describe('createSessionTracker', () => {
    it('creates tracker with zero values', () => {
      const session = createSessionTracker();
      expect(session.tokens).toBe(0);
      expect(session.reviews).toBe(0);
      expect(session.tokenBreakdown).toEqual({ input: 0, output: 0, estimated: 0 });
    });
  });

  describe('recordSessionUsage (legacy number overload)', () => {
    it('increments tokens and reviews', () => {
      const session = createSessionTracker();
      recordSessionUsage(session, 1000);
      expect(session.tokens).toBe(1000);
      expect(session.reviews).toBe(1);
      expect(session.tokenBreakdown.estimated).toBe(1000);
      recordSessionUsage(session, 500);
      expect(session.tokens).toBe(1500);
      expect(session.reviews).toBe(2);
      expect(session.tokenBreakdown.estimated).toBe(1500);
    });
  });

  describe('recordSessionUsage (detailed options)', () => {
    it('tracks actual input/output tokens separately', () => {
      const session = createSessionTracker();
      recordSessionUsage(session, {
        inputTokens: 800,
        outputTokens: 200,
        totalTokens: 1000,
        estimated: false,
      });
      expect(session.tokens).toBe(1000);
      expect(session.reviews).toBe(1);
      expect(session.tokenBreakdown.input).toBe(800);
      expect(session.tokenBreakdown.output).toBe(200);
      expect(session.tokenBreakdown.estimated).toBe(0);
    });

    it('tracks estimated tokens', () => {
      const session = createSessionTracker();
      recordSessionUsage(session, {
        inputTokens: 500,
        outputTokens: 300,
        totalTokens: 800,
        estimated: true,
      });
      expect(session.tokenBreakdown.estimated).toBe(800);
      expect(session.tokenBreakdown.input).toBe(0);
      expect(session.tokenBreakdown.output).toBe(0);
    });
  });

  describe('formatPostReviewStats', () => {
    it('shows session stats', () => {
      const session = {
        tokens: 4521,
        reviews: 3,
        tokenBreakdown: { input: 0, output: 0, estimated: 0 },
      };
      const output = formatPostReviewStats(session);
      expect(output).toContain('Session:');
      expect(output).toContain('4,521');
      expect(output).toContain('3 reviews');
    });

    it('shows breakdown when actual tokens are tracked', () => {
      const session = {
        tokens: 1500,
        reviews: 2,
        tokenBreakdown: { input: 800, output: 500, estimated: 200 },
      };
      const output = formatPostReviewStats(session);
      expect(output).toContain('800 in');
      expect(output).toContain('500 out');
      expect(output).toContain('200 est');
    });
  });
});
