import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

// Mock only the Supabase client factory — everything else runs for real
vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('Auth Middleware (E2E)', () => {
  let ctx: E2EContext;
  let apiKey: string;
  let userId: string;
  let agentId: string;

  beforeEach(async () => {
    ctx = createE2EContext();
    vi.mocked(createSupabaseClient).mockReturnValue(ctx.supabase.client as never);

    // Create a user and agent for authenticated tests
    const { user, apiKey: key } = await ctx.createUser();
    apiKey = key;
    userId = user.id as string;
    const agent = await ctx.createAgent(userId);
    agentId = agent.id as string;
  });

  afterEach(() => {
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  it('GET /api/agents without auth returns 401', async () => {
    const res = await ctx.workerFetch(
      new Request('https://api.opencara.dev/api/agents'),
    );
    expect(res.status).toBe(401);
  });

  it('GET /api/agents with invalid Bearer returns 401', async () => {
    const res = await ctx.workerFetch(
      new Request('https://api.opencara.dev/api/agents', {
        headers: { Authorization: 'Bearer cr_invalid_key_that_does_not_exist' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('GET /api/agents with valid Bearer returns 200', async () => {
    const res = await ctx.workerFetch(ctx.authedRequest('/api/agents', apiKey));
    expect(res.status).toBe(200);
  });

  it('POST /api/agents without auth returns 401', async () => {
    const res = await ctx.workerFetch(
      new Request('https://api.opencara.dev/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4', tool: 'cursor' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('GET /api/stats/{agentId} without auth returns 401', async () => {
    const res = await ctx.workerFetch(
      new Request(`https://api.opencara.dev/api/stats/${agentId}`),
    );
    expect(res.status).toBe(401);
  });

  it('POST /auth/revoke without auth returns 401', async () => {
    const res = await ctx.workerFetch(
      new Request('https://api.opencara.dev/auth/revoke', { method: 'POST' }),
    );
    expect(res.status).toBe(401);
  });

  it('POST /api/tasks/{taskId}/collect-ratings without auth returns 401', async () => {
    const res = await ctx.workerFetch(
      new Request('https://api.opencara.dev/api/tasks/fake-task-id/collect-ratings', {
        method: 'POST',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('GET /api/consumption/{agentId} without auth returns 401', async () => {
    const res = await ctx.workerFetch(
      new Request(`https://api.opencara.dev/api/consumption/${agentId}`),
    );
    expect(res.status).toBe(401);
  });

  it('auth via session cookie returns 200', async () => {
    const res = await ctx.workerFetch(
      new Request('https://api.opencara.dev/api/agents', {
        headers: { Cookie: `opencara_session=${apiKey}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('Bearer takes priority over cookie with different keys', async () => {
    // Create a second user with a different key
    const { user: user2, apiKey: apiKey2 } = await ctx.createUser({ name: 'user2', github_id: 99999 });
    await ctx.createAgent(user2.id as string, { model: 'gpt-4o' });

    // Use apiKey2 in Bearer and apiKey in Cookie — Bearer should win
    const res = await ctx.workerFetch(
      new Request('https://api.opencara.dev/api/agents', {
        headers: {
          Authorization: `Bearer ${apiKey2}`,
          Cookie: `opencara_session=${apiKey}`,
        },
      }),
    );
    expect(res.status).toBe(200);

    // The response should contain user2's agents (the one with gpt-4o model)
    const body = (await res.json()) as { agents: Array<{ model: string }> };
    expect(body).toHaveProperty('agents');
    expect(Array.isArray(body.agents)).toBe(true);
    // User2 has one agent with model gpt-4o
    const models = body.agents.map((a) => a.model);
    expect(models).toContain('gpt-4o');
    // User1's agent (claude-sonnet-4-6) should NOT be in the response
    expect(models).not.toContain('claude-sonnet-4-6');
  });
});
