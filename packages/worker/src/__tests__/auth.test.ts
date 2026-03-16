/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { API_KEY_PREFIX } from '@opencrust/shared';
import { generateApiKey, hashApiKey, authenticateRequest } from '../auth.js';

describe('generateApiKey', () => {
  it('generates key with correct prefix', async () => {
    const key = await generateApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
  });

  it('generates key with correct length (prefix + 40 hex chars)', async () => {
    const key = await generateApiKey();
    expect(key.length).toBe(API_KEY_PREFIX.length + 40);
  });

  it('generates unique keys', async () => {
    const key1 = await generateApiKey();
    const key2 = await generateApiKey();
    expect(key1).not.toBe(key2);
  });

  it('contains only hex characters after prefix', async () => {
    const key = await generateApiKey();
    const hex = key.slice(API_KEY_PREFIX.length);
    expect(/^[0-9a-f]{40}$/.test(hex)).toBe(true);
  });
});

describe('hashApiKey', () => {
  it('produces consistent hash for same key', async () => {
    const key = 'cr_' + '0'.repeat(40);
    const hash1 = await hashApiKey(key);
    const hash2 = await hashApiKey(key);
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different keys', async () => {
    const key1 = await generateApiKey();
    const key2 = await generateApiKey();
    const hash1 = await hashApiKey(key1);
    const hash2 = await hashApiKey(key2);
    expect(hash1).not.toBe(hash2);
  });

  it('produces 64-char hex string (SHA-256)', async () => {
    const key = await generateApiKey();
    const hash = await hashApiKey(key);
    expect(hash.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });
});

describe('authenticateRequest', () => {
  function createMockSupabase(user: unknown = null) {
    return {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: user,
              error: user ? null : { message: 'Not found' },
            }),
          }),
        }),
      }),
    } as any;
  }

  it('returns null for missing Authorization header', async () => {
    const request = new Request('http://localhost');
    const result = await authenticateRequest(request, createMockSupabase());
    expect(result).toBeNull();
  });

  it('returns null for non-Bearer auth', async () => {
    const request = new Request('http://localhost', {
      headers: { Authorization: 'Basic abc' },
    });
    const result = await authenticateRequest(request, createMockSupabase());
    expect(result).toBeNull();
  });

  it('returns null for invalid key prefix', async () => {
    const request = new Request('http://localhost', {
      headers: { Authorization: 'Bearer invalid_key' },
    });
    const result = await authenticateRequest(request, createMockSupabase());
    expect(result).toBeNull();
  });

  it('returns null when user not found in database', async () => {
    const request = new Request('http://localhost', {
      headers: { Authorization: 'Bearer cr_' + '0'.repeat(40) },
    });
    const result = await authenticateRequest(request, createMockSupabase(null));
    expect(result).toBeNull();
  });

  it('returns user when valid key matches', async () => {
    const mockUser = {
      id: '123',
      github_id: 456,
      name: 'testuser',
      avatar: null,
      api_key_hash: 'somehash',
      reputation_score: 0,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    };
    const request = new Request('http://localhost', {
      headers: { Authorization: 'Bearer cr_' + '0'.repeat(40) },
    });
    const result = await authenticateRequest(request, createMockSupabase(mockUser));
    expect(result).toEqual(mockUser);
  });

  // --- Cookie-based auth fallback ---

  it('authenticates via session cookie when no Authorization header', async () => {
    const mockUser = {
      id: '123',
      github_id: 456,
      name: 'testuser',
      avatar: null,
      api_key_hash: 'somehash',
      reputation_score: 0,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    };
    const apiKey = 'cr_' + '0'.repeat(40);
    const request = new Request('http://localhost', {
      headers: { Cookie: `opencrust_session=${apiKey}` },
    });
    const result = await authenticateRequest(request, createMockSupabase(mockUser));
    expect(result).toEqual(mockUser);
  });

  it('prefers Authorization header over cookie', async () => {
    const mockUser = {
      id: '123',
      github_id: 456,
      name: 'testuser',
      avatar: null,
      api_key_hash: 'somehash',
      reputation_score: 0,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    };
    const apiKey = 'cr_' + '0'.repeat(40);
    const supabase = createMockSupabase(mockUser);
    const request = new Request('http://localhost', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Cookie: `opencrust_session=cr_${'1'.repeat(40)}`,
      },
    });
    await authenticateRequest(request, supabase);

    // Should have been called with the hash of the Bearer key, not the cookie key
    const fromCall = supabase.from.mock.results[0].value;
    const selectCall = fromCall.select.mock.results[0].value;
    const eqCall = selectCall.eq;
    expect(eqCall).toHaveBeenCalledWith('api_key_hash', expect.any(String));
  });

  it('returns null for cookie with invalid key prefix', async () => {
    const request = new Request('http://localhost', {
      headers: { Cookie: 'opencrust_session=invalid_key' },
    });
    const result = await authenticateRequest(request, createMockSupabase());
    expect(result).toBeNull();
  });

  it('returns null for cookie not named opencrust_session', async () => {
    const request = new Request('http://localhost', {
      headers: { Cookie: `other_cookie=cr_${'0'.repeat(40)}` },
    });
    const result = await authenticateRequest(request, createMockSupabase());
    expect(result).toBeNull();
  });

  it('authenticates via cookie when other cookies are present', async () => {
    const mockUser = {
      id: '123',
      github_id: 456,
      name: 'testuser',
      avatar: null,
      api_key_hash: 'somehash',
      reputation_score: 0,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    };
    const apiKey = 'cr_' + '0'.repeat(40);
    const request = new Request('http://localhost', {
      headers: { Cookie: `foo=bar; opencrust_session=${apiKey}; baz=qux` },
    });
    const result = await authenticateRequest(request, createMockSupabase(mockUser));
    expect(result).toEqual(mockUser);
  });
});
