import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  fetchPRContext,
  formatPRContext,
  hasContent,
  UNTRUSTED_BOUNDARY_START,
  UNTRUSTED_BOUNDARY_END,
  type PRContext,
} from '../pr-context.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('fetchPRContext', () => {
  it('fetches all PR context data in parallel', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/pulls/42') && !url.includes('/comments') && !url.includes('/reviews')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              title: 'Fix bug',
              body: 'This fixes a race condition',
              user: { login: 'alice' },
              labels: [{ name: 'bug' }, { name: 'priority:high' }],
              base: { ref: 'main' },
              head: { ref: 'fix/race-condition' },
            }),
        });
      }
      if (url.includes('/issues/42/comments')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                user: { login: 'bob' },
                body: 'Have you considered a mutex?',
                created_at: '2026-03-20T10:00:00Z',
              },
            ]),
        });
      }
      if (url.includes('/pulls/42/comments')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                user: { login: 'carol' },
                body: 'This line looks wrong',
                path: 'src/agent.ts',
                line: 42,
                created_at: '2026-03-20T11:00:00Z',
              },
            ]),
        });
      }
      if (url.includes('/pulls/42/reviews')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                user: { login: 'opencara[bot]' },
                state: 'COMMENTED',
                body: 'No critical issues found.',
              },
              {
                user: { login: 'dave' },
                state: 'PENDING',
                body: 'Draft',
              },
            ]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const ctx = await fetchPRContext('owner', 'repo', 42, { githubToken: 'ghp_test123' });

    expect(ctx.metadata).toEqual({
      title: 'Fix bug',
      body: 'This fixes a race condition',
      author: 'alice',
      labels: ['bug', 'priority:high'],
      baseBranch: 'main',
      headBranch: 'fix/race-condition',
    });
    expect(ctx.comments).toHaveLength(1);
    expect(ctx.comments[0].author).toBe('bob');
    expect(ctx.reviewThreads).toHaveLength(1);
    expect(ctx.reviewThreads[0].path).toBe('src/agent.ts');
    expect(ctx.reviewThreads[0].line).toBe(42);
    // PENDING reviews are filtered out
    expect(ctx.existingReviews).toHaveLength(1);
    expect(ctx.existingReviews[0].author).toBe('opencara[bot]');
  });

  it('includes Authorization header when githubToken is provided', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          title: 'Test',
          body: null,
          user: null,
          labels: [],
          base: { ref: 'main' },
          head: { ref: 'test' },
        }),
    });
    globalThis.fetch = fetchSpy;

    await fetchPRContext('owner', 'repo', 1, { githubToken: 'ghp_abc' });

    // All 4 API calls should have the auth header
    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer ghp_abc');
    }
  });

  it('omits Authorization header when no githubToken', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          title: 'Test',
          body: null,
          user: null,
          labels: [],
          base: { ref: 'main' },
          head: { ref: 'test' },
        }),
    });
    globalThis.fetch = fetchSpy;

    await fetchPRContext('owner', 'repo', 1, {});

    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
    }
  });

  it('returns null metadata on API error', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/pulls/1') && !url.includes('/comments') && !url.includes('/reviews')) {
        return Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden' });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    const ctx = await fetchPRContext('owner', 'repo', 1, {});

    expect(ctx.metadata).toBeNull();
    expect(ctx.comments).toEqual([]);
    expect(ctx.reviewThreads).toEqual([]);
    expect(ctx.existingReviews).toEqual([]);
  });

  it('returns empty arrays on API errors for comments/reviews', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const ctx = await fetchPRContext('owner', 'repo', 1, {});

    expect(ctx.metadata).toBeNull();
    expect(ctx.comments).toEqual([]);
    expect(ctx.reviewThreads).toEqual([]);
    expect(ctx.existingReviews).toEqual([]);
  });

  it('returns empty arrays on network errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const ctx = await fetchPRContext('owner', 'repo', 1, {});

    expect(ctx.metadata).toBeNull();
    expect(ctx.comments).toEqual([]);
    expect(ctx.reviewThreads).toEqual([]);
    expect(ctx.existingReviews).toEqual([]);
  });

  it('handles null user fields gracefully', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/pulls/1') && !url.includes('/comments') && !url.includes('/reviews')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              title: 'Test',
              body: null,
              user: null,
              labels: [],
              base: { ref: 'main' },
              head: { ref: 'test' },
            }),
        });
      }
      if (url.includes('/issues/1/comments')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ user: null, body: 'Comment', created_at: '2026-01-01' }]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    const ctx = await fetchPRContext('owner', 'repo', 1, {});

    expect(ctx.metadata!.author).toBe('unknown');
    expect(ctx.metadata!.body).toBe('');
    expect(ctx.comments[0].author).toBe('unknown');
  });

  it('passes signal to fetch calls', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          title: 'Test',
          body: null,
          user: null,
          labels: [],
          base: { ref: 'main' },
          head: { ref: 'test' },
        }),
    });
    globalThis.fetch = fetchSpy;

    const controller = new AbortController();
    await fetchPRContext('owner', 'repo', 1, { signal: controller.signal });

    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.signal).toBe(controller.signal);
    }
  });
});

describe('formatPRContext', () => {
  const fullContext: PRContext = {
    metadata: {
      title: 'Fix race condition in task claiming',
      body: 'This PR fixes a race condition where...',
      author: 'alice',
      labels: ['bug', 'priority:high'],
      baseBranch: 'main',
      headBranch: 'fix/race-condition',
    },
    comments: [
      {
        author: 'bob',
        body: 'Have you considered using a mutex?',
        createdAt: '2026-03-20T10:00:00Z',
      },
      {
        author: 'alice',
        body: 'Good point, updated in latest commit.',
        createdAt: '2026-03-20T11:00:00Z',
      },
    ],
    reviewThreads: [
      {
        author: 'carol',
        body: 'This line looks wrong',
        path: 'src/agent.ts',
        line: 42,
        createdAt: '2026-03-20T11:00:00Z',
      },
      {
        author: 'dave',
        body: 'Consider null check',
        path: 'src/utils.ts',
        line: null,
        createdAt: '2026-03-20T12:00:00Z',
      },
    ],
    existingReviews: [
      { author: 'opencara[bot]', state: 'COMMENTED', body: 'No critical issues found.' },
    ],
  };

  it('formats all sections into structured text with anti-injection boundaries', () => {
    const text = formatPRContext(fullContext);

    // Must be wrapped in untrusted content boundaries
    expect(text).toContain(UNTRUSTED_BOUNDARY_START);
    expect(text).toContain(UNTRUSTED_BOUNDARY_END);
    expect(text.startsWith(UNTRUSTED_BOUNDARY_START)).toBe(true);
    expect(text.trimEnd().endsWith(UNTRUSTED_BOUNDARY_END)).toBe(true);

    expect(text).toContain('## PR Context');
    expect(text).toContain('**Title**: Fix race condition in task claiming');
    expect(text).toContain('**Author**: @alice');
    expect(text).toContain('**Description**: This PR fixes a race condition where...');
    expect(text).toContain('**Labels**: bug, priority:high');
    expect(text).toContain('**Branches**: fix/race-condition → main');
    expect(text).toContain('## Discussion (2 comments)');
    expect(text).toContain('@bob: Have you considered using a mutex?');
    expect(text).toContain('@alice: Good point, updated in latest commit.');
    expect(text).toContain('## Review Threads (2)');
    expect(text).toContain('@carol on `src/agent.ts:42`: This line looks wrong');
    expect(text).toContain('@dave on `src/utils.ts`: Consider null check');
    expect(text).toContain('## Existing Reviews (1)');
    expect(text).toContain('@opencara[bot]: [COMMENTED] No critical issues found.');
  });

  it('includes codebase directory when provided', () => {
    const text = formatPRContext(fullContext, '/tmp/repos/owner/repo');

    expect(text).toContain('## Local Codebase');
    expect(text).toContain('/tmp/repos/owner/repo');
    expect(text).toContain(UNTRUSTED_BOUNDARY_START);
    expect(text).toContain(UNTRUSTED_BOUNDARY_END);
  });

  it('omits codebase section when not provided', () => {
    const text = formatPRContext(fullContext);

    expect(text).not.toContain('## Local Codebase');
  });

  it('omits sections when data is empty', () => {
    const emptyContext: PRContext = {
      metadata: null,
      comments: [],
      reviewThreads: [],
      existingReviews: [],
    };

    const text = formatPRContext(emptyContext);

    expect(text).toBe('');
  });

  it('handles metadata-only context with boundaries', () => {
    const metadataOnly: PRContext = {
      metadata: {
        title: 'Simple PR',
        body: '',
        author: 'bob',
        labels: [],
        baseBranch: 'main',
        headBranch: 'feature',
      },
      comments: [],
      reviewThreads: [],
      existingReviews: [],
    };

    const text = formatPRContext(metadataOnly);

    expect(text).toContain(UNTRUSTED_BOUNDARY_START);
    expect(text).toContain(UNTRUSTED_BOUNDARY_END);
    expect(text).toContain('## PR Context');
    expect(text).toContain('**Title**: Simple PR');
    expect(text).not.toContain('**Description**');
    expect(text).not.toContain('**Labels**');
    expect(text).not.toContain('## Discussion');
    expect(text).not.toContain('## Review Threads');
    expect(text).not.toContain('## Existing Reviews');
  });

  it('uses singular "comment" for one comment', () => {
    const oneComment: PRContext = {
      metadata: null,
      comments: [{ author: 'bob', body: 'LGTM', createdAt: '2026-03-20T10:00:00Z' }],
      reviewThreads: [],
      existingReviews: [],
    };

    const text = formatPRContext(oneComment);
    expect(text).toContain('## Discussion (1 comment)');
  });

  it('sanitizes tokens in output', () => {
    const ctx: PRContext = {
      metadata: {
        title: 'PR with token ghp_secrettoken123',
        body: 'Contains ghp_anothertoken456',
        author: 'alice',
        labels: [],
        baseBranch: 'main',
        headBranch: 'feature',
      },
      comments: [
        { author: 'bob', body: 'Token: ghp_commenttoken789', createdAt: '2026-03-20T10:00:00Z' },
      ],
      reviewThreads: [],
      existingReviews: [],
    };

    const text = formatPRContext(ctx);

    expect(text).not.toContain('ghp_secrettoken123');
    expect(text).not.toContain('ghp_anothertoken456');
    expect(text).not.toContain('ghp_commenttoken789');
    expect(text).toContain('***');
  });

  it('handles review with empty body', () => {
    const ctx: PRContext = {
      metadata: null,
      comments: [],
      reviewThreads: [],
      existingReviews: [{ author: 'bot', state: 'APPROVED', body: '' }],
    };

    const text = formatPRContext(ctx);
    expect(text).toContain('@bot: [APPROVED]');
  });
});

describe('hasContent', () => {
  it('returns true when metadata is present', () => {
    expect(
      hasContent({
        metadata: {
          title: 'Test',
          body: '',
          author: 'alice',
          labels: [],
          baseBranch: 'main',
          headBranch: 'test',
        },
        comments: [],
        reviewThreads: [],
        existingReviews: [],
      }),
    ).toBe(true);
  });

  it('returns true when comments are present', () => {
    expect(
      hasContent({
        metadata: null,
        comments: [{ author: 'bob', body: 'LGTM', createdAt: '2026-03-20' }],
        reviewThreads: [],
        existingReviews: [],
      }),
    ).toBe(true);
  });

  it('returns true when review threads are present', () => {
    expect(
      hasContent({
        metadata: null,
        comments: [],
        reviewThreads: [
          { author: 'carol', body: 'Fix this', path: 'file.ts', line: 1, createdAt: '2026-03-20' },
        ],
        existingReviews: [],
      }),
    ).toBe(true);
  });

  it('returns true when existing reviews are present', () => {
    expect(
      hasContent({
        metadata: null,
        comments: [],
        reviewThreads: [],
        existingReviews: [{ author: 'bot', state: 'APPROVED', body: '' }],
      }),
    ).toBe(true);
  });

  it('returns false when everything is empty', () => {
    expect(
      hasContent({
        metadata: null,
        comments: [],
        reviewThreads: [],
        existingReviews: [],
      }),
    ).toBe(false);
  });
});
