import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Agent CRUD (/api/agents)', () => {
  let ctx: E2EContext;

  beforeEach(() => {
    ctx = createE2EContext();
    vi.mocked(createSupabaseClient).mockReturnValue(ctx.supabase.client as ReturnType<typeof createSupabaseClient>);
  });

  afterEach(() => {
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  it('POST /api/agents creates an agent and returns 201', async () => {
    const { apiKey } = await ctx.createUser();

    const req = ctx.authedRequest('/api/agents', apiKey, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', tool: 'claude-code' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body).toMatchObject({
      id: expect.any(String),
      model: 'claude-sonnet-4-6',
      tool: 'claude-code',
      createdAt: expect.any(String),
    });
  });

  it('GET /api/agents returns the created agent', async () => {
    const { apiKey } = await ctx.createUser();

    // Create an agent via POST first
    const createReq = ctx.authedRequest('/api/agents', apiKey, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', tool: 'claude-code' }),
      headers: { 'Content-Type': 'application/json' },
    });
    await ctx.workerFetch(createReq);

    // List agents
    const listReq = ctx.authedRequest('/api/agents', apiKey, { method: 'GET' });
    const res = await ctx.workerFetch(listReq);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({
      model: 'claude-sonnet-4-6',
      tool: 'claude-code',
    });
  });

  it('POST /api/agents with missing model returns 400', async () => {
    const { apiKey } = await ctx.createUser();

    const req = ctx.authedRequest('/api/agents', apiKey, {
      method: 'POST',
      body: JSON.stringify({ tool: 'claude-code' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('POST /api/agents with missing tool returns 400', async () => {
    const { apiKey } = await ctx.createUser();

    const req = ctx.authedRequest('/api/agents', apiKey, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('GET /api/agents returns multiple agents when two are created', async () => {
    const { apiKey } = await ctx.createUser();

    // Create two agents
    const createReq1 = ctx.authedRequest('/api/agents', apiKey, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', tool: 'claude-code' }),
      headers: { 'Content-Type': 'application/json' },
    });
    await ctx.workerFetch(createReq1);

    const createReq2 = ctx.authedRequest('/api/agents', apiKey, {
      method: 'POST',
      body: JSON.stringify({ model: 'gemini-2.5-pro', tool: 'gemini' }),
      headers: { 'Content-Type': 'application/json' },
    });
    await ctx.workerFetch(createReq2);

    // List agents
    const listReq = ctx.authedRequest('/api/agents', apiKey, { method: 'GET' });
    const res = await ctx.workerFetch(listReq);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
    expect(body.agents).toHaveLength(2);
  });

  it('User A cannot see User B agents', async () => {
    const { user: _userA, apiKey: keyA } = await ctx.createUser({ name: 'user-a' });
    const { user: _userB, apiKey: keyB } = await ctx.createUser({ name: 'user-b' });

    // User A creates an agent
    const createReqA = ctx.authedRequest('/api/agents', keyA, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', tool: 'claude-code' }),
      headers: { 'Content-Type': 'application/json' },
    });
    await ctx.workerFetch(createReqA);

    // User B creates an agent
    const createReqB = ctx.authedRequest('/api/agents', keyB, {
      method: 'POST',
      body: JSON.stringify({ model: 'gemini-2.5-pro', tool: 'gemini' }),
      headers: { 'Content-Type': 'application/json' },
    });
    await ctx.workerFetch(createReqB);

    // User A lists agents — should only see their own
    const listReqA = ctx.authedRequest('/api/agents', keyA, { method: 'GET' });
    const resA = await ctx.workerFetch(listReqA);
    const bodyA = (await resA.json()) as { agents: Array<Record<string, unknown>> };
    expect(bodyA.agents).toHaveLength(1);
    expect(bodyA.agents[0].model).toBe('claude-sonnet-4-6');

    // User B lists agents — should only see their own
    const listReqB = ctx.authedRequest('/api/agents', keyB, { method: 'GET' });
    const resB = await ctx.workerFetch(listReqB);
    const bodyB = (await resB.json()) as { agents: Array<Record<string, unknown>> };
    expect(bodyB.agents).toHaveLength(1);
    expect(bodyB.agents[0].model).toBe('gemini-2.5-pro');
  });

  it('POST /api/agents with invalid JSON returns 400', async () => {
    const { apiKey } = await ctx.createUser();

    const req = ctx.authedRequest('/api/agents', apiKey, {
      method: 'POST',
      body: 'not valid json{{{',
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body).toHaveProperty('error');
  });
});
