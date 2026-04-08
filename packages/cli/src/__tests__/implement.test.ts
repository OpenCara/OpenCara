import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PollTask } from '@opencara/shared';
import type { ToolExecutorResult } from '../tool-executor.js';
import {
  slugify,
  buildBranchName,
  buildImplementPrompt,
  truncateToBytes,
  extractJsonFromOutput,
  parseImplementOutput,
  executeImplement,
  executeImplementTask,
  detectDefaultBranch,
  resolveStartRef,
  checkoutForImplement,
  MAX_ISSUE_BODY_BYTES,
  type ImplementExecutorDeps,
} from '../implement.js';

// ── Helpers ───────────────────────────���──────────────────────────

function makeTask(overrides: Partial<PollTask> = {}): PollTask {
  return {
    task_id: 'task-1',
    owner: 'acme',
    repo: 'widgets',
    pr_number: 0, // issue-based task
    diff_url: '',
    timeout_seconds: 300,
    prompt: '',
    role: 'implement',
    issue_number: 42,
    issue_title: 'Add dark mode support',
    issue_body: 'We need to add a dark mode toggle to the settings page.',
    ...overrides,
  };
}

function makeToolResult(stdout: string): ToolExecutorResult {
  return {
    stdout,
    stderr: '',
    tokensUsed: 500,
    tokensParsed: false,
    tokenDetail: { input: 0, output: 500, total: 500, parsed: false },
  };
}

function makeParsedToolResult(stdout: string, input: number, output: number): ToolExecutorResult {
  return {
    stdout,
    stderr: '',
    tokensUsed: input + output,
    tokensParsed: true,
    tokenDetail: { input, output, total: input + output, parsed: true },
  };
}

// ── slugify ─────��─────────────────────���─────────────────────────

describe('slugify', () => {
  it('converts title to lowercase hyphenated slug', () => {
    expect(slugify('Add Dark Mode Support')).toBe('add-dark-mode-support');
  });

  it('replaces special characters with hyphens', () => {
    expect(slugify('Fix: CORS error (Safari)')).toBe('fix-cors-error-safari');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('--hello world--')).toBe('hello-world');
  });

  it('truncates to maxLength', () => {
    const result = slugify('A very long title that exceeds the maximum length allowed', 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toBe('a-very-long-title-th');
  });

  it('removes trailing hyphens after truncation', () => {
    const result = slugify('hello-world-and-more', 12);
    // "hello-world-" would be 12 chars, trailing hyphen removed
    expect(result).toBe('hello-world');
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  it('handles numbers', () => {
    expect(slugify('Issue #123 fix')).toBe('issue-123-fix');
  });
});

// ── buildBranchName ──��──────────────────────────────────────────

describe('buildBranchName', () => {
  it('builds branch with issue number and slug', () => {
    expect(buildBranchName(42, 'Add dark mode')).toBe('opencara/issue-42-add-dark-mode');
  });

  it('handles special characters in title', () => {
    expect(buildBranchName(7, 'Fix: broken login')).toBe('opencara/issue-7-fix-broken-login');
  });
});

// ── truncateToBytes ─────────────────���───────────────────────────

describe('truncateToBytes', () => {
  it('returns short strings unchanged', () => {
    expect(truncateToBytes('hello', 1024)).toBe('hello');
  });

  it('truncates strings exceeding max bytes', () => {
    const long = 'a'.repeat(40_000);
    const result = truncateToBytes(long, MAX_ISSUE_BODY_BYTES);
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThan(MAX_ISSUE_BODY_BYTES + 100);
    expect(result).toContain('[... truncated ...]');
  });

  it('handles multi-byte characters safely without replacement chars', () => {
    const emoji = '\u{1F600}'.repeat(100);
    const result = truncateToBytes(emoji, 100);
    expect(() => Buffer.from(result, 'utf-8').toString('utf-8')).not.toThrow();
    // Should not contain replacement characters (U+FFFD)
    expect(result).not.toContain('\uFFFD');
  });
});

// ── buildImplementPrompt ───────���────────────────────────────────

describe('buildImplementPrompt', () => {
  it('includes issue number and title', () => {
    const prompt = buildImplementPrompt(makeTask());
    expect(prompt).toContain('Issue #42: Add dark mode support');
  });

  it('includes issue body in UNTRUSTED_CONTENT tags', () => {
    const prompt = buildImplementPrompt(makeTask());
    expect(prompt).toContain('<UNTRUSTED_CONTENT>');
    expect(prompt).toContain('dark mode toggle to the settings page');
    expect(prompt).toContain('</UNTRUSTED_CONTENT>');
  });

  it('includes system prompt with implementation instructions', () => {
    const prompt = buildImplementPrompt(makeTask());
    expect(prompt).toContain('implementation agent');
    expect(prompt).toContain('Do NOT commit or push');
  });

  it('includes repo-specific instructions when present', () => {
    const prompt = buildImplementPrompt(makeTask({ prompt: 'Use TypeScript strict mode' }));
    expect(prompt).toContain('Repo-Specific Instructions');
    expect(prompt).toContain('Use TypeScript strict mode');
  });

  it('omits repo-specific section when prompt is empty', () => {
    const prompt = buildImplementPrompt(makeTask({ prompt: '' }));
    expect(prompt).not.toContain('Repo-Specific Instructions');
  });

  it('falls back to pr_number when issue_number is absent', () => {
    const prompt = buildImplementPrompt(makeTask({ issue_number: undefined, pr_number: 99 }));
    expect(prompt).toContain('Issue #99');
  });

  it('truncates long issue bodies', () => {
    const longBody = 'x'.repeat(50_000);
    const prompt = buildImplementPrompt(makeTask({ issue_body: longBody }));
    expect(prompt).toContain('[... truncated ...]');
  });
});

// ── extractJsonFromOutput ───────────────────────────────────────

describe('extractJsonFromOutput', () => {
  it('extracts JSON from markdown code fence', () => {
    const output = 'Some text\n```json\n{"summary": "done"}\n```\nMore text';
    expect(extractJsonFromOutput(output)).toBe('{"summary": "done"}');
  });

  it('extracts JSON from unfenced output', () => {
    const output = 'Here is the result: {"summary": "done", "files_changed": []}';
    expect(extractJsonFromOutput(output)).toBe('{"summary": "done", "files_changed": []}');
  });

  it('returns null when no JSON found', () => {
    expect(extractJsonFromOutput('No JSON here')).toBeNull();
  });

  it('handles empty code fences gracefully', () => {
    const output = '```json\n\n```';
    // Empty fence content — should fall through
    expect(extractJsonFromOutput(output)).toBeNull();
  });
});

// ── parseImplementOutput ────────────────────────────────────────

describe('parseImplementOutput', () => {
  it('parses valid JSON output', () => {
    const output =
      '```json\n{"summary": "Added dark mode", "files_changed": ["src/theme.ts"]}\n```';
    const result = parseImplementOutput(output);
    expect(result.summary).toBe('Added dark mode');
    expect(result.filesChanged).toEqual(['src/theme.ts']);
  });

  it('handles missing files_changed field', () => {
    const output = '{"summary": "Fixed the bug"}';
    const result = parseImplementOutput(output);
    expect(result.summary).toBe('Fixed the bug');
    expect(result.filesChanged).toEqual([]);
  });

  it('handles invalid JSON gracefully with fallback', () => {
    const output = 'I made these changes:\n- Updated theme.ts\n- Added dark mode toggle';
    const result = parseImplementOutput(output);
    expect(result.summary).toContain('I made these changes');
    expect(result.filesChanged).toEqual([]);
  });

  it('truncates long fallback summaries', () => {
    const output = 'x'.repeat(300);
    const result = parseImplementOutput(output);
    expect(result.summary.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(result.summary).toContain('...');
  });

  it('provides default summary for empty output', () => {
    const result = parseImplementOutput('');
    expect(result.summary).toBe('Implementation completed');
  });

  it('filters non-string entries from files_changed', () => {
    const output = '{"summary": "done", "files_changed": ["a.ts", 123, "b.ts", null]}';
    const result = parseImplementOutput(output);
    expect(result.filesChanged).toEqual(['a.ts', 'b.ts']);
  });
});

// ── executeImplement ────────────────────────────────────────────

describe('executeImplement', () => {
  const deps: ImplementExecutorDeps = {
    commandTemplate: 'claude --model test --print',
    codebaseDir: '/tmp/repos',
  };

  it('runs tool with prompt in worktree directory', async () => {
    const toolOutput = '{"summary": "Added feature", "files_changed": ["src/app.ts"]}';
    const mockTool = vi.fn().mockResolvedValue(makeToolResult(toolOutput));

    const result = await executeImplement(
      makeTask(),
      '/tmp/worktree',
      deps,
      300,
      undefined,
      mockTool,
    );

    expect(mockTool).toHaveBeenCalledWith(
      deps.commandTemplate,
      expect.stringContaining('Issue #42'),
      expect.any(Number),
      undefined,
      undefined,
      '/tmp/worktree',
    );
    expect(result.output.summary).toBe('Added feature');
    expect(result.output.filesChanged).toEqual(['src/app.ts']);
  });

  it('uses effective timeout minus safety margin', async () => {
    const mockTool = vi.fn().mockResolvedValue(makeToolResult('{"summary": "ok"}'));

    await executeImplement(makeTask(), '/tmp/wt', deps, 300, undefined, mockTool);

    const [, , timeoutMs] = mockTool.mock.calls[0];
    expect(timeoutMs).toBe(300_000 - 30_000);
  });

  it('throws if not enough time remaining', async () => {
    const mockTool = vi.fn();
    await expect(
      executeImplement(makeTask(), '/tmp/wt', deps, 20, undefined, mockTool),
    ).rejects.toThrow('Not enough time remaining');
    expect(mockTool).not.toHaveBeenCalled();
  });

  it('estimates tokens when not parsed from tool output', async () => {
    const mockTool = vi.fn().mockResolvedValue(makeToolResult('{"summary": "done"}'));

    const result = await executeImplement(makeTask(), '/tmp/wt', deps, 300, undefined, mockTool);

    expect(result.tokensEstimated).toBe(true);
    expect(result.tokenDetail.parsed).toBe(false);
    expect(result.tokenDetail.input).toBeGreaterThan(0);
  });

  it('uses parsed tokens when available', async () => {
    const mockTool = vi
      .fn()
      .mockResolvedValue(makeParsedToolResult('{"summary": "done"}', 1000, 200));

    const result = await executeImplement(makeTask(), '/tmp/wt', deps, 300, undefined, mockTool);

    expect(result.tokensEstimated).toBe(false);
    expect(result.tokenDetail.parsed).toBe(true);
    expect(result.tokenDetail.input).toBe(1000);
    expect(result.tokenDetail.output).toBe(200);
  });
});

// ── executeImplementTask ─────────���──────────────────────────────

describe('executeImplementTask', () => {
  const mockClient = {
    post: vi.fn().mockResolvedValue({ success: true }),
  };

  const deps: ImplementExecutorDeps = {
    commandTemplate: 'claude --model test --print',
    codebaseDir: '/tmp/repos',
  };

  const mockLogger = {
    log: vi.fn(),
  };

  const mockGitOps = {
    checkoutForImplement: vi.fn().mockReturnValue({
      worktreePath: '/tmp/repos/acme/widgets-worktrees/implement-42',
      bareRepoPath: '/tmp/repos/acme/widgets.git',
    }),
    commitAndPush: vi.fn().mockReturnValue(3),
    createPR: vi.fn().mockReturnValue({
      prNumber: 101,
      prUrl: 'https://github.com/acme/widgets/pull/101',
    }),
    cleanupImplementWorktree: vi.fn(),
  };

  const mockToolResult = makeToolResult(
    '{"summary": "Added dark mode toggle", "files_changed": ["src/theme.ts"]}',
  );

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.post.mockResolvedValue({ success: true });
    mockGitOps.checkoutForImplement.mockReturnValue({
      worktreePath: '/tmp/repos/acme/widgets-worktrees/implement-42',
      bareRepoPath: '/tmp/repos/acme/widgets.git',
    });
    mockGitOps.commitAndPush.mockReturnValue(3);
    mockGitOps.createPR.mockReturnValue({
      prNumber: 101,
      prUrl: 'https://github.com/acme/widgets/pull/101',
    });
  });

  it('executes full workflow: checkout → AI → commit → PR → submit', async () => {
    const mockTool = vi.fn().mockResolvedValue(mockToolResult);

    const result = await executeImplementTask(
      mockClient,
      'agent-1',
      makeTask(),
      deps,
      300,
      mockLogger,
      undefined,
      mockTool,
      'implement',
      mockGitOps,
    );

    // Verify checkout
    expect(mockGitOps.checkoutForImplement).toHaveBeenCalledWith(
      'acme',
      'widgets',
      42,
      'opencara/issue-42-add-dark-mode-support',
      '/tmp/repos',
    );

    // Verify AI tool was run in worktree
    expect(mockTool).toHaveBeenCalledWith(
      deps.commandTemplate,
      expect.stringContaining('Issue #42'),
      expect.any(Number),
      undefined,
      undefined,
      '/tmp/repos/acme/widgets-worktrees/implement-42',
    );

    // Verify commit and push
    expect(mockGitOps.commitAndPush).toHaveBeenCalledWith(
      '/tmp/repos/acme/widgets-worktrees/implement-42',
      42,
      'Add dark mode support',
    );

    // Verify PR creation
    expect(mockGitOps.createPR).toHaveBeenCalledWith(
      '/tmp/repos/acme/widgets-worktrees/implement-42',
      42,
      'Add dark mode support',
      'Added dark mode toggle',
      'opencara/issue-42-add-dark-mode-support',
    );

    // Verify result submitted to server
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/tasks/task-1/result',
      expect.objectContaining({
        agent_id: 'agent-1',
        type: 'implement',
        implement_report: expect.objectContaining({
          branch: 'opencara/issue-42-add-dark-mode-support',
          pr_number: 101,
          pr_url: 'https://github.com/acme/widgets/pull/101',
          files_changed: 3,
          summary: 'Added dark mode toggle',
        }),
      }),
    );

    // Verify cleanup
    expect(mockGitOps.cleanupImplementWorktree).toHaveBeenCalledWith(
      '/tmp/repos/acme/widgets.git',
      '/tmp/repos/acme/widgets-worktrees/implement-42',
    );

    expect(result.tokensUsed).toBeGreaterThan(0);
  });

  it('reports error to server and re-throws on AI tool failure', async () => {
    const mockTool = vi.fn().mockRejectedValue(new Error('AI tool crashed'));

    await expect(
      executeImplementTask(
        mockClient,
        'agent-1',
        makeTask(),
        deps,
        300,
        mockLogger,
        undefined,
        mockTool,
        'implement',
        mockGitOps,
      ),
    ).rejects.toThrow('AI tool crashed');

    // Error reported to server
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/tasks/task-1/error',
      expect.objectContaining({
        agent_id: 'agent-1',
        error: expect.stringContaining('AI tool crashed'),
      }),
    );

    // Cleanup still happens
    expect(mockGitOps.cleanupImplementWorktree).toHaveBeenCalled();
  });

  it('reports error on checkout failure', async () => {
    mockGitOps.checkoutForImplement.mockImplementation(() => {
      throw new Error('Clone failed');
    });
    const mockTool = vi.fn();

    await expect(
      executeImplementTask(
        mockClient,
        'agent-1',
        makeTask(),
        deps,
        300,
        mockLogger,
        undefined,
        mockTool,
        'implement',
        mockGitOps,
      ),
    ).rejects.toThrow('Clone failed');

    // AI tool should not have been called
    expect(mockTool).not.toHaveBeenCalled();

    // Error reported to server
    expect(mockClient.post).toHaveBeenCalledWith(
      '/api/tasks/task-1/error',
      expect.objectContaining({ error: expect.stringContaining('Clone failed') }),
    );
  });

  it('reports error on commit/push failure', async () => {
    mockGitOps.commitAndPush.mockImplementation(() => {
      throw new Error('No changes to commit');
    });
    const mockTool = vi.fn().mockResolvedValue(mockToolResult);

    await expect(
      executeImplementTask(
        mockClient,
        'agent-1',
        makeTask(),
        deps,
        300,
        mockLogger,
        undefined,
        mockTool,
        'implement',
        mockGitOps,
      ),
    ).rejects.toThrow('No changes to commit');

    expect(mockGitOps.cleanupImplementWorktree).toHaveBeenCalled();
  });

  it('reports error on PR creation failure', async () => {
    mockGitOps.createPR.mockImplementation(() => {
      throw new Error('gh: not authenticated');
    });
    const mockTool = vi.fn().mockResolvedValue(mockToolResult);

    await expect(
      executeImplementTask(
        mockClient,
        'agent-1',
        makeTask(),
        deps,
        300,
        mockLogger,
        undefined,
        mockTool,
        'implement',
        mockGitOps,
      ),
    ).rejects.toThrow('gh: not authenticated');

    expect(mockGitOps.cleanupImplementWorktree).toHaveBeenCalled();
  });

  it('cleans up worktree even when error reporting fails', async () => {
    const mockTool = vi.fn().mockRejectedValue(new Error('AI failed'));
    mockClient.post.mockRejectedValue(new Error('Network error'));

    await expect(
      executeImplementTask(
        mockClient,
        'agent-1',
        makeTask(),
        deps,
        300,
        mockLogger,
        undefined,
        mockTool,
        'implement',
        mockGitOps,
      ),
    ).rejects.toThrow('AI failed');

    expect(mockGitOps.cleanupImplementWorktree).toHaveBeenCalled();
  });

  it('handles cleanup failure gracefully', async () => {
    mockGitOps.cleanupImplementWorktree.mockImplementation(() => {
      throw new Error('Cleanup failed');
    });
    const mockTool = vi.fn().mockResolvedValue(mockToolResult);

    // Should not throw despite cleanup failure
    const result = await executeImplementTask(
      mockClient,
      'agent-1',
      makeTask(),
      deps,
      300,
      mockLogger,
      undefined,
      mockTool,
      'implement',
      mockGitOps,
    );

    expect(result.tokensUsed).toBeGreaterThan(0);
  });

  it('logs progress at each step', async () => {
    const mockTool = vi.fn().mockResolvedValue(mockToolResult);

    await executeImplementTask(
      mockClient,
      'agent-1',
      makeTask(),
      deps,
      300,
      mockLogger,
      undefined,
      mockTool,
      'implement',
      mockGitOps,
    );

    const logs = mockLogger.log.mock.calls.map((c) => c[0]);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Implementing issue #42'),
        expect.stringContaining('Checking out'),
        expect.stringContaining('Running AI tool'),
        expect.stringContaining('AI completed'),
        expect.stringContaining('Committing and pushing'),
        expect.stringContaining('Pushed 3 file(s)'),
        expect.stringContaining('Creating pull request'),
        expect.stringContaining('PR #101 created'),
        expect.stringContaining('Implement result submitted'),
      ]),
    );
  });

  it('uses issue_number when present, falls back to pr_number', async () => {
    const mockTool = vi.fn().mockResolvedValue(mockToolResult);

    // With issue_number
    await executeImplementTask(
      mockClient,
      'agent-1',
      makeTask({ issue_number: 42 }),
      deps,
      300,
      mockLogger,
      undefined,
      mockTool,
      'implement',
      mockGitOps,
    );

    expect(mockGitOps.checkoutForImplement).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      42,
      expect.stringContaining('issue-42'),
      expect.any(String),
    );
  });
});

// ── Bare clone branch detection (real git repos) ────────────────

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Create a normal (non-bare) git repo with one commit on the given branch. */
function createSourceRepo(dir: string, branch: string = 'main'): void {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-b', branch], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test');
  git(['add', '.'], dir);
  git(['commit', '-m', 'init'], dir);
}

describe('detectDefaultBranch', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocara-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects "main" in a bare clone', () => {
    const srcDir = path.join(tmpDir, 'src');
    const bareDir = path.join(tmpDir, 'bare.git');
    createSourceRepo(srcDir, 'main');
    git(['clone', '--bare', srcDir, bareDir], tmpDir);

    expect(detectDefaultBranch(bareDir)).toBe('main');
  });

  it('detects "master" in a bare clone with master branch', () => {
    const srcDir = path.join(tmpDir, 'src');
    const bareDir = path.join(tmpDir, 'bare.git');
    createSourceRepo(srcDir, 'master');
    git(['clone', '--bare', srcDir, bareDir], tmpDir);

    expect(detectDefaultBranch(bareDir)).toBe('master');
  });

  it('detects "main" in a non-bare clone with remote tracking', () => {
    const srcDir = path.join(tmpDir, 'src');
    const cloneDir = path.join(tmpDir, 'clone');
    createSourceRepo(srcDir, 'main');
    git(['clone', srcDir, cloneDir], tmpDir);

    expect(detectDefaultBranch(cloneDir)).toBe('main');
  });

  it('throws when neither main nor master exists', () => {
    const srcDir = path.join(tmpDir, 'src');
    const bareDir = path.join(tmpDir, 'bare.git');
    createSourceRepo(srcDir, 'develop');
    git(['clone', '--bare', srcDir, bareDir], tmpDir);

    expect(() => detectDefaultBranch(bareDir)).toThrow('Cannot determine default branch');
  });
});

describe('resolveStartRef', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocara-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns origin/<branch> for non-bare clones', () => {
    const srcDir = path.join(tmpDir, 'src');
    const cloneDir = path.join(tmpDir, 'clone');
    createSourceRepo(srcDir, 'main');
    git(['clone', srcDir, cloneDir], tmpDir);

    expect(resolveStartRef(cloneDir, 'main')).toBe('origin/main');
  });

  it('returns branch name for bare clones (no origin/ prefix)', () => {
    const srcDir = path.join(tmpDir, 'src');
    const bareDir = path.join(tmpDir, 'bare.git');
    createSourceRepo(srcDir, 'main');
    git(['clone', '--bare', srcDir, bareDir], tmpDir);

    expect(resolveStartRef(bareDir, 'main')).toBe('main');
  });
});

describe('checkoutForImplement (bare clone integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocara-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates worktree from bare clone with main branch', () => {
    const srcDir = path.join(tmpDir, 'src');
    createSourceRepo(srcDir, 'main');

    // Simulate bare clone structure that checkoutForImplement creates
    const baseDir = path.join(tmpDir, 'repos');
    const bareDir = path.join(baseDir, 'acme', 'widgets.git');
    fs.mkdirSync(path.join(baseDir, 'acme'), { recursive: true });
    git(['clone', '--bare', '--filter=blob:none', srcDir, bareDir], tmpDir);

    const result = checkoutForImplement('acme', 'widgets', 42, 'opencara/issue-42-test', baseDir);

    expect(result.bareRepoPath).toBe(bareDir);
    expect(result.worktreePath).toContain('implement-42');
    expect(fs.existsSync(path.join(result.worktreePath, 'README.md'))).toBe(true);

    // Verify worktree is on the correct branch
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], result.worktreePath).trim();
    expect(branch).toBe('opencara/issue-42-test');
  });

  it('creates worktree from bare clone with master branch', () => {
    const srcDir = path.join(tmpDir, 'src');
    createSourceRepo(srcDir, 'master');

    const baseDir = path.join(tmpDir, 'repos');
    const bareDir = path.join(baseDir, 'acme', 'widgets.git');
    fs.mkdirSync(path.join(baseDir, 'acme'), { recursive: true });
    git(['clone', '--bare', '--filter=blob:none', srcDir, bareDir], tmpDir);

    const result = checkoutForImplement('acme', 'widgets', 99, 'opencara/issue-99-test', baseDir);

    expect(fs.existsSync(path.join(result.worktreePath, 'README.md'))).toBe(true);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], result.worktreePath).trim();
    expect(branch).toBe('opencara/issue-99-test');
  });
});
