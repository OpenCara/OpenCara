/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { handleListAgents, handleCreateAgent } from '../handlers/agents.js';
import type { User } from '@opencara/shared';

const mockUser: User = {
  id: 'user-123',
  github_id: 456,
  name: 'testuser',
  avatar: null,
  api_key_hash: 'hash',
  created_at: '2024-01-01',
  updated_at: '2024-01-01',
};

describe('handleListAgents', () => {
  it('returns empty array when user has no agents', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        }),
      }),
    } as any;

    const response = await handleListAgents(mockUser, mockSupabase);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.agents).toEqual([]);
  });

  it('returns agents with camelCase keys', async () => {
    const mockAgents = [
      {
        id: 'agent-1',
        user_id: 'user-123',
        model: 'gpt-4',
        tool: 'cline',
        status: 'online',
        last_heartbeat_at: '2024-01-01',
        created_at: '2024-01-01',
      },
    ];
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: mockAgents, error: null }),
          }),
        }),
      }),
    } as any;

    const response = await handleListAgents(mockUser, mockSupabase);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0]).toEqual({
      id: 'agent-1',
      model: 'gpt-4',
      tool: 'cline',
      isAnonymous: false,
      status: 'online',
      repoConfig: null,
      createdAt: '2024-01-01',
    });
  });

  it('returns displayName when set', async () => {
    const mockAgents = [
      {
        id: 'agent-1',
        user_id: 'user-123',
        model: 'gpt-4',
        tool: 'cline',
        display_name: 'My Reviewer',
        status: 'online',
        created_at: '2024-01-01',
      },
    ];
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: mockAgents, error: null }),
          }),
        }),
      }),
    } as any;

    const response = await handleListAgents(mockUser, mockSupabase);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.agents[0].displayName).toBe('My Reviewer');
  });

  it('omits displayName when null', async () => {
    const mockAgents = [
      {
        id: 'agent-1',
        user_id: 'user-123',
        model: 'gpt-4',
        tool: 'cline',
        display_name: null,
        status: 'online',
        created_at: '2024-01-01',
      },
    ];
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: mockAgents, error: null }),
          }),
        }),
      }),
    } as any;

    const response = await handleListAgents(mockUser, mockSupabase);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.agents[0]).not.toHaveProperty('displayName');
  });

  it('returns 500 when database query fails', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: null, error: { message: 'fail' } }),
          }),
        }),
      }),
    } as any;

    const response = await handleListAgents(mockUser, mockSupabase);
    expect(response.status).toBe(500);
  });

  it('handles null data gracefully (uses empty array fallback)', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    } as any;

    const response = await handleListAgents(mockUser, mockSupabase);
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.agents).toEqual([]);
  });
});

describe('handleCreateAgent', () => {
  it('creates agent and returns 201', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                id: 'agent-new',
                model: 'claude-3',
                tool: 'cursor',
                status: 'offline',
                created_at: '2024-01-01',
              },
              error: null,
            }),
          }),
        }),
      }),
    } as any;

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-3', tool: 'cursor' }),
    });

    const response = await handleCreateAgent(request, mockUser, mockSupabase);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.id).toBe('agent-new');
    expect(data.model).toBe('claude-3');
    expect(data.tool).toBe('cursor');
    expect(data).not.toHaveProperty('reputationScore');
    expect(data.status).toBe('offline');
  });

  it('creates agent with displayName and returns it', async () => {
    const insertMock = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: {
            id: 'agent-named',
            model: 'claude-3',
            tool: 'cursor',
            display_name: 'My Bot',
            status: 'offline',
            created_at: '2024-01-01',
          },
          error: null,
        }),
      }),
    });
    const mockSupabase = {
      from: vi.fn().mockReturnValue({ insert: insertMock }),
    } as any;

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-3', tool: 'cursor', displayName: 'My Bot' }),
    });

    const response = await handleCreateAgent(request, mockUser, mockSupabase);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.displayName).toBe('My Bot');
    // Verify display_name was passed to insert
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ display_name: 'My Bot' }));
  });

  it('omits displayName from response when not set', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: {
                id: 'agent-new',
                model: 'claude-3',
                tool: 'cursor',
                display_name: null,
                status: 'offline',
                created_at: '2024-01-01',
              },
              error: null,
            }),
          }),
        }),
      }),
    } as any;

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-3', tool: 'cursor' }),
    });

    const response = await handleCreateAgent(request, mockUser, mockSupabase);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data).not.toHaveProperty('displayName');
  });

  it('returns 400 when model is missing', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ tool: 'cursor' }),
    });

    const response = await handleCreateAgent(request, mockUser, {} as any);
    expect(response.status).toBe(400);
  });

  it('returns 400 when tool is missing', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-3' }),
    });

    const response = await handleCreateAgent(request, mockUser, {} as any);
    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid JSON body', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      body: 'not json',
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await handleCreateAgent(request, mockUser, {} as any);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid JSON body');
  });

  it('returns 500 when database insert fails', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: null,
              error: { message: 'insert failed' },
            }),
          }),
        }),
      }),
    } as any;

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-3', tool: 'cursor' }),
    });

    const response = await handleCreateAgent(request, mockUser, mockSupabase);
    expect(response.status).toBe(500);
  });
});
