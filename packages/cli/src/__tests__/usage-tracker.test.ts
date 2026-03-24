import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UsageTracker, type DailyUsage, type UsageData } from '../usage-tracker.js';
import type { UsageLimits } from '../config.js';

function tmpUsageFile(): string {
  return path.join(
    os.tmpdir(),
    `opencara-usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

const NO_LIMITS: UsageLimits = {
  maxReviewsPerDay: null,
  maxTokensPerDay: null,
  maxTokensPerReview: null,
};

describe('UsageTracker', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpUsageFile();
  });

  afterEach(() => {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  });

  describe('initialization', () => {
    it('creates empty data when file does not exist', () => {
      const tracker = new UsageTracker(filePath);
      expect(tracker.getData().days).toEqual([]);
    });

    it('loads existing data from file', () => {
      const existing: UsageData = {
        days: [
          { date: '2026-03-22', reviews: 5, tokens: { input: 1000, output: 500, estimated: 200 } },
        ],
      };
      fs.writeFileSync(filePath, JSON.stringify(existing));
      const tracker = new UsageTracker(filePath);
      expect(tracker.getData().days).toHaveLength(1);
      expect(tracker.getData().days[0].reviews).toBe(5);
    });

    it('handles corrupt JSON gracefully', () => {
      fs.writeFileSync(filePath, 'not valid json');
      const tracker = new UsageTracker(filePath);
      expect(tracker.getData().days).toEqual([]);
    });
  });

  describe('getToday', () => {
    it('creates today entry if missing', () => {
      const tracker = new UsageTracker(filePath);
      const today = tracker.getToday();
      expect(today.date).toBe(todayKey());
      expect(today.reviews).toBe(0);
      expect(today.tokens).toEqual({ input: 0, output: 0, estimated: 0 });
    });

    it('returns existing today entry', () => {
      const existing: UsageData = {
        days: [{ date: todayKey(), reviews: 3, tokens: { input: 100, output: 50, estimated: 0 } }],
      };
      fs.writeFileSync(filePath, JSON.stringify(existing));
      const tracker = new UsageTracker(filePath);
      const today = tracker.getToday();
      expect(today.reviews).toBe(3);
    });
  });

  describe('recordReview', () => {
    it('increments review count and adds actual tokens', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordReview({ input: 500, output: 200, estimated: false });
      const today = tracker.getToday();
      expect(today.reviews).toBe(1);
      expect(today.tokens.input).toBe(500);
      expect(today.tokens.output).toBe(200);
      expect(today.tokens.estimated).toBe(0);
    });

    it('increments estimated tokens when estimated=true', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordReview({ input: 300, output: 100, estimated: true });
      const today = tracker.getToday();
      expect(today.tokens.estimated).toBe(400);
      expect(today.tokens.input).toBe(0);
      expect(today.tokens.output).toBe(0);
    });

    it('persists to file after recording', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordReview({ input: 100, output: 50, estimated: false });
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as UsageData;
      expect(data.days[0].reviews).toBe(1);
    });

    it('accumulates across multiple reviews', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordReview({ input: 100, output: 50, estimated: false });
      tracker.recordReview({ input: 200, output: 100, estimated: false });
      const today = tracker.getToday();
      expect(today.reviews).toBe(2);
      expect(today.tokens.input).toBe(300);
      expect(today.tokens.output).toBe(150);
    });
  });

  describe('checkLimits', () => {
    it('allows when no limits set', () => {
      const tracker = new UsageTracker(filePath);
      const result = tracker.checkLimits(NO_LIMITS);
      expect(result.allowed).toBe(true);
    });

    it('blocks when review limit reached', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordReview({ input: 100, output: 50, estimated: false });
      tracker.recordReview({ input: 100, output: 50, estimated: false });
      const result = tracker.checkLimits({ ...NO_LIMITS, maxReviewsPerDay: 2 });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('review limit');
      }
    });

    it('blocks when token budget exhausted', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordReview({ input: 500, output: 600, estimated: false });
      const result = tracker.checkLimits({ ...NO_LIMITS, maxTokensPerDay: 1000 });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('token budget');
      }
    });

    it('warns at 80% of review limit', () => {
      const tracker = new UsageTracker(filePath);
      for (let i = 0; i < 8; i++) {
        tracker.recordReview({ input: 10, output: 5, estimated: false });
      }
      const result = tracker.checkLimits({ ...NO_LIMITS, maxReviewsPerDay: 10 });
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.warning).toContain('80%');
      }
    });

    it('warns at 80% of token budget', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordReview({ input: 400, output: 400, estimated: false });
      const result = tracker.checkLimits({ ...NO_LIMITS, maxTokensPerDay: 1000 });
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.warning).toContain('80%');
      }
    });

    it('no warning below 80%', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordReview({ input: 100, output: 50, estimated: false });
      const result = tracker.checkLimits({ ...NO_LIMITS, maxReviewsPerDay: 10 });
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.warning).toBeUndefined();
      }
    });
  });

  describe('checkPerReviewLimit', () => {
    it('allows when no limit set', () => {
      const tracker = new UsageTracker(filePath);
      const result = tracker.checkPerReviewLimit(50000, NO_LIMITS);
      expect(result.allowed).toBe(true);
    });

    it('allows when under limit', () => {
      const tracker = new UsageTracker(filePath);
      const result = tracker.checkPerReviewLimit(5000, { ...NO_LIMITS, maxTokensPerReview: 10000 });
      expect(result.allowed).toBe(true);
    });

    it('blocks when over limit', () => {
      const tracker = new UsageTracker(filePath);
      const result = tracker.checkPerReviewLimit(15000, {
        ...NO_LIMITS,
        maxTokensPerReview: 10000,
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('per-review limit');
      }
    });
  });

  describe('history pruning', () => {
    it('keeps only 30 days of history', () => {
      const days: DailyUsage[] = [];
      for (let i = 0; i < 35; i++) {
        const date = new Date(2026, 2, i + 1);
        days.push({
          date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
          reviews: 1,
          tokens: { input: 10, output: 5, estimated: 0 },
        });
      }
      fs.writeFileSync(filePath, JSON.stringify({ days }));
      const tracker = new UsageTracker(filePath);
      // Trigger prune by getting today (which adds a new entry)
      tracker.getToday();
      // Should have at most 30 entries
      expect(tracker.getData().days.length).toBeLessThanOrEqual(30);
    });
  });

  describe('formatSummary', () => {
    it('includes date, reviews, and tokens', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordReview({ input: 500, output: 200, estimated: false });
      const summary = tracker.formatSummary(NO_LIMITS);
      expect(summary).toContain('Usage Summary:');
      expect(summary).toContain(todayKey());
      expect(summary).toContain('Reviews: 1');
      expect(summary).toContain('500');
    });

    it('shows limit info when limits are set', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordReview({ input: 100, output: 50, estimated: false });
      const summary = tracker.formatSummary({
        maxReviewsPerDay: 10,
        maxTokensPerDay: 100000,
        maxTokensPerReview: null,
      });
      expect(summary).toContain('Reviews: 1/10');
      expect(summary).toContain('Remaining');
    });
  });

  describe('persistence across instances', () => {
    it('data survives tracker recreation', () => {
      const tracker1 = new UsageTracker(filePath);
      tracker1.recordReview({ input: 500, output: 200, estimated: false });

      const tracker2 = new UsageTracker(filePath);
      const today = tracker2.getToday();
      expect(today.reviews).toBe(1);
      expect(today.tokens.input).toBe(500);
    });
  });
});
