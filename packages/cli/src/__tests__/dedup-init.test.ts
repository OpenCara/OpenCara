import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StoredAuth } from '../auth.js';
import {
  formatEntry,
  categorizeItems,
  parseExistingNumbers,
  buildCommentBody,
  fetchRepoFile,
  fetchAllPRs,
  fetchAllIssues,
  initIndex,
  runDedupInit,
} from '../commands/dedup.js';
import type { GitHubItem } from '../commands/dedup.js';

// ── Test Helpers ─────────────────────────────────────────────

function makeItem(overrides: Partial<GitHubItem> = {}): GitHubItem {
  return {
    number: 1,
    title: 'Test item',
    state: 'open',
    labels: [],
    closed_at: null,
    ...overrides,
  };
}

function makePR(overrides: Partial<GitHubItem> = {}): GitHubItem {
  return makeItem({ merged_at: null, ...overrides });
}

const validAuth: StoredAuth = {
  access_token: 'ghp_test123',
  expires_at: Date.now() + 3600_000,
  github_username: 'testuser',
  github_user_id: 12345,
};

// ── formatEntry ──────────────────────────────────────────────

describe('formatEntry', () => {
  it('formats item with labels', () => {
    const item = makeItem({
      number: 42,
      title: 'Fix login bug',
      labels: [{ name: 'bug' }, { name: 'critical' }],
    });
    expect(formatEntry(item)).toBe('- 42(bug, critical): Fix login bug');
  });

  it('formats item without labels', () => {
    const item = makeItem({ number: 10, title: 'Add feature' });
    expect(formatEntry(item)).toBe('- 10(): Add feature');
  });

  it('formats compact entry (archived)', () => {
    const item = makeItem({
      number: 42,
      title: 'Fix login bug',
      labels: [{ name: 'bug' }],
    });
    expect(formatEntry(item, true)).toBe('- 42(): Fix login bug');
  });
});

// ── categorizeItems ──────────────────────────────────────────

describe('categorizeItems', () => {
  const now = new Date('2026-03-26T12:00:00Z').getTime();
  const tenDaysAgo = new Date('2026-03-16T12:00:00Z').toISOString();
  const sixtyDaysAgo = new Date('2026-01-25T12:00:00Z').toISOString();

  it('categorizes open items', () => {
    const items = [makeItem({ number: 1, state: 'open' })];
    const result = categorizeItems(items, 30, now);
    expect(result.open).toHaveLength(1);
    expect(result.recentlyClosed).toHaveLength(0);
    expect(result.archived).toHaveLength(0);
  });

  it('categorizes recently closed items', () => {
    const items = [makeItem({ number: 2, state: 'closed', closed_at: tenDaysAgo })];
    const result = categorizeItems(items, 30, now);
    expect(result.open).toHaveLength(0);
    expect(result.recentlyClosed).toHaveLength(1);
    expect(result.archived).toHaveLength(0);
  });

  it('categorizes archived items', () => {
    const items = [makeItem({ number: 3, state: 'closed', closed_at: sixtyDaysAgo })];
    const result = categorizeItems(items, 30, now);
    expect(result.open).toHaveLength(0);
    expect(result.recentlyClosed).toHaveLength(0);
    expect(result.archived).toHaveLength(1);
  });

  it('handles mixed items', () => {
    const items = [
      makeItem({ number: 1, state: 'open' }),
      makeItem({ number: 2, state: 'closed', closed_at: tenDaysAgo }),
      makeItem({ number: 3, state: 'closed', closed_at: sixtyDaysAgo }),
    ];
    const result = categorizeItems(items, 30, now);
    expect(result.open).toHaveLength(1);
    expect(result.recentlyClosed).toHaveLength(1);
    expect(result.archived).toHaveLength(1);
  });

  it('respects custom recentDays window', () => {
    // With 5-day window, the 10-day-old item should be archived
    const items = [makeItem({ number: 2, state: 'closed', closed_at: tenDaysAgo })];
    const result = categorizeItems(items, 5, now);
    expect(result.recentlyClosed).toHaveLength(0);
    expect(result.archived).toHaveLength(1);
  });

  it('treats closed items with null closed_at as archived', () => {
    const items = [makeItem({ number: 4, state: 'closed', closed_at: null })];
    const result = categorizeItems(items, 30, now);
    expect(result.archived).toHaveLength(1);
  });
});

// ── parseExistingNumbers ─────────────────────────────────────

describe('parseExistingNumbers', () => {
  it('parses numbers from entry lines', () => {
    const body = `<!-- opencara-dedup-index:open -->
## Open Items

- #1 [bug] — Fix
- #42 — Add feature
- #100 [feat] [ui] — Dashboard`;

    const numbers = parseExistingNumbers(body);
    expect(numbers).toEqual(new Set([1, 42, 100]));
  });

  it('returns empty set for empty body', () => {
    const numbers = parseExistingNumbers('<!-- marker -->\n## Header\n');
    expect(numbers).toEqual(new Set());
  });

  it('ignores non-entry lines', () => {
    const body = `## Open Items
Some description text
- #5 — Item
Not a list item #99`;
    const numbers = parseExistingNumbers(body);
    expect(numbers).toEqual(new Set([5]));
  });

  it('parses numbers from new format entries', () => {
    const body = `<!-- opencara-dedup-index:open -->
## Open Items

- 1(bug): Fix
- 42(): Add feature
- 100(feat, ui): Dashboard`;

    const numbers = parseExistingNumbers(body);
    expect(numbers).toEqual(new Set([1, 42, 100]));
  });

  it('parses numbers from mixed old and new format entries', () => {
    const body = `<!-- opencara-dedup-index:open -->
## Open Items

- #1 [bug] — Fix
- 42(cli): Add feature`;

    const numbers = parseExistingNumbers(body);
    expect(numbers).toEqual(new Set([1, 42]));
  });
});

// ── buildCommentBody ─────────────────────────────────────────

describe('buildCommentBody', () => {
  const marker = '<!-- opencara-dedup-index:open -->';
  const header = 'Open Items';

  it('creates new comment when no existing body', () => {
    const items = [
      makeItem({ number: 1, title: 'First' }),
      makeItem({ number: 2, title: 'Second' }),
    ];
    const body = buildCommentBody(marker, header, items, null);
    expect(body).toContain(marker);
    expect(body).toContain('## Open Items');
    expect(body).toContain('- 1(): First');
    expect(body).toContain('- 2(): Second');
  });

  it('merges without duplicates', () => {
    const existingBody = `${marker}\n## Open Items\n\n- #1 — First`;
    const items = [
      makeItem({ number: 1, title: 'First' }),
      makeItem({ number: 3, title: 'Third' }),
    ];
    const body = buildCommentBody(marker, header, items, existingBody);
    // Should contain #1 from existing and add #3
    expect(body).toContain('- #1 — First');
    expect(body).toContain('- 3(): Third');
    // Should NOT have duplicate #1
    const count1 = (body.match(/- #?1[\s(]/g) || []).length;
    expect(count1).toBe(1);
  });

  it('uses compact format for archived', () => {
    const items = [makeItem({ number: 1, title: 'Item', labels: [{ name: 'bug' }] })];
    const body = buildCommentBody(marker, header, items, null, true);
    expect(body).toContain('- 1(): Item');
    expect(body).not.toContain('bug');
  });
});

// ── fetchRepoFile ────────────────────────────────────────────

describe('fetchRepoFile', () => {
  it('returns file content on success', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('version = 1', { status: 200 })) as unknown as typeof fetch;

    const content = await fetchRepoFile('owner', 'repo', '.opencara.toml', 'token', mockFetch);
    expect(content).toBe('version = 1');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/contents/.opencara.toml',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token',
        }),
      }),
    );
  });

  it('returns null on 404', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('Not Found', { status: 404 })) as unknown as typeof fetch;

    const content = await fetchRepoFile('owner', 'repo', 'missing', 'token', mockFetch);
    expect(content).toBeNull();
  });

  it('throws on other errors', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('Server Error', { status: 500 })) as unknown as typeof fetch;

    await expect(fetchRepoFile('owner', 'repo', 'file', 'token', mockFetch)).rejects.toThrow(
      'GitHub API error: 500',
    );
  });
});

// ── fetchAllPRs ──────────────────────────────────────────────

describe('fetchAllPRs', () => {
  it('fetches single page of PRs', async () => {
    const prs = [makePR({ number: 1, title: 'PR 1' })];
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(prs), { status: 200 }),
      ) as unknown as typeof fetch;

    const result = await fetchAllPRs('owner', 'repo', 'token', mockFetch);
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });

  it('paginates multiple pages', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makePR({ number: i + 1 }));
    const page2 = [makePR({ number: 101 })];

    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount++;
      const data = callCount === 1 ? page1 : page2;
      return new Response(JSON.stringify(data), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchAllPRs('owner', 'repo', 'token', mockFetch);
    expect(result).toHaveLength(101);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws on API error', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('Error', { status: 403 })) as unknown as typeof fetch;

    await expect(fetchAllPRs('owner', 'repo', 'token', mockFetch)).rejects.toThrow(
      'GitHub API error: 403',
    );
  });
});

// ── fetchAllIssues ───────────────────────────────────────────

describe('fetchAllIssues', () => {
  it('filters out PRs from issues endpoint', async () => {
    const items = [
      makeItem({ number: 1, title: 'Issue 1' }),
      makeItem({ number: 2, title: 'PR 1', pull_request: { url: '...' } }),
    ];
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(items), { status: 200 }),
      ) as unknown as typeof fetch;

    const result = await fetchAllIssues('owner', 'repo', 'token', mockFetch);
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });
});

// ── initIndex ────────────────────────────────────────────────

describe('initIndex', () => {
  const baseOpts = {
    owner: 'acme',
    repo: 'widgets',
    indexIssue: 53,
    kind: 'prs' as const,
    recentDays: 30,
    dryRun: false,
    token: 'ghp_test',
    log: vi.fn(),
  };

  it('initializes empty index from scratch', async () => {
    const prs = [
      makePR({ number: 1, title: 'Open PR', state: 'open' }),
      makePR({
        number: 2,
        title: 'Recent PR',
        state: 'closed',
        closed_at: new Date(Date.now() - 5 * 86400_000).toISOString(),
      }),
      makePR({
        number: 3,
        title: 'Old PR',
        state: 'closed',
        closed_at: new Date(Date.now() - 60 * 86400_000).toISOString(),
      }),
    ];

    let callCount = 0;
    const createdComments: string[] = [];

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.includes('/pulls?')) {
        return new Response(JSON.stringify(prs), { status: 200 });
      }
      if (
        url.includes(`/issues/${baseOpts.indexIssue}/comments`) &&
        (!init || init.method !== 'POST')
      ) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes(`/issues/${baseOpts.indexIssue}/comments`) && init?.method === 'POST') {
        callCount++;
        const body = JSON.parse(init.body as string) as { body: string };
        createdComments.push(body.body);
        return new Response(JSON.stringify({ id: callCount }), { status: 201 });
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await initIndex({ ...baseOpts, fetchFn: mockFetch });
    expect(result.openCount).toBe(1);
    expect(result.recentCount).toBe(1);
    expect(result.archivedCount).toBe(1);
    expect(result.newEntries).toBe(3);
    expect(createdComments).toHaveLength(3);
    expect(createdComments[0]).toContain('Open Items');
    expect(createdComments[0]).toContain('- 1(): Open PR');
    expect(createdComments[1]).toContain('Recently Closed');
    expect(createdComments[1]).toContain('- 2(): Recent PR');
    expect(createdComments[2]).toContain('Archived');
    expect(createdComments[2]).toContain('- 3(): Old PR');
  });

  it('merges with existing entries', async () => {
    const prs = [
      makePR({ number: 1, title: 'Existing PR', state: 'open' }),
      makePR({ number: 4, title: 'New PR', state: 'open' }),
    ];

    const existingComments = [
      {
        id: 100,
        body: '<!-- opencara-dedup-index:open -->\n## Open Items\n\n- #1 — Existing PR',
      },
      { id: 101, body: '<!-- opencara-dedup-index:recent -->\n## Recently Closed Items\n' },
      { id: 102, body: '<!-- opencara-dedup-index:archived -->\n## Archived Items\n' },
    ];

    const updatedBodies: Array<{ id: number; body: string }> = [];

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.includes('/pulls?')) {
        return new Response(JSON.stringify(prs), { status: 200 });
      }
      if (
        url.includes(`/issues/${baseOpts.indexIssue}/comments`) &&
        (!init || (init.method !== 'POST' && init.method !== 'PATCH'))
      ) {
        return new Response(JSON.stringify(existingComments), { status: 200 });
      }
      if (url.includes('/issues/comments/') && init?.method === 'PATCH') {
        const idMatch = url.match(/comments\/(\d+)/);
        const body = JSON.parse(init.body as string) as { body: string };
        updatedBodies.push({ id: parseInt(idMatch![1], 10), body: body.body });
        return new Response('{}', { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await initIndex({ ...baseOpts, fetchFn: mockFetch });
    expect(result.openCount).toBe(2);
    expect(result.newEntries).toBe(1); // Only #4 is new

    // Verify the open comment was updated with #4 but #1 not duplicated
    const openUpdate = updatedBodies.find((u) => u.id === 100);
    expect(openUpdate).toBeDefined();
    expect(openUpdate!.body).toContain('- #1 — Existing PR');
    expect(openUpdate!.body).toContain('- 4(): New PR');
    const count1 = (openUpdate!.body.match(/- #?1[\s(]/g) || []).length;
    expect(count1).toBe(1);
  });

  it('dry run does not call GitHub write APIs', async () => {
    const prs = [makePR({ number: 1, title: 'PR 1', state: 'open' })];

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (init?.method === 'POST' || init?.method === 'PATCH') {
        throw new Error('Should not write in dry run mode');
      }
      if (url.includes('/pulls?')) {
        return new Response(JSON.stringify(prs), { status: 200 });
      }
      if (url.includes('/comments')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await initIndex({ ...baseOpts, dryRun: true, fetchFn: mockFetch });
    expect(result.openCount).toBe(1);
    expect(result.newEntries).toBe(1);
  });

  it('works for issues kind', async () => {
    const issues = [makeItem({ number: 10, title: 'Bug report', state: 'open' })];

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.includes('/issues?state=all')) {
        return new Response(JSON.stringify(issues), { status: 200 });
      }
      if (url.includes('/comments') && (!init || init.method !== 'POST')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await initIndex({
      ...baseOpts,
      kind: 'issues',
      fetchFn: mockFetch,
    });
    expect(result.openCount).toBe(1);
  });
});

// ── runDedupInit ─────────────────────────────────────────────

describe('runDedupInit', () => {
  let log: ReturnType<typeof vi.fn>;
  let logError: ReturnType<typeof vi.fn>;
  let originalExitCode: number | undefined;

  beforeEach(() => {
    log = vi.fn();
    logError = vi.fn();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it('requires authentication', async () => {
    await runDedupInit({ repo: 'owner/repo' }, { log, logError, loadAuthFn: () => null });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('Not authenticated'));
    expect(process.exitCode).toBe(1);
  });

  it('rejects expired auth', async () => {
    const expiredAuth = { ...validAuth, expires_at: Date.now() - 1000 };
    await runDedupInit({ repo: 'owner/repo' }, { log, logError, loadAuthFn: () => expiredAuth });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('Not authenticated'));
    expect(process.exitCode).toBe(1);
  });

  it('requires --repo flag', async () => {
    await runDedupInit({}, { log, logError, loadAuthFn: () => validAuth });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('--repo is required'));
    expect(process.exitCode).toBe(1);
  });

  it('validates repo format', async () => {
    await runDedupInit({ repo: 'invalid' }, { log, logError, loadAuthFn: () => validAuth });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('Invalid repo format'));
    expect(process.exitCode).toBe(1);
  });

  it('errors when .opencara.toml not found', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('Not Found', { status: 404 })) as unknown as typeof fetch;

    await runDedupInit(
      { repo: 'owner/repo' },
      { log, logError, loadAuthFn: () => validAuth, fetchFn: mockFetch },
    );
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('No .opencara.toml'));
    expect(process.exitCode).toBe(1);
  });

  it('errors when no dedup config in .opencara.toml', async () => {
    const toml = 'version = 1\n\n[review]\nprompt = "Review this"';
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(toml, { status: 200 })) as unknown as typeof fetch;

    await runDedupInit(
      { repo: 'owner/repo' },
      { log, logError, loadAuthFn: () => validAuth, fetchFn: mockFetch },
    );
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('No dedup index issues'));
    expect(process.exitCode).toBe(1);
  });

  it('errors when --all not set and only issues index configured', async () => {
    const toml = `version = 1
[dedup.issues]
index_issue = 10
`;
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('contents/')) {
        return new Response(toml, { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    await runDedupInit(
      { repo: 'owner/repo' },
      { log, logError, loadAuthFn: () => validAuth, fetchFn: mockFetch },
    );
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('No PR dedup index configured'));
    expect(process.exitCode).toBe(1);
  });

  it('validates --days flag', async () => {
    await runDedupInit(
      { repo: 'owner/repo', days: 'abc' },
      { log, logError, loadAuthFn: () => validAuth },
    );
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('--days must be a positive'));
    expect(process.exitCode).toBe(1);
  });

  it('runs successfully with PR dedup config', async () => {
    const toml = `version = 1
[dedup.prs]
index_issue = 53
`;
    const prs = [makePR({ number: 1, title: 'PR 1', state: 'open' })];

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.includes('contents/')) {
        return new Response(toml, { status: 200 });
      }
      if (url.includes('/pulls?')) {
        return new Response(JSON.stringify(prs), { status: 200 });
      }
      if (
        url.includes('/comments') &&
        (!init || (init.method !== 'POST' && init.method !== 'PATCH'))
      ) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await runDedupInit(
      { repo: 'acme/widgets' },
      { log, logError, loadAuthFn: () => validAuth, fetchFn: mockFetch },
    );
    expect(process.exitCode).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Initializing prs'));
  });

  it('runs both indexes with --all', async () => {
    const toml = `version = 1
[dedup.prs]
index_issue = 53

[dedup.issues]
index_issue = 54
`;
    const prs = [makePR({ number: 1, title: 'PR 1', state: 'open' })];
    const issues = [makeItem({ number: 10, title: 'Issue 1', state: 'open' })];

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.includes('contents/')) {
        return new Response(toml, { status: 200 });
      }
      if (url.includes('/pulls?')) {
        return new Response(JSON.stringify(prs), { status: 200 });
      }
      if (url.includes('/issues?state=all')) {
        return new Response(JSON.stringify(issues), { status: 200 });
      }
      if (
        url.includes('/comments') &&
        (!init || (init.method !== 'POST' && init.method !== 'PATCH'))
      ) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await runDedupInit(
      { repo: 'acme/widgets', all: true },
      { log, logError, loadAuthFn: () => validAuth, fetchFn: mockFetch },
    );
    expect(process.exitCode).toBeUndefined();
    // Should have logs for both prs and issues
    const logCalls = log.mock.calls.map((c: string[]) => c[0]);
    expect(logCalls.some((c: string) => c.includes('prs'))).toBe(true);
    expect(logCalls.some((c: string) => c.includes('issues'))).toBe(true);
  });

  it('supports dry run mode', async () => {
    const toml = `version = 1
[dedup.prs]
index_issue = 53
`;
    const prs = [makePR({ number: 1, title: 'PR 1', state: 'open' })];

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (init?.method === 'POST' || init?.method === 'PATCH') {
        throw new Error('Should not write in dry run');
      }
      if (url.includes('contents/')) {
        return new Response(toml, { status: 200 });
      }
      if (url.includes('/pulls?')) {
        return new Response(JSON.stringify(prs), { status: 200 });
      }
      if (url.includes('/comments')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    await runDedupInit(
      { repo: 'acme/widgets', dryRun: true },
      { log, logError, loadAuthFn: () => validAuth, fetchFn: mockFetch },
    );
    expect(process.exitCode).toBeUndefined();
    const logCalls = log.mock.calls.map((c: string[]) => c[0]);
    expect(logCalls.some((c: string) => c.includes('Dry run'))).toBe(true);
  });
});
