/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../index.js';
import type { Env } from '../env.js';

vi.mock('../webhook.js', () => ({
  handleGitHubWebhook: vi.fn().mockResolvedValue(new Response('OK')),
}));

vi.mock('../auth.js', () => ({
  authenticateRequest: vi.fn(),
}));

vi.mock('../db.js', () => ({
  createSupabaseClient: vi.fn(() => 'mock-supabase'),
}));

vi.mock('../handlers/consumption.js', () => ({
  handleGetConsumption: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ agentId: 'agent-1', totalTokens: 0, totalReviews: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  ),
}));

vi.mock('../handlers/agents.js', () => ({
  handleListAgents: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ agents: [] }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  ),
  handleCreateAgent: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: 'new' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }),
  ),
}));

vi.mock('../handlers/collect-ratings.js', () => ({
  handleCollectRatings: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ collected: 0, ratings: [] }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  ),
}));

vi.mock('../handlers/device-flow.js', () => ({
  handleDeviceFlow: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ userCode: 'TEST' }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  ),
  handleDeviceToken: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ status: 'pending' }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  ),
  handleRevokeKey: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ apiKey: 'new-key' }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  ),
}));

vi.mock('../handlers/stats.js', () => ({
  handleGetStats: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ agent: {}, stats: {} }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  ),
  handleGetLeaderboard: vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ agents: [] }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  ),
}));

import { handleGitHubWebhook } from '../webhook.js';
import { authenticateRequest } from '../auth.js';
import { handleGetConsumption } from '../handlers/consumption.js';
import { handleListAgents, handleCreateAgent } from '../handlers/agents.js';
import { handleCollectRatings } from '../handlers/collect-ratings.js';
import { handleDeviceFlow, handleDeviceToken, handleRevokeKey } from '../handlers/device-flow.js';
import { handleGetStats, handleGetLeaderboard } from '../handlers/stats.js';

const mockEnv: Env = {
  GITHUB_WEBHOOK_SECRET: 'test',
  GITHUB_APP_ID: 'test',
  GITHUB_APP_PRIVATE_KEY: '',
  GITHUB_CLIENT_ID: 'test',
  GITHUB_CLIENT_SECRET: '',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  AGENT_CONNECTION: {} as DurableObjectNamespace,
  TASK_TIMEOUT: {} as DurableObjectNamespace,
};

describe('worker router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- 404 routes ---

  it('returns 404 for unknown routes', async () => {
    const response = await worker.fetch(new Request('http://localhost/unknown'), mockEnv);
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data).toEqual({ error: 'Not found' });
  });

  it('returns 404 for GET /webhook/github', async () => {
    const response = await worker.fetch(new Request('http://localhost/webhook/github'), mockEnv);
    expect(response.status).toBe(404);
  });

  // --- Webhook route ---

  it('routes POST /webhook/github to webhook handler', async () => {
    const req = new Request('http://localhost/webhook/github', {
      method: 'POST',
      body: '{}',
    });
    await worker.fetch(req, mockEnv);
    expect(handleGitHubWebhook).toHaveBeenCalledWith(req, mockEnv);
  });

  // --- Auth routes ---

  it('routes POST /auth/device to device flow handler', async () => {
    const response = await worker.fetch(
      new Request('http://localhost/auth/device', { method: 'POST' }),
      mockEnv,
    );
    expect(response.status).toBe(200);
    expect(handleDeviceFlow).toHaveBeenCalledWith(mockEnv);
  });

  it('routes POST /auth/device/token to device token handler', async () => {
    const req = new Request('http://localhost/auth/device/token', {
      method: 'POST',
      body: '{}',
    });
    await worker.fetch(req, mockEnv);
    expect(handleDeviceToken).toHaveBeenCalledWith(req, mockEnv, 'mock-supabase');
  });

  it('routes POST /auth/revoke with valid auth', async () => {
    const mockUser = { id: 'user-1', name: 'test' };
    vi.mocked(authenticateRequest).mockResolvedValue(mockUser as any);

    const req = new Request('http://localhost/auth/revoke', {
      method: 'POST',
      headers: { Authorization: 'Bearer cr_test' },
    });
    await worker.fetch(req, mockEnv);
    expect(handleRevokeKey).toHaveBeenCalledWith(mockUser, 'mock-supabase');
  });

  it('returns 401 for POST /auth/revoke without auth', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue(null);

    const response = await worker.fetch(
      new Request('http://localhost/auth/revoke', { method: 'POST' }),
      mockEnv,
    );
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data).toEqual({ error: 'Unauthorized' });
  });

  // --- Agent routes ---

  it('routes GET /api/agents with valid auth', async () => {
    const mockUser = { id: 'user-1', name: 'test' };
    vi.mocked(authenticateRequest).mockResolvedValue(mockUser as any);

    const response = await worker.fetch(
      new Request('http://localhost/api/agents', {
        headers: { Authorization: 'Bearer cr_test' },
      }),
      mockEnv,
    );
    expect(response.status).toBe(200);
    expect(handleListAgents).toHaveBeenCalledWith(mockUser, 'mock-supabase');
  });

  it('routes POST /api/agents with valid auth', async () => {
    const mockUser = { id: 'user-1', name: 'test' };
    vi.mocked(authenticateRequest).mockResolvedValue(mockUser as any);

    const req = new Request('http://localhost/api/agents', {
      method: 'POST',
      headers: { Authorization: 'Bearer cr_test' },
      body: JSON.stringify({ model: 'gpt-4', tool: 'claude-code' }),
    });
    await worker.fetch(req, mockEnv);
    expect(handleCreateAgent).toHaveBeenCalledWith(req, mockUser, 'mock-supabase');
  });

  it('returns 401 for GET /api/agents without auth', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue(null);

    const response = await worker.fetch(new Request('http://localhost/api/agents'), mockEnv);
    expect(response.status).toBe(401);
  });

  it('returns 401 for POST /api/agents without auth', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue(null);

    const response = await worker.fetch(
      new Request('http://localhost/api/agents', { method: 'POST' }),
      mockEnv,
    );
    expect(response.status).toBe(401);
  });

  it('returns 404 for unsupported method on /api/agents', async () => {
    const mockUser = { id: 'user-1', name: 'test' };
    vi.mocked(authenticateRequest).mockResolvedValue(mockUser as any);

    const response = await worker.fetch(
      new Request('http://localhost/api/agents', { method: 'DELETE' }),
      mockEnv,
    );
    expect(response.status).toBe(404);
  });

  // --- Stats routes ---

  it('routes GET /api/stats/:agentId with valid auth', async () => {
    const mockUser = { id: 'user-1', name: 'test' };
    vi.mocked(authenticateRequest).mockResolvedValue(mockUser as any);

    const response = await worker.fetch(
      new Request('http://localhost/api/stats/agent-123', {
        headers: { Authorization: 'Bearer cr_test' },
      }),
      mockEnv,
    );
    expect(response.status).toBe(200);
    expect(handleGetStats).toHaveBeenCalledWith('agent-123', mockUser, 'mock-supabase');
  });

  it('returns 401 for GET /api/stats/:agentId without auth', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue(null);

    const response = await worker.fetch(
      new Request('http://localhost/api/stats/agent-123'),
      mockEnv,
    );
    expect(response.status).toBe(401);
  });

  // --- Leaderboard routes ---

  it('routes GET /api/leaderboard (public)', async () => {
    const response = await worker.fetch(new Request('http://localhost/api/leaderboard'), mockEnv);
    expect(response.status).toBe(200);
    expect(handleGetLeaderboard).toHaveBeenCalledWith('mock-supabase');
  });

  // --- Collect ratings routes ---

  it('routes POST /api/tasks/:taskId/collect-ratings with valid auth', async () => {
    const mockUser = { id: 'user-1', name: 'test' };
    vi.mocked(authenticateRequest).mockResolvedValue(mockUser as any);

    const response = await worker.fetch(
      new Request('http://localhost/api/tasks/task-456/collect-ratings', {
        method: 'POST',
        headers: { Authorization: 'Bearer cr_test' },
      }),
      mockEnv,
    );
    expect(response.status).toBe(200);
    expect(handleCollectRatings).toHaveBeenCalledWith(
      'task-456',
      mockUser,
      mockEnv,
      'mock-supabase',
    );
  });

  it('returns 401 for POST /api/tasks/:taskId/collect-ratings without auth', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue(null);

    const response = await worker.fetch(
      new Request('http://localhost/api/tasks/task-456/collect-ratings', { method: 'POST' }),
      mockEnv,
    );
    expect(response.status).toBe(401);
  });

  // --- Consumption routes ---

  it('routes GET /api/consumption/:agentId with valid auth', async () => {
    const mockUser = { id: 'user-1', name: 'test' };
    vi.mocked(authenticateRequest).mockResolvedValue(mockUser as any);

    const response = await worker.fetch(
      new Request('http://localhost/api/consumption/a1b2c3d4-e5f6-7890-abcd-ef1234567890', {
        headers: { Authorization: 'Bearer cr_test' },
      }),
      mockEnv,
    );
    expect(response.status).toBe(200);
    expect(handleGetConsumption).toHaveBeenCalledWith(
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      mockUser,
      'mock-supabase',
    );
  });

  it('returns 401 for GET /api/consumption/:agentId without auth', async () => {
    vi.mocked(authenticateRequest).mockResolvedValue(null);

    const response = await worker.fetch(
      new Request('http://localhost/api/consumption/a1b2c3d4-e5f6-7890-abcd-ef1234567890'),
      mockEnv,
    );
    expect(response.status).toBe(401);
  });

  it('returns 404 for POST /api/consumption/:agentId (only GET allowed)', async () => {
    const response = await worker.fetch(
      new Request('http://localhost/api/consumption/a1b2c3d4-e5f6-7890-abcd-ef1234567890', {
        method: 'POST',
      }),
      mockEnv,
    );
    expect(response.status).toBe(404);
  });

  it('returns 404 for /api/consumption with invalid UUID format', async () => {
    const response = await worker.fetch(
      new Request('http://localhost/api/consumption/not-a-uuid!'),
      mockEnv,
    );
    expect(response.status).toBe(404);
  });

  it('returns 404 for /api/consumption without agentId', async () => {
    const response = await worker.fetch(new Request('http://localhost/api/consumption/'), mockEnv);
    expect(response.status).toBe(404);
  });
});
