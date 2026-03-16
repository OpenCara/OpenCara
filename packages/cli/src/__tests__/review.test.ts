import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildSystemPrompt,
  buildUserMessage,
  extractVerdict,
  executeReview,
  getAnthropicApiKey,
  DiffTooLargeError,
  type ReviewRequest,
  type ReviewExecutorDeps,
} from '../review.js';

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

  it('defaults to comment when no verdict found', () => {
    const { verdict, review } = extractVerdict('Just a regular review text.');
    expect(verdict).toBe('comment');
    expect(review).toBe('Just a regular review text.');
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

describe('getAnthropicApiKey', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['ANTHROPIC_API_KEY'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('prefers environment variable over config', () => {
    process.env['ANTHROPIC_API_KEY'] = 'env-key';
    expect(getAnthropicApiKey('config-key')).toBe('env-key');
  });

  it('falls back to config key', () => {
    expect(getAnthropicApiKey('config-key')).toBe('config-key');
  });

  it('throws when neither env nor config key is available', () => {
    expect(() => getAnthropicApiKey(null)).toThrow('Anthropic API key not found');
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
  };

  const defaultDeps: ReviewExecutorDeps = {
    anthropicApiKey: 'sk-ant-test',
    reviewModel: 'claude-sonnet-4-6',
    maxDiffSizeKb: 100,
  };

  it('calls Anthropic API and returns parsed response', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'VERDICT: APPROVE\nGreat code!' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const mockClient = { messages: { create: mockCreate } };
    const createClient = vi.fn().mockReturnValue(mockClient);

    const result = await executeReview(defaultRequest, defaultDeps, createClient as never);

    expect(result.verdict).toBe('approve');
    expect(result.review).toBe('Great code!');
    expect(result.tokensUsed).toBe(150);
    expect(createClient).toHaveBeenCalledWith('sk-ant-test');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: expect.stringContaining('acme/widgets'),
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Review this PR'),
          }),
        ]),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('rejects diff that exceeds max size', async () => {
    const largeDiff = 'x'.repeat(200 * 1024); // 200KB
    const request = { ...defaultRequest, diffContent: largeDiff };

    await expect(executeReview(request, defaultDeps, vi.fn() as never)).rejects.toThrow(
      DiffTooLargeError,
    );
  });

  it('rejects when not enough time remaining', async () => {
    const request = { ...defaultRequest, timeout: 0 };

    await expect(executeReview(request, defaultDeps, vi.fn() as never)).rejects.toThrow(
      'Not enough time remaining',
    );
  });

  it('handles request_changes verdict', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'VERDICT: REQUEST_CHANGES\nFix the bug.' }],
      usage: { input_tokens: 80, output_tokens: 20 },
    });
    const mockClient = { messages: { create: mockCreate } };

    const result = await executeReview(
      defaultRequest,
      defaultDeps,
      vi.fn().mockReturnValue(mockClient) as never,
    );

    expect(result.verdict).toBe('request_changes');
    expect(result.review).toBe('Fix the bug.');
    expect(result.tokensUsed).toBe(100);
  });

  it('defaults to comment verdict when not found', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Some observations about the code.' }],
      usage: { input_tokens: 50, output_tokens: 30 },
    });
    const mockClient = { messages: { create: mockCreate } };

    const result = await executeReview(
      defaultRequest,
      defaultDeps,
      vi.fn().mockReturnValue(mockClient) as never,
    );

    expect(result.verdict).toBe('comment');
    expect(result.review).toBe('Some observations about the code.');
  });

  it('handles missing usage in response', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'VERDICT: APPROVE\nOK' }],
      usage: undefined,
    });
    const mockClient = { messages: { create: mockCreate } };

    const result = await executeReview(
      defaultRequest,
      defaultDeps,
      vi.fn().mockReturnValue(mockClient) as never,
    );

    expect(result.tokensUsed).toBe(0);
  });

  it('propagates API errors', async () => {
    const mockCreate = vi.fn().mockRejectedValue(new Error('API rate limited'));
    const mockClient = { messages: { create: mockCreate } };

    await expect(
      executeReview(defaultRequest, defaultDeps, vi.fn().mockReturnValue(mockClient) as never),
    ).rejects.toThrow('API rate limited');
  });

  it('joins multiple text blocks in response', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        { type: 'text', text: 'VERDICT: COMMENT' },
        { type: 'text', text: 'More text here.' },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const mockClient = { messages: { create: mockCreate } };

    const result = await executeReview(
      defaultRequest,
      defaultDeps,
      vi.fn().mockReturnValue(mockClient) as never,
    );

    expect(result.verdict).toBe('comment');
    expect(result.review).toContain('More text here.');
  });

  it('filters out non-text blocks', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        { type: 'tool_use', text: 'ignored' },
        { type: 'text', text: 'VERDICT: APPROVE\nGood.' },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const mockClient = { messages: { create: mockCreate } };

    const result = await executeReview(
      defaultRequest,
      defaultDeps,
      vi.fn().mockReturnValue(mockClient) as never,
    );

    expect(result.verdict).toBe('approve');
    expect(result.review).toBe('Good.');
  });
});
