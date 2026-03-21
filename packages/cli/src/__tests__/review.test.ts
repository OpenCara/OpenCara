import { describe, it, expect, vi } from 'vitest';
import {
  buildSystemPrompt,
  buildUserMessage,
  extractVerdict,
  executeReview,
  DiffTooLargeError,
  type ReviewRequest,
  type ReviewExecutorDeps,
} from '../review.js';
import type { ToolExecutorResult } from '../tool-executor.js';

describe('buildSystemPrompt', () => {
  it('inserts owner and repo into template', () => {
    const prompt = buildSystemPrompt('acme', 'widgets');
    expect(prompt).toContain('acme/widgets');
    expect(prompt).toContain('code reviewer');
  });
});

describe('buildUserMessage', () => {
  it('combines prompt and diff with separator', () => {
    const message = buildUserMessage('Review this PR', 'diff content here');
    expect(message).toContain('Review this PR');
    expect(message).toContain('diff content here');
    expect(message).toContain('---');
  });
});

describe('extractVerdict', () => {
  it('extracts APPROVE verdict', () => {
    const { verdict, review } = extractVerdict('VERDICT: APPROVE\nLooks good to me.');
    expect(verdict).toBe('approve');
    expect(review).toBe('Looks good to me.');
  });

  it('extracts REQUEST_CHANGES verdict', () => {
    const { verdict, review } = extractVerdict('VERDICT: REQUEST_CHANGES\nPlease fix the bug.');
    expect(verdict).toBe('request_changes');
    expect(review).toBe('Please fix the bug.');
  });

  it('extracts COMMENT verdict', () => {
    const { verdict, review } = extractVerdict('VERDICT: COMMENT\nSome observations.');
    expect(verdict).toBe('comment');
    expect(review).toBe('Some observations.');
  });

  it('defaults to comment when no verdict found and logs warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { verdict, review } = extractVerdict('Just a regular review text.');
    expect(verdict).toBe('comment');
    expect(review).toBe('Just a regular review text.');
    expect(warnSpy).toHaveBeenCalledWith(
      'No verdict found in review output, defaulting to COMMENT',
    );
    warnSpy.mockRestore();
  });

  it('does not warn when verdict is found', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    extractVerdict('VERDICT: APPROVE\nGreat code!');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('handles verdict in middle of text', () => {
    const { verdict, review } = extractVerdict('Intro text\nVERDICT: APPROVE\nDetailed review.');
    expect(verdict).toBe('approve');
    expect(review).toBe('Intro text\n\nDetailed review.');
  });

  it('handles verdict with extra whitespace', () => {
    const { verdict } = extractVerdict('VERDICT: APPROVE  \nRest');
    expect(verdict).toBe('approve');
  });
});

describe('DiffTooLargeError', () => {
  it('has correct name and message', () => {
    const err = new DiffTooLargeError('too big');
    expect(err.name).toBe('DiffTooLargeError');
    expect(err.message).toBe('too big');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('executeReview', () => {
  const defaultRequest: ReviewRequest = {
    taskId: 'task-1',
    diffContent: 'some diff',
    prompt: 'Review this PR',
    owner: 'acme',
    repo: 'widgets',
    prNumber: 42,
    timeout: 300,
    reviewMode: 'full',
  };

  const defaultDeps: ReviewExecutorDeps = {
    commandTemplate: 'claude -p --output-format text',
    maxDiffSizeKb: 100,
  };

  it('invokes tool subprocess and returns parsed response', async () => {
    const mockRunTool = vi
      .fn<
        (
          commandTemplate: string,
          prompt: string,
          timeoutMs: number,
          signal?: AbortSignal,
          vars?: Record<string, string>,
          cwd?: string,
        ) => Promise<ToolExecutorResult>
      >()
      .mockResolvedValue({
        stdout: 'VERDICT: APPROVE\nGreat code!',
        stderr: '',
        tokensUsed: 0,
        tokensParsed: false,
      });

    const result = await executeReview(defaultRequest, defaultDeps, mockRunTool);

    expect(result.verdict).toBe('approve');
    expect(result.review).toBe('Great code!');
    // Includes input prompt estimate + output estimate
    expect(result.tokensUsed).toBeGreaterThan(0);
    expect(mockRunTool).toHaveBeenCalledWith(
      'claude -p --output-format text',
      expect.stringContaining('acme/widgets'),
      expect.any(Number),
      expect.any(AbortSignal),
      undefined,
      undefined,
    );
    // Prompt should contain both system and user content
    const prompt = mockRunTool.mock.calls[0][1];
    expect(prompt).toContain('Review this PR');
    expect(prompt).toContain('some diff');
  });

  it('rejects diff that exceeds max size', async () => {
    const largeDiff = 'x'.repeat(200 * 1024); // 200KB
    const request = { ...defaultRequest, diffContent: largeDiff };

    await expect(executeReview(request, defaultDeps, vi.fn())).rejects.toThrow(DiffTooLargeError);
  });

  it('rejects when not enough time remaining', async () => {
    const request = { ...defaultRequest, timeout: 0 };

    await expect(executeReview(request, defaultDeps, vi.fn())).rejects.toThrow(
      'Not enough time remaining',
    );
  });

  it('handles request_changes verdict', async () => {
    const mockRunTool = vi.fn().mockResolvedValue({
      stdout: 'VERDICT: REQUEST_CHANGES\nFix the bug.',
      stderr: '',
      tokensUsed: 0,
      tokensParsed: false,
    });

    const result = await executeReview(defaultRequest, defaultDeps, mockRunTool);

    expect(result.verdict).toBe('request_changes');
    expect(result.review).toBe('Fix the bug.');
  });

  it('defaults to comment verdict when not found', async () => {
    const mockRunTool = vi.fn().mockResolvedValue({
      stdout: 'Some observations about the code.',
      stderr: '',
      tokensUsed: 0,
      tokensParsed: false,
    });

    const result = await executeReview(defaultRequest, defaultDeps, mockRunTool);

    expect(result.verdict).toBe('comment');
    expect(result.review).toBe('Some observations about the code.');
  });

  it('returns tokensUsed from tool when reported', async () => {
    const mockRunTool = vi.fn().mockResolvedValue({
      stdout: 'VERDICT: APPROVE\nOK',
      stderr: '',
      tokensUsed: 150,
      tokensParsed: true,
    });

    const result = await executeReview(defaultRequest, defaultDeps, mockRunTool);

    // 150 from tool (parsed, no input estimate added)
    expect(result.tokensUsed).toBe(150);
  });

  it('propagates tool errors', async () => {
    const mockRunTool = vi.fn().mockRejectedValue(new Error('Tool not found'));

    await expect(executeReview(defaultRequest, defaultDeps, mockRunTool)).rejects.toThrow(
      'Tool not found',
    );
  });

  it('passes correct timeout to tool', async () => {
    const mockRunTool = vi.fn().mockResolvedValue({
      stdout: 'VERDICT: APPROVE\nOK',
      stderr: '',
      tokensUsed: 0,
      tokensParsed: false,
    });

    await executeReview(defaultRequest, defaultDeps, mockRunTool);

    // timeout is 300s, safety margin is 30s, so effective timeout is 270s = 270000ms
    const timeoutMs = mockRunTool.mock.calls[0][2];
    expect(timeoutMs).toBe(270_000);
  });

  it('passes the command template from deps', async () => {
    const mockRunTool = vi.fn().mockResolvedValue({
      stdout: 'VERDICT: COMMENT\nLooks OK.',
      stderr: '',
      tokensUsed: 0,
      tokensParsed: false,
    });

    await executeReview(
      defaultRequest,
      { commandTemplate: 'codex exec', maxDiffSizeKb: 100 },
      mockRunTool,
    );

    expect(mockRunTool.mock.calls[0][0]).toBe('codex exec');
  });

  it('passes cwd when codebaseDir is set', async () => {
    const mockRunTool = vi.fn().mockResolvedValue({
      stdout: 'VERDICT: APPROVE\nOK',
      stderr: '',
      tokensUsed: 0,
      tokensParsed: false,
    });

    await executeReview(
      defaultRequest,
      { ...defaultDeps, codebaseDir: '/tmp/repos/acme/widgets' },
      mockRunTool,
    );

    const cwd = mockRunTool.mock.calls[0][5];
    expect(cwd).toBe('/tmp/repos/acme/widgets');
  });

  it('does not pass cwd when codebaseDir is not set', async () => {
    const mockRunTool = vi.fn().mockResolvedValue({
      stdout: 'VERDICT: APPROVE\nOK',
      stderr: '',
      tokensUsed: 0,
      tokensParsed: false,
    });

    await executeReview(defaultRequest, defaultDeps, mockRunTool);

    const cwd = mockRunTool.mock.calls[0][5];
    expect(cwd).toBeUndefined();
  });
});
