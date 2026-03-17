import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifySignature, handleGitHubWebhook } from '../webhook.js';
import type { Env } from '../env.js';

vi.mock('../github.js', () => ({
  getInstallationToken: vi.fn(),
  fetchReviewConfig: vi.fn(),
  fetchPrDiff: vi.fn(),
  postPrComment: vi.fn(),
}));

vi.mock('../db.js', () => ({
  createSupabaseClient: vi.fn(() => ({})),
}));

vi.mock('../task-distribution.js', () => ({
  distributeTask: vi.fn().mockResolvedValue('mock-task-id'),
}));

import { getInstallationToken, fetchReviewConfig, fetchPrDiff, postPrComment } from '../github.js';

const mockedGetInstallationToken = vi.mocked(getInstallationToken);
const mockedFetchReviewConfig = vi.mocked(fetchReviewConfig);
const mockedFetchPrDiff = vi.mocked(fetchPrDiff);
const mockedPostPrComment = vi.mocked(postPrComment);

const TEST_SECRET = 'test-webhook-secret';

async function computeSignature(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

describe('verifySignature', () => {
  it('returns true for valid signature', async () => {
    const body = '{"action":"opened"}';
    const sig = await computeSignature(body, TEST_SECRET);
    expect(await verifySignature(body, sig, TEST_SECRET)).toBe(true);
  });

  it('returns false for invalid signature', async () => {
    const body = '{"action":"opened"}';
    expect(
      await verifySignature(
        body,
        'sha256=deadbeef00000000000000000000000000000000000000000000000000000000',
        TEST_SECRET,
      ),
    ).toBe(false);
  });

  it('returns false for missing signature', async () => {
    expect(await verifySignature('body', null, TEST_SECRET)).toBe(false);
  });

  it('returns false for signature without sha256= prefix', async () => {
    expect(await verifySignature('body', 'invalid-format', TEST_SECRET)).toBe(false);
  });
});

const TEST_ENV: Env = {
  GITHUB_WEBHOOK_SECRET: TEST_SECRET,
  GITHUB_APP_ID: 'test-app-id',
  GITHUB_APP_PRIVATE_KEY: '',
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: '',
  GITHUB_CLI_CLIENT_ID: 'test-cli-client',
  GITHUB_CLI_CLIENT_SECRET: 'test-cli-secret',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  AGENT_CONNECTION: {} as DurableObjectNamespace,
  TASK_TIMEOUT: {} as DurableObjectNamespace,
};

async function makeSignedRequest(
  event: string,
  payload: Record<string, unknown>,
): Promise<Request> {
  const body = JSON.stringify(payload);
  const sig = await computeSignature(body, TEST_SECRET);
  return new Request('https://worker.example.com/webhook/github', {
    method: 'POST',
    headers: {
      'X-GitHub-Event': event,
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': sig,
    },
    body,
  });
}

describe('handleGitHubWebhook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 for missing signature', async () => {
    const req = new Request('https://worker.example.com/webhook/github', {
      method: 'POST',
      headers: { 'X-GitHub-Event': 'ping' },
      body: '{}',
    });
    const res = await handleGitHubWebhook(req, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it('returns 401 for invalid signature', async () => {
    const req = new Request('https://worker.example.com/webhook/github', {
      method: 'POST',
      headers: {
        'X-GitHub-Event': 'ping',
        'X-Hub-Signature-256':
          'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: '{}',
    });
    const res = await handleGitHubWebhook(req, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it('returns 200 for valid unhandled event', async () => {
    const req = await makeSignedRequest('ping', { zen: 'test' });
    const res = await handleGitHubWebhook(req, TEST_ENV);
    expect(res.status).toBe(200);
  });

  it('returns 200 for pull_request.closed (unhandled action)', async () => {
    const req = await makeSignedRequest('pull_request', {
      action: 'closed',
      pull_request: { number: 1 },
    });
    const res = await handleGitHubWebhook(req, TEST_ENV);
    expect(res.status).toBe(200);
  });

  it('handles installation.created event', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const req = await makeSignedRequest('installation', {
      action: 'created',
      installation: { id: 12345, account: { login: 'test-org' } },
      repositories: [{ name: 'test-repo', full_name: 'test-org/test-repo' }],
    });
    const res = await handleGitHubWebhook(req, TEST_ENV);
    expect(res.status).toBe(200);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('installed by test-org'));
  });

  it('handles installation.deleted event', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const req = await makeSignedRequest('installation', {
      action: 'deleted',
      installation: { id: 12345, account: { login: 'test-org' } },
    });
    const res = await handleGitHubWebhook(req, TEST_ENV);
    expect(res.status).toBe(200);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('uninstalled by test-org'));
  });

  it('handles pull_request.opened with valid .review.yml', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockedGetInstallationToken.mockResolvedValue('test-token');
    mockedFetchReviewConfig.mockResolvedValue('version: 1\nprompt: Review this code.\n');
    mockedFetchPrDiff.mockResolvedValue('diff --git a/file.ts b/file.ts\n');

    const req = await makeSignedRequest('pull_request', {
      action: 'opened',
      installation: { id: 99 },
      repository: { owner: { login: 'test-org' }, name: 'test-repo' },
      pull_request: {
        number: 42,
        html_url: 'https://github.com/test-org/test-repo/pull/42',
        diff_url: 'https://github.com/test-org/test-repo/pull/42.diff',
        base: { ref: 'main' },
        head: { ref: 'feature-branch' },
      },
    });
    const res = await handleGitHubWebhook(req, TEST_ENV);
    expect(res.status).toBe(200);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('PR #42'));
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Review config for'),
      expect.objectContaining({ version: 1 }),
    );
    expect(mockedFetchReviewConfig).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      'feature-branch',
      'test-token',
    );
  });

  it('uses default config when .review.yml is not found', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockedGetInstallationToken.mockResolvedValue('test-token');
    mockedFetchReviewConfig.mockResolvedValue(null);
    mockedFetchPrDiff.mockResolvedValue('diff --git a/file.ts b/file.ts\n');

    const req = await makeSignedRequest('pull_request', {
      action: 'opened',
      installation: { id: 99 },
      repository: { owner: { login: 'test-org' }, name: 'test-repo' },
      pull_request: {
        number: 10,
        html_url: 'https://github.com/test-org/test-repo/pull/10',
        diff_url: 'https://github.com/test-org/test-repo/pull/10.diff',
        base: { ref: 'main' },
        head: { ref: 'fix-branch' },
      },
    });
    const res = await handleGitHubWebhook(req, TEST_ENV);
    expect(res.status).toBe(200);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('using default review config'));
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Review config for'),
      expect.objectContaining({}),
    );
  });

  it('posts error comment when .review.yml is malformed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockedGetInstallationToken.mockResolvedValue('test-token');
    mockedFetchReviewConfig.mockResolvedValue('{ invalid yaml: [');
    mockedPostPrComment.mockResolvedValue('');

    const req = await makeSignedRequest('pull_request', {
      action: 'opened',
      installation: { id: 99 },
      repository: { owner: { login: 'test-org' }, name: 'test-repo' },
      pull_request: {
        number: 7,
        html_url: 'https://github.com/test-org/test-repo/pull/7',
        diff_url: 'https://github.com/test-org/test-repo/pull/7.diff',
        base: { ref: 'main' },
        head: { ref: 'bad-config' },
      },
    });
    const res = await handleGitHubWebhook(req, TEST_ENV);
    expect(res.status).toBe(200);
    expect(mockedPostPrComment).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      7,
      expect.stringContaining('Failed to parse'),
      'test-token',
    );
  });

  it('posts error comment when .review.yml is missing required fields', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockedGetInstallationToken.mockResolvedValue('test-token');
    mockedFetchReviewConfig.mockResolvedValue('version: 1\n');
    mockedPostPrComment.mockResolvedValue('');

    const req = await makeSignedRequest('pull_request', {
      action: 'opened',
      installation: { id: 99 },
      repository: { owner: { login: 'test-org' }, name: 'test-repo' },
      pull_request: {
        number: 8,
        html_url: 'https://github.com/test-org/test-repo/pull/8',
        diff_url: 'https://github.com/test-org/test-repo/pull/8.diff',
        base: { ref: 'main' },
        head: { ref: 'no-prompt' },
      },
    });
    const res = await handleGitHubWebhook(req, TEST_ENV);
    expect(res.status).toBe(200);
    expect(mockedPostPrComment).toHaveBeenCalledWith(
      'test-org',
      'test-repo',
      8,
      expect.stringContaining('Missing required field: prompt'),
      'test-token',
    );
  });

  it('returns 200 when installation token fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockedGetInstallationToken.mockRejectedValue(new Error('Token error'));

    const req = await makeSignedRequest('pull_request', {
      action: 'opened',
      installation: { id: 99 },
      repository: { owner: { login: 'test-org' }, name: 'test-repo' },
      pull_request: {
        number: 1,
        html_url: 'https://github.com/test-org/test-repo/pull/1',
        diff_url: 'https://github.com/test-org/test-repo/pull/1.diff',
        base: { ref: 'main' },
        head: { ref: 'branch' },
      },
    });
    const res = await handleGitHubWebhook(req, TEST_ENV);
    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid JSON body with valid signature', async () => {
    const body = 'not json at all';
    const sig = await computeSignature(body, TEST_SECRET);
    const req = new Request('https://worker.example.com/webhook/github', {
      method: 'POST',
      headers: {
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': sig,
      },
      body,
    });
    const res = await handleGitHubWebhook(req, TEST_ENV);
    expect(res.status).toBe(400);
  });

  it('handles postPrComment failure when posting parse error comment', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedGetInstallationToken.mockResolvedValue('test-token');
    mockedFetchReviewConfig.mockResolvedValue('{ invalid yaml: [');
    mockedPostPrComment.mockRejectedValue(new Error('Post failed'));

    const req = await makeSignedRequest('pull_request', {
      action: 'opened',
      installation: { id: 99 },
      repository: { owner: { login: 'o' }, name: 'r' },
      pull_request: {
        number: 1,
        html_url: 'url',
        diff_url: 'diff',
        base: { ref: 'main' },
        head: { ref: 'br' },
      },
    });
    const res = await handleGitHubWebhook(req, TEST_ENV);
    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith('Failed to post error comment:', expect.any(Error));
  });

  it('returns 200 for installation event with unhandled action', async () => {
    const req = await makeSignedRequest('installation', {
      action: 'suspend',
      installation: { id: 123, account: { login: 'test' } },
    });
    const res = await handleGitHubWebhook(req, TEST_ENV);
    expect(res.status).toBe(200);
  });

  it('returns 200 for fetchReviewConfig failure', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedGetInstallationToken.mockResolvedValue('test-token');
    mockedFetchReviewConfig.mockRejectedValue(new Error('Fetch failed'));

    const req = await makeSignedRequest('pull_request', {
      action: 'opened',
      installation: { id: 99 },
      repository: { owner: { login: 'o' }, name: 'r' },
      pull_request: {
        number: 2,
        html_url: 'url',
        diff_url: 'diff',
        base: { ref: 'main' },
        head: { ref: 'br' },
      },
    });
    const res = await handleGitHubWebhook(req, TEST_ENV);
    expect(res.status).toBe(200);
  });

  it('returns 200 when fetchPrDiff fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedGetInstallationToken.mockResolvedValue('test-token');
    mockedFetchReviewConfig.mockResolvedValue('version: 1\nprompt: Review this code.\n');
    mockedFetchPrDiff.mockRejectedValue(new Error('Diff fetch failed'));

    const req = await makeSignedRequest('pull_request', {
      action: 'opened',
      installation: { id: 99 },
      repository: { owner: { login: 'o' }, name: 'r' },
      pull_request: {
        number: 5,
        html_url: 'url',
        diff_url: 'diff',
        base: { ref: 'main' },
        head: { ref: 'br' },
      },
    });
    const res = await handleGitHubWebhook(req, TEST_ENV);
    expect(res.status).toBe(200);
  });

  it('handles pull_request without installation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const req = await makeSignedRequest('pull_request', {
      action: 'opened',
      repository: { owner: { login: 'o' }, name: 'r' },
      pull_request: {
        number: 3,
        html_url: 'url',
        diff_url: 'diff',
        base: { ref: 'main' },
        head: { ref: 'br' },
      },
    });
    const res = await handleGitHubWebhook(req, TEST_ENV);
    expect(res.status).toBe(200);
  });

  it('returns false for signature with invalid hex chars', async () => {
    expect(
      await verifySignature(
        'body',
        'sha256=gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg',
        TEST_SECRET,
      ),
    ).toBe(false);
  });

  it('returns false for wrong-length hex signature', async () => {
    // 32 hex chars = 16 bytes, but HMAC-SHA256 produces 32 bytes
    expect(await verifySignature('body', 'sha256=' + '00'.repeat(16), TEST_SECRET)).toBe(false);
  });

  it('returns false for odd-length hex signature', async () => {
    expect(await verifySignature('body', 'sha256=abc', TEST_SECRET)).toBe(false);
  });
});
