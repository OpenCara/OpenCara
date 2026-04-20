import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubOAuthFetch, OAUTH_HEADERS } from './test-oauth-helper.js';
import { DEFAULT_REVIEW_CONFIG, type ReviewTask } from '@opencara/shared';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';
import { resetTimeoutThrottle } from '../routes/tasks.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import { RELIABILITY_WINDOW_MS } from '../store/constants.js';

function makeTask(overrides: Partial<ReviewTask> = {}): ReviewTask {
  return {
    id: 'task-1',
    owner: 'test-org',
    repo: 'test-repo',
    pr_number: 1,
    pr_url: 'https://github.com/test-org/test-repo/pull/1',
    diff_url: 'https://github.com/test-org/test-repo/pull/1.diff',
    base_ref: 'main',
    head_ref: 'feature',
    review_count: 1,
    prompt: 'Review this PR',
    timeout_at: Date.now() + 600_000,
    status: 'reviewing',
    queue: 'summary',
    github_installation_id: 123,
    private: false,
    config: DEFAULT_REVIEW_CONFIG,
    created_at: Date.now(),
    task_type: 'review',
    feature: 'review',
    group_id: 'group-1',
    ...overrides,
  };
}

const mockEnv = {
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: 'test-key',
  WEB_URL: 'https://test.com',
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'csecret',
};

describe('Agent reliability — outcome recording', () => {
  let store: MemoryDataStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stubOAuthFetch();
    resetTimeoutThrottle();
    resetRateLimits();
    store = new MemoryDataStore();
    app = createApp(store);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function request(method: string, path: string, body?: unknown) {
    return app.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      mockEnv,
    );
  }

  it('records a success event when an agent submits a result', async () => {
    await store.createTask(makeTask({ task_type: 'review', status: 'reviewing' }));
    await store.createClaim({
      id: 'task-1:agent-A:review',
      task_id: 'task-1',
      agent_id: 'agent-A',
      role: 'review',
      status: 'pending',
      created_at: Date.now(),
    });

    const res = await request('POST', '/api/tasks/task-1/result', {
      agent_id: 'agent-A',
      type: 'review',
      review_text: 'Looks good!',
      verdict: 'approve',
      tokens_used: 100,
    });
    expect(res.status).toBe(200);

    const events = await store.getAgentReliabilityEventsBatch(
      ['agent-A'],
      Date.now() - RELIABILITY_WINDOW_MS,
    );
    const list = events.get('agent-A') ?? [];
    expect(list).toHaveLength(1);
    expect(list[0].outcome).toBe('success');
  });

  it('records an error event when an agent reports a tool error', async () => {
    await store.createTask(makeTask({ task_type: 'review', status: 'reviewing' }));
    await store.createClaim({
      id: 'task-1:agent-B:review',
      task_id: 'task-1',
      agent_id: 'agent-B',
      role: 'review',
      status: 'pending',
      created_at: Date.now(),
    });

    const res = await request('POST', '/api/tasks/task-1/error', {
      agent_id: 'agent-B',
      error: 'Tool crashed',
    });
    expect(res.status).toBe(200);

    const events = await store.getAgentReliabilityEventsBatch(
      ['agent-B'],
      Date.now() - RELIABILITY_WINDOW_MS,
    );
    const list = events.get('agent-B') ?? [];
    expect(list).toHaveLength(1);
    expect(list[0].outcome).toBe('error');
  });

  it('getAgentReliabilityEventsBatch filters by timestamp window', async () => {
    const oldIso = new Date(Date.now() - 2 * RELIABILITY_WINDOW_MS).toISOString();
    const newIso = new Date().toISOString();
    await store.recordAgentReliabilityEvent('agent-C', 'error', oldIso);
    await store.recordAgentReliabilityEvent('agent-C', 'success', newIso);

    const events = await store.getAgentReliabilityEventsBatch(
      ['agent-C'],
      Date.now() - RELIABILITY_WINDOW_MS,
    );
    const list = events.get('agent-C') ?? [];
    expect(list).toHaveLength(1);
    expect(list[0].outcome).toBe('success');
  });
});

describe('Agent reliability — weighted dispatch', () => {
  let store: MemoryDataStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stubOAuthFetch();
    resetTimeoutThrottle();
    resetRateLimits();
    store = new MemoryDataStore();
    app = createApp(store);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function batchPoll(body: unknown) {
    return app.request(
      '/api/tasks/poll/batch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
        body: JSON.stringify(body),
      },
      mockEnv,
    );
  }

  it('prefers a high-reliability agent over a zero-reliability agent', async () => {
    // id-bad has only errors in the window → reliability = 0 → shuffle score = 0.
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      await store.recordAgentReliabilityEvent('id-bad', 'error', now);
    }
    // id-good has only successes → reliability = 1.
    await store.recordAgentReliabilityEvent('id-good', 'success', now);

    // One pending task, both agents accept role 'review' on a public repo.
    await store.createTask(
      makeTask({
        id: 'only-task',
        status: 'pending',
        queue: 'review',
        task_type: 'review',
      }),
    );

    // Deterministic Math.random so score = weight * constant.
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const res = await batchPoll({
        agents: [
          {
            agent_name: 'agent-bad',
            agent_id: 'id-bad',
            roles: ['review'],
            model: 'm1',
            tool: 't1',
          },
          {
            agent_name: 'agent-good',
            agent_id: 'id-good',
            roles: ['review'],
            model: 'm2',
            tool: 't2',
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        assignments: Record<string, { tasks: Array<{ task_id: string }> }>;
      };
      expect(body.assignments['agent-good'].tasks).toHaveLength(1);
      expect(body.assignments['agent-bad'].tasks).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('a zero-weight agent is skipped even when it is the only polling candidate', async () => {
    // Only Codex is polling for this task; every recent event was an error.
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      await store.recordAgentReliabilityEvent('id-broken', 'error', now);
    }

    await store.createTask(
      makeTask({
        id: 'only-task',
        status: 'pending',
        queue: 'review',
        task_type: 'review',
      }),
    );

    const res = await batchPoll({
      agents: [
        {
          agent_name: 'agent-broken',
          agent_id: 'id-broken',
          roles: ['review'],
          model: 'm',
          tool: 't',
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      assignments: Record<string, { tasks: Array<{ task_id: string }> }>;
    };
    // Broken agent gets no assignment — task stays pending for someone else.
    expect(body.assignments['agent-broken'].tasks).toHaveLength(0);
  });

  it('an agent with no history still gets a neutral weight (not zero)', async () => {
    // agent-fresh has no events → reliability defaults to 1.0.
    await store.createTask(
      makeTask({
        id: 'only-task',
        status: 'pending',
        queue: 'review',
        task_type: 'review',
      }),
    );

    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const res = await batchPoll({
        agents: [
          {
            agent_name: 'agent-fresh',
            agent_id: 'id-fresh',
            roles: ['review'],
            model: 'm',
            tool: 't',
          },
        ],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        assignments: Record<string, { tasks: Array<{ task_id: string }> }>;
      };
      expect(body.assignments['agent-fresh'].tasks).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
