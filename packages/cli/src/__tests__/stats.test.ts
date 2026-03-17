import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConsumptionStatsResponse, AgentResponse } from '@opencrust/shared';

const mockGet = vi.hoisted(() => vi.fn());
const mockFetchConsumptionStats = vi.hoisted(() => vi.fn());

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({
    apiKey: 'cr_testkey',
    platformUrl: 'https://test.api.dev',
    limits: null,
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

import { formatAgentStats, statsCommand } from '../commands/stats.js';

function makeAgent(overrides?: Partial<AgentResponse>): AgentResponse {
  return {
    id: 'agent-1',
    model: 'claude-sonnet-4-6',
    tool: 'claude-code',
    status: 'online',
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeStats(overrides?: Partial<ConsumptionStatsResponse>): ConsumptionStatsResponse {
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

  describe('formatAgentStats', () => {
    it('displays agent info and all period stats', () => {
      const output = formatAgentStats(makeAgent(), makeStats());
      expect(output).toContain('Agent: agent-1 (claude-sonnet-4-6 / claude-code)');
      expect(output).toContain('Total: 125,430 tokens across 47 reviews');
      expect(output).toContain('Last 24h: 12,300 tokens / 5 reviews');
      expect(output).toContain('Last 7d:  45,200 tokens / 18 reviews');
      expect(output).toContain('Last 30d: 98,100 tokens / 39 reviews');
    });

    it('shows daily budget line when tokens_per_day configured', () => {
      const output = formatAgentStats(makeAgent(), makeStats(), { tokens_per_day: 100_000 });
      expect(output).toContain('Budget:');
      expect(output).toContain('12,300');
      expect(output).toContain('100,000');
      expect(output).toContain('87,700 remaining');
    });

    it('shows monthly budget line when tokens_per_month configured but no daily limit', () => {
      const output = formatAgentStats(makeAgent(), makeStats(), { tokens_per_month: 200_000 });
      expect(output).toContain('Budget:');
      expect(output).toContain('98,100');
      expect(output).toContain('200,000');
      expect(output).toContain('101,900 remaining');
    });

    it('prefers daily budget over monthly when both configured', () => {
      const output = formatAgentStats(makeAgent(), makeStats(), {
        tokens_per_day: 100_000,
        tokens_per_month: 200_000,
      });
      expect(output).toContain('(24h)');
      expect(output).not.toContain('(30d)');
    });

    it('does not show budget line when no limits configured', () => {
      const output = formatAgentStats(makeAgent(), makeStats());
      expect(output).not.toContain('Budget:');
    });

    it('does not show budget line when limits is null', () => {
      const output = formatAgentStats(makeAgent(), makeStats(), null);
      expect(output).not.toContain('Budget:');
    });

    it('shows 0 remaining when budget exceeded', () => {
      const output = formatAgentStats(
        makeAgent(),
        makeStats({
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

  describe('statsCommand action', () => {
    it('displays stats for a specific agent', async () => {
      const stats = makeStats();
      mockFetchConsumptionStats.mockResolvedValueOnce(stats);
      mockGet.mockResolvedValueOnce({
        agents: [makeAgent()],
      });

      await statsCommand.parseAsync(['--agent', 'agent-1'], { from: 'user' });

      expect(mockFetchConsumptionStats).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Agent: agent-1'));
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('claude-sonnet-4-6 / claude-code'),
      );
    });

    it('shows unknown model/tool when agent list fetch fails for specific agent', async () => {
      const stats = makeStats();
      mockFetchConsumptionStats.mockResolvedValueOnce(stats);
      mockGet.mockRejectedValueOnce(new Error('Network error'));

      await statsCommand.parseAsync(['--agent', 'agent-1'], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('unknown / unknown'));
    });

    it('shows unknown model/tool when agent not found in list', async () => {
      const stats = makeStats();
      mockFetchConsumptionStats.mockResolvedValueOnce(stats);
      mockGet.mockResolvedValueOnce({
        agents: [makeAgent({ id: 'other-agent' })],
      });

      await statsCommand.parseAsync(['--agent', 'agent-1'], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('unknown / unknown'));
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
      mockGet.mockResolvedValueOnce({
        agents: [makeAgent(), makeAgent({ id: 'agent-2', model: 'gpt-4', tool: 'copilot' })],
      });
      mockFetchConsumptionStats
        .mockResolvedValueOnce(makeStats())
        .mockResolvedValueOnce(makeStats({ agentId: 'agent-2' }));

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
      mockGet.mockResolvedValueOnce({
        agents: [makeAgent(), makeAgent({ id: 'agent-2', model: 'gpt-4', tool: 'copilot' })],
      });
      mockFetchConsumptionStats
        .mockResolvedValueOnce(makeStats())
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
