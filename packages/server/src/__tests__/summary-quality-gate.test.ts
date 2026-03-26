/**
 * Integration tests for summary quality gate.
 *
 * Tests the full flow: summary result submission → quality evaluation → rejection/fallback.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { MemoryDataStore } from '../store/memory.js';
import { resetTimeoutThrottle } from '../routes/tasks.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import { MAX_SUMMARY_RETRIES } from '../summary-evaluator.js';
import type { Env } from '../types.js';
import { createTestApp } from './helpers/test-server.js';
import { MockGitHubService } from './helpers/github-mock.js';
import { MockAgent } from './helpers/mock-agent.js';

let TEST_PEM: string;
beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  TEST_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
});

function getMockEnv(): Env {
  return {
    GITHUB_WEBHOOK_SECRET: 'test-secret',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: TEST_PEM,
    WEB_URL: 'https://test.opencara.com',
  };
}

describe('Summary Quality Gate', () => {
  let store: MemoryDataStore;
  let github: MockGitHubService;
  let app: ReturnType<typeof createTestApp>;
  let env: Env;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetTimeoutThrottle();
    resetRateLimits();
    store = new MemoryDataStore();
    github = new MockGitHubService();
    env = getMockEnv();
    app = createTestApp(store, github);
  });

  function mkAgent(id: string): MockAgent {
    return new MockAgent(id, app, env);
  }

  /** Inject a PR and return the task ID. */
  async function injectPR(reviewCount = 1): Promise<string> {
    const a = mkAgent('setup-agent');
    const { created, taskId } = await a.injectPR({ reviewCount });
    expect(created).toBe(true);
    return taskId!;
  }

  /**
   * Complete the review phase for a multi-reviewer task (reviewCount > 1).
   * Returns the review texts submitted.
   */
  async function completeReviewPhase(taskId: string, reviewerCount: number): Promise<string[]> {
    const reviewTexts: string[] = [];
    for (let i = 0; i < reviewerCount; i++) {
      const reviewer = mkAgent(`reviewer-${i}`);
      const claimResult = await reviewer.claim(taskId, 'review');
      expect(claimResult.claimed).toBe(true);

      const text =
        `Detailed review ${i + 1}: The authentication middleware has a vulnerability ` +
        `where session tokens are stored in plain text. The database query on line ${42 + i} ` +
        `exhibits an N+1 pattern that should be replaced with a JOIN for better performance.`;
      reviewTexts.push(text);

      const result = await reviewer.submitResult(taskId, 'review', text, 'comment');
      expect(result.status).toBe(200);
    }
    return reviewTexts;
  }

  // ── Rejection tests ─────────────────────────────────────────

  it('rejects blocklist summary with REVIEW_QUALITY_REJECTED', async () => {
    const taskId = await injectPR(1);
    const synth = mkAgent('synth-1');

    const claimResult = await synth.claim(taskId, 'summary');
    expect(claimResult.claimed).toBe(true);

    // "No issues found." is 16 chars — passes Zod min 10 but hits blocklist
    const result = await synth.submitResult(taskId, 'summary', 'No issues found.', 'approve');
    expect(result.status).toBe(400);
    expect(result.body).toHaveProperty('error');
    const err = result.body.error as { code: string; message: string };
    expect(err.code).toBe('REVIEW_QUALITY_REJECTED');
    expect(err.message).toContain('blocklist');
  });

  it('rejects too-short summary', async () => {
    const taskId = await injectPR(1);
    const synth = mkAgent('synth-1');

    await synth.claim(taskId, 'summary');
    const result = await synth.submitResult(
      taskId,
      'summary',
      'This is a short summary that does not meet length requirements.',
      'comment',
    );
    expect(result.status).toBe(400);
    const err = result.body.error as { code: string; message: string };
    expect(err.code).toBe('REVIEW_QUALITY_REJECTED');
    expect(err.message).toContain('too short');
  });

  it('rejects summary that does not reference individual reviews', async () => {
    // Use review_count=3 → 2 reviewers + 1 synthesizer
    const taskId = await injectPR(3);
    await completeReviewPhase(taskId, 2);

    const synth = mkAgent('synth-1');
    const claimResult = await synth.claim(taskId, 'summary');
    expect(claimResult.claimed).toBe(true);

    // Long enough but completely unrelated to the review content
    const unrelatedText =
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
      'Vestibulum ante ipsum primis in faucibus orci luctus et ultrices posuere cubilia curae. ' +
      'Nulla facilisi. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
      'Curabitur pretium tincidunt lacus. Nullam euismod, nisl eget ultricies.';

    const result = await synth.submitResult(taskId, 'summary', unrelatedText, 'comment');
    expect(result.status).toBe(400);
    const err = result.body.error as { code: string; message: string };
    expect(err.code).toBe('REVIEW_QUALITY_REJECTED');
    expect(err.message).toContain('does not reference');
  });

  // ── Slot release on rejection ──────────────────────────────

  it('releases summary slot on rejection — another agent can claim', async () => {
    const taskId = await injectPR(1);
    const synth1 = mkAgent('synth-1');
    const synth2 = mkAgent('synth-2');

    // First agent claims and submits blocklisted text (passes Zod min 10)
    await synth1.claim(taskId, 'summary');
    const result = await synth1.submitResult(taskId, 'summary', 'Nothing to report.', 'approve');
    expect(result.status).toBe(400);

    // Second agent should be able to claim the summary slot
    const tasks = await synth2.poll();
    expect(tasks.length).toBe(1);
    expect(tasks[0].role).toBe('summary');

    const claimResult = await synth2.claim(taskId, 'summary');
    expect(claimResult.claimed).toBe(true);
  });

  // ── Abuse tracking ─────────────────────────────────────────

  it('records rejection for abuse tracking', async () => {
    const taskId = await injectPR(1);
    const synth = mkAgent('bad-synth');

    await synth.claim(taskId, 'summary');
    await synth.submitResult(taskId, 'summary', 'No issues found.', 'approve');

    // Check that a rejection was recorded
    const rejections = await store.countAgentRejections('bad-synth', Date.now() - 60_000);
    expect(rejections).toBeGreaterThanOrEqual(1);
  });

  // ── Retry count ────────────────────────────────────────────

  it('increments summary_retry_count on each rejection', async () => {
    const taskId = await injectPR(1);

    for (let i = 0; i < 2; i++) {
      const synth = mkAgent(`synth-${i}`);
      await synth.claim(taskId, 'summary');
      const result = await synth.submitResult(taskId, 'summary', 'Looks good to me.', 'approve');
      expect(result.status).toBe(400);
    }

    const task = await store.getTask(taskId);
    expect(task).not.toBeNull();
    expect(task!.summary_retry_count).toBe(2);
  });

  // ── Fallback posting ───────────────────────────────────────

  it('posts fallback consolidated reviews after MAX_SUMMARY_RETRIES', async () => {
    // Use review_count=3 → 2 reviewers + 1 synthesizer
    const taskId = await injectPR(3);
    await completeReviewPhase(taskId, 2);

    // Exhaust all retries with low-quality summaries (Zod-valid but blocklisted)
    for (let i = 0; i < MAX_SUMMARY_RETRIES; i++) {
      const synth = mkAgent(`synth-${i}`);
      const claimResult = await synth.claim(taskId, 'summary');
      expect(claimResult.claimed).toBe(true);

      const result = await synth.submitResult(taskId, 'summary', 'No issues found.', 'approve');
      // Last retry triggers fallback and returns 200; earlier retries return 400
      const expectedStatus = i === MAX_SUMMARY_RETRIES - 1 ? 200 : 400;
      expect(result.status).toBe(expectedStatus);
    }

    // Task should be deleted (fallback posted and cleaned up)
    const task = await store.getTask(taskId);
    expect(task).toBeNull();

    // GitHub service should have received a comment
    const comments = github.calls.filter((c) => c.method === 'postPrComment');
    expect(comments.length).toBe(1);
    expect(comments[0].args.body).toContain('partial review(s) collected');
  });

  // ── Passing summary ────────────────────────────────────────

  it('posts to GitHub when summary passes quality gate', async () => {
    const taskId = await injectPR(3);
    await completeReviewPhase(taskId, 2);

    const synth = mkAgent('good-synth');
    const claimResult = await synth.claim(taskId, 'summary');
    expect(claimResult.claimed).toBe(true);

    // Build a good summary that references the reviews
    const goodSummary =
      'This pull request has several issues that need addressing. ' +
      'The authentication middleware has a vulnerability related to session tokens stored in plain text. ' +
      'Additionally, there is a performance issue with the database query that exhibits an N+1 pattern. ' +
      'Replacing it with a JOIN would significantly improve performance. ' +
      'Overall, the code needs security and performance improvements before merging.';

    const result = await synth.submitResult(taskId, 'summary', goodSummary, 'request_changes');
    expect(result.status).toBe(200);

    // Task should be deleted (posted and cleaned up)
    const task = await store.getTask(taskId);
    expect(task).toBeNull();

    // GitHub should have received the review
    const comments = github.calls.filter((c) => c.method === 'postPrComment');
    expect(comments.length).toBe(1);
    expect(comments[0].args.body).toContain('OpenCara Review');
  });

  // ── Single-reviewer task (review_count=1, skip overlap check) ──

  it('passes summary for single-reviewer task with sufficient length', async () => {
    const taskId = await injectPR(1);
    const synth = mkAgent('synth-1');

    await synth.claim(taskId, 'summary');

    // No individual reviews to compare against — just needs to be long enough
    const longSummary =
      'This is a detailed code review summary. The pull request introduces several changes to the ' +
      'application architecture that improve maintainability. The new service layer properly ' +
      'separates concerns between the controller and data access layers. Error handling has been ' +
      'improved with proper exception propagation and logging throughout the stack.';

    const result = await synth.submitResult(taskId, 'summary', longSummary, 'approve');
    expect(result.status).toBe(200);
  });
});
