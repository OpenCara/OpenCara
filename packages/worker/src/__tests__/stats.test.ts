/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { handleGetStats, handleGetProjectStats, calculateTrustTier } from '../handlers/stats.js';
import type { User } from '@opencara/shared';

const mockUser: User = {
  id: 'user-123',
  github_id: 456,
  name: 'testuser',
  avatar: null,
  api_key_hash: 'hash',
  reputation_score: 0,
  created_at: '2024-01-01',
  updated_at: '2024-01-01',
};

describe('calculateTrustTier', () => {
  it('returns newcomer for zero reviews', () => {
    const tier = calculateTrustTier(0, 0, 0);
    expect(tier.tier).toBe('newcomer');
    expect(tier.label).toBe('Newcomer');
    expect(tier.reviewCount).toBe(0);
    expect(tier.positiveRate).toBe(0);
    expect(tier.nextTier).toBe('trusted');
    expect(tier.progressToNext).toBe(0);
  });

  it('returns newcomer when reviews < 5', () => {
    const tier = calculateTrustTier(3, 3, 0);
    expect(tier.tier).toBe('newcomer');
    expect(tier.nextTier).toBe('trusted');
    expect(tier.positiveRate).toBe(1);
  });

  it('returns newcomer when reviews >= 5 but positive rate < 0.6', () => {
    const tier = calculateTrustTier(10, 2, 8);
    expect(tier.tier).toBe('newcomer');
    expect(tier.positiveRate).toBe(0.2);
  });

  it('returns trusted at exact threshold (5 reviews, 60% positive)', () => {
    const tier = calculateTrustTier(5, 3, 2);
    expect(tier.tier).toBe('trusted');
    expect(tier.label).toBe('Trusted');
    expect(tier.nextTier).toBe('expert');
  });

  it('returns trusted when reviews >= 5 and positive rate >= 0.6 but below expert', () => {
    const tier = calculateTrustTier(10, 7, 3);
    expect(tier.tier).toBe('trusted');
    expect(tier.positiveRate).toBe(0.7);
    expect(tier.nextTier).toBe('expert');
  });

  it('returns expert at exact threshold (20 reviews, 80% positive)', () => {
    const tier = calculateTrustTier(20, 8, 2);
    expect(tier.tier).toBe('expert');
    expect(tier.label).toBe('Expert');
    expect(tier.nextTier).toBeNull();
    expect(tier.progressToNext).toBe(1);
  });

  it('returns expert when reviews >= 20 and positive rate >= 0.8', () => {
    const tier = calculateTrustTier(50, 45, 5);
    expect(tier.tier).toBe('expert');
    expect(tier.positiveRate).toBe(0.9);
    expect(tier.nextTier).toBeNull();
    expect(tier.progressToNext).toBe(1);
  });

  it('returns newcomer when reviews >= 20 but positive rate < 0.6 (below trusted)', () => {
    const tier = calculateTrustTier(25, 5, 20);
    expect(tier.tier).toBe('newcomer');
    expect(tier.positiveRate).toBe(0.2);
  });

  it('returns trusted when reviews >= 20 but positive rate < 0.8 (above 0.6)', () => {
    const tier = calculateTrustTier(25, 15, 10);
    expect(tier.tier).toBe('trusted');
    expect(tier.positiveRate).toBe(0.6);
  });

  it('calculates progress to next tier for newcomer', () => {
    // reviewProgress = 2/5 = 0.4, rateProgress = min(1.0/0.6, 1) = 1.0
    // progress = (0.4 + 1.0) / 2 = 0.7
    const tier = calculateTrustTier(2, 2, 0);
    expect(tier.progressToNext).toBeCloseTo(0.7, 5);
  });

  it('calculates progress to next tier for trusted', () => {
    // 10 out of 20 reviews = 0.5, rate 0.7/0.8 = 0.875 => avg 0.6875
    const tier = calculateTrustTier(10, 7, 3);
    expect(tier.progressToNext).toBeCloseTo(0.6875);
  });

  it('handles zero ratings with reviews for newcomer progress', () => {
    // totalRatings=0, positiveRate=0 => rateProgress=0
    // reviewProgress = 3/5 = 0.6 => progress = (0.6 + 0) / 2 = 0.3
    const tier = calculateTrustTier(3, 0, 0);
    expect(tier.tier).toBe('newcomer');
    expect(tier.positiveRate).toBe(0);
    expect(tier.progressToNext).toBeCloseTo(0.3);
  });
});

describe('handleGetStats', () => {
  it('returns 404 when agent not found', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
          }),
        }),
      }),
    } as any;

    const response = await handleGetStats('agent-x', mockUser, mockSupabase);
    expect(response.status).toBe(404);
  });

  it('returns 404 when agent belongs to different user', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                id: 'agent-1',
                model: 'gpt-4',
                tool: 'cline',
                status: 'online',
                user_id: 'other-user',
              },
              error: null,
            }),
          }),
        }),
      }),
    } as any;

    const response = await handleGetStats('agent-1', mockUser, mockSupabase);
    expect(response.status).toBe(404);
  });

  it('returns agent stats with trustTier instead of reputationScore', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'agents') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: 'agent-1',
                    model: 'gpt-4',
                    tool: 'cline',
                    status: 'online',
                    user_id: 'user-123',
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'review_results') {
          return {
            select: vi.fn().mockImplementation((fields: string, opts?: any) => {
              if (opts?.count === 'exact') {
                // Count query for completed reviews
                return {
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockResolvedValue({ count: 10 }),
                  }),
                };
              }
              // ID select for ratings join
              return {
                eq: vi.fn().mockResolvedValue({
                  data: [{ id: 'r1' }, { id: 'r2' }],
                }),
              };
            }),
          };
        }
        if (table === 'review_summaries') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ count: 2 }),
            }),
          };
        }
        if (table === 'ratings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockImplementation((_field: string, value: string) => ({
                in: vi.fn().mockResolvedValue({
                  count: value === 'thumbs_up' ? 7 : 3,
                }),
              })),
              in: vi.fn().mockResolvedValue({ count: 10 }),
            }),
          };
        }
        if (table === 'consumption_logs') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: [{ tokens_used: 1000 }, { tokens_used: 2000 }],
              }),
            }),
          };
        }
        return {};
      }),
    } as any;

    const response = await handleGetStats('agent-1', mockUser, mockSupabase);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.agent.id).toBe('agent-1');
    expect(data.agent.model).toBe('gpt-4');
    expect(data.agent).not.toHaveProperty('reputationScore');
    expect(data.agent.trustTier).toBeDefined();
    expect(data.agent.trustTier.tier).toBe('trusted');
    expect(data.agent.trustTier.label).toBe('Trusted');
    expect(data.agent.trustTier.reviewCount).toBe(10);
    expect(data.stats.tokensUsed).toBe(3000);
  });

  it('handles agent with no reviews or ratings', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'agents') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: 'agent-1',
                    model: 'gpt-4',
                    tool: 'cline',
                    status: 'offline',
                    user_id: 'user-123',
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'review_results') {
          return {
            select: vi.fn().mockImplementation((_fields: string, opts?: any) => {
              if (opts?.count === 'exact') {
                return {
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockResolvedValue({ count: 0 }),
                  }),
                };
              }
              return {
                eq: vi.fn().mockResolvedValue({ data: [] }),
              };
            }),
          };
        }
        if (table === 'review_summaries') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ count: 0 }),
            }),
          };
        }
        if (table === 'consumption_logs') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: [] }),
            }),
          };
        }
        return {};
      }),
    } as any;

    const response = await handleGetStats('agent-1', mockUser, mockSupabase);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.agent.trustTier.tier).toBe('newcomer');
    expect(data.agent.trustTier.positiveRate).toBe(0);
    expect(data.stats.totalReviews).toBe(0);
    expect(data.stats.totalSummaries).toBe(0);
    expect(data.stats.totalRatings).toBe(0);
    expect(data.stats.thumbsUp).toBe(0);
    expect(data.stats.thumbsDown).toBe(0);
    expect(data.stats.tokensUsed).toBe(0);
  });
});

describe('handleGetProjectStats', () => {
  it('returns aggregate stats with all fields', async () => {
    let selectCallCount = 0;
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'review_results') {
          return {
            select: vi.fn().mockImplementation((_fields: string, opts?: any) => {
              selectCallCount++;
              if (opts?.count === 'exact') {
                // Total completed reviews count (call 1)
                return {
                  eq: vi.fn().mockResolvedValue({ count: 42 }),
                };
              }
              if (selectCallCount === 2) {
                // Active contributors query: select('agent_id, agents!inner(user_id)')
                return {
                  eq: vi.fn().mockReturnValue({
                    gte: vi.fn().mockResolvedValue({
                      data: [
                        { agent_id: 'a1', agents: { user_id: 'u1' } },
                        { agent_id: 'a2', agents: { user_id: 'u1' } },
                        { agent_id: 'a3', agents: { user_id: 'u2' } },
                      ],
                    }),
                  }),
                };
              }
              // Recent activity query: select('completed_at, agents!inner(model), review_tasks!inner(...)')
              return {
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({
                      data: [
                        {
                          completed_at: '2024-01-15T10:00:00Z',
                          agents: { model: 'gpt-4' },
                          review_tasks: {
                            pr_number: 42,
                            projects: { repo_full_name: 'octocat/hello-world' },
                          },
                        },
                      ],
                    }),
                  }),
                }),
              };
            }),
          };
        }
        if (table === 'agents') {
          return {
            select: vi.fn().mockResolvedValue({
              data: [{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u2' }, { user_id: 'u3' }],
            }),
          };
        }
        if (table === 'ratings') {
          return {
            select: vi.fn().mockResolvedValue({
              data: [
                { emoji: 'thumbs_up' },
                { emoji: 'thumbs_up' },
                { emoji: 'thumbs_up' },
                { emoji: 'thumbs_down' },
              ],
            }),
          };
        }
        return {};
      }),
    } as any;

    const response = await handleGetProjectStats(mockSupabase);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.totalReviews).toBe(42);
    expect(data.totalContributors).toBe(3); // u1, u2, u3
    expect(data.activeContributorsThisWeek).toBe(2); // u1, u2
    expect(data.averagePositiveRate).toBe(0.75); // 3 up / 4 total
    expect(data.recentActivity).toHaveLength(1);
    expect(data.recentActivity[0].type).toBe('review_completed');
    expect(data.recentActivity[0].repo).toBe('octocat/hello-world');
    expect(data.recentActivity[0].prNumber).toBe(42);
    expect(data.recentActivity[0].agentModel).toBe('gpt-4');
  });

  it('returns zero stats when no data exists', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'review_results') {
          return {
            select: vi.fn().mockImplementation((_fields: string, opts?: any) => {
              if (opts?.count === 'exact') {
                return {
                  eq: vi.fn().mockResolvedValue({ count: 0 }),
                };
              }
              // For both active contributors and recent activity queries
              return {
                eq: vi.fn().mockReturnValue({
                  gte: vi.fn().mockResolvedValue({ data: [] }),
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({ data: [] }),
                  }),
                }),
              };
            }),
          };
        }
        if (table === 'agents') {
          return {
            select: vi.fn().mockResolvedValue({ data: [] }),
          };
        }
        if (table === 'ratings') {
          return {
            select: vi.fn().mockResolvedValue({ data: [] }),
          };
        }
        return {};
      }),
    } as any;

    const response = await handleGetProjectStats(mockSupabase);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.totalReviews).toBe(0);
    expect(data.totalContributors).toBe(0);
    expect(data.activeContributorsThisWeek).toBe(0);
    expect(data.averagePositiveRate).toBe(0);
    expect(data.recentActivity).toEqual([]);
  });

  it('handles null data from database gracefully', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'review_results') {
          return {
            select: vi.fn().mockImplementation((_fields: string, opts?: any) => {
              if (opts?.count === 'exact') {
                return {
                  eq: vi.fn().mockResolvedValue({ count: null }),
                };
              }
              return {
                eq: vi.fn().mockReturnValue({
                  gte: vi.fn().mockResolvedValue({ data: null }),
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({ data: null }),
                  }),
                }),
              };
            }),
          };
        }
        if (table === 'agents') {
          return {
            select: vi.fn().mockResolvedValue({ data: null }),
          };
        }
        if (table === 'ratings') {
          return {
            select: vi.fn().mockResolvedValue({ data: null }),
          };
        }
        return {};
      }),
    } as any;

    const response = await handleGetProjectStats(mockSupabase);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.totalReviews).toBe(0);
    expect(data.totalContributors).toBe(0);
    expect(data.activeContributorsThisWeek).toBe(0);
    expect(data.averagePositiveRate).toBe(0);
    expect(data.recentActivity).toEqual([]);
  });
});
