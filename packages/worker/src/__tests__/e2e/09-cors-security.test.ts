import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: CORS & Security Headers', () => {
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

  it('OPTIONS /api/agents with matching Origin returns CORS headers', async () => {
    const req = new Request('https://api.opencara.dev/api/agents', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://opencara.dev',
        'Access-Control-Request-Method': 'GET',
      },
    });

    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://opencara.dev');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('OPTIONS /api/agents with non-matching Origin does not return CORS allow-origin', async () => {
    const req = new Request('https://api.opencara.dev/api/agents', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example.com',
        'Access-Control-Request-Method': 'GET',
      },
    });

    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(204);
    // Should NOT have Access-Control-Allow-Origin for non-matching origins
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('all responses include security headers', async () => {
    // Use any endpoint — the registry is public, no auth needed
    const req = new Request('https://api.opencara.dev/api/registry', { method: 'GET' });
    const res = await ctx.workerFetch(req);

    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('GET /api/agents with valid auth and matching Origin includes CORS headers', async () => {
    const { apiKey } = await ctx.createUser();

    const req = ctx.authedRequest('/api/agents', apiKey, {
      method: 'GET',
      headers: {
        Origin: 'https://opencara.dev',
      },
    });

    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://opencara.dev');
  });

  it('POST /webhook/github (non-API route) does not include CORS headers', async () => {
    // Send a minimal webhook request — it will fail signature validation,
    // but we only care about the CORS header behavior on the response
    const req = new Request('https://api.opencara.dev/webhook/github', {
      method: 'POST',
      headers: {
        Origin: 'https://opencara.dev',
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
        'X-Hub-Signature-256': 'sha256=invalid',
      },
      body: '{}',
    });

    const res = await ctx.workerFetch(req);
    // Webhook may return an error (bad signature), but CORS headers should be absent
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
