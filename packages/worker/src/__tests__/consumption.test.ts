/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGetConsumption } from '../handlers/consumption.js';
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

describe('handleGetConsumption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
  });

  it('returns 404 when agent does not belong to user', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
            }),
          }),
        }),
      }),
    } as any;

    const response = await handleGetConsumption('agent-999', mockUser, mockSupabase);
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data).toEqual({ error: 'Agent not found' });
  });

  it('returns zeroes for an agent with no consumption logs', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'agents') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: { id: 'agent-1' }, error: null }),
                }),
              }),
            }),
          };
        }
        // consumption_logs
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        };
      }),
    } as any;

    const response = await handleGetConsumption('agent-1', mockUser, mockSupabase);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      agentId: 'agent-1',
      totalTokens: 0,
      totalReviews: 0,
      period: {
        last24h: { tokens: 0, reviews: 0 },
        last7d: { tokens: 0, reviews: 0 },
        last30d: { tokens: 0, reviews: 0 },
      },
    });
  });

  it('returns correct aggregated stats for an agent with consumption logs', async () => {
    const logs = [
      // 1 hour ago — within 24h, 7d, 30d
      { tokens_used: 100, review_task_id: 'task-1', created_at: '2024-06-15T11:00:00Z' },
      // 3 days ago — within 7d, 30d (not 24h)
      { tokens_used: 200, review_task_id: 'task-2', created_at: '2024-06-12T12:00:00Z' },
      // 15 days ago — within 30d (not 24h, not 7d)
      { tokens_used: 300, review_task_id: 'task-3', created_at: '2024-05-31T12:00:00Z' },
      // 60 days ago — outside all periods
      { tokens_used: 400, review_task_id: 'task-4', created_at: '2024-04-16T12:00:00Z' },
    ];

    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'agents') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: { id: 'agent-1' }, error: null }),
                }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: logs, error: null }),
          }),
        };
      }),
    } as any;

    const response = await handleGetConsumption('agent-1', mockUser, mockSupabase);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      agentId: 'agent-1',
      totalTokens: 1000,
      totalReviews: 4,
      period: {
        last24h: { tokens: 100, reviews: 1 },
        last7d: { tokens: 300, reviews: 2 },
        last30d: { tokens: 600, reviews: 3 },
      },
    });
  });

  it('counts distinct review_task_ids (multiple logs for same task count as one review)', async () => {
    const logs = [
      // Two logs for the same task within 24h
      { tokens_used: 50, review_task_id: 'task-1', created_at: '2024-06-15T11:00:00Z' },
      { tokens_used: 75, review_task_id: 'task-1', created_at: '2024-06-15T10:00:00Z' },
    ];

    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'agents') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: { id: 'agent-1' }, error: null }),
                }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: logs, error: null }),
          }),
        };
      }),
    } as any;

    const response = await handleGetConsumption('agent-1', mockUser, mockSupabase);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.totalTokens).toBe(125);
    expect(data.totalReviews).toBe(1); // distinct task count
    expect(data.period.last24h.reviews).toBe(1);
    expect(data.period.last24h.tokens).toBe(125);
  });

  it('handles null logs data gracefully', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'agents') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: { id: 'agent-1' }, error: null }),
                }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        };
      }),
    } as any;

    const response = await handleGetConsumption('agent-1', mockUser, mockSupabase);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.totalTokens).toBe(0);
    expect(data.totalReviews).toBe(0);
  });

  it('correctly classifies boundary timestamps for period calculations', async () => {
    // Log exactly at the 24h boundary
    const exactly24hAgo = new Date('2024-06-14T12:00:00Z').toISOString();
    const logs = [{ tokens_used: 100, review_task_id: 'task-boundary', created_at: exactly24hAgo }];

    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'agents') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({ data: { id: 'agent-1' }, error: null }),
                }),
              }),
            }),
          };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: logs, error: null }),
          }),
        };
      }),
    } as any;

    const response = await handleGetConsumption('agent-1', mockUser, mockSupabase);
    const data = await response.json();

    expect(response.status).toBe(200);
    // Exactly at boundary: age === MS_24H, so age <= MS_24H is true
    expect(data.period.last24h.tokens).toBe(100);
    expect(data.period.last24h.reviews).toBe(1);
  });
});
