import { describe, it, expect } from 'vitest';
import type {
  AgentResponse,
  AgentStatsResponse,
  TrustTier,
  TrustTierInfo,
  ProjectStatsResponse,
  ProjectActivityEntry,
} from '../api.js';

describe('api types', () => {
  describe('AgentResponse', () => {
    it('does not include reputationScore', () => {
      const agent: AgentResponse = {
        id: 'agent-1',
        model: 'gpt-4',
        tool: 'claude-code',
        status: 'online',
        createdAt: '2026-01-01T00:00:00Z',
      };
      expect(agent).not.toHaveProperty('reputationScore');
      expect(agent.status).toBe('online');
    });
  });

  describe('TrustTier', () => {
    it('accepts valid tier values', () => {
      const tiers: TrustTier[] = ['newcomer', 'trusted', 'expert'];
      expect(tiers).toHaveLength(3);
      expect(tiers).toContain('newcomer');
      expect(tiers).toContain('trusted');
      expect(tiers).toContain('expert');
    });
  });

  describe('TrustTierInfo', () => {
    it('represents newcomer with progress toward trusted', () => {
      const info: TrustTierInfo = {
        tier: 'newcomer',
        label: 'Newcomer',
        reviewCount: 3,
        positiveRate: 0.67,
        nextTier: 'trusted',
        progressToNext: 0.3,
      };
      expect(info.tier).toBe('newcomer');
      expect(info.nextTier).toBe('trusted');
      expect(info.progressToNext).toBeGreaterThanOrEqual(0);
      expect(info.progressToNext).toBeLessThanOrEqual(1);
    });

    it('represents expert with no next tier', () => {
      const info: TrustTierInfo = {
        tier: 'expert',
        label: 'Expert',
        reviewCount: 100,
        positiveRate: 0.95,
        nextTier: null,
        progressToNext: 1,
      };
      expect(info.tier).toBe('expert');
      expect(info.nextTier).toBeNull();
    });
  });

  describe('AgentStatsResponse', () => {
    it('includes trustTier instead of reputationScore', () => {
      const response: AgentStatsResponse = {
        agent: {
          id: 'agent-1',
          model: 'gpt-4',
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
          totalSummaries: 10,
          totalRatings: 20,
          thumbsUp: 18,
          thumbsDown: 2,
          tokensUsed: 50000,
        },
      };
      expect(response.agent.trustTier.tier).toBe('trusted');
      expect(response.agent).not.toHaveProperty('reputationScore');
      expect(response.stats.totalReviews).toBe(25);
    });
  });

  describe('ProjectStatsResponse', () => {
    it('represents public project-level statistics', () => {
      const response: ProjectStatsResponse = {
        totalReviews: 150,
        totalContributors: 12,
        activeContributorsThisWeek: 5,
        averagePositiveRate: 0.82,
        recentActivity: [
          {
            type: 'review_completed',
            repo: 'owner/repo',
            prNumber: 42,
            agentModel: 'gpt-4',
            completedAt: '2026-03-15T10:00:00Z',
          },
        ],
      };
      expect(response.totalReviews).toBe(150);
      expect(response.recentActivity).toHaveLength(1);
      expect(response.recentActivity[0].type).toBe('review_completed');
    });

    it('handles empty activity feed', () => {
      const response: ProjectStatsResponse = {
        totalReviews: 0,
        totalContributors: 0,
        activeContributorsThisWeek: 0,
        averagePositiveRate: 0,
        recentActivity: [],
      };
      expect(response.recentActivity).toHaveLength(0);
    });
  });

  describe('ProjectActivityEntry', () => {
    it('represents a completed review activity', () => {
      const entry: ProjectActivityEntry = {
        type: 'review_completed',
        repo: 'OpenCara/OpenCara',
        prNumber: 99,
        agentModel: 'claude-3.5-sonnet',
        completedAt: '2026-03-16T12:00:00Z',
      };
      expect(entry.type).toBe('review_completed');
      expect(entry.repo).toContain('/');
    });
  });

  describe('exports', () => {
    it('exports all new types from index', async () => {
      const mod = await import('../index.js');
      // Runtime exports (constants)
      expect(mod.API_KEY_PREFIX).toBe('cr_');
      // Type exports are verified at compile time by this test file compiling successfully
    });

    it('does not export LeaderboardResponse or LeaderboardEntry', async () => {
      const mod = await import('../index.js');
      expect(mod).not.toHaveProperty('LeaderboardResponse');
      expect(mod).not.toHaveProperty('LeaderboardEntry');
    });
  });
});
