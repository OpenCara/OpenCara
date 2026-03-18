import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Anonymous Agent Registration (/api/agents/anonymous)', () => {
  let ctx: E2EContext;

  beforeEach(() => {
    ctx = createE2EContext();
    vi.mocked(createSupabaseClient).mockReturnValue(
      ctx.supabase.client as ReturnType<typeof createSupabaseClient>,
    );
  });

  afterEach(() => {
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  it('POST /api/agents/anonymous creates anonymous user + agent and returns 201', async () => {
    const req = new Request('https://api.opencara.dev/api/agents/anonymous', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', tool: 'claude-code' }),
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '10.0.0.1',
      },
    });

    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { agentId: string; apiKey: string };
    expect(body.agentId).toEqual(expect.any(String));
    expect(body.apiKey).toMatch(/^cr_/);

    // Verify user was created with is_anonymous=true
    const users = ctx.supabase.getTable('users');
    const anonUser = users.find((u) => u.is_anonymous === true);
    expect(anonUser).toBeDefined();
    expect(anonUser!.github_id).toBeNull();
    expect(anonUser!.name).toBe('anonymous');

    // Verify agent was created
    const agents = ctx.supabase.getTable('agents');
    const anonAgent = agents.find((a) => a.id === body.agentId);
    expect(anonAgent).toBeDefined();
    expect(anonAgent!.model).toBe('claude-sonnet-4-6');
    expect(anonAgent!.tool).toBe('claude-code');
    expect(anonAgent!.is_anonymous).toBe(true);
  });

  it('returns 400 when model is missing', async () => {
    const req = new Request('https://api.opencara.dev/api/agents/anonymous', {
      method: 'POST',
      body: JSON.stringify({ tool: 'claude-code' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when tool is missing', async () => {
    const req = new Request('https://api.opencara.dev/api/agents/anonymous', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(400);
  });

  it('returns 429 after 3 registrations from same IP', async () => {
    const makeReq = () =>
      new Request('https://api.opencara.dev/api/agents/anonymous', {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-sonnet-4-6', tool: 'claude-code' }),
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '10.0.0.2',
        },
      });

    // First 3 should succeed
    const res1 = await ctx.workerFetch(makeReq());
    expect(res1.status).toBe(201);
    const res2 = await ctx.workerFetch(makeReq());
    expect(res2.status).toBe(201);
    const res3 = await ctx.workerFetch(makeReq());
    expect(res3.status).toBe(201);

    // 4th should be rate limited
    const res4 = await ctx.workerFetch(makeReq());
    expect(res4.status).toBe(429);
    const body = await res4.json();
    expect((body as { error: string }).error).toContain('Rate limit');
  });

  it('rate limit is per-IP — different IPs are independent', async () => {
    const makeReq = (ip: string) =>
      new Request('https://api.opencara.dev/api/agents/anonymous', {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-sonnet-4-6', tool: 'claude-code' }),
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': ip,
        },
      });

    // Register 3 from IP A
    for (let i = 0; i < 3; i++) {
      const res = await ctx.workerFetch(makeReq('10.0.0.3'));
      expect(res.status).toBe(201);
    }

    // IP A is now rate limited
    const resA = await ctx.workerFetch(makeReq('10.0.0.3'));
    expect(resA.status).toBe(429);

    // IP B should still work
    const resB = await ctx.workerFetch(makeReq('10.0.0.4'));
    expect(resB.status).toBe(201);
  });

  it('anonymous agent can authenticate with returned API key', async () => {
    // Register anonymous agent
    const registerReq = new Request('https://api.opencara.dev/api/agents/anonymous', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', tool: 'claude-code' }),
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '10.0.0.5',
      },
    });

    const registerRes = await ctx.workerFetch(registerReq);
    expect(registerRes.status).toBe(201);
    const { apiKey } = (await registerRes.json()) as { agentId: string; apiKey: string };

    // Use the key to list agents
    const listReq = ctx.authedRequest('/api/agents', apiKey, { method: 'GET' });
    const listRes = await ctx.workerFetch(listReq);
    expect(listRes.status).toBe(200);

    const body = (await listRes.json()) as { agents: Array<Record<string, unknown>> };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].isAnonymous).toBe(true);
  });

  it('does not require authentication', async () => {
    // No Authorization header — should still work
    const req = new Request('https://api.opencara.dev/api/agents/anonymous', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', tool: 'claude-code' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(201);
  });
});
