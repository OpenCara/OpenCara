import { describe, it, expect, vi } from 'vitest';
import type { PollTask } from '@opencara/shared';
import type { ToolExecutorResult } from '../tool-executor.js';
import {
  buildIssueReviewPrompt,
  executeIssueReview,
  executeIssueReviewTask,
  type IssueReviewExecutorDeps,
} from '../issue-review.js';

// ── Helpers ──────────────────────────────────────────────────────

function makeTask(overrides: Partial<PollTask> = {}): PollTask {
  return {
    task_id: 'task-1',
    owner: 'acme',
    repo: 'widgets',
    pr_number: 0,
    diff_url: '',
    timeout_seconds: 300,
    prompt: '',
    role: 'issue_review',
    issue_number: 42,
    issue_title: 'Add dark mode support',
    issue_body: 'As a user I want dark mode so my eyes do not hurt at night.',
    ...overrides,
  };
}

function makeToolResult(stdout: string): ToolExecutorResult {
  return {
    stdout,
    stderr: '',
    tokensUsed: 100,
    tokensParsed: false,
    tokenDetail: { input: 0, output: 100, total: 100, parsed: false },
  };
}

// ── buildIssueReviewPrompt ──────────────────────────────────────

describe('buildIssueReviewPrompt', () => {
  it('includes issue title and body', () => {
    const prompt = buildIssueReviewPrompt(makeTask());
    expect(prompt).toContain('Add dark mode support');
    expect(prompt).toContain('dark mode so my eyes do not hurt');
  });

  it('wraps issue body in UNTRUSTED_CONTENT tags', () => {
    const prompt = buildIssueReviewPrompt(makeTask());
    expect(prompt).toContain('<UNTRUSTED_CONTENT>');
    expect(prompt).toContain('</UNTRUSTED_CONTENT>');
    const start = prompt.indexOf('<UNTRUSTED_CONTENT>');
    const end = prompt.indexOf('</UNTRUSTED_CONTENT>');
    const between = prompt.slice(start, end);
    expect(between).toContain('dark mode');
  });

  it('truncates long issue bodies to 10KB', () => {
    const longBody = 'x'.repeat(20_000);
    const prompt = buildIssueReviewPrompt(makeTask({ issue_body: longBody }));
    expect(prompt).toContain('truncated to 10KB');
  });

  it('includes repo-specific prompt when provided', () => {
    const prompt = buildIssueReviewPrompt(makeTask({ prompt: 'custom review guidelines' }));
    expect(prompt).toContain('Repo-Specific Instructions');
    expect(prompt).toContain('custom review guidelines');
  });

  it('omits repo-specific section when prompt is empty', () => {
    const prompt = buildIssueReviewPrompt(makeTask({ prompt: '' }));
    expect(prompt).not.toContain('Repo-Specific Instructions');
  });

  it('handles missing issue_title gracefully', () => {
    const prompt = buildIssueReviewPrompt(makeTask({ issue_title: undefined, issue_number: 99 }));
    expect(prompt).toContain('Issue #99');
  });

  it('falls back to pr_number when no issue_number or title', () => {
    const prompt = buildIssueReviewPrompt(
      makeTask({ issue_title: undefined, issue_number: undefined, pr_number: 7 }),
    );
    expect(prompt).toContain('Issue #7');
  });

  it('handles missing issue_body gracefully', () => {
    const prompt = buildIssueReviewPrompt(makeTask({ issue_body: undefined }));
    expect(prompt).toContain('(no body provided)');
  });

  it('handles empty issue_body', () => {
    const prompt = buildIssueReviewPrompt(makeTask({ issue_body: '' }));
    expect(prompt).toContain('(no body provided)');
  });

  it('includes system prompt with review criteria', () => {
    const prompt = buildIssueReviewPrompt(makeTask());
    expect(prompt).toContain('quality reviewer');
    expect(prompt).toContain('Clarity');
    expect(prompt).toContain('Completeness');
    expect(prompt).toContain('Actionability');
    expect(prompt).toContain('Scope');
    expect(prompt).toContain('Verdict');
  });
});

// ── executeIssueReview ──────────────────────────────────────────

describe('executeIssueReview', () => {
  const deps: IssueReviewExecutorDeps = { commandTemplate: 'echo {{prompt}}' };

  it('returns review text from tool output', async () => {
    const runTool = vi
      .fn()
      .mockResolvedValue(makeToolResult('## Summary\nLooks good.\n\n**Verdict**: approve'));
    const result = await executeIssueReview(makeTask(), deps, 300, undefined, runTool);
    expect(result.reviewText).toContain('Looks good');
    expect(result.reviewText).toContain('approve');
  });

  it('trims whitespace from output', async () => {
    const runTool = vi.fn().mockResolvedValue(makeToolResult('  review text  \n\n'));
    const result = await executeIssueReview(makeTask(), deps, 300, undefined, runTool);
    expect(result.reviewText).toBe('review text');
  });

  it('throws on empty output', async () => {
    const runTool = vi.fn().mockResolvedValue(makeToolResult('   \n  '));
    await expect(executeIssueReview(makeTask(), deps, 300, undefined, runTool)).rejects.toThrow(
      'Issue review produced empty output',
    );
  });

  it('throws when timeout too short', async () => {
    const runTool = vi.fn();
    await expect(executeIssueReview(makeTask(), deps, 25, undefined, runTool)).rejects.toThrow(
      'Not enough time remaining',
    );
    expect(runTool).not.toHaveBeenCalled();
  });

  it('computes token usage with estimation', async () => {
    const runTool = vi.fn().mockResolvedValue(makeToolResult('review'));
    const result = await executeIssueReview(makeTask(), deps, 300, undefined, runTool);
    expect(result.tokensEstimated).toBe(true);
    expect(result.tokenDetail.parsed).toBe(false);
    expect(result.tokensUsed).toBeGreaterThan(100); // 100 from tool + estimated input
  });

  it('uses parsed token counts when available', async () => {
    const runTool = vi.fn().mockResolvedValue({
      stdout: 'review output',
      stderr: '',
      tokensUsed: 500,
      tokensParsed: true,
      tokenDetail: { input: 300, output: 200, total: 500, parsed: true },
    });
    const result = await executeIssueReview(makeTask(), deps, 300, undefined, runTool);
    expect(result.tokensEstimated).toBe(false);
    expect(result.tokensUsed).toBe(500);
    expect(result.tokenDetail.parsed).toBe(true);
  });

  it('passes signal and timeout to tool', async () => {
    const controller = new AbortController();
    const runTool = vi.fn().mockResolvedValue(makeToolResult('review'));
    await executeIssueReview(makeTask(), deps, 300, controller.signal, runTool);
    expect(runTool).toHaveBeenCalledWith(
      'echo {{prompt}}',
      expect.any(String),
      270_000, // 300s - 30s safety margin
      controller.signal,
    );
  });
});

// ── executeIssueReviewTask ──────────────────────────────────────

describe('executeIssueReviewTask', () => {
  const deps: IssueReviewExecutorDeps = { commandTemplate: 'echo {{prompt}}' };
  const logger = { log: vi.fn() };

  it('submits result to server', async () => {
    const client = { post: vi.fn().mockResolvedValue({}) };
    const runTool = vi.fn().mockResolvedValue(makeToolResult('Great issue!'));

    await executeIssueReviewTask(
      client,
      'agent-1',
      makeTask(),
      deps,
      300,
      logger,
      undefined,
      runTool,
    );

    expect(client.post).toHaveBeenCalledWith('/api/tasks/task-1/result', {
      agent_id: 'agent-1',
      type: 'issue_review',
      review_text: 'Great issue!',
      tokens_used: expect.any(Number),
    });
  });

  it('returns token usage stats', async () => {
    const client = { post: vi.fn().mockResolvedValue({}) };
    const runTool = vi.fn().mockResolvedValue(makeToolResult('Good issue'));

    const result = await executeIssueReviewTask(
      client,
      'agent-1',
      makeTask(),
      deps,
      300,
      logger,
      undefined,
      runTool,
    );

    expect(result.tokensUsed).toBeGreaterThan(0);
    expect(result.tokenDetail).toBeDefined();
    expect(typeof result.tokensEstimated).toBe('boolean');
  });

  it('logs issue reference', async () => {
    const logFn = vi.fn();
    const client = { post: vi.fn().mockResolvedValue({}) };
    const runTool = vi.fn().mockResolvedValue(makeToolResult('review text'));

    await executeIssueReviewTask(
      client,
      'agent-1',
      makeTask(),
      deps,
      300,
      { log: logFn },
      undefined,
      runTool,
    );

    expect(logFn).toHaveBeenCalledWith(expect.stringContaining('Add dark mode support'));
  });

  it('uses custom role when provided', async () => {
    const client = { post: vi.fn().mockResolvedValue({}) };
    const runTool = vi.fn().mockResolvedValue(makeToolResult('review'));

    await executeIssueReviewTask(
      client,
      'agent-1',
      makeTask(),
      deps,
      300,
      logger,
      undefined,
      runTool,
      'issue_review',
    );

    expect(client.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'issue_review' }),
    );
  });

  it('falls back to issue number when no title', async () => {
    const logFn = vi.fn();
    const client = { post: vi.fn().mockResolvedValue({}) };
    const runTool = vi.fn().mockResolvedValue(makeToolResult('review'));

    await executeIssueReviewTask(
      client,
      'agent-1',
      makeTask({ issue_title: undefined, issue_number: 55 }),
      deps,
      300,
      { log: logFn },
      undefined,
      runTool,
    );

    expect(logFn).toHaveBeenCalledWith(expect.stringContaining('#55'));
  });
});
