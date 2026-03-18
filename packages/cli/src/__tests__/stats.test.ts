import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConsumptionStatsResponse, AgentResponse, AgentStatsResponse } from '@opencara/shared';

const mockGet = vi.hoisted(() => vi.fn());
const mockFetchConsumptionStats = vi.hoisted(() => vi.fn());

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({
    apiKey: 'cr_testkey',
    platformUrl: 'https://test.api.dev',
    limits: null,
    agents: null,
  })),
  requireApiKey: vi.fn((config: { apiKey: string }) => config.apiKey),
}));

vi.mock('../http.js', () => ({
  ApiClient: vi.fn(() => ({ get: mockGet })),
}));

vi.mock('../consumption.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../consumption.js')>();
  return {
    ...actual,
    fetchConsumptionStats: mockFetchConsumptionStats,
  };
});

import {
  formatAgentStats,
  formatTrustTier,
  formatReviewQuality,
  formatConsumption,
  statsCommand,
} from '../commands/stats.js';

function makeAgent(overrides?: Partial<AgentResponse>): AgentResponse {
  return {
    id: 'agent-1',
    model: 'claude-sonnet-4-6',
    tool: 'claude-code',
    status: 'online',
    repoConfig: null,
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeConsumption(overrides?: Partial<ConsumptionStatsResponse>): ConsumptionStatsResponse {
  return {
    agentId: 'agent-1',
    period: {
      last24h: { tokens: 12_300, reviews: 5 },
      last7d: { tokens: 45_200, reviews: 18 },
      last30d: { tokens: 98_100, reviews: 39 },
    },
    totalTokens: 125_430,
    totalReviews: 47,
    ...overrides,
  };
}

function makeAgentStats(overrides?: Partial<AgentStatsResponse>): AgentStatsResponse {
  return {
    agent: {
      id: 'agent-1',
      model: 'claude-sonnet-4-6',
      tool: 'claude-code',
      status: 'online',
      trustTier: {
        tier: 'trusted',
        label: 'Trusted',
        reviewCount: 25,
        positiveRate: 0.88,
        nextTier: 'expert',
        progressToNext: 0.6,
      },
    },
    stats: {
      totalReviews: 25,
      totalSummaries: 8,
      totalRatings: 20,
      thumbsUp: 18,
      thumbsDown: 2,
      tokensUsed: 50_000,
    },
    ...overrides,
  };
}

describe('stats command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('formatTrustTier', () => {
    it('shows trust tier with review count and positive rate', () => {
      const output = formatTrustTier({
        tier: 'trusted',
        label: 'Trusted',
        reviewCount: 25,
        positiveRate: 0.88,
        nextTier: 'expert',
        progressToNext: 0.6,
      });
      expect(output).toContain('Trusted');
      expect(output).toContain('25 reviews');
      expect(output).toContain('88% positive');
    });

    it('shows progress to next tier', () => {
      const output = formatTrustTier({
        tier: 'newcomer',
        label: 'Newcomer',
        reviewCount: 3,
        positiveRate: 0.67,
        nextTier: 'trusted',
        progressToNext: 0.3,
      });
      expect(output).toContain('Progress to Trusted: 30%');
    });

    it('does not show progress when at max tier', () => {
      const output = formatTrustTier({
        tier: 'expert',
        label: 'Expert',
        reviewCount: 100,
        positiveRate: 0.95,
        nextTier: null,
        progressToNext: 1,
      });
      expect(output).toContain('Expert');
      expect(output).not.toContain('Progress to');
    });

    it('capitalizes next tier name', () => {
      const output = formatTrustTier({
        tier: 'trusted',
        label: 'Trusted',
        reviewCount: 25,
        positiveRate: 0.88,
        nextTier: 'expert',
        progressToNext: 0.5,
      });
      expect(output).toContain('Progress to Expert');
    });
  });

  describe('formatReviewQuality', () => {
    it('shows reviews completed and summaries', () => {
      const output = formatReviewQuality({
        totalReviews: 25,
        totalSummaries: 8,
        totalRatings: 20,
        thumbsUp: 18,
        thumbsDown: 2,
        tokensUsed: 50_000,
      });
      expect(output).toContain('25 completed');
      expect(output).toContain('8 summaries');
    });

    it('shows quality percentage', () => {
      const output = formatReviewQuality({
        totalReviews: 25,
        totalSummaries: 8,
        totalRatings: 20,
        thumbsUp: 18,
        thumbsDown: 2,
        tokensUsed: 50_000,
      });
      expect(output).toContain('18/20 positive ratings (90%)');
    });

    it('shows no ratings message when no ratings', () => {
      const output = formatReviewQuality({
        totalReviews: 5,
        totalSummaries: 1,
        totalRatings: 0,
        thumbsUp: 0,
        thumbsDown: 0,
        tokensUsed: 10_000,
      });
      expect(output).toContain('No ratings yet');
    });
  });

  describe('formatConsumption', () => {
    it('shows token totals with today and this week', () => {
      const output = formatConsumption(makeConsumption());
      expect(output).toContain('125,430 total');
      expect(output).toContain('12,300 today');
      expect(output).toContain('45,200 this week');
    });

    it('shows daily budget when configured', () => {
      const output = formatConsumption(makeConsumption(), { tokens_per_day: 100_000 });
      expect(output).toContain('Budget:');
      expect(output).toContain('87,700 remaining');
    });

    it('shows monthly budget when no daily limit', () => {
      const output = formatConsumption(makeConsumption(), { tokens_per_month: 200_000 });
      expect(output).toContain('Budget:');
      expect(output).toContain('101,900 remaining');
    });

    it('prefers daily budget over monthly', () => {
      const output = formatConsumption(makeConsumption(), {
        tokens_per_day: 100_000,
        tokens_per_month: 200_000,
      });
      expect(output).toContain('(24h)');
      expect(output).not.toContain('(30d)');
    });

    it('does not show budget when no limits', () => {
      const output = formatConsumption(makeConsumption());
      expect(output).not.toContain('Budget:');
    });

    it('shows 0 remaining when budget exceeded', () => {
      const output = formatConsumption(
        makeConsumption({
          period: {
            last24h: { tokens: 150_000, reviews: 60 },
            last7d: { tokens: 150_000, reviews: 60 },
            last30d: { tokens: 150_000, reviews: 60 },
          },
        }),
        { tokens_per_day: 100_000 },
      );
      expect(output).toContain('0 remaining');
    });
  });

  describe('formatAgentStats', () => {
    it('displays agent info and consumption', () => {
      const output = formatAgentStats(makeAgent(), makeConsumption());
      expect(output).toContain('Agent: agent-1 (claude-sonnet-4-6 / claude-code)');
      expect(output).toContain('Tokens:');
      expect(output).toContain('125,430 total');
    });

    it('displays trust tier when agent stats provided', () => {
      const output = formatAgentStats(makeAgent(), makeConsumption(), null, makeAgentStats());
      expect(output).toContain('Trusted');
      expect(output).toContain('25 reviews');
      expect(output).toContain('88% positive');
    });

    it('displays review quality when agent stats provided', () => {
      const output = formatAgentStats(makeAgent(), makeConsumption(), null, makeAgentStats());
      expect(output).toContain('25 completed');
      expect(output).toContain('18/20 positive ratings');
    });

    it('omits trust and quality when no agent stats', () => {
      const output = formatAgentStats(makeAgent(), makeConsumption());
      expect(output).not.toContain('Trust:');
      expect(output).not.toContain('Quality:');
    });

    it('shows budget when limits configured', () => {
      const output = formatAgentStats(makeAgent(), makeConsumption(), { tokens_per_day: 100_000 });
      expect(output).toContain('Budget:');
      expect(output).toContain('87,700 remaining');
    });
  });

  describe('statsCommand action', () => {
    it('displays stats for a specific agent with trust tier', async () => {
      const consumption = makeConsumption();
      mockFetchConsumptionStats.mockResolvedValueOnce(consumption);
      mockGet
        .mockResolvedValueOnce({ agents: [makeAgent()] }) // /api/agents
        .mockResolvedValueOnce(makeAgentStats()); // /api/stats/:agentId

      await statsCommand.parseAsync(['--agent', 'agent-1'], { from: 'user' });

      expect(mockFetchConsumptionStats).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Agent: agent-1'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Trusted'));
    });

    it('shows unknown model/tool when agent list fetch fails for specific agent', async () => {
      const consumption = makeConsumption();
      mockFetchConsumptionStats.mockResolvedValueOnce(consumption);
      mockGet
        .mockRejectedValueOnce(new Error('Network error')) // /api/agents fails
        .mockResolvedValueOnce(makeAgentStats()); // /api/stats/:agentId

      await statsCommand.parseAsync(['--agent', 'agent-1'], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('unknown / unknown'));
    });

    it('shows unknown model/tool when agent not found in list', async () => {
      const consumption = makeConsumption();
      mockFetchConsumptionStats.mockResolvedValueOnce(consumption);
      mockGet
        .mockResolvedValueOnce({ agents: [makeAgent({ id: 'other-agent' })] })
        .mockResolvedValueOnce(makeAgentStats());

      await statsCommand.parseAsync(['--agent', 'agent-1'], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('unknown / unknown'));
    });

    it('displays stats without trust tier when agent stats fail', async () => {
      const consumption = makeConsumption();
      mockFetchConsumptionStats.mockResolvedValueOnce(consumption);
      mockGet
        .mockResolvedValueOnce({ agents: [makeAgent()] })
        .mockRejectedValueOnce(new Error('Stats unavailable'));

      await statsCommand.parseAsync(['--agent', 'agent-1'], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Agent: agent-1'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Tokens:'));
      // Should not contain trust info since stats fetch failed
      const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).not.toContain('Trust:');
    });

    it('exits when consumption stats fetch fails for specific agent', async () => {
      mockFetchConsumptionStats.mockRejectedValueOnce(new Error('API error: 500'));

      await expect(
        statsCommand.parseAsync(['--agent', 'agent-1'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      expect(errorSpy).toHaveBeenCalledWith('Failed to fetch consumption stats:', 'API error: 500');
    });

    it('exits with non-Error when consumption stats fetch fails for specific agent', async () => {
      mockFetchConsumptionStats.mockRejectedValueOnce('raw error');

      await expect(
        statsCommand.parseAsync(['--agent', 'agent-1'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      expect(errorSpy).toHaveBeenCalledWith('Failed to fetch consumption stats:', 'raw error');
    });

    it('displays stats for all agents', async () => {
      mockGet
        .mockResolvedValueOnce({
          agents: [makeAgent(), makeAgent({ id: 'agent-2', model: 'gpt-4', tool: 'copilot' })],
        })
        .mockResolvedValueOnce(makeAgentStats()) // stats for agent-1
        .mockResolvedValueOnce(
          makeAgentStats({ agent: { ...makeAgentStats().agent, id: 'agent-2' } }),
        ); // stats for agent-2
      mockFetchConsumptionStats
        .mockResolvedValueOnce(makeConsumption())
        .mockResolvedValueOnce(makeConsumption({ agentId: 'agent-2' }));

      await statsCommand.parseAsync([], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Agent: agent-1'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Agent: agent-2'));
    });

    it('shows no-agents message when no agents registered', async () => {
      mockGet.mockResolvedValueOnce({ agents: [] });

      await statsCommand.parseAsync([], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No agents registered'));
    });

    it('exits when agent list fetch fails', async () => {
      mockGet.mockRejectedValueOnce(new Error('Network error'));

      await expect(statsCommand.parseAsync([], { from: 'user' })).rejects.toThrow('process.exit');

      expect(errorSpy).toHaveBeenCalledWith('Failed to list agents:', 'Network error');
    });

    it('exits with non-Error when agent list fetch fails', async () => {
      mockGet.mockRejectedValueOnce('raw error');

      await expect(statsCommand.parseAsync([], { from: 'user' })).rejects.toThrow('process.exit');

      expect(errorSpy).toHaveBeenCalledWith('Failed to list agents:', 'raw error');
    });

    it('handles individual agent stats fetch failure in all-agents mode', async () => {
      mockGet
        .mockResolvedValueOnce({
          agents: [makeAgent(), makeAgent({ id: 'agent-2', model: 'gpt-4', tool: 'copilot' })],
        })
        .mockResolvedValueOnce(makeAgentStats()); // stats for agent-1 (agent-2 consumption fails)
      mockFetchConsumptionStats
        .mockResolvedValueOnce(makeConsumption())
        .mockRejectedValueOnce(new Error('Agent offline'));

      await statsCommand.parseAsync([], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Agent: agent-1'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Error: Agent offline'));
    });

    it('handles non-Error failure for individual agent in all-agents mode', async () => {
      mockGet.mockResolvedValueOnce({
        agents: [makeAgent()],
      });
      mockFetchConsumptionStats.mockRejectedValueOnce('raw error');

      await statsCommand.parseAsync([], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Error: Failed to fetch stats'));
    });
  });
});
