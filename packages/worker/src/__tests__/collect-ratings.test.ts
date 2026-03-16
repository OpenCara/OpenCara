/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { handleCollectRatings } from '../handlers/collect-ratings.js';
import type { User } from '@opencrust/shared';

// Mock the reputation module
vi.mock('../reputation.js', () => ({
  collectTaskRatings: vi.fn(),
}));

import { collectTaskRatings } from '../reputation.js';

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

function createMockEnv(): any {
  return {
    GITHUB_APP_ID: 'test',
    GITHUB_APP_PRIVATE_KEY: 'test-key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  };
}

describe('handleCollectRatings', () => {
  it('returns 404 when task not found', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null }),
          }),
        }),
      }),
    } as any;

    const response = await handleCollectRatings('task-x', mockUser, createMockEnv(), mockSupabase);
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error).toBe('Task not found');
  });

  it('returns collected ratings on success', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'task-1', status: 'completed' },
            }),
          }),
        }),
      }),
    } as any;

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
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'task-1', status: 'completed' },
            }),
          }),
        }),
      }),
    } as any;

    vi.mocked(collectTaskRatings).mockRejectedValue(new Error('GitHub API failed'));

    const response = await handleCollectRatings('task-1', mockUser, createMockEnv(), mockSupabase);
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.error).toContain('GitHub API failed');
  });

  it('handles non-Error thrown values', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'task-1', status: 'completed' },
            }),
          }),
        }),
      }),
    } as any;

    vi.mocked(collectTaskRatings).mockRejectedValue('string error');

    const response = await handleCollectRatings('task-1', mockUser, createMockEnv(), mockSupabase);
    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data.error).toContain('Unknown error');
  });
});
