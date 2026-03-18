/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import {
  calculateWilsonScore,
  collectTaskRatings,
  recalculateAgentReputation,
} from '../reputation.js';

// Mock GitHub module to avoid real API calls and PEM key processing
vi.mock('../github.js', () => ({
  getInstallationToken: vi.fn().mockResolvedValue('ghs_mock_token'),
  fetchCommentReactions: vi.fn().mockResolvedValue([]),
  extractCommentId: vi.fn().mockImplementation((url: string) => {
    const match = url.match(/#issuecomment-(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
  }),
}));

import { fetchCommentReactions } from '../github.js';

describe('calculateWilsonScore', () => {
  it('returns 0 for no ratings', () => {
    expect(calculateWilsonScore(0, 0)).toBe(0);
  });

  it('returns a score between 0 and 1 for all positive', () => {
    const score = calculateWilsonScore(10, 10);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns a low score for all negative', () => {
    const score = calculateWilsonScore(0, 10);
    expect(score).toBe(0);
  });

  it('returns a moderate score for 50/50 split', () => {
    const score = calculateWilsonScore(5, 10);
    expect(score).toBeGreaterThan(0.15);
    expect(score).toBeLessThan(0.5);
  });

  it('score increases with more positive ratings', () => {
    const score1 = calculateWilsonScore(3, 10);
    const score2 = calculateWilsonScore(7, 10);
    expect(score2).toBeGreaterThan(score1);
  });

  it('more ratings give higher confidence (higher lower bound)', () => {
    const scoreFew = calculateWilsonScore(10, 10);
    const scoreMany = calculateWilsonScore(100, 100);
    expect(scoreMany).toBeGreaterThan(scoreFew);
  });

  it('handles single positive rating', () => {
    const score = calculateWilsonScore(1, 1);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('handles single negative rating', () => {
    const score = calculateWilsonScore(0, 1);
    expect(score).toBe(0);
  });

  it('uses custom confidence level', () => {
    const score95 = calculateWilsonScore(7, 10, 0.95);
    const score99 = calculateWilsonScore(7, 10, 0.99);
    expect(score99).toBeLessThan(score95);
  });

  it('falls back to z=1.96 for unknown confidence levels', () => {
    const score = calculateWilsonScore(7, 10, 0.85);
    const score95 = calculateWilsonScore(7, 10, 0.95);
    expect(score).toBe(score95);
  });
});

describe('collectTaskRatings', () => {
  function createMockEnv(): any {
    return {
      GITHUB_APP_ID: 'test',
      GITHUB_APP_PRIVATE_KEY: 'test-key',
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-key',
    };
  }

  it('returns empty result when no review results exist', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'review_tasks') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    github_installation_id: 42,
                    owner: 'owner',
                    repo: 'repo',
                  },
                }),
              }),
            }),
          };
        }
        if (table === 'review_results') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ data: [] }),
              }),
            }),
          };
        }
        return {};
      }),
    } as any;

    const result = await collectTaskRatings('task-1', createMockEnv(), mockSupabase);
    expect(result).toEqual({ collected: 0, ratings: [] });
  });

  it('collects reactions and creates ratings', async () => {
    vi.mocked(fetchCommentReactions).mockResolvedValue([
      { id: 1, user: { id: 100, login: 'reviewer1' }, content: '+1' },
      { id: 2, user: { id: 101, login: 'reviewer2' }, content: '-1' },
      { id: 3, user: { id: 102, login: 'reviewer3' }, content: 'heart' },
    ]);

    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'review_tasks') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    github_installation_id: 42,
                    owner: 'owner',
                    repo: 'repo',
                    config_json: {
                      commentUrl: 'https://github.com/owner/repo/pull/1#issuecomment-12345',
                    },
                  },
                }),
              }),
            }),
          };
        }
        if (table === 'review_results') {
          return {
            select: vi.fn().mockImplementation((fields: string) => {
              if (fields === 'id, agent_id') {
                return {
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockResolvedValue({
                      data: [
                        {
                          id: 'result-1',
                          agent_id: 'agent-1',
                        },
                      ],
                    }),
                  }),
                };
              }
              // For recalculateAgentReputation: select('id').eq('agent_id', agentId)
              return {
                eq: vi.fn().mockResolvedValue({
                  data: [{ id: 'result-1' }],
                }),
              };
            }),
          };
        }
        if (table === 'ratings') {
          return {
            upsert: vi.fn().mockResolvedValue({ error: null }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({ count: 1 }),
              }),
              in: vi.fn().mockResolvedValue({ count: 5 }),
            }),
          };
        }
        if (table === 'reputation_history') {
          return {
            insert: vi.fn().mockResolvedValue({ error: null }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({ data: [] }),
                }),
              }),
            }),
          };
        }
        return {};
      }),
    } as any;

    const result = await collectTaskRatings('task-1', createMockEnv(), mockSupabase);
    // 2 relevant reactions (+1 and -1), heart is filtered out
    expect(result.collected).toBe(2);
    expect(result.ratings).toHaveLength(1);
    expect(result.ratings[0].agentId).toBe('agent-1');
  });

  it('throws when task is not found', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'review_tasks') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: null }),
              }),
            }),
          };
        }
        return {};
      }),
    } as any;

    await expect(collectTaskRatings('task-x', createMockEnv(), mockSupabase)).rejects.toThrow(
      'Task task-x not found',
    );
  });
});

describe('recalculateAgentReputation', () => {
  it('returns zero scores when no review results exist', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'review_results') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: [] }),
            }),
          };
        }
        return {};
      }),
    } as any;

    const result = await recalculateAgentReputation('agent-1', mockSupabase);
    expect(result.thumbsUp).toBe(0);
    expect(result.thumbsDown).toBe(0);
    expect(result.newScore).toBe(0);
  });

  it('calculates Wilson score from ratings', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'review_results') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({
                data: [{ id: 'r1' }, { id: 'r2' }],
              }),
            }),
          };
        }
        if (table === 'ratings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockImplementation((field: string, value: string) => {
                if (field === 'emoji' && value === 'thumbs_up') {
                  return {
                    in: vi.fn().mockResolvedValue({ count: 8 }),
                  };
                }
                if (field === 'emoji' && value === 'thumbs_down') {
                  return {
                    in: vi.fn().mockResolvedValue({ count: 2 }),
                  };
                }
                return { in: vi.fn().mockResolvedValue({ count: 0 }) };
              }),
            }),
          };
        }
        if (table === 'reputation_history') {
          return {
            insert: vi.fn().mockResolvedValue({ error: null }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({ data: [] }),
                }),
              }),
            }),
          };
        }
        return {};
      }),
    } as any;

    const result = await recalculateAgentReputation('agent-1', mockSupabase);
    expect(result.thumbsUp).toBe(8);
    expect(result.thumbsDown).toBe(2);
    expect(result.newScore).toBeGreaterThan(0);
    expect(result.newScore).toBeGreaterThan(0.4);
    expect(result.newScore).toBeLessThan(1);
  });
});
