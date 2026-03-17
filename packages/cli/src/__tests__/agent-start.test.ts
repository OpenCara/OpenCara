import { describe, it, expect, vi } from 'vitest';
import { buildWsUrl, handleMessage, type ConsumptionDeps } from '../commands/agent.js';
import type { ReviewExecutorDeps } from '../review.js';
import { createSessionTracker } from '../consumption.js';
import { ApiClient } from '../http.js';

describe('buildWsUrl', () => {
  it('converts https to wss', () => {
    const url = buildWsUrl('https://api.opencrust.dev', 'agent-123', 'cr_key');
    expect(url).toBe('wss://api.opencrust.dev/ws/agent/agent-123?token=cr_key');
  });

  it('converts http to ws', () => {
    const url = buildWsUrl('http://localhost:8787', 'agent-456', 'cr_test');
    expect(url).toBe('ws://localhost:8787/ws/agent/agent-456?token=cr_test');
  });

  it('encodes special characters in apiKey', () => {
    const url = buildWsUrl('https://api.test.com', 'a1', 'cr_k+y=');
    expect(url).toContain('token=cr_k%2By%3D');
  });
});

describe('handleMessage', () => {
  it('responds to heartbeat_ping with heartbeat_pong', () => {
    const send = vi.fn();
    const ws = { send };

    handleMessage(ws, { type: 'heartbeat_ping', timestamp: 1000 });

    expect(send).toHaveBeenCalledOnce();
    const sent = JSON.parse(send.mock.calls[0][0]);
    expect(sent.type).toBe('heartbeat_pong');
    expect(sent.timestamp).toBeTypeOf('number');
  });

  it('calls resetHeartbeat on heartbeat_ping', () => {
    const resetHeartbeat = vi.fn();
    const ws = { send: vi.fn() };

    handleMessage(ws, { type: 'heartbeat_ping', timestamp: 1000 }, resetHeartbeat);
    expect(resetHeartbeat).toHaveBeenCalledOnce();
  });

  it('rejects review_request when no reviewDeps', () => {
    const send = vi.fn();
    const ws = { send };

    handleMessage(ws, {
      type: 'review_request',
      taskId: 'task-1',
      diffContent: 'diff',
      project: { owner: 'a', repo: 'b', prompt: 'p' },
      pr: { url: '', number: 1, diffUrl: '', base: '', head: '' },
      timeout: 300,
    } as never);

    const sent = JSON.parse(send.mock.calls[0][0]);
    expect(sent.type).toBe('review_rejected');
    expect(sent.taskId).toBe('task-1');
    expect(sent.reason).toContain('not configured');
  });

  it('sends review_complete on successful review', async () => {
    const send = vi.fn();
    const ws = { send };

    const mockReviewDeps: ReviewExecutorDeps = {
      tool: 'claude-code',
      maxDiffSizeKb: 100,
    };

    const reviewModule = await import('../review.js');
    const executeSpy = vi.spyOn(reviewModule, 'executeReview').mockResolvedValue({
      review: 'Looks good!',
      verdict: 'approve',
      tokensUsed: 150,
    });

    const { handleMessage: hm } = await import('../commands/agent.js');

    hm(
      ws,
      {
        type: 'review_request',
        taskId: 'task-1',
        diffContent: 'some diff',
        project: { owner: 'acme', repo: 'widgets', prompt: 'Review this' },
        pr: { url: '', number: 42, diffUrl: '', base: '', head: '' },
        timeout: 300,
      } as never,
      undefined,
      mockReviewDeps,
    );

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled();
    });

    const sent = JSON.parse(send.mock.calls[0][0]);
    expect(sent.type).toBe('review_complete');
    expect(sent.taskId).toBe('task-1');
    expect(sent.review).toBe('Looks good!');
    expect(sent.verdict).toBe('approve');
    expect(sent.tokensUsed).toBe(150);

    executeSpy.mockRestore();
  });

  it('sends review_error on review failure', async () => {
    const send = vi.fn();
    const ws = { send };
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mockReviewDeps: ReviewExecutorDeps = {
      tool: 'claude-code',
      maxDiffSizeKb: 100,
    };

    const reviewModule = await import('../review.js');
    const executeSpy = vi
      .spyOn(reviewModule, 'executeReview')
      .mockRejectedValue(new Error('Tool not found'));

    const { handleMessage: hm } = await import('../commands/agent.js');

    hm(
      ws,
      {
        type: 'review_request',
        taskId: 'task-1',
        diffContent: 'some diff',
        project: { owner: 'acme', repo: 'widgets', prompt: 'Review this' },
        pr: { url: '', number: 42, diffUrl: '', base: '', head: '' },
        timeout: 300,
      } as never,
      undefined,
      mockReviewDeps,
    );

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled();
    });

    const sent = JSON.parse(send.mock.calls[0][0]);
    expect(sent.type).toBe('review_error');
    expect(sent.taskId).toBe('task-1');
    expect(sent.error).toBe('Tool not found');

    executeSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('sends review_rejected on DiffTooLargeError', async () => {
    const send = vi.fn();
    const ws = { send };
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mockReviewDeps: ReviewExecutorDeps = {
      tool: 'claude-code',
      maxDiffSizeKb: 100,
    };

    const reviewModule = await import('../review.js');
    const { DiffTooLargeError } = reviewModule;
    const executeSpy = vi
      .spyOn(reviewModule, 'executeReview')
      .mockRejectedValue(new DiffTooLargeError('Diff too large (200KB > 100KB limit)'));

    const { handleMessage: hm } = await import('../commands/agent.js');

    hm(
      ws,
      {
        type: 'review_request',
        taskId: 'task-1',
        diffContent: 'some diff',
        project: { owner: 'acme', repo: 'widgets', prompt: 'Review this' },
        pr: { url: '', number: 42, diffUrl: '', base: '', head: '' },
        timeout: 300,
      } as never,
      undefined,
      mockReviewDeps,
    );

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled();
    });

    const sent = JSON.parse(send.mock.calls[0][0]);
    expect(sent.type).toBe('review_rejected');
    expect(sent.taskId).toBe('task-1');
    expect(sent.reason).toContain('Diff too large');

    executeSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('rejects summary_request when no reviewDeps', () => {
    const send = vi.fn();
    const ws = { send };

    handleMessage(ws, {
      type: 'summary_request',
      taskId: 'task-2',
      pr: { url: '', number: 1 },
      project: { owner: 'acme', repo: 'widgets', prompt: 'Review' },
      reviews: [
        { agentId: 'a1', model: 'claude', tool: 'code', review: 'LGTM', verdict: 'approve' },
      ],
      timeout: 300,
    } as never);

    const sent = JSON.parse(send.mock.calls[0][0]);
    expect(sent.type).toBe('review_rejected');
    expect(sent.taskId).toBe('task-2');
    expect(sent.reason).toContain('not configured');
  });

  it('sends summary_complete on successful summary', async () => {
    const send = vi.fn();
    const ws = { send };

    const mockReviewDeps: ReviewExecutorDeps = {
      tool: 'claude-code',
      maxDiffSizeKb: 100,
    };

    const summaryModule = await import('../summary.js');
    const executeSpy = vi.spyOn(summaryModule, 'executeSummary').mockResolvedValue({
      summary: '## Summary\nAll reviews agree the code is good.',
      tokensUsed: 200,
    });

    const { handleMessage: hm } = await import('../commands/agent.js');

    hm(
      ws,
      {
        type: 'summary_request',
        taskId: 'task-2',
        pr: { url: '', number: 5 },
        project: { owner: 'acme', repo: 'widgets', prompt: 'Review' },
        reviews: [
          { agentId: 'a1', model: 'claude', tool: 'code', review: 'LGTM', verdict: 'approve' },
        ],
        timeout: 300,
      } as never,
      undefined,
      mockReviewDeps,
    );

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled();
    });

    const sent = JSON.parse(send.mock.calls[0][0]);
    expect(sent.type).toBe('summary_complete');
    expect(sent.taskId).toBe('task-2');
    expect(sent.summary).toContain('All reviews agree');
    expect(sent.tokensUsed).toBe(200);

    executeSpy.mockRestore();
  });

  it('sends review_error on summary failure', async () => {
    const send = vi.fn();
    const ws = { send };
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mockReviewDeps: ReviewExecutorDeps = {
      tool: 'claude-code',
      maxDiffSizeKb: 100,
    };

    const summaryModule = await import('../summary.js');
    const executeSpy = vi
      .spyOn(summaryModule, 'executeSummary')
      .mockRejectedValue(new Error('Tool crashed'));

    const { handleMessage: hm } = await import('../commands/agent.js');

    hm(
      ws,
      {
        type: 'summary_request',
        taskId: 'task-2',
        pr: { url: '', number: 5 },
        project: { owner: 'acme', repo: 'widgets', prompt: 'Review' },
        reviews: [
          { agentId: 'a1', model: 'claude', tool: 'code', review: 'LGTM', verdict: 'approve' },
        ],
        timeout: 300,
      } as never,
      undefined,
      mockReviewDeps,
    );

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled();
    });

    const sent = JSON.parse(send.mock.calls[0][0]);
    expect(sent.type).toBe('review_error');
    expect(sent.taskId).toBe('task-2');
    expect(sent.error).toBe('Tool crashed');

    executeSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('sends review_rejected on InputTooLargeError', async () => {
    const send = vi.fn();
    const ws = { send };
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const mockReviewDeps: ReviewExecutorDeps = {
      tool: 'claude-code',
      maxDiffSizeKb: 100,
    };

    const summaryModule = await import('../summary.js');
    const { InputTooLargeError } = summaryModule;
    const executeSpy = vi
      .spyOn(summaryModule, 'executeSummary')
      .mockRejectedValue(new InputTooLargeError('Summary input too large (250KB > 200KB limit)'));

    const { handleMessage: hm } = await import('../commands/agent.js');

    hm(
      ws,
      {
        type: 'summary_request',
        taskId: 'task-2',
        pr: { url: '', number: 5 },
        project: { owner: 'acme', repo: 'widgets', prompt: 'Review' },
        reviews: [
          { agentId: 'a1', model: 'claude', tool: 'code', review: 'LGTM', verdict: 'approve' },
        ],
        timeout: 300,
      } as never,
      undefined,
      mockReviewDeps,
    );

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled();
    });

    const sent = JSON.parse(send.mock.calls[0][0]);
    expect(sent.type).toBe('review_rejected');
    expect(sent.taskId).toBe('task-2');
    expect(sent.reason).toContain('Summary input too large');

    executeSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('handles connected message', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ws = { send: vi.fn() };

    handleMessage(ws, { type: 'connected', version: '1' });

    expect(consoleSpy).toHaveBeenCalledWith('Authenticated. Protocol v1');
    consoleSpy.mockRestore();
  });

  it('handles error message', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ws = { send: vi.fn() };

    handleMessage(ws, { type: 'error', code: 'rate_limited' });

    expect(consoleSpy).toHaveBeenCalledWith('Platform error: rate_limited');
    consoleSpy.mockRestore();
  });

  it('ignores unknown message types', () => {
    const ws = { send: vi.fn() };
    handleMessage(ws, { type: 'unknown_type' });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('rejects review_request when consumption limit exceeded', async () => {
    const send = vi.fn();
    const ws = { send };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const mockReviewDeps: ReviewExecutorDeps = {
      tool: 'claude-code',
      maxDiffSizeKb: 100,
    };

    const consumptionModule = await import('../consumption.js');
    const checkSpy = vi.spyOn(consumptionModule, 'checkConsumptionLimits').mockResolvedValue({
      allowed: false,
      reason: 'Daily token limit reached (50,000/50,000)',
    });

    const { handleMessage: hm } = await import('../commands/agent.js');

    const consumptionDeps: ConsumptionDeps = {
      client: { get: vi.fn() } as unknown as ApiClient,
      agentId: 'agent-1',
      limits: { tokens_per_day: 50_000 },
      session: createSessionTracker(),
    };

    hm(
      ws,
      {
        type: 'review_request',
        taskId: 'task-1',
        diffContent: 'some diff',
        project: { owner: 'acme', repo: 'widgets', prompt: 'Review this' },
        pr: { url: '', number: 42, diffUrl: '', base: '', head: '' },
        timeout: 300,
      } as never,
      undefined,
      mockReviewDeps,
      consumptionDeps,
    );

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled();
    });

    const sent = JSON.parse(send.mock.calls[0][0]);
    expect(sent.type).toBe('review_rejected');
    expect(sent.taskId).toBe('task-1');
    expect(sent.reason).toContain('Daily token limit reached');

    checkSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('rejects summary_request when consumption limit exceeded', async () => {
    const send = vi.fn();
    const ws = { send };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const mockReviewDeps: ReviewExecutorDeps = {
      tool: 'claude-code',
      maxDiffSizeKb: 100,
    };

    const consumptionModule = await import('../consumption.js');
    const checkSpy = vi.spyOn(consumptionModule, 'checkConsumptionLimits').mockResolvedValue({
      allowed: false,
      reason: 'Daily review limit reached (20/20)',
    });

    const { handleMessage: hm } = await import('../commands/agent.js');

    const consumptionDeps: ConsumptionDeps = {
      client: { get: vi.fn() } as unknown as ApiClient,
      agentId: 'agent-1',
      limits: { reviews_per_day: 20 },
      session: createSessionTracker(),
    };

    hm(
      ws,
      {
        type: 'summary_request',
        taskId: 'task-2',
        pr: { url: '', number: 5 },
        project: { owner: 'acme', repo: 'widgets', prompt: 'Review' },
        reviews: [
          { agentId: 'a1', model: 'claude', tool: 'code', review: 'LGTM', verdict: 'approve' },
        ],
        timeout: 300,
      } as never,
      undefined,
      mockReviewDeps,
      consumptionDeps,
    );

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled();
    });

    const sent = JSON.parse(send.mock.calls[0][0]);
    expect(sent.type).toBe('review_rejected');
    expect(sent.taskId).toBe('task-2');
    expect(sent.reason).toContain('Daily review limit reached');

    checkSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('proceeds with review when consumption check passes', async () => {
    const send = vi.fn();
    const ws = { send };

    const mockReviewDeps: ReviewExecutorDeps = {
      tool: 'claude-code',
      maxDiffSizeKb: 100,
    };

    const consumptionModule = await import('../consumption.js');
    const checkSpy = vi.spyOn(consumptionModule, 'checkConsumptionLimits').mockResolvedValue({
      allowed: true,
    });
    const fetchSpy = vi
      .spyOn(consumptionModule, 'fetchConsumptionStats')
      .mockRejectedValue(new Error('API unavailable'));

    const reviewModule = await import('../review.js');
    const executeSpy = vi.spyOn(reviewModule, 'executeReview').mockResolvedValue({
      review: 'Looks good!',
      verdict: 'approve',
      tokensUsed: 150,
    });

    const { handleMessage: hm } = await import('../commands/agent.js');

    const consumptionDeps: ConsumptionDeps = {
      client: { get: vi.fn() } as unknown as ApiClient,
      agentId: 'agent-1',
      limits: { tokens_per_day: 50_000 },
      session: createSessionTracker(),
    };

    hm(
      ws,
      {
        type: 'review_request',
        taskId: 'task-1',
        diffContent: 'some diff',
        project: { owner: 'acme', repo: 'widgets', prompt: 'Review this' },
        pr: { url: '', number: 42, diffUrl: '', base: '', head: '' },
        timeout: 300,
      } as never,
      undefined,
      mockReviewDeps,
      consumptionDeps,
    );

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalled();
    });

    const sent = JSON.parse(send.mock.calls[0][0]);
    expect(sent.type).toBe('review_complete');
    expect(sent.verdict).toBe('approve');

    // Session stats should be updated
    expect(consumptionDeps.session.tokens).toBe(150);
    expect(consumptionDeps.session.reviews).toBe(1);

    checkSpy.mockRestore();
    fetchSpy.mockRestore();
    executeSpy.mockRestore();
  });

  it('logs verbose heartbeat diagnostics when verbose is true', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const send = vi.fn();
    const ws = { send };

    handleMessage(
      ws,
      { type: 'heartbeat_ping', timestamp: 1000 },
      undefined,
      undefined,
      undefined,
      true,
    );

    const verboseCalls = consoleSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('[verbose]'),
    );
    expect(verboseCalls.length).toBeGreaterThan(0);
    expect(verboseCalls[0][0]).toContain('Heartbeat ping received');
    consoleSpy.mockRestore();
  });

  it('does not log verbose heartbeat diagnostics when verbose is false', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const send = vi.fn();
    const ws = { send };

    handleMessage(
      ws,
      { type: 'heartbeat_ping', timestamp: 1000 },
      undefined,
      undefined,
      undefined,
      false,
    );

    const verboseCalls = consoleSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('[verbose]'),
    );
    expect(verboseCalls).toHaveLength(0);
    consoleSpy.mockRestore();
  });
});
