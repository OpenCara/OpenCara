/**
 * Tests for GitHubService new issue management methods:
 * - updateIssue
 * - fetchIssueBody
 * - createIssue
 *
 * Tests both RealGitHubService (with mocked fetch) and NoOpGitHubService.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RealGitHubService, NoOpGitHubService } from '../github/service.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ── RealGitHubService ───────────────────────────────────────

describe('RealGitHubService issue methods', () => {
  function createService(): RealGitHubService {
    return new RealGitHubService('app-id', 'private-key');
  }

  describe('updateIssue', () => {
    it('sends PATCH request with updates', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      const svc = createService();
      await svc.updateIssue('owner', 'repo', 42, { title: 'New Title', labels: ['bug'] }, 'token');

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://api.github.com/repos/owner/repo/issues/42');
      expect(opts.method).toBe('PATCH');
      expect(JSON.parse(opts.body as string)).toEqual({ title: 'New Title', labels: ['bug'] });
    });

    it('throws on non-ok response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });

      const svc = createService();
      await expect(
        svc.updateIssue('owner', 'repo', 42, { title: 'New Title' }, 'token'),
      ).rejects.toThrow('Failed to update issue #42: 403 Forbidden');
    });
  });

  describe('fetchIssueBody', () => {
    it('returns issue body on success', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ body: 'Issue description here' }),
      });

      const svc = createService();
      const result = await svc.fetchIssueBody('owner', 'repo', 10, 'token');
      expect(result).toBe('Issue description here');

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://api.github.com/repos/owner/repo/issues/10');
    });

    it('returns null on 404', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const svc = createService();
      const result = await svc.fetchIssueBody('owner', 'repo', 999, 'token');
      expect(result).toBeNull();
    });

    it('returns null when body is null', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ body: null }),
      });

      const svc = createService();
      const result = await svc.fetchIssueBody('owner', 'repo', 10, 'token');
      expect(result).toBeNull();
    });

    it('throws on non-404 error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });

      const svc = createService();
      await expect(svc.fetchIssueBody('owner', 'repo', 10, 'token')).rejects.toThrow(
        'Failed to fetch issue #10: 403 Forbidden',
      );
    });
  });

  describe('createIssue', () => {
    it('sends POST request and returns issue number', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ number: 123 }),
      });

      const svc = createService();
      const result = await svc.createIssue(
        'owner',
        'repo',
        { title: 'New Issue', body: 'Description', labels: ['enhancement'] },
        'token',
      );
      expect(result).toBe(123);

      const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe('https://api.github.com/repos/owner/repo/issues');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body as string)).toEqual({
        title: 'New Issue',
        body: 'Description',
        labels: ['enhancement'],
      });
    });

    it('throws on non-ok response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
      });

      const svc = createService();
      await expect(
        svc.createIssue('owner', 'repo', { title: 'Bad', body: '' }, 'token'),
      ).rejects.toThrow('Failed to create issue: 422 Unprocessable Entity');
    });
  });
});

// ── NoOpGitHubService ───────────────────────────────────────

describe('NoOpGitHubService issue methods', () => {
  it('updateIssue is a no-op', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const svc = new NoOpGitHubService();
    await expect(
      svc.updateIssue('owner', 'repo', 1, { title: 'test' }, 'token'),
    ).resolves.toBeUndefined();
  });

  it('fetchIssueBody returns mock body', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const svc = new NoOpGitHubService();
    const result = await svc.fetchIssueBody('owner', 'repo', 5, 'token');
    expect(result).toBe('Mock issue body for #5');
  });

  it('createIssue returns 0', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const svc = new NoOpGitHubService();
    const result = await svc.createIssue('owner', 'repo', { title: 'Test', body: 'Body' }, 'token');
    expect(result).toBe(0);
  });
});
