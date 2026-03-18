import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';
import { buildPullRequestPayload } from './helpers/webhook-builder.js';

// Mock only the Supabase client factory — everything else runs for real
vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('Webhook Signature Validation (E2E)', () => {
  let ctx: E2EContext;

  beforeEach(() => {
    ctx = createE2EContext();
    vi.mocked(createSupabaseClient).mockReturnValue(ctx.supabase.client as never);
  });

  afterEach(() => {
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  function buildSignedRequest(
    body: string,
    signature: string | null,
    event = 'pull_request',
  ): Request {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
    };
    if (signature !== null) {
      headers['X-Hub-Signature-256'] = signature;
    }
    return new Request('https://api.opencara.dev/webhook/github', {
      method: 'POST',
      headers,
      body,
    });
  }

  it('valid signature returns 200', async () => {
    const payload = buildPullRequestPayload();
    const body = JSON.stringify(payload);
    const sig = await ctx.signWebhook(body);

    const res = await ctx.workerFetch(buildSignedRequest(body, sig));
    expect(res.status).toBe(200);
  });

  it('invalid signature returns 401', async () => {
    const payload = buildPullRequestPayload();
    const body = JSON.stringify(payload);

    const res = await ctx.workerFetch(
      buildSignedRequest(
        body,
        'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      ),
    );
    expect(res.status).toBe(401);
  });

  it('missing X-Hub-Signature-256 header returns 401', async () => {
    const payload = buildPullRequestPayload();
    const body = JSON.stringify(payload);

    const res = await ctx.workerFetch(buildSignedRequest(body, null));
    expect(res.status).toBe(401);
  });

  it('empty body with valid signature for empty string does not crash', async () => {
    const body = '';
    const sig = await ctx.signWebhook(body);

    const res = await ctx.workerFetch(buildSignedRequest(body, sig));
    // Empty body is not valid JSON, so after signature passes it should return 400
    expect(res.status).toBe(400);
  });

  it('malformed JSON with valid signature returns 400', async () => {
    const body = '{not valid json!!!}';
    const sig = await ctx.signWebhook(body);

    const res = await ctx.workerFetch(buildSignedRequest(body, sig));
    expect(res.status).toBe(400);
  });

  it('tampered body (valid sig for body A, sent body B) returns 401', async () => {
    const bodyA = JSON.stringify(buildPullRequestPayload({ action: 'opened' }));
    const bodyB = JSON.stringify(buildPullRequestPayload({ action: 'closed' }));
    const sigForA = await ctx.signWebhook(bodyA);

    const res = await ctx.workerFetch(buildSignedRequest(bodyB, sigForA));
    expect(res.status).toBe(401);
  });
});
