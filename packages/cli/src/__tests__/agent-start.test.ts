import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  buildWsUrl,
  handleMessage,
  syncAgentToServer,
  resolveAnonymousAgent,
  type ConsumptionDeps,
} from '../commands/agent.js';
import type { ReviewExecutorDeps } from '../review.js';
import type { AgentResponse } from '@opencara/shared';
import { createSessionTracker } from '../consumption.js';
import { ApiClient } from '../http.js';
import { RouterRelay } from '../router.js';

describe('buildWsUrl', () => {
  it('converts https to wss', () => {
    const url = buildWsUrl('https://api.opencara.dev', 'agent-123', 'cr_key');
    expect(url).toBe('wss://api.opencara.dev/ws/agent/agent-123?token=cr_key');
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
      tokensEstimated: false,
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
      tokensEstimated: false,
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

  it('handles connected message and sends agent_preferences with default repo config', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ws = { send: vi.fn() };

    handleMessage(ws, { type: 'connected', version: '1' });

    expect(consoleSpy).toHaveBeenCalledWith('Authenticated. Protocol v1');

    // Should send agent_preferences
    expect(ws.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('agent_preferences');
    expect(sent.repoConfig).toEqual({ mode: 'all' });
    expect(sent.id).toBeDefined();
    expect(sent.timestamp).toBeTypeOf('number');

    consoleSpy.mockRestore();
  });

  it('sends agent_preferences with custom repo config on connected', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ws = { send: vi.fn() };

    const repoConfig = { mode: 'whitelist' as const, list: ['org/repo'] };
    handleMessage(
      ws,
      { type: 'connected', version: '1' },
      undefined,
      undefined,
      undefined,
      undefined,
      repoConfig,
    );

    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('agent_preferences');
    expect(sent.repoConfig).toEqual({ mode: 'whitelist', list: ['org/repo'] });

    consoleSpy.mockRestore();
  });

  it('sends agent_preferences with displayName on connected', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ws = { send: vi.fn() };

    handleMessage(
      ws,
      { type: 'connected', version: '1' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'SecurityBot',
    );

    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('agent_preferences');
    expect(sent.displayName).toBe('SecurityBot');
    expect(sent.repoConfig).toEqual({ mode: 'all' });

    consoleSpy.mockRestore();
  });

  it('does not include displayName in agent_preferences when not set', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ws = { send: vi.fn() };

    handleMessage(ws, { type: 'connected', version: '1' });

    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('agent_preferences');
    expect(sent.displayName).toBeUndefined();

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
    const reviewModule = await import('../review.js');
    const executeSpy = vi.spyOn(reviewModule, 'executeReview').mockResolvedValue({
      review: 'Looks good!',
      verdict: 'approve',
      tokensUsed: 150,
      tokensEstimated: false,
    });

    const { handleMessage: hm } = await import('../commands/agent.js');

    const consumptionDeps: ConsumptionDeps = {
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

describe('syncAgentToServer', () => {
  function makeServerAgent(overrides?: Partial<AgentResponse>): AgentResponse {
    return {
      id: 'agent-1',
      model: 'claude-sonnet-4-6',
      tool: 'claude-code',
      status: 'online',
      repoConfig: null,
      createdAt: '2024-01-01T00:00:00Z',
      ...overrides,
    };
  }

  it('returns existing agent when model+tool match', async () => {
    const client = { post: vi.fn() } as unknown as ApiClient;
    const result = await syncAgentToServer(client, [makeServerAgent()], {
      model: 'claude-sonnet-4-6',
      tool: 'claude-code',
    });

    expect(result.agentId).toBe('agent-1');
    expect(result.created).toBe(false);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('creates new agent without repoConfig when repos not specified', async () => {
    const client = {
      post: vi.fn().mockResolvedValue({ id: 'new-agent' }),
    } as unknown as ApiClient;

    const result = await syncAgentToServer(client, [], { model: 'gpt-4', tool: 'copilot' });

    expect(result.agentId).toBe('new-agent');
    expect(result.created).toBe(true);
    expect(client.post).toHaveBeenCalledWith('/api/agents', {
      model: 'gpt-4',
      tool: 'copilot',
    });
  });

  it('creates new agent with repoConfig when repos specified', async () => {
    const client = {
      post: vi.fn().mockResolvedValue({ id: 'new-agent' }),
    } as unknown as ApiClient;

    const result = await syncAgentToServer(client, [], {
      model: 'gpt-4',
      tool: 'copilot',
      repos: { mode: 'whitelist', list: ['org/repo'] },
    });

    expect(result.agentId).toBe('new-agent');
    expect(result.created).toBe(true);
    expect(client.post).toHaveBeenCalledWith('/api/agents', {
      model: 'gpt-4',
      tool: 'copilot',
      repoConfig: { mode: 'whitelist', list: ['org/repo'] },
    });
  });

  it('creates new agent with displayName when name specified', async () => {
    const client = {
      post: vi.fn().mockResolvedValue({ id: 'new-agent' }),
    } as unknown as ApiClient;

    const result = await syncAgentToServer(client, [], {
      model: 'gpt-4',
      tool: 'copilot',
      name: 'SecurityBot',
    });

    expect(result.agentId).toBe('new-agent');
    expect(result.created).toBe(true);
    expect(client.post).toHaveBeenCalledWith('/api/agents', {
      model: 'gpt-4',
      tool: 'copilot',
      displayName: 'SecurityBot',
    });
  });

  it('does not include displayName when name is not specified', async () => {
    const client = {
      post: vi.fn().mockResolvedValue({ id: 'new-agent' }),
    } as unknown as ApiClient;

    await syncAgentToServer(client, [], {
      model: 'gpt-4',
      tool: 'copilot',
    });

    const calledWith = client.post.mock.calls[0][1] as Record<string, unknown>;
    expect(calledWith.displayName).toBeUndefined();
  });
});

describe('resolveAnonymousAgent', () => {
  it('reuses stored anonymous agent with matching model+tool', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const config = {
      apiKey: null,
      platformUrl: 'https://test.api.dev',
      maxDiffSizeKb: 100,
      limits: null,
      agentCommand: null,
      agents: null,
      anonymousAgents: [
        {
          agentId: 'existing-1',
          apiKey: 'cr_existing',
          model: 'claude-sonnet-4-6',
          tool: 'claude',
        },
      ],
    };

    const result = await resolveAnonymousAgent(config, 'claude-sonnet-4-6', 'claude');

    expect(result.entry.agentId).toBe('existing-1');
    expect(result.entry.apiKey).toBe('cr_existing');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Reusing stored anonymous agent'));
    logSpy.mockRestore();
  });

  it('registers new anonymous agent when no stored credentials', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Mock fetch for the API call and saveConfig's fs.writeFileSync
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ agentId: 'new-anon', apiKey: 'cr_new' }),
    });

    // Mock the saveConfig import to prevent fs access
    const configModule = await import('../config.js');
    const saveConfigSpy = vi.spyOn(configModule, 'saveConfig').mockImplementation(() => {});

    const config = {
      apiKey: null,
      platformUrl: 'https://test.api.dev',
      maxDiffSizeKb: 100,
      limits: null,
      agentCommand: null,
      agents: null,
      anonymousAgents: [] as Array<{
        agentId: string;
        apiKey: string;
        model: string;
        tool: string;
        repoConfig?: unknown;
      }>,
    };

    const result = await resolveAnonymousAgent(config, 'claude-sonnet-4-6', 'claude');

    expect(result.entry.agentId).toBe('new-anon');
    expect(result.entry.apiKey).toBe('cr_new');
    // Agent should be added to config
    expect(config.anonymousAgents).toHaveLength(1);
    expect(config.anonymousAgents[0].agentId).toBe('new-anon');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Registering anonymous agent'));
    expect(saveConfigSpy).toHaveBeenCalled();

    globalThis.fetch = originalFetch;
    logSpy.mockRestore();
    saveConfigSpy.mockRestore();
  });

  it('throws when API registration fails', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Server error' }),
    });

    const config = {
      apiKey: null,
      platformUrl: 'https://test.api.dev',
      maxDiffSizeKb: 100,
      limits: null,
      agentCommand: null,
      agents: null,
      anonymousAgents: [],
    };

    await expect(resolveAnonymousAgent(config, 'claude-sonnet-4-6', 'claude')).rejects.toThrow(
      'Server error',
    );

    globalThis.fetch = originalFetch;
    logSpy.mockRestore();
  });
});

describe('handleMessage with routerRelay', () => {
  function createTestRelay(): {
    relay: RouterRelay;
    stdin: PassThrough;
    getStdout: () => string[];
    getStderr: () => string[];
  } {
    const stdin = new PassThrough();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdout = {
      write: (data: string) => {
        stdoutChunks.push(data);
      },
    };
    const stderr = {
      write: (data: string) => {
        stderrChunks.push(data);
      },
    };
    const relay = new RouterRelay({ stdin, stdout, stderr });
    relay.start();
    return { relay, stdin, getStdout: () => stdoutChunks, getStderr: () => stderrChunks };
  }

  it('outputs idle message on connected when in router mode', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ws = { send: vi.fn() };
    const { relay, getStderr } = createTestRelay();

    handleMessage(
      ws,
      { type: 'connected', version: '1' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      relay,
    );

    // Should have sent agent_preferences via WS
    const wsSent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(wsSent.type).toBe('agent_preferences');

    // Should have written idle message to stderr
    const stderrOutput = getStderr();
    expect(stderrOutput.length).toBeGreaterThanOrEqual(1);
    expect(stderrOutput[stderrOutput.length - 1]).toContain('Waiting for review requests...');

    relay.stop();
    consoleSpy.mockRestore();
  });

  it('routes review_request through router relay', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ws = { send: vi.fn() };
    const { relay, stdin, getStdout } = createTestRelay();

    handleMessage(
      ws,
      {
        type: 'review_request',
        taskId: 'task-1',
        diffContent: '+ new line',
        project: { owner: 'acme', repo: 'widgets', prompt: 'Review this' },
        pr: { url: '', number: 42, diffUrl: '', base: '', head: '' },
        timeout: 300,
        reviewMode: 'full',
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      relay,
    );

    // Wait for prompt to be written to stdout as plain text
    await vi.waitFor(() => {
      expect(getStdout().length).toBeGreaterThan(0);
    });

    // Verify prompt is plain text containing the review context
    const output = getStdout().join('');
    expect(output).toContain('acme/widgets');
    expect(output).toContain('+ new line');

    // Send response via stdin as plain text, terminated by END_OF_RESPONSE
    stdin.write('## Summary\n');
    stdin.write('LGTM\n');
    stdin.write('\n');
    stdin.write('## Findings\n');
    stdin.write('No issues.\n');
    stdin.write('\n');
    stdin.write('## Verdict\n');
    stdin.write('APPROVE\n');
    stdin.write('<<<OPENCARA_END_RESPONSE>>>\n');

    // Wait for WS send
    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalled();
    });

    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('review_complete');
    expect(sent.taskId).toBe('task-1');
    expect(sent.verdict).toBe('approve');
    expect(sent.review).toContain('LGTM');
    expect(sent.tokensUsed).toBeGreaterThan(0);

    relay.stop();
    consoleSpy.mockRestore();
  });

  it('routes summary_request through router relay', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ws = { send: vi.fn() };
    const { relay, stdin, getStdout } = createTestRelay();

    handleMessage(
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
        diffContent: 'diff content',
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      relay,
    );

    await vi.waitFor(() => {
      expect(getStdout().length).toBeGreaterThan(0);
    });

    // Verify prompt is plain text
    const output = getStdout().join('');
    expect(output).toContain('acme/widgets');

    // Send summary response as plain text
    stdin.write('All reviews agree the code is good.\n');
    stdin.write('<<<OPENCARA_END_RESPONSE>>>\n');

    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalled();
    });

    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('summary_complete');
    expect(sent.taskId).toBe('task-2');
    expect(sent.summary).toBe('All reviews agree the code is good.');
    expect(sent.tokensUsed).toBeGreaterThan(0);

    relay.stop();
    consoleSpy.mockRestore();
  });

  it('sends review_error on router timeout', async () => {
    vi.useFakeTimers();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ws = { send: vi.fn() };
    const { relay } = createTestRelay();

    handleMessage(
      ws,
      {
        type: 'review_request',
        taskId: 'task-1',
        diffContent: 'diff',
        project: { owner: 'a', repo: 'b', prompt: 'p' },
        pr: { url: '', number: 1, diffUrl: '', base: '', head: '' },
        timeout: 5,
        reviewMode: 'full',
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      relay,
    );

    // Advance past timeout
    vi.advanceTimersByTime(5001);

    await vi.waitFor(() => {
      expect(ws.send).toHaveBeenCalled();
    });

    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('review_error');
    expect(sent.taskId).toBe('task-1');
    expect(sent.error).toContain('timeout');

    relay.stop();
    vi.useRealTimers();
    consoleSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('does not require reviewDeps when router relay is provided', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ws = { send: vi.fn() };
    const { relay } = createTestRelay();

    // Without routerRelay and without reviewDeps, it would send review_rejected
    // With routerRelay, it should relay through the router instead
    handleMessage(
      ws,
      {
        type: 'review_request',
        taskId: 'task-1',
        diffContent: 'diff',
        project: { owner: 'a', repo: 'b', prompt: 'p' },
        pr: { url: '', number: 1, diffUrl: '', base: '', head: '' },
        timeout: 300,
        reviewMode: 'full',
      } as never,
      undefined,
      undefined, // no reviewDeps
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      relay,
    );

    // Should NOT have sent review_rejected
    // (ws.send is only called synchronously for rejected, router path is async)
    expect(ws.send).not.toHaveBeenCalled();

    relay.stop();
    consoleSpy.mockRestore();
  });
});
