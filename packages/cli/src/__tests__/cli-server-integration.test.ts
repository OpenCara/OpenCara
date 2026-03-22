/**
 * CLI ↔ Server integration tests.
 *
 * Runs the real CLI startAgent() against an in-process Hono server with
 * MemoryTaskStore. Verifies cross-package contract: shared types, poll/claim
 * responses, result submission, and error handling match between CLI and server.
 *
 * Mocks: tool-executor (no real AI calls), globalThis.fetch (routes to Hono app).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startAgent, type ConsumptionDeps } from '../commands/agent.js';
import type { ReviewExecutorDeps } from '../review.js';
import { createSessionTracker } from '../consumption.js';
import { executeTool } from '../tool-executor.js';
import { FakeServer, FAKE_SERVER_URL } from './helpers/fake-server.js';

// ── Mock tool executor ───────────────────────────────────────

vi.mock('../tool-executor.js', () => ({
  executeTool: vi.fn(async () => ({
    stdout:
      '## Summary\nLooks good. No issues found.\n\n## Findings\nNo issues found.\n\n## Verdict\nAPPROVE',
    stderr: '',
    exitCode: 0,
    tokensUsed: 500,
    tokensParsed: true,
  })),
  estimateTokens: (text: string) => Math.ceil(text.length / 4),
  validateCommandBinary: () => true,
  parseCommandTemplate: (cmd: string) => cmd.split(' '),
  testCommand: vi.fn(async () => ({ ok: true, elapsedMs: 100 })),
}));

const mockedExecuteTool = vi.mocked(executeTool);

// ── Helpers ──────────────────────────────────────────────────

function makeDeps(agentId = 'cli-agent'): {
  reviewDeps: ReviewExecutorDeps;
  consumptionDeps: ConsumptionDeps;
} {
  const session = createSessionTracker();
  return {
    reviewDeps: { commandTemplate: 'echo test', maxDiffSizeKb: 500 },
    consumptionDeps: { agentId, session },
  };
}

async function advanceTime(totalMs: number, stepMs = 100): Promise<void> {
  const steps = Math.ceil(totalMs / stepMs);
  for (let i = 0; i < steps; i++) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
}

async function stopAgent(promise: Promise<void>, server: FakeServer): Promise<void> {
  server.uninstallFetch();
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status: 401,
    json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'shutdown' } }),
  });
  await advanceTime(3000);
  await promise;
}

// ── Test Suite ───────────────────────────────────────────────

describe('CLI ↔ Server Integration', () => {
  let server: FakeServer;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(process, 'on').mockImplementation(() => process);

    server = new FakeServer();
    server.install();

    mockedExecuteTool.mockReset();
    mockedExecuteTool.mockResolvedValue({
      stdout:
        '## Summary\nLooks good. No issues found.\n\n## Findings\nNo issues found.\n\n## Verdict\nAPPROVE',
      stderr: '',
      exitCode: 0,
      tokensUsed: 500,
      tokensParsed: true,
    });
  });

  afterEach(() => {
    server.restore();
    vi.useRealTimers();
  });

  function startTestAgent(
    agentId: string,
    opts?: {
      reviewOnly?: boolean;
      repoConfig?: import('@opencara/shared').RepoConfig;
    },
  ): Promise<void> {
    const deps = makeDeps(agentId);
    return startAgent(
      agentId,
      FAKE_SERVER_URL,
      { model: 'test-model', tool: 'test-tool' },
      deps.reviewDeps,
      deps.consumptionDeps,
      {
        pollIntervalMs: 100,
        reviewOnly: opts?.reviewOnly,
        repoConfig: opts?.repoConfig,
      },
    );
  }

  // ═══════════════════════════════════════════════════════════
  // A. CLI poll → claim → review → submit lifecycle
  // ═══════════════════════════════════════════════════════════

  describe('A. CLI agent poll → claim → submit lifecycle', () => {
    it('CLI agent claims review task and submits result via server API', async () => {
      const taskId = await server.injectTask({ reviewCount: 2 });

      const agentPromise = startTestAgent('cli-review-agent');
      await advanceTime(500);

      // Verify claim was created in server store
      const claims = await server.getClaims(taskId);
      expect(claims).toHaveLength(1);
      expect(claims[0].agent_id).toBe('cli-review-agent');
      expect(claims[0].role).toBe('review');
      expect(claims[0].status).toBe('completed');
      expect(claims[0].model).toBe('test-model');
      expect(claims[0].tool).toBe('test-tool');
      expect(claims[0].review_text).toBeDefined();
      expect(claims[0].tokens_used).toBe(500);

      // Tool was called
      expect(mockedExecuteTool).toHaveBeenCalled();

      // Server task updated
      const task = await server.getTask(taskId);
      expect(task?.completed_reviews).toBe(1);

      await stopAgent(agentPromise, server);
    });

    it('two CLI agents complete review slots sequentially', async () => {
      const taskId = await server.injectTask({ reviewCount: 3 });

      // First agent completes review
      const agent1Promise = startTestAgent('cli-r1');
      await advanceTime(500);

      let claims = await server.getClaims(taskId);
      expect(claims).toHaveLength(1);
      expect(claims[0].status).toBe('completed');

      await stopAgent(agent1Promise, server);
      server.install();

      // Second agent completes review
      const agent2Promise = startTestAgent('cli-r2');
      await advanceTime(500);

      claims = await server.getClaims(taskId);
      expect(claims).toHaveLength(2);
      expect(claims.every((c) => c.status === 'completed')).toBe(true);

      const task = await server.getTask(taskId);
      expect(task?.completed_reviews).toBe(2);

      await stopAgent(agent2Promise, server);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // B. CLI handles structured error responses from server
  // ═══════════════════════════════════════════════════════════

  describe('B. CLI handles structured server errors', () => {
    it('CLI handles claim conflict gracefully (slot taken)', async () => {
      const taskId = await server.injectTask();

      // Pre-claim the slot
      await server.store.updateTask(taskId, {
        claimed_agents: ['other-agent'],
        status: 'reviewing',
      });
      await server.store.acquireLock(`summary:${taskId}`, 'other-agent');
      await server.store.createClaim({
        id: `${taskId}:other-agent`,
        task_id: taskId,
        agent_id: 'other-agent',
        role: 'summary',
        status: 'pending',
        created_at: Date.now(),
      });

      const agentPromise = startTestAgent('late-cli-agent');
      await advanceTime(500);

      // Agent should not have crashed — just failed to claim
      expect(mockedExecuteTool).not.toHaveBeenCalled();

      await stopAgent(agentPromise, server);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // C. CLI with review_only flag
  // ═══════════════════════════════════════════════════════════

  describe('C. review_only flag via CLI', () => {
    it('CLI agent with reviewOnly skips summary-only tasks', async () => {
      await server.injectTask({ reviewCount: 1 }); // summary only

      const agentPromise = startTestAgent('review-only-cli', { reviewOnly: true });
      await advanceTime(500);

      expect(mockedExecuteTool).not.toHaveBeenCalled();

      await stopAgent(agentPromise, server);
    });

    it('CLI agent with reviewOnly claims review tasks', async () => {
      const taskId = await server.injectTask({ reviewCount: 3 });

      const agentPromise = startTestAgent('review-only-cli', { reviewOnly: true });
      await advanceTime(500);

      const claims = await server.getClaims(taskId);
      expect(claims).toHaveLength(1);
      expect(claims[0].role).toBe('review');
      expect(claims[0].status).toBe('completed');

      await stopAgent(agentPromise, server);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // D. CLI repo filtering via server poll
  // ═══════════════════════════════════════════════════════════

  describe('D. CLI repo config filtering', () => {
    it('CLI agent with repo whitelist skips non-matching tasks', async () => {
      await server.injectTask({ reviewCount: 2 }); // owner: test-org, repo: test-repo

      const agentPromise = startTestAgent('filtered-cli', {
        repoConfig: { mode: 'whitelist', list: ['other-org/other-repo'] },
      });
      await advanceTime(500);

      expect(mockedExecuteTool).not.toHaveBeenCalled();

      await stopAgent(agentPromise, server);
    });

    it('CLI agent with matching whitelist claims the task', async () => {
      const taskId = await server.injectTask({ reviewCount: 2 });

      const agentPromise = startTestAgent('filtered-cli', {
        repoConfig: { mode: 'whitelist', list: ['test-org/test-repo'] },
      });
      await advanceTime(500);

      const claims = await server.getClaims(taskId);
      expect(claims).toHaveLength(1);
      expect(claims[0].status).toBe('completed');

      await stopAgent(agentPromise, server);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // E. CLI tool execution failure → server error report
  // ═══════════════════════════════════════════════════════════

  describe('E. Tool execution failure → error reported to server', () => {
    it('tool crash reports error to server, slot is freed', async () => {
      const taskId = await server.injectTask({ reviewCount: 2 });
      mockedExecuteTool.mockRejectedValue(new Error('Tool SIGSEGV'));

      const agentPromise = startTestAgent('crash-cli');
      await advanceTime(3000);

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error on task'));

      // Slot freed — task should be re-claimable
      const task = await server.getTask(taskId);
      expect(task?.review_claims).toBe(0);

      // Mark completed to stop loop
      await server.store.updateTask(taskId, { status: 'completed' });
      await stopAgent(agentPromise, server);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // F. Schema contract: shared types match between CLI and server
  // ═══════════════════════════════════════════════════════════

  describe('F. Schema contract verification', () => {
    it('server poll response matches shared PollResponse shape', async () => {
      await server.injectTask({ reviewCount: 2 });

      // Make a raw poll request to verify response shape
      const res = await server.app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: 'schema-test' }),
        },
        server.env,
      );
      const body = (await res.json()) as Record<string, unknown>;

      // PollResponse shape
      expect(body).toHaveProperty('tasks');
      expect(Array.isArray(body.tasks)).toBe(true);

      const tasks = body.tasks as Record<string, unknown>[];
      expect(tasks).toHaveLength(1);

      // PollTask shape — every field the CLI expects
      const task = tasks[0];
      expect(typeof task.task_id).toBe('string');
      expect(typeof task.owner).toBe('string');
      expect(typeof task.repo).toBe('string');
      expect(typeof task.pr_number).toBe('number');
      expect(typeof task.diff_url).toBe('string');
      expect(typeof task.timeout_seconds).toBe('number');
      expect(typeof task.prompt).toBe('string');
      expect(typeof task.role).toBe('string');
      expect(['review', 'summary']).toContain(task.role);
    });

    it('server claim response matches shared ClaimResponse shape', async () => {
      const taskId = await server.injectTask({ reviewCount: 2 });

      const res = await server.app.request(
        `/api/tasks/${taskId}/claim`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: 'schema-test', role: 'review', model: 'm', tool: 't' }),
        },
        server.env,
      );
      const body = (await res.json()) as Record<string, unknown>;

      // ClaimResponse shape
      expect(res.status).toBe(200);
      expect(body.claimed).toBe(true);
    });

    it('server error response matches shared ErrorResponse shape', async () => {
      const res = await server.app.request(
        '/api/tasks/any/claim',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: 'a' }), // missing role
        },
        server.env,
      );
      const body = (await res.json()) as Record<string, unknown>;

      // ErrorResponse shape
      expect(res.status).toBe(400);
      expect(body).toHaveProperty('error');
      const error = body.error as Record<string, unknown>;
      expect(typeof error.code).toBe('string');
      expect(typeof error.message).toBe('string');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // G. Private repo task visibility from CLI
  // ═══════════════════════════════════════════════════════════

  describe('G. Private repo tasks via CLI', () => {
    it('CLI agent with repo whitelist can see and claim private tasks', async () => {
      const taskId = await server.injectTask({
        owner: 'corp',
        repo: 'secret',
        reviewCount: 2,
        private: true,
      });

      const agentPromise = startTestAgent('private-cli-agent', {
        repoConfig: { mode: 'whitelist', list: ['corp/secret'] },
      });
      await advanceTime(500);

      const claims = await server.getClaims(taskId);
      expect(claims).toHaveLength(1);
      expect(claims[0].status).toBe('completed');
      expect(claims[0].agent_id).toBe('private-cli-agent');

      await stopAgent(agentPromise, server);
    });

    it('CLI agent without repo whitelist cannot see private tasks', async () => {
      await server.injectTask({
        owner: 'corp',
        repo: 'secret',
        reviewCount: 2,
        private: true,
      });

      const agentPromise = startTestAgent('no-repos-cli');
      await advanceTime(500);

      // Agent should not have picked up the private task
      expect(mockedExecuteTool).not.toHaveBeenCalled();

      await stopAgent(agentPromise, server);
    });
  });
});
