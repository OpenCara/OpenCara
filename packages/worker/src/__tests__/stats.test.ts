/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { handleGetStats, handleGetLeaderboard } from '../handlers/stats.js';
import type { User } from '@opencrust/shared';

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
                reputation_score: 0.5,
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

  it('returns agent stats with correct structure', async () => {
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
                    reputation_score: 0.75,
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
                    eq: vi.fn().mockResolvedValue({ count: 5 }),
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
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ count: 3 }),
              }),
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
    expect(data.agent.reputationScore).toBe(0.75);
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
                    reputation_score: 0,
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
    expect(data.stats.totalReviews).toBe(0);
    expect(data.stats.totalSummaries).toBe(0);
    expect(data.stats.totalRatings).toBe(0);
    expect(data.stats.thumbsUp).toBe(0);
    expect(data.stats.thumbsDown).toBe(0);
    expect(data.stats.tokensUsed).toBe(0);
  });
});

describe('handleGetLeaderboard', () => {
  it('returns empty leaderboard when no agents exist', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      }),
    } as any;

    const response = await handleGetLeaderboard(mockSupabase);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.agents).toEqual([]);
  });

  it('returns 500 when database query fails', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: null, error: { message: 'fail' } }),
          }),
        }),
      }),
    } as any;

    const response = await handleGetLeaderboard(mockSupabase);
    expect(response.status).toBe(500);
  });

  it('returns agents sorted by reputation with stats', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'agents') {
          return {
            select: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [
                    {
                      id: 'agent-1',
                      model: 'gpt-4',
                      tool: 'cline',
                      reputation_score: 0.9,
                      user_id: 'u1',
                      users: { name: 'alice' },
                    },
                    {
                      id: 'agent-2',
                      model: 'claude-3',
                      tool: 'cursor',
                      reputation_score: 0.7,
                      user_id: 'u2',
                      users: { name: 'bob' },
                    },
                  ],
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
                    eq: vi.fn().mockResolvedValue({ count: 10 }),
                  }),
                };
              }
              return {
                eq: vi.fn().mockResolvedValue({
                  data: [{ id: 'r1' }],
                }),
              };
            }),
          };
        }
        if (table === 'ratings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ count: 5 }),
              }),
            }),
          };
        }
        return {};
      }),
    } as any;

    const response = await handleGetLeaderboard(mockSupabase);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.agents).toHaveLength(2);
    expect(data.agents[0].id).toBe('agent-1');
    expect(data.agents[0].userName).toBe('alice');
    expect(data.agents[0].reputationScore).toBe(0.9);
    expect(data.agents[1].id).toBe('agent-2');
    expect(data.agents[1].userName).toBe('bob');
  });

  it('handles null data from database gracefully', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    } as any;

    const response = await handleGetLeaderboard(mockSupabase);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.agents).toEqual([]);
  });
});
