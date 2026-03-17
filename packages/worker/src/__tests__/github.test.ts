import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  getInstallationToken,
  fetchReviewConfig,
  fetchPrDiff,
  postPrComment,
  extractCommentId,
  fetchCommentReactions,
} from '../github.js';
import type { Env } from '../env.js';

const originalFetch = globalThis.fetch;

const BASE_ENV: Env = {
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: '',
  GITHUB_CLIENT_ID: 'test-client',
  GITHUB_CLIENT_SECRET: 'test-secret',
  GITHUB_CLI_CLIENT_ID: 'test-cli-client',
  GITHUB_CLI_CLIENT_SECRET: 'test-cli-secret',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
};

describe('github', () => {
  let testEnv: Env;

  beforeEach(() => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    testEnv = { ...BASE_ENV, GITHUB_APP_PRIVATE_KEY: privateKey };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('getInstallationToken', () => {
    it('returns token on success', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token: 'ghs_test_token' }),
      });

      const token = await getInstallationToken(42, testEnv);
      expect(token).toBe('ghs_test_token');
    });

    it('calls correct GitHub API endpoint', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token: 'ghs_t' }),
      });

      await getInstallationToken(99, testEnv);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.github.com/app/installations/99/access_tokens',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Accept: 'application/vnd.github+json',
            'User-Agent': 'OpenCara-Worker',
            'X-GitHub-Api-Version': '2022-11-28',
          }),
        }),
      );
    });

    it('includes Bearer JWT in Authorization header', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token: 'ghs_t' }),
      });

      await getInstallationToken(1, testEnv);

      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const headers = call[1].headers;
      // JWT format: header.payload.signature
      expect(headers.Authorization).toMatch(
        /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      );
    });

    it('throws on non-ok response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      await expect(getInstallationToken(42, testEnv)).rejects.toThrow(
        'Failed to get installation token: 401 Unauthorized',
      );
    });
  });

  describe('fetchReviewConfig', () => {
    it('returns file content on success', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('version: 1\nprompt: Review\n'),
      });

      const content = await fetchReviewConfig('owner', 'repo', 'main', 'tok');
      expect(content).toBe('version: 1\nprompt: Review\n');
    });

    it('calls correct GitHub API endpoint', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('v: 1'),
      });

      await fetchReviewConfig('myorg', 'myrepo', 'feature', 'mytoken');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/myorg/myrepo/contents/.review.yml?ref=feature',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer mytoken',
            Accept: 'application/vnd.github.raw+json',
            'User-Agent': 'OpenCara-Worker',
          }),
        }),
      );
    });

    it('returns null when file not found (404)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      const content = await fetchReviewConfig('o', 'r', 'main', 'tok');
      expect(content).toBeNull();
    });

    it('throws on non-404 error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(fetchReviewConfig('o', 'r', 'main', 'tok')).rejects.toThrow(
        'Failed to fetch .review.yml: 500 Internal Server Error',
      );
    });
  });

  describe('fetchPrDiff', () => {
    it('returns diff content on success', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('diff --git a/file.ts b/file.ts\n'),
      });

      const diff = await fetchPrDiff('owner', 'repo', 42, 'tok');
      expect(diff).toBe('diff --git a/file.ts b/file.ts\n');
    });

    it('calls correct GitHub API endpoint with diff accept header', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('diff content'),
      });

      await fetchPrDiff('myorg', 'myrepo', 10, 'mytoken');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/myorg/myrepo/pulls/10',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer mytoken',
            Accept: 'application/vnd.github.diff',
            'User-Agent': 'OpenCara-Worker',
            'X-GitHub-Api-Version': '2022-11-28',
          }),
        }),
      );
    });

    it('throws on non-ok response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(fetchPrDiff('o', 'r', 1, 'tok')).rejects.toThrow(
        'Failed to fetch PR diff: 404 Not Found',
      );
    });
  });

  describe('postPrComment', () => {
    it('posts comment and returns html_url', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            html_url: 'https://github.com/owner/repo/pull/42#issuecomment-123',
          }),
      });

      const url = await postPrComment('owner', 'repo', 42, 'Test comment', 'tok');
      expect(url).toBe('https://github.com/owner/repo/pull/42#issuecomment-123');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/owner/repo/issues/42/comments',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer tok',
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({ body: 'Test comment' }),
        }),
      );
    });

    it('throws on failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });

      await expect(postPrComment('o', 'r', 42, 'Test', 'tok')).rejects.toThrow(
        'Failed to post PR comment: 403 Forbidden',
      );
    });
  });

  describe('extractCommentId', () => {
    it('extracts ID from HTML URL with issuecomment fragment', () => {
      const url = 'https://github.com/owner/repo/pull/42#issuecomment-123456';
      expect(extractCommentId(url)).toBe(123456);
    });

    it('extracts ID from API URL', () => {
      const url = 'https://api.github.com/repos/owner/repo/issues/comments/789';
      expect(extractCommentId(url)).toBe(789);
    });

    it('returns null for unrecognized URL format', () => {
      expect(extractCommentId('https://example.com/random')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(extractCommentId('')).toBeNull();
    });

    it('handles large comment IDs', () => {
      const url = 'https://github.com/o/r/pull/1#issuecomment-9999999999';
      expect(extractCommentId(url)).toBe(9999999999);
    });
  });

  describe('fetchCommentReactions', () => {
    it('returns reactions on success', async () => {
      const mockReactions = [
        { id: 1, user: { id: 100, login: 'user1' }, content: '+1' },
        { id: 2, user: { id: 101, login: 'user2' }, content: '-1' },
      ];
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockReactions),
      });

      const reactions = await fetchCommentReactions('owner', 'repo', 123, 'tok');
      expect(reactions).toEqual(mockReactions);
    });

    it('calls correct GitHub API endpoint with pagination params', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });

      await fetchCommentReactions('myorg', 'myrepo', 456, 'mytoken');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/myorg/myrepo/issues/comments/456/reactions?per_page=100&page=1',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer mytoken',
            Accept: 'application/vnd.github+json',
            'User-Agent': 'OpenCara-Worker',
            'X-GitHub-Api-Version': '2022-11-28',
          }),
        }),
      );
    });

    it('paginates when first page has 100 reactions', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        user: { id: i, login: `user${i}` },
        content: '+1',
      }));
      const page2 = [{ id: 100, user: { id: 100, login: 'user100' }, content: '-1' }];

      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page1) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page2) });

      const reactions = await fetchCommentReactions('o', 'r', 1, 'tok');
      expect(reactions).toHaveLength(101);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('page=2'),
        expect.anything(),
      );
    });

    it('throws on non-ok response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(fetchCommentReactions('o', 'r', 1, 'tok')).rejects.toThrow(
        'Failed to fetch comment reactions: 404 Not Found',
      );
    });
  });
});
