/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { handleCollectRatings } from '../handlers/collect-ratings.js';
import type { User } from '@opencara/shared';

// Mock the reputation module
vi.mock('../reputation.js', () => ({
  collectTaskRatings: vi.fn(),
}));

import { collectTaskRatings } from '../reputation.js';

const mockUser: User = {
  id: 'user-123',
  github_id: 456,
  name: 'testuser',
  api_key_hash: 'hash',
  created_at: '2024-01-01',
};

function createMockEnv(): any {
  return {
    GITHUB_APP_ID: 'test',
    GITHUB_APP_PRIVATE_KEY: 'test-key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  };
}

/**
 * The handler does 3 separate queries:
 * 1. review_tasks.select('id, status').eq('id', taskId).single()
 * 2. agents.select('id').eq('user_id', userId)
 * 3. review_results.select('id', {count}).eq('review_task_id', taskId).in('agent_id', agentIds)
 */
function createMockSupabase(options: {
  taskData?: any;
  userAgents?: any[];
  resultCount?: number;
}): any {
  const { taskData = null, userAgents = [], resultCount = 0 } = options;
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'review_tasks') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: taskData }),
            }),
          }),
        };
      }
      if (table === 'agents') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: userAgents }),
          }),
        };
      }
      if (table === 'review_results') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({ count: resultCount }),
            }),
          }),
        };
      }
      return {};
    }),
  };
}

describe('handleCollectRatings', () => {
  it('returns 404 when task not found', async () => {
    const mockSupabase = createMockSupabase({ taskData: null });

    const response = await handleCollectRatings('task-x', mockUser, createMockEnv(), mockSupabase);
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('returns 404 when user has no agents', async () => {
    const mockSupabase = createMockSupabase({
      taskData: { id: 'task-1', status: 'completed' },
      userAgents: [],
    });

    const response = await handleCollectRatings('task-1', mockUser, createMockEnv(), mockSupabase);
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('returns 404 when no review results belong to user agents', async () => {
    const mockSupabase = createMockSupabase({
      taskData: { id: 'task-1', status: 'completed' },
      userAgents: [{ id: 'agent-1' }],
      resultCount: 0,
    });

    const response = await handleCollectRatings('task-1', mockUser, createMockEnv(), mockSupabase);
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('returns collected ratings on success', async () => {
    const mockSupabase = createMockSupabase({
      taskData: { id: 'task-1', status: 'completed' },
      userAgents: [{ id: 'agent-1' }],
      resultCount: 1,
    });

    vi.mocked(collectTaskRatings).mockResolvedValue({
      collected: 5,
      ratings: [{ agentId: 'agent-1', thumbsUp: 4, thumbsDown: 1, newScore: 0.5 }],
    });

    const response = await handleCollectRatings('task-1', mockUser, createMockEnv(), mockSupabase);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.collected).toBe(5);
    expect(data.ratings).toHaveLength(1);
    expect(data.ratings[0].agentId).toBe('agent-1');
  });

  it('returns 500 when collectTaskRatings throws', async () => {
    const mockSupabase = createMockSupabase({
      taskData: { id: 'task-1', status: 'completed' },
      userAgents: [{ id: 'agent-1' }],
      resultCount: 1,
    });

    vi.mocked(collectTaskRatings).mockRejectedValue(new Error('GitHub API failed'));

    const response = await handleCollectRatings('task-1', mockUser, createMockEnv(), mockSupabase);
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.error).toContain('GitHub API failed');
  });

  it('handles non-Error thrown values', async () => {
    const mockSupabase = createMockSupabase({
      taskData: { id: 'task-1', status: 'completed' },
      userAgents: [{ id: 'agent-1' }],
      resultCount: 1,
    });

    vi.mocked(collectTaskRatings).mockRejectedValue('string error');

    const response = await handleCollectRatings('task-1', mockUser, createMockEnv(), mockSupabase);
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.error).toContain('Unknown error');
  });
});
