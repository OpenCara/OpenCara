import { describe, it, expect, vi } from 'vitest';
import {
  buildSummarySystemPrompt,
  buildSummaryUserMessage,
  calculateInputSize,
  executeSummary,
  InputTooLargeError,
  MAX_INPUT_SIZE_BYTES,
  type SummaryRequest,
  type SummaryReviewInput,
} from '../summary.js';
import type { ReviewExecutorDeps } from '../review.js';

const sampleReviews: SummaryReviewInput[] = [
  {
    agentId: 'agent-1',
    model: 'claude-sonnet',
    tool: 'claude-code',
    review: 'Code looks clean. LGTM.',
    verdict: 'approve',
  },
  {
    agentId: 'agent-2',
    model: 'gpt-4',
    tool: 'copilot',
    review: 'Found a potential null reference on line 42.',
    verdict: 'request_changes',
  },
];

describe('buildSummarySystemPrompt', () => {
  it('includes owner, repo, and review count', () => {
    const prompt = buildSummarySystemPrompt('acme', 'widgets', 3);
    expect(prompt).toContain('acme/widgets');
    expect(prompt).toContain('3 individual code reviews');
    expect(prompt).toContain('code review summarizer');
  });

  it('includes formatting instructions', () => {
    const prompt = buildSummarySystemPrompt('org', 'repo', 1);
    expect(prompt).toContain('markdown');
    expect(prompt).toContain('action items');
  });
});

describe('buildSummaryUserMessage', () => {
  it('includes project prompt and all reviews', () => {
    const message = buildSummaryUserMessage('Check for bugs', sampleReviews);
    expect(message).toContain('Check for bugs');
    expect(message).toContain('claude-sonnet/claude-code');
    expect(message).toContain('Verdict: approve');
    expect(message).toContain('Code looks clean. LGTM.');
    expect(message).toContain('gpt-4/copilot');
    expect(message).toContain('Verdict: request_changes');
    expect(message).toContain('Found a potential null reference');
  });

  it('handles single review', () => {
    const message = buildSummaryUserMessage('Review', [sampleReviews[0]]);
    expect(message).toContain('claude-sonnet/claude-code');
    expect(message).not.toContain('gpt-4');
  });

  it('handles empty reviews array', () => {
    const message = buildSummaryUserMessage('Review', []);
    expect(message).toContain('Review');
    expect(message).toContain('Individual reviews:');
  });
});

describe('calculateInputSize', () => {
  it('sums byte lengths of prompt and review fields', () => {
    const size = calculateInputSize('short prompt', [
      { agentId: 'a1', model: 'model', tool: 'tool', review: 'review text', verdict: 'approve' },
    ]);
    expect(size).toBeGreaterThan(0);
    expect(size).toBe(
      Buffer.byteLength('short prompt', 'utf-8') +
        Buffer.byteLength('review text', 'utf-8') +
        Buffer.byteLength('model', 'utf-8') +
        Buffer.byteLength('tool', 'utf-8') +
        Buffer.byteLength('approve', 'utf-8'),
    );
  });

  it('returns prompt size for empty reviews', () => {
    const size = calculateInputSize('my prompt', []);
    expect(size).toBe(Buffer.byteLength('my prompt', 'utf-8'));
  });

  it('handles multi-byte characters', () => {
    const size = calculateInputSize('', [
      { agentId: 'a', model: 'm', tool: 't', review: '\u{1F600}'.repeat(10), verdict: 'approve' },
    ]);
    expect(size).toBeGreaterThan(10);
  });
});

describe('InputTooLargeError', () => {
  it('has correct name and message', () => {
    const err = new InputTooLargeError('too big');
    expect(err.name).toBe('InputTooLargeError');
    expect(err.message).toBe('too big');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('executeSummary', () => {
  const defaultDeps: ReviewExecutorDeps = {
    anthropicApiKey: 'sk-ant-test',
    reviewModel: 'claude-sonnet-4-6',
    maxDiffSizeKb: 100,
  };

  const defaultRequest: SummaryRequest = {
    taskId: 'task-1',
    reviews: sampleReviews,
    prompt: 'Review this PR carefully',
    owner: 'acme',
    repo: 'widgets',
    prNumber: 42,
    timeout: 300,
  };

  function createMockClient(text: string, inputTokens = 100, outputTokens = 50) {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });
    const mockClient = { messages: { create: mockCreate } };
    const createClient = vi.fn().mockReturnValue(mockClient);
    return { mockCreate, createClient };
  }

  it('calls Anthropic API and returns summary', async () => {
    const { mockCreate, createClient } = createMockClient('## Summary\nAll good.');

    const result = await executeSummary(defaultRequest, defaultDeps, createClient as never);

    expect(result.summary).toBe('## Summary\nAll good.');
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
            content: expect.stringContaining('Review this PR carefully'),
          }),
        ]),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('includes all reviews in the user message', async () => {
    const { mockCreate, createClient } = createMockClient('Summary text');

    await executeSummary(defaultRequest, defaultDeps, createClient as never);

    const userContent = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(userContent).toContain('claude-sonnet/claude-code');
    expect(userContent).toContain('gpt-4/copilot');
    expect(userContent).toContain('Verdict: approve');
    expect(userContent).toContain('Verdict: request_changes');
  });

  it('includes review count in system prompt', async () => {
    const { mockCreate, createClient } = createMockClient('Summary');

    await executeSummary(defaultRequest, defaultDeps, createClient as never);

    const systemPrompt = mockCreate.mock.calls[0][0].system as string;
    expect(systemPrompt).toContain('2 individual code reviews');
  });

  it('rejects when input is too large', async () => {
    const largeReview = 'x'.repeat(MAX_INPUT_SIZE_BYTES + 1);
    const request: SummaryRequest = {
      ...defaultRequest,
      reviews: [{ agentId: 'a1', model: 'm', tool: 't', review: largeReview, verdict: 'approve' }],
    };

    await expect(executeSummary(request, defaultDeps, vi.fn() as never)).rejects.toThrow(
      InputTooLargeError,
    );
  });

  it('rejects when not enough time remaining', async () => {
    const request: SummaryRequest = { ...defaultRequest, timeout: 0 };

    await expect(executeSummary(request, defaultDeps, vi.fn() as never)).rejects.toThrow(
      'Not enough time remaining',
    );
  });

  it('rejects when timeout is exactly at safety margin', async () => {
    const request: SummaryRequest = { ...defaultRequest, timeout: 30 };

    await expect(executeSummary(request, defaultDeps, vi.fn() as never)).rejects.toThrow(
      'Not enough time remaining',
    );
  });

  it('handles missing usage in response', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Summary' }],
      usage: undefined,
    });
    const mockClient = { messages: { create: mockCreate } };
    const createClient = vi.fn().mockReturnValue(mockClient);

    const result = await executeSummary(defaultRequest, defaultDeps, createClient as never);

    expect(result.tokensUsed).toBe(0);
  });

  it('propagates API errors', async () => {
    const mockCreate = vi.fn().mockRejectedValue(new Error('API rate limited'));
    const mockClient = { messages: { create: mockCreate } };
    const createClient = vi.fn().mockReturnValue(mockClient);

    await expect(
      executeSummary(defaultRequest, defaultDeps, createClient as never),
    ).rejects.toThrow('API rate limited');
  });

  it('joins multiple text blocks in response', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: 'Part 2' },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const mockClient = { messages: { create: mockCreate } };
    const createClient = vi.fn().mockReturnValue(mockClient);

    const result = await executeSummary(defaultRequest, defaultDeps, createClient as never);

    expect(result.summary).toBe('Part 1\nPart 2');
  });

  it('filters out non-text blocks', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        { type: 'tool_use', text: 'ignored' },
        { type: 'text', text: 'Actual summary' },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const mockClient = { messages: { create: mockCreate } };
    const createClient = vi.fn().mockReturnValue(mockClient);

    const result = await executeSummary(defaultRequest, defaultDeps, createClient as never);

    expect(result.summary).toBe('Actual summary');
  });

  it('passes abort signal to Anthropic client', async () => {
    const { mockCreate, createClient } = createMockClient('Summary');

    await executeSummary(defaultRequest, defaultDeps, createClient as never);

    const options = mockCreate.mock.calls[0][1] as { signal: AbortSignal };
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
  });
});
