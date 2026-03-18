import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Account Linking (/api/account/link)', () => {
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

  async function registerAnonymousAgent(): Promise<{ agentId: string; apiKey: string }> {
    const req = new Request('https://api.opencara.dev/api/agents/anonymous', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', tool: 'claude-code' }),
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '10.0.0.10',
      },
    });
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(201);
    return (await res.json()) as { agentId: string; apiKey: string };
  }

  it('links anonymous agents to authenticated user', async () => {
    // Create an authenticated user
    const { user, apiKey: authKey } = await ctx.createUser({ name: 'real-user' });

    // Register an anonymous agent
    const { agentId, apiKey: anonKey } = await registerAnonymousAgent();

    // Link the anonymous agent to the authenticated user
    const linkReq = ctx.authedRequest('/api/account/link', authKey, {
      method: 'POST',
      body: JSON.stringify({ anonymousApiKey: anonKey }),
      headers: { 'Content-Type': 'application/json' },
    });

    const linkRes = await ctx.workerFetch(linkReq);
    expect(linkRes.status).toBe(200);

    const body = (await linkRes.json()) as { linked: boolean; agentIds: string[] };
    expect(body.linked).toBe(true);
    expect(body.agentIds).toContain(agentId);

    // Verify the agent now belongs to the authenticated user
    const agents = ctx.supabase.getTable('agents');
    const linkedAgent = agents.find((a) => a.id === agentId);
    expect(linkedAgent).toBeDefined();
    expect(linkedAgent!.user_id).toBe(user.id);
    expect(linkedAgent!.is_anonymous).toBe(false);

    // Verify the anonymous user was deleted
    const users = ctx.supabase.getTable('users');
    const anonUser = users.find((u) => u.is_anonymous === true);
    expect(anonUser).toBeUndefined();
  });

  it('returns 401 without authentication', async () => {
    const req = new Request('https://api.opencara.dev/api/account/link', {
      method: 'POST',
      body: JSON.stringify({ anonymousApiKey: 'cr_fake' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 when anonymousApiKey is missing', async () => {
    const { apiKey } = await ctx.createUser();

    const req = ctx.authedRequest('/api/account/link', apiKey, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect((body as { error: string }).error).toContain('anonymousApiKey is required');
  });

  it('returns 400 when API key is invalid', async () => {
    const { apiKey } = await ctx.createUser();

    const req = ctx.authedRequest('/api/account/link', apiKey, {
      method: 'POST',
      body: JSON.stringify({ anonymousApiKey: 'cr_nonexistent' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect((body as { error: string }).error).toContain('Invalid anonymous API key');
  });

  it('returns 400 when key belongs to non-anonymous user', async () => {
    const { apiKey: authKey } = await ctx.createUser({ name: 'user-a' });
    const { apiKey: otherKey } = await ctx.createUser({ name: 'user-b' });

    // Try to link a non-anonymous user's key
    const req = ctx.authedRequest('/api/account/link', authKey, {
      method: 'POST',
      body: JSON.stringify({ anonymousApiKey: otherKey }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect((body as { error: string }).error).toContain('not belong to an anonymous user');
  });

  it('linked agents appear in authenticated user agent list', async () => {
    const { apiKey: authKey } = await ctx.createUser({ name: 'real-user' });

    // Create authenticated agent first
    const createReq = ctx.authedRequest('/api/agents', authKey, {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5-codex', tool: 'codex' }),
      headers: { 'Content-Type': 'application/json' },
    });
    await ctx.workerFetch(createReq);

    // Register and link an anonymous agent
    const { apiKey: anonKey } = await registerAnonymousAgent();
    const linkReq = ctx.authedRequest('/api/account/link', authKey, {
      method: 'POST',
      body: JSON.stringify({ anonymousApiKey: anonKey }),
      headers: { 'Content-Type': 'application/json' },
    });
    const linkRes = await ctx.workerFetch(linkReq);
    expect(linkRes.status).toBe(200);

    // List agents — should have both
    const listReq = ctx.authedRequest('/api/agents', authKey, { method: 'GET' });
    const listRes = await ctx.workerFetch(listReq);
    expect(listRes.status).toBe(200);

    const body = (await listRes.json()) as { agents: Array<Record<string, unknown>> };
    expect(body.agents).toHaveLength(2);
  });

  it('returns 400 for invalid JSON body', async () => {
    const { apiKey } = await ctx.createUser();

    const req = ctx.authedRequest('/api/account/link', apiKey, {
      method: 'POST',
      body: 'not valid json',
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(400);
  });
});
