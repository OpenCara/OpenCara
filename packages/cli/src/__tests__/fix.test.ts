import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PollTask } from '@opencara/shared';
import type { ToolExecutorResult } from '../tool-executor.js';
import {
  buildFixPrompt,
  countReviewComments,
  executeFix,
  executeFixTask,
  checkoutPRBranch,
  commitAndPush,
  BranchNotFoundError,
  PushFailedError,
  type FixExecutorDeps,
} from '../fix.js';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
const mockExecFileSync = vi.mocked(execFileSync);

// ── Helpers ──────────────────────────────────────────────────────

function makeTask(overrides: Partial<PollTask> = {}): PollTask {
  return {
    task_id: 'task-fix-1',
    owner: 'acme',
    repo: 'widgets',
    pr_number: 42,
    diff_url: 'https://github.com/acme/widgets/pull/42.diff',
    timeout_seconds: 300,
    prompt: '',
    role: 'fix',
    head_ref: 'feat/login-fix',
    head_sha: 'abc123',
    pr_review_comments:
      '### File: src/auth.ts (line 42)\nReviewer: alice\n> Handle null case\n\n### General Review Comment\nReviewer: bob\n> Improve error messages',
    ...overrides,
  };
}

function makeToolResult(stdout: string = 'Applied fixes'): ToolExecutorResult {
  return {
    stdout,
    stderr: '',
    tokensUsed: 200,
    tokensParsed: false,
    tokenDetail: { input: 0, output: 200, total: 200, parsed: false },
  };
}

function makeParsedToolResult(): ToolExecutorResult {
  return {
    stdout: 'Applied fixes',
    stderr: '',
    tokensUsed: 500,
    tokensParsed: true,
    tokenDetail: { input: 300, output: 200, total: 500, parsed: true },
  };
}

const mockLogger = {
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
};

function makeClient() {
  return {
    post: vi.fn().mockResolvedValue({ success: true }),
  };
}

// ── buildFixPrompt ───────────────────────────────────────────────

describe('buildFixPrompt', () => {
  it('includes owner, repo, and PR number', () => {
    const prompt = buildFixPrompt({
      owner: 'acme',
      repo: 'widgets',
      prNumber: 42,
      diffContent: 'diff --git a/foo.ts',
      prReviewComments: '### File: foo.ts\nReviewer: alice\n> Fix this',
    });
    expect(prompt).toContain('acme/widgets');
    expect(prompt).toContain('PR #42');
  });

  it('includes diff content', () => {
    const prompt = buildFixPrompt({
      owner: 'acme',
      repo: 'widgets',
      prNumber: 1,
      diffContent: 'diff --git a/bar.ts b/bar.ts\n+const x = 1;',
      prReviewComments: 'some comments',
    });
    expect(prompt).toContain('diff --git a/bar.ts');
    expect(prompt).toContain('+const x = 1;');
  });

  it('includes review comments', () => {
    const comments = '### File: src/auth.ts (line 42)\nReviewer: alice\n> Handle null case';
    const prompt = buildFixPrompt({
      owner: 'acme',
      repo: 'widgets',
      prNumber: 1,
      diffContent: 'diff',
      prReviewComments: comments,
    });
    expect(prompt).toContain('Handle null case');
    expect(prompt).toContain('src/auth.ts');
  });

  it('includes custom prompt when provided', () => {
    const prompt = buildFixPrompt({
      owner: 'acme',
      repo: 'widgets',
      prNumber: 1,
      diffContent: 'diff',
      prReviewComments: 'comments',
      customPrompt: 'Follow our style guide',
    });
    expect(prompt).toContain('Follow our style guide');
    expect(prompt).toContain('Repo-Specific Instructions');
  });

  it('omits custom prompt section when not provided', () => {
    const prompt = buildFixPrompt({
      owner: 'acme',
      repo: 'widgets',
      prNumber: 1,
      diffContent: 'diff',
      prReviewComments: 'comments',
    });
    expect(prompt).not.toContain('Repo-Specific Instructions');
  });
});

// ── countReviewComments ──────────────────────────────────────────

describe('countReviewComments', () => {
  it('returns 0 for empty string', () => {
    expect(countReviewComments('')).toBe(0);
  });

  it('counts File headers', () => {
    const text = '### File: src/a.ts (line 1)\ncomment\n### File: src/b.ts (line 5)\nanother';
    expect(countReviewComments(text)).toBe(2);
  });

  it('counts General Review Comment headers', () => {
    const text = '### General Review Comment\nReviewer: bob\n> Fix this';
    expect(countReviewComments(text)).toBe(1);
  });

  it('counts mixed headers', () => {
    const text =
      '### File: src/a.ts (line 1)\ncomment\n### General Review Comment\ncomment\n### File: src/b.ts (line 3)\ncomment';
    expect(countReviewComments(text)).toBe(3);
  });
});

// ── checkoutPRBranch ─────────────────────────────────────────────

describe('checkoutPRBranch', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockExecFileSync.mockReturnValue('');
  });

  it('fetches and checks out the branch', () => {
    checkoutPRBranch('/tmp/worktree', 'feat/login');
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    // First call: fetch
    expect(mockExecFileSync.mock.calls[0][1]).toEqual(['fetch', 'origin', 'feat/login']);
    // Second call: checkout
    expect(mockExecFileSync.mock.calls[1][1]).toEqual([
      'checkout',
      '-B',
      'feat/login',
      'origin/feat/login',
    ]);
  });

  it('throws on fetch failure', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('fetch failed');
    });
    expect(() => checkoutPRBranch('/tmp/worktree', 'nonexistent')).toThrow();
  });
});

// ── commitAndPush ────────────────────────────────────────────────

describe('commitAndPush', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it('returns zero files when no changes detected', () => {
    // add -A, status --porcelain (empty)
    mockExecFileSync.mockReturnValueOnce(''); // add -A
    mockExecFileSync.mockReturnValueOnce(''); // status --porcelain
    const result = commitAndPush('/tmp/wt', 'feat/fix', 42);
    expect(result.filesChanged).toBe(0);
    expect(result.commitSha).toBe('');
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it('commits and pushes when changes exist', () => {
    mockExecFileSync.mockReturnValueOnce(''); // add -A
    mockExecFileSync.mockReturnValueOnce('M src/foo.ts\nM src/bar.ts\n'); // status
    mockExecFileSync.mockReturnValueOnce(''); // commit
    mockExecFileSync.mockReturnValueOnce('abc1234def\n'); // rev-parse HEAD
    mockExecFileSync.mockReturnValueOnce(''); // push
    const result = commitAndPush('/tmp/wt', 'feat/fix', 42);
    expect(result.filesChanged).toBe(2);
    expect(result.commitSha).toBe('abc1234def');
    // Check commit message
    expect(mockExecFileSync.mock.calls[2][1]).toEqual([
      'commit',
      '-m',
      'Fix review comments on PR #42',
    ]);
    // Check push args (never force-push)
    expect(mockExecFileSync.mock.calls[4][1]).toEqual(['push', 'origin', 'feat/fix']);
  });

  it('throws on push failure', () => {
    mockExecFileSync.mockReturnValueOnce(''); // add
    mockExecFileSync.mockReturnValueOnce('M src/foo.ts\n'); // status
    mockExecFileSync.mockReturnValueOnce(''); // commit
    mockExecFileSync.mockReturnValueOnce('sha123\n'); // rev-parse
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('rejected: non-fast-forward');
    });
    expect(() => commitAndPush('/tmp/wt', 'feat/fix', 10)).toThrow();
  });
});

// ── executeFix ───────────────────────────────────────────────────

describe('executeFix', () => {
  it('calls runTool with correct params', async () => {
    const task = makeTask();
    const mockRunTool = vi.fn().mockResolvedValue(makeToolResult());
    const deps: FixExecutorDeps = { commandTemplate: 'claude --print' };

    await executeFix(task, 'diff content', deps, 300, '/tmp/wt', undefined, mockRunTool);

    expect(mockRunTool).toHaveBeenCalledOnce();
    const [template, prompt, timeout, _signal, _vars, cwd] = mockRunTool.mock.calls[0];
    expect(template).toBe('claude --print');
    expect(prompt).toContain('acme/widgets');
    expect(prompt).toContain('Handle null case');
    expect(prompt).toContain('diff content');
    expect(timeout).toBe(270_000); // 300s - 30s safety margin
    expect(cwd).toBe('/tmp/wt');
  });

  it('throws when timeout is too short', async () => {
    const task = makeTask();
    const mockRunTool = vi.fn();
    const deps: FixExecutorDeps = { commandTemplate: 'claude --print' };

    await expect(
      executeFix(task, 'diff', deps, 20, '/tmp/wt', undefined, mockRunTool),
    ).rejects.toThrow('Not enough time remaining');
    expect(mockRunTool).not.toHaveBeenCalled();
  });

  it('computes estimated tokens when not parsed', async () => {
    const task = makeTask();
    const mockRunTool = vi.fn().mockResolvedValue(makeToolResult());
    const deps: FixExecutorDeps = { commandTemplate: 'claude --print' };

    const result = await executeFix(task, 'diff', deps, 300, '/tmp/wt', undefined, mockRunTool);

    expect(result.tokensEstimated).toBe(true);
    expect(result.tokensUsed).toBeGreaterThan(200); // 200 output + input estimate
  });

  it('uses parsed tokens when available', async () => {
    const task = makeTask();
    const mockRunTool = vi.fn().mockResolvedValue(makeParsedToolResult());
    const deps: FixExecutorDeps = { commandTemplate: 'claude --print' };

    const result = await executeFix(task, 'diff', deps, 300, '/tmp/wt', undefined, mockRunTool);

    expect(result.tokensEstimated).toBe(false);
    expect(result.tokensUsed).toBe(500);
    expect(result.tokenDetail.input).toBe(300);
    expect(result.tokenDetail.output).toBe(200);
  });

  it('handles missing review comments gracefully', async () => {
    const task = makeTask({ pr_review_comments: undefined });
    const mockRunTool = vi.fn().mockResolvedValue(makeToolResult());
    const deps: FixExecutorDeps = { commandTemplate: 'claude --print' };

    await executeFix(task, 'diff', deps, 300, '/tmp/wt', undefined, mockRunTool);

    const prompt = mockRunTool.mock.calls[0][1] as string;
    expect(prompt).toContain('(no review comments provided)');
  });
});

// ── executeFixTask ───────────────────────────────────────────────

describe('executeFixTask', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockLogger.log.mockReset();
    mockLogger.logError.mockReset();
    mockLogger.logWarn.mockReset();
  });

  it('executes full fix workflow: checkout, AI, commit, push, submit', async () => {
    const task = makeTask();
    const client = makeClient();
    const deps: FixExecutorDeps = { commandTemplate: 'claude --print' };
    const mockRunTool = vi.fn().mockResolvedValue(makeToolResult());

    // Git mock sequence: fetch, checkout, add, status, commit, rev-parse, push
    mockExecFileSync
      .mockReturnValueOnce('') // fetch
      .mockReturnValueOnce('') // checkout
      .mockReturnValueOnce('') // add -A
      .mockReturnValueOnce('M src/auth.ts\n') // status
      .mockReturnValueOnce('') // commit
      .mockReturnValueOnce('def456\n') // rev-parse
      .mockReturnValueOnce(''); // push

    const result = await executeFixTask(
      client,
      'agent-1',
      task,
      'diff content',
      deps,
      300,
      '/tmp/wt',
      mockLogger,
      undefined,
      mockRunTool,
    );

    // Verify result submitted
    expect(client.post).toHaveBeenCalledWith(
      '/api/tasks/task-fix-1/result',
      expect.objectContaining({
        agent_id: 'agent-1',
        type: 'fix',
        fix_report: expect.objectContaining({
          files_changed: 1,
          comments_addressed: 2,
          commit_sha: 'def456',
        }),
      }),
    );

    expect(result.tokensUsed).toBeGreaterThan(0);
  });

  it('handles no changes from AI tool', async () => {
    const task = makeTask();
    const client = makeClient();
    const deps: FixExecutorDeps = { commandTemplate: 'claude --print' };
    const mockRunTool = vi.fn().mockResolvedValue(makeToolResult());

    // Git: fetch, checkout, add, status (empty)
    mockExecFileSync
      .mockReturnValueOnce('') // fetch
      .mockReturnValueOnce('') // checkout
      .mockReturnValueOnce('') // add -A
      .mockReturnValueOnce(''); // status (empty = no changes)

    await executeFixTask(
      client,
      'agent-1',
      task,
      'diff',
      deps,
      300,
      '/tmp/wt',
      mockLogger,
      undefined,
      mockRunTool,
    );

    expect(client.post).toHaveBeenCalledWith(
      '/api/tasks/task-fix-1/result',
      expect.objectContaining({
        fix_report: expect.objectContaining({
          files_changed: 0,
          summary: expect.stringContaining('no file changes'),
        }),
      }),
    );
  });

  it('throws BranchNotFoundError when head_ref is missing', async () => {
    const task = makeTask({ head_ref: undefined });
    const client = makeClient();
    const deps: FixExecutorDeps = { commandTemplate: 'claude --print' };
    const mockRunTool = vi.fn();

    await expect(
      executeFixTask(
        client,
        'agent-1',
        task,
        'diff',
        deps,
        300,
        '/tmp/wt',
        mockLogger,
        undefined,
        mockRunTool,
      ),
    ).rejects.toThrow(BranchNotFoundError);
    expect(mockRunTool).not.toHaveBeenCalled();
  });

  it('throws BranchNotFoundError when fetch fails', async () => {
    const task = makeTask();
    const client = makeClient();
    const deps: FixExecutorDeps = { commandTemplate: 'claude --print' };
    const mockRunTool = vi.fn();

    mockExecFileSync.mockImplementation(() => {
      throw new Error('fatal: remote branch not found');
    });

    await expect(
      executeFixTask(
        client,
        'agent-1',
        task,
        'diff',
        deps,
        300,
        '/tmp/wt',
        mockLogger,
        undefined,
        mockRunTool,
      ),
    ).rejects.toThrow(BranchNotFoundError);
  });

  it('throws PushFailedError when push fails', async () => {
    const task = makeTask();
    const client = makeClient();
    const deps: FixExecutorDeps = { commandTemplate: 'claude --print' };
    const mockRunTool = vi.fn().mockResolvedValue(makeToolResult());

    // Git: fetch, checkout succeed; add, status, commit, rev-parse succeed; push fails
    mockExecFileSync
      .mockReturnValueOnce('') // fetch
      .mockReturnValueOnce('') // checkout
      .mockReturnValueOnce('') // add -A
      .mockReturnValueOnce('M src/foo.ts\n') // status
      .mockReturnValueOnce('') // commit
      .mockReturnValueOnce('sha789\n') // rev-parse
      .mockImplementationOnce(() => {
        throw new Error('rejected: non-fast-forward');
      }); // push

    await expect(
      executeFixTask(
        client,
        'agent-1',
        task,
        'diff',
        deps,
        300,
        '/tmp/wt',
        mockLogger,
        undefined,
        mockRunTool,
      ),
    ).rejects.toThrow(PushFailedError);
  });

  it('propagates AI tool errors', async () => {
    const task = makeTask();
    const client = makeClient();
    const deps: FixExecutorDeps = { commandTemplate: 'claude --print' };
    const mockRunTool = vi.fn().mockRejectedValue(new Error('AI tool crashed'));

    // Git: fetch, checkout succeed
    mockExecFileSync
      .mockReturnValueOnce('') // fetch
      .mockReturnValueOnce(''); // checkout

    await expect(
      executeFixTask(
        client,
        'agent-1',
        task,
        'diff',
        deps,
        300,
        '/tmp/wt',
        mockLogger,
        undefined,
        mockRunTool,
      ),
    ).rejects.toThrow('AI tool crashed');
  });

  it('logs progress during execution', async () => {
    const task = makeTask();
    const client = makeClient();
    const deps: FixExecutorDeps = { commandTemplate: 'claude --print' };
    const mockRunTool = vi.fn().mockResolvedValue(makeToolResult());

    mockExecFileSync
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('M src/auth.ts\n')
      .mockReturnValueOnce('')
      .mockReturnValueOnce('abc123\n')
      .mockReturnValueOnce('');

    await executeFixTask(
      client,
      'agent-1',
      task,
      'diff',
      deps,
      300,
      '/tmp/wt',
      mockLogger,
      undefined,
      mockRunTool,
    );

    const logMessages = mockLogger.log.mock.calls.map((c) => c[0]);
    expect(logMessages.some((m: string) => m.includes('Checking out PR branch'))).toBe(true);
    expect(logMessages.some((m: string) => m.includes('Running AI fix tool'))).toBe(true);
    expect(logMessages.some((m: string) => m.includes('Committing and pushing'))).toBe(true);
    expect(logMessages.some((m: string) => m.includes('Fix submitted'))).toBe(true);
  });
});
