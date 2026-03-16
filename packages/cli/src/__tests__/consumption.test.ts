import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkConsumptionLimits,
  fetchConsumptionStats,
  createSessionTracker,
  recordSessionUsage,
  formatPostReviewStats,
} from '../consumption.js';
import { ApiClient } from '../http.js';
import type { ConsumptionStatsResponse } from '@opencrust/shared';

function makeStats(overrides?: Partial<ConsumptionStatsResponse>): ConsumptionStatsResponse {
  return {
    agentId: 'agent-1',
    period: {
      last24h: { tokens: 10_000, reviews: 5 },
      last7d: { tokens: 45_000, reviews: 18 },
      last30d: { tokens: 98_000, reviews: 39 },
    },
    totalTokens: 125_000,
    totalReviews: 47,
    ...overrides,
  };
}

describe('consumption', () => {
  describe('fetchConsumptionStats', () => {
    it('calls GET /api/consumption/:agentId', async () => {
      const mockClient = { get: vi.fn().mockResolvedValue(makeStats()) } as unknown as ApiClient;
      const result = await fetchConsumptionStats(mockClient, 'agent-1');
      expect(mockClient.get).toHaveBeenCalledWith('/api/consumption/agent-1');
      expect(result.agentId).toBe('agent-1');
    });

    it('propagates API errors', async () => {
      const mockClient = {
        get: vi.fn().mockRejectedValue(new Error('API error: 500')),
      } as unknown as ApiClient;
      await expect(fetchConsumptionStats(mockClient, 'agent-1')).rejects.toThrow('API error: 500');
    });
  });

  describe('checkConsumptionLimits', () => {
    let mockClient: ApiClient;

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('returns allowed when no limits configured', async () => {
      mockClient = { get: vi.fn() } as unknown as ApiClient;
      const result = await checkConsumptionLimits(mockClient, 'agent-1', null);
      expect(result.allowed).toBe(true);
      expect(mockClient.get).not.toHaveBeenCalled();
    });

    it('returns allowed when under all limits', async () => {
      mockClient = { get: vi.fn().mockResolvedValue(makeStats()) } as unknown as ApiClient;
      const result = await checkConsumptionLimits(mockClient, 'agent-1', {
        tokens_per_day: 50_000,
        tokens_per_month: 500_000,
        reviews_per_day: 20,
      });
      expect(result.allowed).toBe(true);
    });

    it('returns rejected when daily token limit exceeded', async () => {
      mockClient = {
        get: vi.fn().mockResolvedValue(
          makeStats({
            period: {
              last24h: { tokens: 50_000, reviews: 5 },
              last7d: { tokens: 50_000, reviews: 5 },
              last30d: { tokens: 50_000, reviews: 5 },
            },
          }),
        ),
      } as unknown as ApiClient;
      const result = await checkConsumptionLimits(mockClient, 'agent-1', {
        tokens_per_day: 50_000,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Daily token limit reached');
      expect(result.reason).toContain('50,000');
    });

    it('returns rejected when monthly token limit exceeded', async () => {
      mockClient = {
        get: vi.fn().mockResolvedValue(
          makeStats({
            period: {
              last24h: { tokens: 1_000, reviews: 1 },
              last7d: { tokens: 100_000, reviews: 10 },
              last30d: { tokens: 500_000, reviews: 50 },
            },
          }),
        ),
      } as unknown as ApiClient;
      const result = await checkConsumptionLimits(mockClient, 'agent-1', {
        tokens_per_month: 500_000,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Monthly token limit reached');
    });

    it('returns rejected when daily review limit exceeded', async () => {
      mockClient = {
        get: vi.fn().mockResolvedValue(
          makeStats({
            period: {
              last24h: { tokens: 5_000, reviews: 20 },
              last7d: { tokens: 20_000, reviews: 20 },
              last30d: { tokens: 20_000, reviews: 20 },
            },
          }),
        ),
      } as unknown as ApiClient;
      const result = await checkConsumptionLimits(mockClient, 'agent-1', {
        reviews_per_day: 20,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Daily review limit reached');
      expect(result.reason).toContain('20/20');
    });

    it('checks daily token limit before monthly', async () => {
      mockClient = {
        get: vi.fn().mockResolvedValue(
          makeStats({
            period: {
              last24h: { tokens: 50_000, reviews: 5 },
              last7d: { tokens: 50_000, reviews: 5 },
              last30d: { tokens: 500_000, reviews: 50 },
            },
          }),
        ),
      } as unknown as ApiClient;
      const result = await checkConsumptionLimits(mockClient, 'agent-1', {
        tokens_per_day: 50_000,
        tokens_per_month: 500_000,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Daily token limit');
    });

    it('gracefully handles API errors and returns allowed', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockClient = {
        get: vi.fn().mockRejectedValue(new Error('Network error')),
      } as unknown as ApiClient;
      const result = await checkConsumptionLimits(mockClient, 'agent-1', {
        tokens_per_day: 50_000,
      });
      expect(result.allowed).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Could not fetch consumption stats'),
      );
      warnSpy.mockRestore();
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

    it('shows daily stats with budget when limits configured', () => {
      const session = { tokens: 4521, reviews: 3 };
      const limits = { tokens_per_day: 50_000 };
      const dailyStats = { tokens: 12_300, reviews: 5 };
      const output = formatPostReviewStats(1523, session, limits, dailyStats);
      expect(output).toContain('Daily:');
      expect(output).toContain('12,300');
      expect(output).toContain('50,000');
      expect(output).toContain('%');
    });

    it('shows daily stats without budget when no limits', () => {
      const session = { tokens: 4521, reviews: 3 };
      const dailyStats = { tokens: 12_300, reviews: 5 };
      const output = formatPostReviewStats(1523, session, null, dailyStats);
      expect(output).toContain('Daily:');
      expect(output).toContain('12,300');
      expect(output).toContain('5 reviews');
    });

    it('omits daily line when no daily stats', () => {
      const session = { tokens: 4521, reviews: 3 };
      const output = formatPostReviewStats(1523, session, null);
      expect(output).not.toContain('Daily:');
    });
  });
});
