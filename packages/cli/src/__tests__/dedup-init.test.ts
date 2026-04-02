import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolExecutorResult } from '../tool-executor.js';
import {
  formatEntry,
  formatEntryWithDescription,
  categorizeItems,
  parseExistingNumbers,
  buildCommentBody,
  buildIndexEntryPrompt,
  parseIndexEntryResponse,
  generateAIEntry,
  fetchRepoFile,
  fetchAllPRs,
  fetchAllIssues,
  initIndex,
  runDedupInit,
} from '../commands/dedup.js';
import type { GitHubItem, ExecGhFn } from '../commands/dedup.js';

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
  it('returns file content on success', () => {
    const mockExecGh: ExecGhFn = vi.fn().mockReturnValue('version = 1');

    const content = fetchRepoFile('owner', 'repo', '.opencara.toml', mockExecGh);
    expect(content).toBe('version = 1');
    expect(mockExecGh).toHaveBeenCalledWith([
      'api',
      'repos/owner/repo/contents/.opencara.toml',
      '-H',
      'Accept: application/vnd.github.raw+json',
    ]);
  });

  it('returns null on 404', () => {
    const error = new Error('gh failed');
    (error as { stderr?: string }).stderr = 'HTTP 404: Not Found';
    const mockExecGh: ExecGhFn = vi.fn().mockImplementation(() => {
      throw error;
    });

    const content = fetchRepoFile('owner', 'repo', 'missing', mockExecGh);
    expect(content).toBeNull();
  });

  it('throws on other errors', () => {
    const error = new Error('gh failed');
    (error as { stderr?: string }).stderr = 'HTTP 500: Internal Server Error';
    const mockExecGh: ExecGhFn = vi.fn().mockImplementation(() => {
      throw error;
    });

    expect(() => fetchRepoFile('owner', 'repo', 'file', mockExecGh)).toThrow(
      'gh API error fetching file',
    );
  });
});

// ── fetchAllPRs ──────────────────────────────────────────────

describe('fetchAllPRs', () => {
  it('fetches PRs via gh pr list', () => {
    const ghOutput = JSON.stringify([
      {
        number: 1,
        title: 'PR 1',
        state: 'OPEN',
        labels: [{ name: 'bug' }],
        closedAt: '',
        mergedAt: '',
      },
    ]);
    const mockExecGh: ExecGhFn = vi.fn().mockReturnValue(ghOutput);

    const result = fetchAllPRs('owner', 'repo', mockExecGh);
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
    expect(result[0].state).toBe('open');
    expect(result[0].labels).toEqual([{ name: 'bug' }]);
    expect(mockExecGh).toHaveBeenCalledWith([
      'pr',
      'list',
      '--repo',
      'owner/repo',
      '--state',
      'all',
      '--limit',
      '9999',
      '--json',
      'number,title,state,labels,closedAt,mergedAt',
    ]);
  });

  it('maps MERGED state to closed', () => {
    const ghOutput = JSON.stringify([
      {
        number: 2,
        title: 'Merged PR',
        state: 'MERGED',
        labels: [],
        closedAt: '2026-03-20T00:00:00Z',
        mergedAt: '2026-03-20T00:00:00Z',
      },
    ]);
    const mockExecGh: ExecGhFn = vi.fn().mockReturnValue(ghOutput);

    const result = fetchAllPRs('owner', 'repo', mockExecGh);
    expect(result[0].state).toBe('closed');
    expect(result[0].merged_at).toBe('2026-03-20T00:00:00Z');
  });

  it('maps CLOSED state to closed', () => {
    const ghOutput = JSON.stringify([
      {
        number: 3,
        title: 'Closed PR',
        state: 'CLOSED',
        labels: [],
        closedAt: '2026-03-20T00:00:00Z',
        mergedAt: '',
      },
    ]);
    const mockExecGh: ExecGhFn = vi.fn().mockReturnValue(ghOutput);

    const result = fetchAllPRs('owner', 'repo', mockExecGh);
    expect(result[0].state).toBe('closed');
    expect(result[0].merged_at).toBeNull();
  });

  it('throws on gh CLI error', () => {
    const mockExecGh: ExecGhFn = vi.fn().mockImplementation(() => {
      throw new Error('gh not found');
    });

    expect(() => fetchAllPRs('owner', 'repo', mockExecGh)).toThrow('gh not found');
  });
});

// ── fetchAllIssues ───────────────────────────────────────────

describe('fetchAllIssues', () => {
  it('fetches issues via gh issue list', () => {
    const ghOutput = JSON.stringify([
      {
        number: 1,
        title: 'Issue 1',
        state: 'OPEN',
        labels: [],
        closedAt: '',
      },
    ]);
    const mockExecGh: ExecGhFn = vi.fn().mockReturnValue(ghOutput);

    const result = fetchAllIssues('owner', 'repo', mockExecGh);
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
    expect(result[0].state).toBe('open');
    expect(mockExecGh).toHaveBeenCalledWith([
      'issue',
      'list',
      '--repo',
      'owner/repo',
      '--state',
      'all',
      '--limit',
      '9999',
      '--json',
      'number,title,state,labels,closedAt',
    ]);
  });

  it('maps CLOSED state to closed with closedAt', () => {
    const ghOutput = JSON.stringify([
      {
        number: 2,
        title: 'Closed Issue',
        state: 'CLOSED',
        labels: [{ name: 'bug' }],
        closedAt: '2026-03-20T00:00:00Z',
      },
    ]);
    const mockExecGh: ExecGhFn = vi.fn().mockReturnValue(ghOutput);

    const result = fetchAllIssues('owner', 'repo', mockExecGh);
    expect(result[0].state).toBe('closed');
    expect(result[0].closed_at).toBe('2026-03-20T00:00:00Z');
    expect(result[0].labels).toEqual([{ name: 'bug' }]);
  });
});

// ── initIndex ────────────────────────────────────────────────

describe('initIndex', () => {
  /** Build a mock execGh that returns canned data based on args. */
  function buildMockExecGh(opts: {
    prs?: GitHubItem[];
    issues?: GitHubItem[];
    existingComments?: Array<{ id: number; body: string }>;
    createdComments?: string[];
    updatedBodies?: Array<{ id: number; body: string }>;
    failOnWrite?: boolean;
  }): ExecGhFn {
    const createdComments = opts.createdComments ?? [];
    const updatedBodies = opts.updatedBodies ?? [];
    let commentIdCounter = 200;

    return vi.fn((args: string[]): string => {
      const argsStr = args.join(' ');

      // gh pr list
      if (args[0] === 'pr' && args[1] === 'list') {
        const items = (opts.prs ?? []).map((pr) => ({
          number: pr.number,
          title: pr.title,
          state: pr.state === 'closed' ? (pr.merged_at ? 'MERGED' : 'CLOSED') : 'OPEN',
          labels: pr.labels,
          closedAt: pr.closed_at ?? '',
          mergedAt: pr.merged_at ?? '',
        }));
        return JSON.stringify(items);
      }

      // gh issue list
      if (args[0] === 'issue' && args[1] === 'list') {
        const items = (opts.issues ?? []).map((issue) => ({
          number: issue.number,
          title: issue.title,
          state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
          labels: issue.labels,
          closedAt: issue.closed_at ?? '',
        }));
        return JSON.stringify(items);
      }

      // gh api --paginate .../comments (fetch comments)
      if (args.includes('--paginate') && argsStr.includes('/comments')) {
        return JSON.stringify(opts.existingComments ?? []);
      }

      // gh api -X POST .../comments (create comment)
      if (args.includes('-X') && args.includes('POST') && argsStr.includes('/comments')) {
        if (opts.failOnWrite) throw new Error('Should not write');
        // -f body=... format: find the arg after `-f` that starts with `body=`
        const fIdx = args.indexOf('-f');
        const bodyArg = fIdx >= 0 ? args[fIdx + 1] : '';
        const body = bodyArg.startsWith('body=') ? bodyArg.slice(5) : bodyArg;
        createdComments.push(body);
        commentIdCounter++;
        return String(commentIdCounter);
      }

      // gh api -X PATCH .../comments/{id} (update comment)
      if (args.includes('-X') && args.includes('PATCH') && argsStr.includes('/comments/')) {
        if (opts.failOnWrite) throw new Error('Should not write');
        const pathArg = args[1];
        const idMatch = pathArg.match(/comments\/(\d+)/);
        const fIdx = args.indexOf('-f');
        const bodyArg = fIdx >= 0 ? args[fIdx + 1] : '';
        const body = bodyArg.startsWith('body=') ? bodyArg.slice(5) : bodyArg;
        updatedBodies.push({ id: parseInt(idMatch![1], 10), body });
        return '{}';
      }

      throw new Error(`Unexpected gh call: ${argsStr}`);
    });
  }

  const baseOpts = {
    owner: 'acme',
    repo: 'widgets',
    indexIssue: 53,
    kind: 'prs' as const,
    recentDays: 30,
    dryRun: false,
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

    const createdComments: string[] = [];
    const mockExecGh = buildMockExecGh({ prs, createdComments });

    const result = await initIndex({ ...baseOpts, execGh: mockExecGh });
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
    const mockExecGh = buildMockExecGh({ prs, existingComments, updatedBodies });

    const result = await initIndex({ ...baseOpts, execGh: mockExecGh });
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

    const mockExecGh = buildMockExecGh({ prs, failOnWrite: true });

    const result = await initIndex({ ...baseOpts, dryRun: true, execGh: mockExecGh });
    expect(result.openCount).toBe(1);
    expect(result.newEntries).toBe(1);
  });

  it('works for issues kind', async () => {
    const issues = [makeItem({ number: 10, title: 'Bug report', state: 'open' })];
    const createdComments: string[] = [];
    const mockExecGh = buildMockExecGh({ issues, createdComments });

    const result = await initIndex({
      ...baseOpts,
      kind: 'issues',
      execGh: mockExecGh,
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

  it('requires --repo flag', async () => {
    await runDedupInit({}, { log, logError });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('--repo is required'));
    expect(process.exitCode).toBe(1);
  });

  it('validates repo format', async () => {
    await runDedupInit({ repo: 'invalid' }, { log, logError });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('Invalid repo format'));
    expect(process.exitCode).toBe(1);
  });

  it('errors when .opencara.toml not found', async () => {
    const error = new Error('gh failed');
    (error as { stderr?: string }).stderr = 'HTTP 404: Not Found';
    const mockExecGh: ExecGhFn = vi.fn().mockImplementation(() => {
      throw error;
    });

    await runDedupInit({ repo: 'owner/repo' }, { log, logError, execGh: mockExecGh });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('No .opencara.toml'));
    expect(process.exitCode).toBe(1);
  });

  it('errors when no dedup config in .opencara.toml', async () => {
    const toml = 'version = 1\n\n[review]\nprompt = "Review this"';
    const mockExecGh: ExecGhFn = vi.fn().mockReturnValue(toml);

    await runDedupInit({ repo: 'owner/repo' }, { log, logError, execGh: mockExecGh });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('No dedup index issues'));
    expect(process.exitCode).toBe(1);
  });

  it('errors when --all not set and only issues index configured', async () => {
    const toml = `version = 1
[dedup.issues]
index_issue = 10
`;
    const mockExecGh: ExecGhFn = vi.fn((args: string[]) => {
      if (args[0] === 'api' && args[1].includes('contents/')) {
        return toml;
      }
      throw new Error(`Unexpected: ${args.join(' ')}`);
    });

    await runDedupInit({ repo: 'owner/repo' }, { log, logError, execGh: mockExecGh });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('No PR dedup index configured'));
    expect(process.exitCode).toBe(1);
  });

  it('validates --days flag', async () => {
    await runDedupInit({ repo: 'owner/repo', days: 'abc' }, { log, logError });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('--days must be a positive'));
    expect(process.exitCode).toBe(1);
  });

  it('runs successfully with PR dedup config', async () => {
    const toml = `version = 1
[dedup.prs]
index_issue = 53
`;
    const prs = [
      {
        number: 1,
        title: 'PR 1',
        state: 'OPEN',
        labels: [],
        closedAt: '',
        mergedAt: '',
      },
    ];

    let commentIdCounter = 200;
    const mockExecGh: ExecGhFn = vi.fn((args: string[]) => {
      const argsStr = args.join(' ');
      // fetchRepoFile
      if (args[0] === 'api' && args[1].includes('contents/')) {
        return toml;
      }
      // fetchAllPRs
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify(prs);
      }
      // fetchIssueComments
      if (args.includes('--paginate') && argsStr.includes('/comments')) {
        return JSON.stringify([]);
      }
      // createIssueComment
      if (args.includes('-X') && args.includes('POST')) {
        commentIdCounter++;
        return String(commentIdCounter);
      }
      return '{}';
    });

    await runDedupInit({ repo: 'acme/widgets' }, { log, logError, execGh: mockExecGh });
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
    const prs = [
      { number: 1, title: 'PR 1', state: 'OPEN', labels: [], closedAt: '', mergedAt: '' },
    ];
    const issues = [{ number: 10, title: 'Issue 1', state: 'OPEN', labels: [], closedAt: '' }];

    let commentIdCounter = 200;
    const mockExecGh: ExecGhFn = vi.fn((args: string[]) => {
      const argsStr = args.join(' ');
      if (args[0] === 'api' && args[1].includes('contents/')) return toml;
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(issues);
      if (args.includes('--paginate') && argsStr.includes('/comments')) return JSON.stringify([]);
      if (args.includes('-X') && args.includes('POST')) {
        commentIdCounter++;
        return String(commentIdCounter);
      }
      return '{}';
    });

    await runDedupInit({ repo: 'acme/widgets', all: true }, { log, logError, execGh: mockExecGh });
    expect(process.exitCode).toBeUndefined();
    const logCalls = log.mock.calls.map((c: string[]) => c[0]);
    expect(logCalls.some((c: string) => c.includes('prs'))).toBe(true);
    expect(logCalls.some((c: string) => c.includes('issues'))).toBe(true);
  });

  it('supports dry run mode', async () => {
    const toml = `version = 1
[dedup.prs]
index_issue = 53
`;
    const prs = [
      { number: 1, title: 'PR 1', state: 'OPEN', labels: [], closedAt: '', mergedAt: '' },
    ];

    const mockExecGh: ExecGhFn = vi.fn((args: string[]) => {
      const argsStr = args.join(' ');
      if (args.includes('-X') && (args.includes('POST') || args.includes('PATCH'))) {
        throw new Error('Should not write in dry run');
      }
      if (args[0] === 'api' && args[1].includes('contents/')) return toml;
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
      if (args.includes('--paginate') && argsStr.includes('/comments')) return JSON.stringify([]);
      throw new Error(`Unexpected: ${argsStr}`);
    });

    await runDedupInit(
      { repo: 'acme/widgets', dryRun: true },
      { log, logError, execGh: mockExecGh },
    );
    expect(process.exitCode).toBeUndefined();
    const logCalls = log.mock.calls.map((c: string[]) => c[0]);
    expect(logCalls.some((c: string) => c.includes('Dry run'))).toBe(true);
  });

  it('errors when --agent specifies unknown tool', async () => {
    const toml = `version = 1
[dedup.prs]
index_issue = 53
`;
    const mockExecGh: ExecGhFn = vi.fn((args: string[]) => {
      if (args[0] === 'api' && args[1].includes('contents/')) return toml;
      throw new Error(`Unexpected: ${args.join(' ')}`);
    });

    await runDedupInit(
      { repo: 'acme/widgets', agent: 'nonexistent-tool' },
      { log, logError, execGh: mockExecGh, resolveAgentCommandFn: () => null },
    );
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('Unknown agent tool'));
    expect(process.exitCode).toBe(1);
  });

  it('runs with --agent using AI-enriched descriptions', async () => {
    const toml = `version = 1
[dedup.prs]
index_issue = 53
`;
    const prs = [
      { number: 1, title: 'Fix login bug', state: 'OPEN', labels: [], closedAt: '', mergedAt: '' },
    ];
    const createdComments: string[] = [];
    let commentIdCounter = 200;

    const mockExecGh: ExecGhFn = vi.fn((args: string[]) => {
      const argsStr = args.join(' ');
      if (args[0] === 'api' && args[1].includes('contents/')) return toml;
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
      if (args.includes('--paginate') && argsStr.includes('/comments')) return JSON.stringify([]);
      if (args.includes('-X') && args.includes('POST')) {
        const fIdx = args.indexOf('-f');
        const bodyArg = fIdx >= 0 ? args[fIdx + 1] : '';
        const body = bodyArg.startsWith('body=') ? bodyArg.slice(5) : bodyArg;
        createdComments.push(body);
        commentIdCounter++;
        return String(commentIdCounter);
      }
      return '{}';
    });

    const mockRunTool = vi.fn(async () => ({
      stdout: '{"description": "Authentication flow fix for login page"}',
      stderr: '',
      tokensUsed: 100,
      tokensParsed: false,
      tokenDetail: { input: 50, output: 50, total: 100, parsed: false },
    }));

    await runDedupInit(
      { repo: 'acme/widgets', agent: 'claude' },
      {
        log,
        logError,
        execGh: mockExecGh,
        resolveAgentCommandFn: () => 'claude --print',
        runTool: mockRunTool,
      },
    );
    expect(process.exitCode).toBeUndefined();
    expect(mockRunTool).toHaveBeenCalled();
    // Open comment should contain AI-generated description instead of raw title
    expect(createdComments[0]).toContain('Authentication flow fix for login page');
    expect(createdComments[0]).not.toContain('Fix login bug');
  });

  it('falls back to raw title when AI fails for an item with --agent', async () => {
    const toml = `version = 1
[dedup.prs]
index_issue = 53
`;
    const prs = [
      { number: 1, title: 'Fix login bug', state: 'OPEN', labels: [], closedAt: '', mergedAt: '' },
    ];
    const createdComments: string[] = [];
    let commentIdCounter = 200;

    const mockExecGh: ExecGhFn = vi.fn((args: string[]) => {
      const argsStr = args.join(' ');
      if (args[0] === 'api' && args[1].includes('contents/')) return toml;
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
      if (args.includes('--paginate') && argsStr.includes('/comments')) return JSON.stringify([]);
      if (args.includes('-X') && args.includes('POST')) {
        const fIdx = args.indexOf('-f');
        const bodyArg = fIdx >= 0 ? args[fIdx + 1] : '';
        const body = bodyArg.startsWith('body=') ? bodyArg.slice(5) : bodyArg;
        createdComments.push(body);
        commentIdCounter++;
        return String(commentIdCounter);
      }
      return '{}';
    });

    // AI tool throws an error
    const mockRunTool = vi.fn(async () => {
      throw new Error('AI tool timed out');
    });

    await runDedupInit(
      { repo: 'acme/widgets', agent: 'claude' },
      {
        log,
        logError,
        execGh: mockExecGh,
        resolveAgentCommandFn: () => 'claude --print',
        runTool: mockRunTool,
      },
    );
    expect(process.exitCode).toBeUndefined();
    // Should fall back to raw title
    expect(createdComments[0]).toContain('Fix login bug');
    // Should log warning about AI failure
    const logCalls = log.mock.calls.map((c: string[]) => c[0]);
    expect(logCalls.some((c: string) => c.includes('AI failed for #1'))).toBe(true);
  });

  it('supports --agent with --dry-run', async () => {
    const toml = `version = 1
[dedup.prs]
index_issue = 53
`;
    const prs = [
      { number: 1, title: 'Fix login bug', state: 'OPEN', labels: [], closedAt: '', mergedAt: '' },
    ];

    const mockExecGh: ExecGhFn = vi.fn((args: string[]) => {
      const argsStr = args.join(' ');
      if (args.includes('-X') && (args.includes('POST') || args.includes('PATCH'))) {
        throw new Error('Should not write in dry run');
      }
      if (args[0] === 'api' && args[1].includes('contents/')) return toml;
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
      if (args.includes('--paginate') && argsStr.includes('/comments')) return JSON.stringify([]);
      throw new Error(`Unexpected: ${argsStr}`);
    });

    const mockRunTool = vi.fn(async () => ({
      stdout: '{"description": "AI enriched description"}',
      stderr: '',
      tokensUsed: 100,
      tokensParsed: false,
      tokenDetail: { input: 50, output: 50, total: 100, parsed: false },
    }));

    await runDedupInit(
      { repo: 'acme/widgets', dryRun: true, agent: 'claude' },
      {
        log,
        logError,
        execGh: mockExecGh,
        resolveAgentCommandFn: () => 'claude --print',
        runTool: mockRunTool,
      },
    );
    expect(process.exitCode).toBeUndefined();
    // AI should still be called in dry-run to show enriched output
    expect(mockRunTool).toHaveBeenCalled();
    const logCalls = log.mock.calls.map((c: string[]) => c[0]);
    expect(logCalls.some((c: string) => c.includes('Dry run'))).toBe(true);
    expect(logCalls.some((c: string) => c.includes('AI enrichment'))).toBe(true);
  });
});

// ── formatEntryWithDescription ───────────────────────────────

describe('formatEntryWithDescription', () => {
  it('formats entry with AI description and labels', () => {
    const item = makeItem({
      number: 42,
      title: 'Fix login bug',
      labels: [{ name: 'bug' }, { name: 'critical' }],
    });
    expect(formatEntryWithDescription(item, 'Authentication fix for login flow')).toBe(
      '- 42(bug, critical): Authentication fix for login flow',
    );
  });

  it('formats compact entry with AI description (ignores labels)', () => {
    const item = makeItem({
      number: 42,
      title: 'Fix login bug',
      labels: [{ name: 'bug' }],
    });
    expect(formatEntryWithDescription(item, 'Auth fix', true)).toBe('- 42(): Auth fix');
  });
});

// ── buildIndexEntryPrompt ────────────────────────────────────

describe('buildIndexEntryPrompt', () => {
  it('includes PR type label for prs kind', () => {
    const item = makeItem({ number: 42, title: 'Fix login', labels: [{ name: 'bug' }] });
    const prompt = buildIndexEntryPrompt(item, 'prs');
    expect(prompt).toContain('PR');
    expect(prompt).toContain('#42');
    expect(prompt).toContain('Fix login');
    expect(prompt).toContain('bug');
  });

  it('includes Issue type label for issues kind', () => {
    const item = makeItem({ number: 10, title: 'Feature request' });
    const prompt = buildIndexEntryPrompt(item, 'issues');
    expect(prompt).toContain('Issue');
    expect(prompt).toContain('#10');
  });

  it('handles items with no labels', () => {
    const item = makeItem({ number: 1, title: 'No labels' });
    const prompt = buildIndexEntryPrompt(item, 'prs');
    expect(prompt).toContain('(none)');
  });
});

// ── parseIndexEntryResponse ──────────────────────────────────

describe('parseIndexEntryResponse', () => {
  it('parses valid JSON response', () => {
    const result = parseIndexEntryResponse('{"description": "Fix authentication bug"}');
    expect(result).toBe('Fix authentication bug');
  });

  it('parses JSON with markdown fences', () => {
    const result = parseIndexEntryResponse('```json\n{"description": "Fix auth"}\n```');
    expect(result).toBe('Fix auth');
  });

  it('returns null for invalid JSON', () => {
    expect(parseIndexEntryResponse('not json')).toBeNull();
  });

  it('returns null for empty description', () => {
    expect(parseIndexEntryResponse('{"description": ""}')).toBeNull();
  });

  it('returns null for missing description field', () => {
    expect(parseIndexEntryResponse('{"summary": "test"}')).toBeNull();
  });
});

// ── generateAIEntry ──────────────────────────────────────────

describe('generateAIEntry', () => {
  it('returns AI description on success', async () => {
    const item = makeItem({ number: 1, title: 'Fix bug' });
    const mockTool = vi.fn(async () => ({
      stdout: '{"description": "Authentication bug fix"}',
      stderr: '',
      tokensUsed: 100,
      tokensParsed: false,
      tokenDetail: { input: 50, output: 50, total: 100, parsed: false },
    }));

    const result = await generateAIEntry(item, 'prs', 'claude --print', mockTool);
    expect(result).toBe('Authentication bug fix');
    expect(mockTool).toHaveBeenCalledWith('claude --print', expect.any(String), 60_000);
  });

  it('returns null when tool throws', async () => {
    const item = makeItem({ number: 1, title: 'Fix bug' });
    const mockTool = vi.fn(async () => {
      throw new Error('Tool timeout');
    });

    const result = await generateAIEntry(item, 'prs', 'claude --print', mockTool);
    expect(result).toBeNull();
  });

  it('returns null when tool output is unparseable', async () => {
    const item = makeItem({ number: 1, title: 'Fix bug' });
    const mockTool = vi.fn(async () => ({
      stdout: 'invalid output with no json',
      stderr: '',
      tokensUsed: 50,
      tokensParsed: false,
      tokenDetail: { input: 25, output: 25, total: 50, parsed: false },
    }));

    const result = await generateAIEntry(item, 'prs', 'claude --print', mockTool);
    expect(result).toBeNull();
  });
});

// ── buildCommentBody with descriptions ───────────────────────

describe('buildCommentBody with AI descriptions', () => {
  const marker = '<!-- opencara-dedup-index:open -->';
  const header = 'Open Items';

  it('uses AI descriptions when available', () => {
    const items = [
      makeItem({ number: 1, title: 'Raw title' }),
      makeItem({ number: 2, title: 'Another raw title' }),
    ];
    const descriptions = new Map<number, string>([[1, 'AI enriched description']]);
    const body = buildCommentBody(marker, header, items, null, false, descriptions);
    expect(body).toContain('- 1(): AI enriched description');
    expect(body).toContain('- 2(): Another raw title');
  });

  it('falls back to raw title when no AI description', () => {
    const items = [makeItem({ number: 1, title: 'Raw title' })];
    const descriptions = new Map<number, string>();
    const body = buildCommentBody(marker, header, items, null, false, descriptions);
    expect(body).toContain('- 1(): Raw title');
  });
});

// ── initIndex with agent ─────────────────────────────────────

describe('initIndex with agent', () => {
  function buildMockExecGh(opts: {
    prs?: Array<{
      number: number;
      title: string;
      state: string;
      labels: Array<{ name: string }>;
      closedAt: string;
      mergedAt: string;
    }>;
    existingComments?: Array<{ id: number; body: string }>;
    createdComments?: string[];
    updatedBodies?: Array<{ id: number; body: string }>;
  }): ExecGhFn {
    const createdComments = opts.createdComments ?? [];
    const updatedBodies = opts.updatedBodies ?? [];
    let commentIdCounter = 200;

    return vi.fn((args: string[]): string => {
      const argsStr = args.join(' ');

      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify(opts.prs ?? []);
      }
      if (args.includes('--paginate') && argsStr.includes('/comments')) {
        return JSON.stringify(opts.existingComments ?? []);
      }
      if (args.includes('-X') && args.includes('POST') && argsStr.includes('/comments')) {
        const fIdx = args.indexOf('-f');
        const bodyArg = fIdx >= 0 ? args[fIdx + 1] : '';
        const body = bodyArg.startsWith('body=') ? bodyArg.slice(5) : bodyArg;
        createdComments.push(body);
        commentIdCounter++;
        return String(commentIdCounter);
      }
      if (args.includes('-X') && args.includes('PATCH') && argsStr.includes('/comments/')) {
        const pathArg = args[1];
        const idMatch = pathArg.match(/comments\/(\d+)/);
        const fIdx = args.indexOf('-f');
        const bodyArg = fIdx >= 0 ? args[fIdx + 1] : '';
        const body = bodyArg.startsWith('body=') ? bodyArg.slice(5) : bodyArg;
        updatedBodies.push({ id: parseInt(idMatch![1], 10), body });
        return '{}';
      }
      throw new Error(`Unexpected gh call: ${argsStr}`);
    });
  }

  const baseOpts = {
    owner: 'acme',
    repo: 'widgets',
    indexIssue: 53,
    kind: 'prs' as const,
    recentDays: 30,
    dryRun: false,
    log: vi.fn(),
  };

  it('uses AI-enriched descriptions when agentCommandTemplate is set', async () => {
    const prs = [
      {
        number: 1,
        title: 'Open PR',
        state: 'OPEN',
        labels: [] as Array<{ name: string }>,
        closedAt: '',
        mergedAt: '',
      },
    ];
    const createdComments: string[] = [];
    const mockExecGh = buildMockExecGh({ prs, createdComments });

    const mockRunTool = vi.fn(
      async (): Promise<ToolExecutorResult> => ({
        stdout: '{"description": "AI generated description"}',
        stderr: '',
        tokensUsed: 100,
        tokensParsed: false,
        tokenDetail: { input: 50, output: 50, total: 100, parsed: false },
      }),
    );

    const result = await initIndex({
      ...baseOpts,
      execGh: mockExecGh,
      agentCommandTemplate: 'claude --print',
      runTool: mockRunTool,
    });
    expect(result.openCount).toBe(1);
    expect(result.newEntries).toBe(1);
    expect(mockRunTool).toHaveBeenCalledTimes(1);
    expect(createdComments[0]).toContain('AI generated description');
    expect(createdComments[0]).not.toContain('Open PR');
  });

  it('falls back to raw title when AI fails for an item', async () => {
    const prs = [
      {
        number: 1,
        title: 'PR One',
        state: 'OPEN',
        labels: [] as Array<{ name: string }>,
        closedAt: '',
        mergedAt: '',
      },
      {
        number: 2,
        title: 'PR Two',
        state: 'OPEN',
        labels: [] as Array<{ name: string }>,
        closedAt: '',
        mergedAt: '',
      },
    ];
    const createdComments: string[] = [];
    const mockExecGh = buildMockExecGh({ prs, createdComments });

    let callCount = 0;
    const mockRunTool = vi.fn(async (): Promise<ToolExecutorResult> => {
      callCount++;
      if (callCount === 1) {
        return {
          stdout: '{"description": "AI description for #1"}',
          stderr: '',
          tokensUsed: 100,
          tokensParsed: false,
          tokenDetail: { input: 50, output: 50, total: 100, parsed: false },
        };
      }
      // Second call fails
      throw new Error('Tool timeout');
    });

    const result = await initIndex({
      ...baseOpts,
      execGh: mockExecGh,
      agentCommandTemplate: 'claude --print',
      runTool: mockRunTool,
    });
    expect(result.openCount).toBe(2);
    expect(mockRunTool).toHaveBeenCalledTimes(2);
    // #1 should use AI description, #2 should fall back to raw title
    expect(createdComments[0]).toContain('AI description for #1');
    expect(createdComments[0]).toContain('PR Two');
  });

  it('skips AI enrichment when no new entries exist', async () => {
    const prs = [
      {
        number: 1,
        title: 'Existing PR',
        state: 'OPEN',
        labels: [] as Array<{ name: string }>,
        closedAt: '',
        mergedAt: '',
      },
    ];

    const existingComments = [
      {
        id: 100,
        body: '<!-- opencara-dedup-index:open -->\n## Open Items\n\n- 1(): Existing PR',
      },
      { id: 101, body: '<!-- opencara-dedup-index:recent -->\n## Recently Closed Items\n' },
      { id: 102, body: '<!-- opencara-dedup-index:archived -->\n## Archived Items\n' },
    ];

    const mockExecGh = buildMockExecGh({ prs, existingComments });

    const mockRunTool = vi.fn(
      async (): Promise<ToolExecutorResult> => ({
        stdout: '{"description": "Should not be called"}',
        stderr: '',
        tokensUsed: 100,
        tokensParsed: false,
        tokenDetail: { input: 50, output: 50, total: 100, parsed: false },
      }),
    );

    const result = await initIndex({
      ...baseOpts,
      execGh: mockExecGh,
      agentCommandTemplate: 'claude --print',
      runTool: mockRunTool,
    });
    expect(result.newEntries).toBe(0);
    // AI should NOT be called since there are no new entries
    expect(mockRunTool).not.toHaveBeenCalled();
  });
});
