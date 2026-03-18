/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { handleAnonymousRegister, handleLinkAccount } from '../handlers/anonymous.js';
import type { User } from '@opencara/shared';

function createMockKV(store: Map<string, string> = new Map()) {
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

function createMockEnv(kv?: ReturnType<typeof createMockKV>) {
  return {
    RATE_LIMIT_KV: kv ?? createMockKV(),
  };
}

function createMockSupabase(
  overrides: {
    userInsertResult?: any;
    agentInsertResult?: any;
    userSelectResult?: any;
    agentSelectResult?: any;
    agentUpdateResult?: any;
    userDeleteResult?: any;
  } = {},
) {
  const defaultInsertResult = {
    data: { id: 'user-anon-1' },
    error: null,
  };
  const defaultAgentInsertResult = {
    data: { id: 'agent-anon-1' },
    error: null,
  };

  return {
    from: vi.fn((table: string) => {
      if (table === 'users') {
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue(overrides.userInsertResult ?? defaultInsertResult),
            }),
          }),
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi
                .fn()
                .mockResolvedValue(
                  overrides.userSelectResult ?? { data: null, error: { message: 'not found' } },
                ),
            }),
          }),
          delete: vi.fn().mockReturnValue({
            eq: vi
              .fn()
              .mockResolvedValue(overrides.userDeleteResult ?? { data: null, error: null }),
          }),
        };
      }
      if (table === 'agents') {
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi
                .fn()
                .mockResolvedValue(overrides.agentInsertResult ?? defaultAgentInsertResult),
            }),
          }),
          select: vi.fn().mockReturnValue({
            eq: vi
              .fn()
              .mockResolvedValue(overrides.agentSelectResult ?? { data: [{ id: 'agent-1' }] }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi
              .fn()
              .mockResolvedValue(overrides.agentUpdateResult ?? { data: null, error: null }),
          }),
        };
      }
      return {};
    }),
  } as any;
}

describe('handleAnonymousRegister', () => {
  it('creates anonymous user + agent and returns 201', async () => {
    const env = createMockEnv();
    const supabase = createMockSupabase();

    const request = new Request('http://localhost/api/agents/anonymous', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', tool: 'claude-code' }),
      headers: { 'CF-Connecting-IP': '1.2.3.4' },
    });

    const response = await handleAnonymousRegister(request, env as any, supabase);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data).toHaveProperty('agentId');
    expect(data).toHaveProperty('apiKey');
    expect((data as { apiKey: string }).apiKey).toMatch(/^cr_/);
  });

  it('returns 400 when model is missing', async () => {
    const env = createMockEnv();
    const supabase = createMockSupabase();

    const request = new Request('http://localhost/api/agents/anonymous', {
      method: 'POST',
      body: JSON.stringify({ tool: 'claude-code' }),
    });

    const response = await handleAnonymousRegister(request, env as any, supabase);
    expect(response.status).toBe(400);
  });

  it('returns 400 when tool is missing', async () => {
    const env = createMockEnv();
    const supabase = createMockSupabase();

    const request = new Request('http://localhost/api/agents/anonymous', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    });

    const response = await handleAnonymousRegister(request, env as any, supabase);
    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid JSON', async () => {
    const env = createMockEnv();
    const supabase = createMockSupabase();

    const request = new Request('http://localhost/api/agents/anonymous', {
      method: 'POST',
      body: 'not json',
    });

    const response = await handleAnonymousRegister(request, env as any, supabase);
    expect(response.status).toBe(400);
  });

  it('returns 429 when rate limit is reached', async () => {
    const store = new Map([['anon-ip:1.2.3.4', '3']]);
    const env = createMockEnv(createMockKV(store));
    const supabase = createMockSupabase();

    const request = new Request('http://localhost/api/agents/anonymous', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', tool: 'claude-code' }),
      headers: { 'CF-Connecting-IP': '1.2.3.4' },
    });

    const response = await handleAnonymousRegister(request, env as any, supabase);
    expect(response.status).toBe(429);
    const data = await response.json();
    expect((data as { error: string }).error).toContain('Rate limit');
  });

  it('allows registration from different IP when one is rate limited', async () => {
    const store = new Map([['anon-ip:1.2.3.4', '3']]);
    const env = createMockEnv(createMockKV(store));
    const supabase = createMockSupabase();

    const request = new Request('http://localhost/api/agents/anonymous', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', tool: 'claude-code' }),
      headers: { 'CF-Connecting-IP': '5.6.7.8' },
    });

    const response = await handleAnonymousRegister(request, env as any, supabase);
    expect(response.status).toBe(201);
  });

  it('returns 500 when user creation fails', async () => {
    const env = createMockEnv();
    const supabase = createMockSupabase({
      userInsertResult: { data: null, error: { message: 'insert failed' } },
    });

    const request = new Request('http://localhost/api/agents/anonymous', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', tool: 'claude-code' }),
    });

    const response = await handleAnonymousRegister(request, env as any, supabase);
    expect(response.status).toBe(500);
  });

  it('returns 500 when agent creation fails', async () => {
    const env = createMockEnv();
    const supabase = createMockSupabase({
      agentInsertResult: { data: null, error: { message: 'insert failed' } },
    });

    const request = new Request('http://localhost/api/agents/anonymous', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', tool: 'claude-code' }),
    });

    const response = await handleAnonymousRegister(request, env as any, supabase);
    expect(response.status).toBe(500);
  });

  it('increments rate limit counter on success', async () => {
    const store = new Map<string, string>();
    const kv = createMockKV(store);
    const env = createMockEnv(kv);
    const supabase = createMockSupabase();

    const request = new Request('http://localhost/api/agents/anonymous', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', tool: 'claude-code' }),
      headers: { 'CF-Connecting-IP': '1.2.3.4' },
    });

    await handleAnonymousRegister(request, env as any, supabase);
    expect(kv.put).toHaveBeenCalledWith('anon-ip:1.2.3.4', '1', { expirationTtl: 86400 });
  });
});

describe('handleLinkAccount', () => {
  const mockAuthUser: User = {
    id: 'user-auth-1',
    github_id: 456,
    name: 'testuser',
    is_anonymous: false,
    api_key_hash: 'hash',
    created_at: '2024-01-01',
  };

  it('returns 400 for invalid JSON', async () => {
    const request = new Request('http://localhost/api/account/link', {
      method: 'POST',
      body: 'not json',
    });

    const response = await handleLinkAccount(request, mockAuthUser, {} as any);
    expect(response.status).toBe(400);
  });

  it('returns 400 when anonymousApiKey is missing', async () => {
    const request = new Request('http://localhost/api/account/link', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await handleLinkAccount(request, mockAuthUser, {} as any);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect((data as { error: string }).error).toContain('anonymousApiKey is required');
  });

  it('returns 400 when API key is not found', async () => {
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
          }),
        }),
      }),
    } as any;

    const request = new Request('http://localhost/api/account/link', {
      method: 'POST',
      body: JSON.stringify({ anonymousApiKey: 'cr_invalid' }),
    });

    const response = await handleLinkAccount(request, mockAuthUser, supabase);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect((data as { error: string }).error).toContain('Invalid anonymous API key');
  });

  it('returns 400 when key belongs to a non-anonymous user', async () => {
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'user-2', is_anonymous: false },
              error: null,
            }),
          }),
        }),
      }),
    } as any;

    const request = new Request('http://localhost/api/account/link', {
      method: 'POST',
      body: JSON.stringify({ anonymousApiKey: 'cr_somekey' }),
    });

    const response = await handleLinkAccount(request, mockAuthUser, supabase);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect((data as { error: string }).error).toContain('not belong to an anonymous user');
  });
});
