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
import type { ToolExecutorResult } from '../tool-executor.js';

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
    expect(prompt).toContain('3 compact reviews');
    expect(prompt).toContain('senior code reviewer and synthesizer');
  });

  it('includes formatting instructions', () => {
    const prompt = buildSummarySystemPrompt('org', 'repo', 1);
    expect(prompt).toContain('markdown');
    expect(prompt).toContain('## Findings');
  });
});

describe('buildSummaryUserMessage', () => {
  it('includes project prompt, diff, and all reviews', () => {
    const message = buildSummaryUserMessage('Check for bugs', sampleReviews, 'diff content');
    expect(message).toContain('Check for bugs');
    expect(message).toContain('diff content');
    expect(message).toContain('claude-sonnet/claude-code');
    expect(message).toContain('Verdict: approve');
    expect(message).toContain('Code looks clean. LGTM.');
    expect(message).toContain('gpt-4/copilot');
    expect(message).toContain('Verdict: request_changes');
    expect(message).toContain('Found a potential null reference');
  });

  it('handles single review', () => {
    const message = buildSummaryUserMessage('Review', [sampleReviews[0]], 'diff');
    expect(message).toContain('claude-sonnet/claude-code');
    expect(message).not.toContain('gpt-4');
  });

  it('handles empty reviews array', () => {
    const message = buildSummaryUserMessage('Review', [], 'diff');
    expect(message).toContain('Review');
    expect(message).toContain('Compact reviews from other agents:');
  });
});

describe('calculateInputSize', () => {
  it('sums byte lengths of prompt, diff, and review fields', () => {
    const size = calculateInputSize(
      'short prompt',
      [{ agentId: 'a1', model: 'model', tool: 'tool', review: 'review text', verdict: 'approve' }],
      'diff data',
    );
    expect(size).toBeGreaterThan(0);
    expect(size).toBe(
      Buffer.byteLength('short prompt', 'utf-8') +
        Buffer.byteLength('diff data', 'utf-8') +
        Buffer.byteLength('review text', 'utf-8') +
        Buffer.byteLength('model', 'utf-8') +
        Buffer.byteLength('tool', 'utf-8') +
        Buffer.byteLength('approve', 'utf-8'),
    );
  });

  it('returns prompt + diff size for empty reviews', () => {
    const size = calculateInputSize('my prompt', [], 'diff');
    expect(size).toBe(Buffer.byteLength('my prompt', 'utf-8') + Buffer.byteLength('diff', 'utf-8'));
  });

  it('handles multi-byte characters', () => {
    const size = calculateInputSize(
      '',
      [{ agentId: 'a', model: 'm', tool: 't', review: '\u{1F600}'.repeat(10), verdict: 'approve' }],
      '',
    );
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
    commandTemplate: 'claude -p --output-format text',
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
    diffContent: 'diff --git a/file.ts\n+hello',
  };

  function createMockRunTool(stdout: string, tokensUsed = 0) {
    return vi
      .fn<
        (
          commandTemplate: string,
          prompt: string,
          timeoutMs: number,
          signal?: AbortSignal,
        ) => Promise<ToolExecutorResult>
      >()
      .mockResolvedValue({ stdout, tokensUsed });
  }

  it('invokes tool subprocess and returns summary', async () => {
    const mockRunTool = createMockRunTool('## Summary\nAll good.');

    const result = await executeSummary(defaultRequest, defaultDeps, mockRunTool);

    expect(result.summary).toBe('## Summary\nAll good.');
    // Includes input prompt estimate + output estimate
    expect(result.tokensUsed).toBeGreaterThan(0);
    expect(mockRunTool).toHaveBeenCalledWith(
      'claude -p --output-format text',
      expect.stringContaining('acme/widgets'),
      expect.any(Number),
      expect.any(AbortSignal),
    );
  });

  it('includes all reviews in the prompt', async () => {
    const mockRunTool = createMockRunTool('Summary text');

    await executeSummary(defaultRequest, defaultDeps, mockRunTool);

    const prompt = mockRunTool.mock.calls[0][1];
    expect(prompt).toContain('claude-sonnet/claude-code');
    expect(prompt).toContain('gpt-4/copilot');
    expect(prompt).toContain('Verdict: approve');
    expect(prompt).toContain('Verdict: request_changes');
  });

  it('includes review count in system prompt portion', async () => {
    const mockRunTool = createMockRunTool('Summary');

    await executeSummary(defaultRequest, defaultDeps, mockRunTool);

    const prompt = mockRunTool.mock.calls[0][1];
    expect(prompt).toContain('2 compact reviews');
  });

  it('rejects when input is too large', async () => {
    const largeReview = 'x'.repeat(MAX_INPUT_SIZE_BYTES + 1);
    const request: SummaryRequest = {
      ...defaultRequest,
      reviews: [{ agentId: 'a1', model: 'm', tool: 't', review: largeReview, verdict: 'approve' }],
    };

    await expect(executeSummary(request, defaultDeps, vi.fn())).rejects.toThrow(InputTooLargeError);
  });

  it('rejects when not enough time remaining', async () => {
    const request: SummaryRequest = { ...defaultRequest, timeout: 0 };

    await expect(executeSummary(request, defaultDeps, vi.fn())).rejects.toThrow(
      'Not enough time remaining',
    );
  });

  it('rejects when timeout is exactly at safety margin', async () => {
    const request: SummaryRequest = { ...defaultRequest, timeout: 30 };

    await expect(executeSummary(request, defaultDeps, vi.fn())).rejects.toThrow(
      'Not enough time remaining',
    );
  });

  it('returns tokensUsed from tool when reported', async () => {
    const mockRunTool = createMockRunTool('Summary', 200);

    const result = await executeSummary(defaultRequest, defaultDeps, mockRunTool);

    // 200 from tool + input prompt estimate
    expect(result.tokensUsed).toBeGreaterThan(200);
  });

  it('propagates tool errors', async () => {
    const mockRunTool = vi.fn().mockRejectedValue(new Error('Tool crashed'));

    await expect(executeSummary(defaultRequest, defaultDeps, mockRunTool)).rejects.toThrow(
      'Tool crashed',
    );
  });

  it('passes correct timeout to tool', async () => {
    const mockRunTool = createMockRunTool('Summary');

    await executeSummary(defaultRequest, defaultDeps, mockRunTool);

    // timeout is 300s, safety margin is 30s, effective = 270s = 270000ms
    const timeoutMs = mockRunTool.mock.calls[0][2];
    expect(timeoutMs).toBe(270_000);
  });

  it('passes abort signal to tool', async () => {
    const mockRunTool = createMockRunTool('Summary');

    await executeSummary(defaultRequest, defaultDeps, mockRunTool);

    const signal = mockRunTool.mock.calls[0][3] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });
});
