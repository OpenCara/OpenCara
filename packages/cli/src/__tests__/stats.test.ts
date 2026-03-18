import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentResponse, AgentStatsResponse } from '@opencara/shared';

const mockGet = vi.hoisted(() => vi.fn());

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

import {
  formatAgentStats,
  formatTrustTier,
  formatReviewQuality,
  formatRepoConfig,
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
      });
      expect(output).toContain('No ratings yet');
    });
  });

  describe('formatRepoConfig', () => {
    it('shows default when repoConfig is null', () => {
      expect(formatRepoConfig(null)).toContain('all (default)');
    });

    it('shows all mode', () => {
      expect(formatRepoConfig({ mode: 'all' })).toContain('all');
    });

    it('shows own mode', () => {
      expect(formatRepoConfig({ mode: 'own' })).toContain('own repos only');
    });

    it('shows whitelist with repos', () => {
      const output = formatRepoConfig({ mode: 'whitelist', list: ['org/repo1', 'org/repo2'] });
      expect(output).toContain('whitelist');
      expect(output).toContain('org/repo1, org/repo2');
    });

    it('shows blacklist with repos', () => {
      const output = formatRepoConfig({ mode: 'blacklist', list: ['spam/repo'] });
      expect(output).toContain('blacklist');
      expect(output).toContain('spam/repo');
    });
  });

  describe('formatAgentStats', () => {
    it('displays agent info', () => {
      const output = formatAgentStats(makeAgent());
      expect(output).toContain('Agent: agent-1 (claude-sonnet-4-6 / claude-code)');
      expect(output).toContain('Repos:');
    });

    it('displays repo config when agent has one', () => {
      const output = formatAgentStats(
        makeAgent({ repoConfig: { mode: 'whitelist', list: ['org/repo'] } }),
      );
      expect(output).toContain('whitelist');
      expect(output).toContain('org/repo');
    });

    it('displays trust tier when agent stats provided', () => {
      const output = formatAgentStats(makeAgent(), makeAgentStats());
      expect(output).toContain('Trusted');
      expect(output).toContain('25 reviews');
      expect(output).toContain('88% positive');
    });

    it('displays review quality when agent stats provided', () => {
      const output = formatAgentStats(makeAgent(), makeAgentStats());
      expect(output).toContain('25 completed');
      expect(output).toContain('18/20 positive ratings');
    });

    it('omits trust and quality when no agent stats', () => {
      const output = formatAgentStats(makeAgent());
      expect(output).not.toContain('Trust:');
      expect(output).not.toContain('Quality:');
    });
  });

  describe('statsCommand action', () => {
    it('displays stats for a specific agent with trust tier', async () => {
      mockGet
        .mockResolvedValueOnce({ agents: [makeAgent()] }) // /api/agents
        .mockResolvedValueOnce(makeAgentStats()); // /api/stats/:agentId

      await statsCommand.parseAsync(['--agent', 'agent-1'], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Agent: agent-1'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Trusted'));
    });

    it('shows unknown model/tool when agent list fetch fails for specific agent', async () => {
      mockGet
        .mockRejectedValueOnce(new Error('Network error')) // /api/agents fails
        .mockResolvedValueOnce(makeAgentStats()); // /api/stats/:agentId

      await statsCommand.parseAsync(['--agent', 'agent-1'], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('unknown / unknown'));
    });

    it('shows unknown model/tool when agent not found in list', async () => {
      mockGet
        .mockResolvedValueOnce({ agents: [makeAgent({ id: 'other-agent' })] })
        .mockResolvedValueOnce(makeAgentStats());

      await statsCommand.parseAsync(['--agent', 'agent-1'], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('unknown / unknown'));
    });

    it('displays stats without trust tier when agent stats fail', async () => {
      mockGet
        .mockResolvedValueOnce({ agents: [makeAgent()] })
        .mockRejectedValueOnce(new Error('Stats unavailable'));

      await statsCommand.parseAsync(['--agent', 'agent-1'], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Agent: agent-1'));
      // Should not contain trust info since stats fetch failed
      const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).not.toContain('Trust:');
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
  });
});
