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
  maxTasksPerDay: null,
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
          { date: '2026-03-22', tasks: 5, tokens: { input: 1000, output: 500, estimated: 200 } },
        ],
      };
      fs.writeFileSync(filePath, JSON.stringify(existing));
      const tracker = new UsageTracker(filePath);
      expect(tracker.getData().days).toHaveLength(1);
      expect(tracker.getData().days[0].tasks).toBe(5);
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
      expect(today.tasks).toBe(0);
      expect(today.tokens).toEqual({ input: 0, output: 0, estimated: 0 });
    });

    it('returns existing today entry', () => {
      const existing: UsageData = {
        days: [{ date: todayKey(), tasks: 3, tokens: { input: 100, output: 50, estimated: 0 } }],
      };
      fs.writeFileSync(filePath, JSON.stringify(existing));
      const tracker = new UsageTracker(filePath);
      const today = tracker.getToday();
      expect(today.tasks).toBe(3);
    });

    it('migrates legacy reviews field to tasks on load', () => {
      const existing: UsageData = {
        days: [
          {
            date: todayKey(),
            reviews: 5,
            tasks: undefined as unknown as number,
            tokens: { input: 10, output: 5, estimated: 0 },
          },
        ],
      };
      fs.writeFileSync(filePath, JSON.stringify(existing));
      const tracker = new UsageTracker(filePath);
      const today = tracker.getToday();
      expect(today.tasks).toBe(5);
    });
  });

  describe('recordTask', () => {
    it('increments task count and adds actual tokens', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordTask({ input: 500, output: 200, estimated: false });
      const today = tracker.getToday();
      expect(today.tasks).toBe(1);
      expect(today.tokens.input).toBe(500);
      expect(today.tokens.output).toBe(200);
      expect(today.tokens.estimated).toBe(0);
    });

    it('increments estimated tokens when estimated=true', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordTask({ input: 300, output: 100, estimated: true });
      const today = tracker.getToday();
      expect(today.tokens.estimated).toBe(400);
      expect(today.tokens.input).toBe(0);
      expect(today.tokens.output).toBe(0);
    });

    it('persists tasks to file after recording', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordTask({ input: 100, output: 50, estimated: false });
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as UsageData;
      expect(data.days[0].tasks).toBe(1);
    });

    it('accumulates across multiple tasks', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordTask({ input: 100, output: 50, estimated: false });
      tracker.recordTask({ input: 200, output: 100, estimated: false });
      const today = tracker.getToday();
      expect(today.tasks).toBe(2);
      expect(today.tokens.input).toBe(300);
      expect(today.tokens.output).toBe(150);
    });

    it('tracks tasks per agent when agentId provided', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordTask({ input: 100, output: 50, estimated: false }, 'claude');
      tracker.recordTask({ input: 200, output: 100, estimated: false }, 'claude');
      tracker.recordTask({ input: 50, output: 25, estimated: false }, 'codex');
      const today = tracker.getToday();
      expect(today.tasks).toBe(3);
      expect(today.tasksByAgent?.['claude']).toBe(2);
      expect(today.tasksByAgent?.['codex']).toBe(1);
    });

    it('global task count increments even when agentId provided', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordTask({ input: 100, output: 50, estimated: false }, 'claude');
      const today = tracker.getToday();
      expect(today.tasks).toBe(1);
    });
  });

  describe('recordReview (deprecated alias)', () => {
    it('still works as deprecated alias for recordTask', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordReview({ input: 100, output: 50, estimated: false });
      const today = tracker.getToday();
      expect(today.tasks).toBe(1);
      expect(today.tokens.input).toBe(100);
    });
  });

  describe('checkLimits', () => {
    it('allows when no limits set', () => {
      const tracker = new UsageTracker(filePath);
      const result = tracker.checkLimits(NO_LIMITS);
      expect(result.allowed).toBe(true);
    });

    it('blocks when task limit reached', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordTask({ input: 100, output: 50, estimated: false });
      tracker.recordTask({ input: 100, output: 50, estimated: false });
      const result = tracker.checkLimits({ ...NO_LIMITS, maxTasksPerDay: 2 });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('task limit');
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

    it('warns at 80% of task limit', () => {
      const tracker = new UsageTracker(filePath);
      for (let i = 0; i < 8; i++) {
        tracker.recordTask({ input: 10, output: 5, estimated: false });
      }
      const result = tracker.checkLimits({ ...NO_LIMITS, maxTasksPerDay: 10 });
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
      tracker.recordTask({ input: 100, output: 50, estimated: false });
      const result = tracker.checkLimits({ ...NO_LIMITS, maxTasksPerDay: 10 });
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.warning).toBeUndefined();
      }
    });

    it('respects per-agent limit override over global', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordTask({ input: 10, output: 5, estimated: false }, 'claude');
      tracker.recordTask({ input: 10, output: 5, estimated: false }, 'claude');
      tracker.recordTask({ input: 10, output: 5, estimated: false }, 'claude');
      // Global limit is 10 (not hit), but per-agent limit is 3 (hit)
      const result = tracker.checkLimits(
        { ...NO_LIMITS, maxTasksPerDay: 10 },
        { maxTasksPerDay: 3 },
        'claude',
      );
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('3/3');
      }
    });

    it('falls back to global limit using aggregate count (not per-agent count)', () => {
      const tracker = new UsageTracker(filePath);
      // 3 tasks from claude, 2 from codex = 5 total
      tracker.recordTask({ input: 10, output: 5, estimated: false }, 'claude');
      tracker.recordTask({ input: 10, output: 5, estimated: false }, 'claude');
      tracker.recordTask({ input: 10, output: 5, estimated: false }, 'claude');
      tracker.recordTask({ input: 10, output: 5, estimated: false }, 'codex');
      tracker.recordTask({ input: 10, output: 5, estimated: false }, 'codex');
      // Global limit is 5 (aggregate hits limit), per-agent claude count is only 3
      // Without per-agent override, should use aggregate (5) not per-agent (3)
      const result = tracker.checkLimits({ ...NO_LIMITS, maxTasksPerDay: 5 }, undefined, 'claude');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('5/5');
      }
    });

    it('per-agent null limit means unlimited (overrides global)', () => {
      const tracker = new UsageTracker(filePath);
      for (let i = 0; i < 20; i++) {
        tracker.recordTask({ input: 10, output: 5, estimated: false }, 'claude');
      }
      // Per-agent null means unlimited, even if global limit is set
      const result = tracker.checkLimits(
        { ...NO_LIMITS, maxTasksPerDay: 5 },
        { maxTasksPerDay: null },
        'claude',
      );
      expect(result.allowed).toBe(true);
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
          tasks: 1,
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
    it('includes date, tasks, and tokens', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordTask({ input: 500, output: 200, estimated: false });
      const summary = tracker.formatSummary(NO_LIMITS);
      expect(summary).toContain('Usage Summary:');
      expect(summary).toContain(todayKey());
      expect(summary).toContain('Tasks: 1');
      expect(summary).toContain('500');
    });

    it('shows limit info when limits are set', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordTask({ input: 100, output: 50, estimated: false });
      const summary = tracker.formatSummary({
        maxTasksPerDay: 10,
        maxTokensPerDay: 100000,
        maxTokensPerReview: null,
      });
      expect(summary).toContain('Tasks: 1/10');
      expect(summary).toContain('Remaining');
    });

    it('shows per-agent task count when agentId provided', () => {
      const tracker = new UsageTracker(filePath);
      tracker.recordTask({ input: 100, output: 50, estimated: false }, 'claude');
      tracker.recordTask({ input: 100, output: 50, estimated: false }, 'claude');
      tracker.recordTask({ input: 100, output: 50, estimated: false }, 'codex');
      const summary = tracker.formatSummary(
        { ...NO_LIMITS, maxTasksPerDay: 5 },
        { maxTasksPerDay: 3 },
        'claude',
      );
      expect(summary).toContain('Tasks: 2/3');
      expect(summary).toContain('Remaining tasks: 1');
    });
  });

  describe('persistence across instances', () => {
    it('data survives tracker recreation', () => {
      const tracker1 = new UsageTracker(filePath);
      tracker1.recordTask({ input: 500, output: 200, estimated: false });

      const tracker2 = new UsageTracker(filePath);
      const today = tracker2.getToday();
      expect(today.tasks).toBe(1);
      expect(today.tokens.input).toBe(500);
    });
  });

  describe('backward compatibility', () => {
    it('loads legacy usage.json with reviews field', () => {
      const legacyData = {
        days: [
          {
            date: '2026-03-30',
            reviews: 7,
            tokens: { input: 500, output: 200, estimated: 0 },
          },
        ],
      };
      fs.writeFileSync(filePath, JSON.stringify(legacyData));
      const tracker = new UsageTracker(filePath);
      const day = tracker.getData().days[0];
      expect(day.reviews).toBe(7);
    });

    it('getToday migrates reviews to tasks for today', () => {
      const legacyData = {
        days: [
          {
            date: todayKey(),
            reviews: 4,
            tokens: { input: 100, output: 50, estimated: 0 },
          },
        ],
      };
      fs.writeFileSync(filePath, JSON.stringify(legacyData));
      const tracker = new UsageTracker(filePath);
      const today = tracker.getToday();
      expect(today.tasks).toBe(4);
    });
  });
});
