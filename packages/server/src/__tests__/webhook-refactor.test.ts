/**
 * Tests for webhook refactor — separate task creation + issue event handler.
 *
 * Covers:
 * - PR webhook creates separate review tasks (not one multi-claim task)
 * - Per-agent prompts assigned correctly from config
 * - Dedup PR tasks alongside review tasks
 * - Issue webhook creates triage + dedup tasks when enabled
 * - Issue events with pull_request field are skipped
 * - createTaskIfNotExists works for issue-based dedup
 * - Group IDs generated and linked correctly
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_REVIEW_CONFIG,
  DEFAULT_OPENCARA_CONFIG,
  type OpenCaraConfig,
  type ReviewConfig,
  type ReviewSectionConfig,
} from '@opencara/shared';
import type { GitHubService, PrDetails } from '../github/service.js';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import { resetTimeoutThrottle } from '../routes/tasks.js';
import { createTaskGroup, createTaskForPR, MAX_PROMPT_LENGTH } from '../routes/webhook.js';
import { Logger } from '../logger.js';

// ── Helpers ────────────────────────────────────────────────────

const WEBHOOK_SECRET = 'test-webhook-secret';

async function signPayload(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

function getMockEnv() {
  return {
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: 'unused-in-mock',
    WEB_URL: 'https://test.opencara.com',
  };
}

/**
 * Configurable mock GitHubService for webhook tests.
 */
class TestGitHubService implements GitHubService {
  openCaraConfig: OpenCaraConfig = DEFAULT_OPENCARA_CONFIG;
  openCaraConfigParseError = false;
  reviewConfig: ReviewConfig = DEFAULT_REVIEW_CONFIG;
  reviewConfigParseError = false;
  fetchPrResult: PrDetails | null = {
    number: 1,
    html_url: 'https://github.com/acme/widget/pull/1',
    diff_url: 'https://github.com/acme/widget/pull/1.diff',
    base: { ref: 'main' },
    head: { ref: 'feat/test' },
    draft: false,
    labels: [],
  };

  async getInstallationToken(_installationId: number): Promise<string> {
    return 'ghs_mock_token';
  }

  async postPrComment(): Promise<string> {
    return 'https://github.com/test/repo/pull/1#comment-mock';
  }

  async fetchPrDetails(): Promise<PrDetails | null> {
    return this.fetchPrResult;
  }

  async loadReviewConfig(): Promise<{ config: ReviewConfig; parseError: boolean }> {
    return { config: this.reviewConfig, parseError: this.reviewConfigParseError };
  }

  async loadOpenCaraConfig(): Promise<{ config: OpenCaraConfig; parseError: boolean }> {
    return { config: this.openCaraConfig, parseError: this.openCaraConfigParseError };
  }

  async updateIssue(): Promise<void> {}
  async fetchIssueBody(): Promise<string | null> {
    return null;
  }
  async createIssue(): Promise<number> {
    return 0;
  }
}

function makePRPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'opened',
    installation: { id: 999 },
    repository: { owner: { login: 'acme' }, name: 'widget', default_branch: 'main' },
    pull_request: {
      number: 42,
      html_url: 'https://github.com/acme/widget/pull/42',
      diff_url: 'https://github.com/acme/widget/pull/42.diff',
      base: { ref: 'main' },
      head: { ref: 'feat/test' },
      draft: false,
      labels: [],
    },
    ...overrides,
  };
}

function makeIssuePayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'opened',
    installation: { id: 999 },
    repository: { owner: { login: 'acme' }, name: 'widget', default_branch: 'main' },
    issue: {
      number: 10,
      html_url: 'https://github.com/acme/widget/issues/10',
      title: 'Bug: something is broken',
      body: 'Steps to reproduce...',
      user: { login: 'alice' },
    },
    ...overrides,
  };
}

async function sendWebhook(
  app: ReturnType<typeof createApp>,
  event: string,
  payload: unknown,
  env: ReturnType<typeof getMockEnv>,
) {
  const body = JSON.stringify(payload);
  const signature = await signPayload(body, WEBHOOK_SECRET);
  return app.request(
    '/webhook/github',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': signature,
        'X-GitHub-Event': event,
      },
      body,
    },
    env,
  );
}

function makeReviewConfig(overrides: Partial<ReviewSectionConfig> = {}): ReviewSectionConfig {
  return { ...DEFAULT_REVIEW_CONFIG, ...overrides };
}

// ── Tests ──────────────────────────────────────────────────────

describe('Webhook refactor — separate task creation', () => {
  let store: MemoryDataStore;
  let github: TestGitHubService;
  let app: ReturnType<typeof createApp>;
  let env: ReturnType<typeof getMockEnv>;
  let logger: Logger;

  beforeEach(() => {
    resetTimeoutThrottle();
    resetRateLimits();
    store = new MemoryDataStore();
    github = new TestGitHubService();
    app = createApp(store, github);
    env = getMockEnv();
    logger = new Logger('test');
  });

  // ── createTaskGroup unit tests ──────────────────────────────

  describe('createTaskGroup', () => {
    const baseTask = {
      owner: 'acme',
      repo: 'widget',
      pr_number: 42,
      pr_url: 'https://github.com/acme/widget/pull/42',
      diff_url: 'https://github.com/acme/widget/pull/42.diff',
      base_ref: 'main',
      head_ref: 'feat/test',
      review_count: 1,
      timeout_at: Date.now() + 600_000,
      status: 'pending' as const,
      queue: 'summary' as const,
      github_installation_id: 999,
      private: false,
      config: DEFAULT_REVIEW_CONFIG,
      created_at: Date.now(),
    };

    it('creates 1 summary task when agentCount == 1', async () => {
      const config = makeReviewConfig({ agentCount: 1 });
      const groupId = await createTaskGroup(store, 'review', config, baseTask, logger);

      expect(groupId).not.toBeNull();
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].task_type).toBe('summary');
      expect(tasks[0].feature).toBe('review');
      expect(tasks[0].group_id).toBe(groupId);
    });

    it('creates (agentCount - 1) review tasks when agentCount > 1', async () => {
      const config = makeReviewConfig({ agentCount: 3 });
      const groupId = await createTaskGroup(store, 'review', config, baseTask, logger);

      expect(groupId).not.toBeNull();
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(2); // 3 - 1 = 2
      for (const task of tasks) {
        expect(task.task_type).toBe('review');
        expect(task.feature).toBe('review');
        expect(task.group_id).toBe(groupId);
      }
    });

    it('assigns per-agent prompts from config.agents', async () => {
      const config = makeReviewConfig({
        agentCount: 4,
        prompt: 'Default prompt',
        agents: [
          { prompt: 'Agent 0 prompt' },
          { prompt: 'Agent 1 prompt' },
          // Agent 2 has no prompt override — falls back to default
        ],
      });
      const groupId = await createTaskGroup(store, 'review', config, baseTask, logger);
      expect(groupId).not.toBeNull();

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(3); // 4 - 1 = 3
      // Sort by creation order (tasks are created sequentially)
      tasks.sort((a, b) => a.created_at - b.created_at);
      expect(tasks[0].prompt).toBe('Agent 0 prompt');
      expect(tasks[1].prompt).toBe('Agent 1 prompt');
      expect(tasks[2].prompt).toBe('Default prompt'); // falls back
    });

    it('returns null when prompt exceeds MAX_PROMPT_LENGTH', async () => {
      const config = makeReviewConfig({ prompt: 'x'.repeat(MAX_PROMPT_LENGTH + 1) });
      const groupId = await createTaskGroup(store, 'review', config, baseTask, logger);
      expect(groupId).toBeNull();

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(0);
    });

    it('returns null on duplicate (idempotency)', async () => {
      const config = makeReviewConfig({ agentCount: 1 });
      const first = await createTaskGroup(store, 'review', config, baseTask, logger);
      expect(first).not.toBeNull();

      const second = await createTaskGroup(store, 'review', config, baseTask, logger);
      expect(second).toBeNull();

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
    });

    it('creates multiple review tasks that all appear in poll', async () => {
      const config = makeReviewConfig({ agentCount: 3 });
      const groupId = await createTaskGroup(store, 'review', config, baseTask, logger);
      expect(groupId).not.toBeNull();

      // Both tasks should be pending and listable
      const pending = await store.listTasks({ status: ['pending'] });
      expect(pending).toHaveLength(2);
      for (const task of pending) {
        expect(task.group_id).toBe(groupId);
        expect(task.status).toBe('pending');
        expect(task.feature).toBe('review');
      }
    });

    it('different agents can claim different tasks without conflict', async () => {
      const config = makeReviewConfig({ agentCount: 3 });
      const groupId = await createTaskGroup(store, 'review', config, baseTask, logger);
      expect(groupId).not.toBeNull();

      const tasks = await store.listTasks({ status: ['pending'] });
      expect(tasks).toHaveLength(2);

      // Agent 1 claims first task
      const claimed1 = await store.claimTask(tasks[0].id);
      expect(claimed1).toBe(true);

      // Agent 2 claims second task — no conflict
      const claimed2 = await store.claimTask(tasks[1].id);
      expect(claimed2).toBe(true);

      // Both tasks are now reviewing
      const reviewing = await store.listTasks({ status: ['reviewing'] });
      expect(reviewing).toHaveLength(2);
    });

    it('allows different feature groups for the same PR', async () => {
      const reviewConfig = makeReviewConfig({ agentCount: 2 });
      const dedupConfig = makeReviewConfig({ agentCount: 2, prompt: 'Check for duplicates' });

      // Review group for the PR
      const reviewGroupId = await createTaskGroup(store, 'review', reviewConfig, baseTask, logger);
      expect(reviewGroupId).not.toBeNull();

      // Dedup group for the same PR — different feature, should succeed
      const dedupGroupId = await createTaskGroup(store, 'dedup_pr', dedupConfig, baseTask, logger);
      expect(dedupGroupId).not.toBeNull();

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(2); // 1 review + 1 dedup
      const features = new Set(tasks.map((t) => t.feature));
      expect(features).toEqual(new Set(['review', 'dedup_pr']));
    });

    it('duplicate review group for same PR is rejected', async () => {
      const config = makeReviewConfig({ agentCount: 3 });

      // First group succeeds
      const first = await createTaskGroup(store, 'review', config, baseTask, logger);
      expect(first).not.toBeNull();

      // Second review group for same PR is rejected (idempotency)
      const second = await createTaskGroup(store, 'review', config, baseTask, logger);
      expect(second).toBeNull();

      // Still only 2 tasks (from the first group)
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(2);
    });

    it('all tasks in group share the same group_id', async () => {
      const config = makeReviewConfig({ agentCount: 5 });
      const groupId = await createTaskGroup(store, 'review', config, baseTask, logger);
      expect(groupId).not.toBeNull();

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(4); // 5 - 1 = 4
      const groupIds = new Set(tasks.map((t) => t.group_id));
      expect(groupIds.size).toBe(1);
      expect(groupIds.has(groupId!)).toBe(true);
    });

    it('each task gets a unique ID', async () => {
      const config = makeReviewConfig({ agentCount: 4 });
      await createTaskGroup(store, 'review', config, baseTask, logger);

      const tasks = await store.listTasks();
      const ids = new Set(tasks.map((t) => t.id));
      expect(ids.size).toBe(3); // All unique
    });

    it('creates dedup tasks with extra fields', async () => {
      const dedupConfig = makeReviewConfig({ agentCount: 2, prompt: 'Check for duplicates' });
      const groupId = await createTaskGroup(store, 'dedup_pr', dedupConfig, baseTask, logger, {
        dedup_target: 'pr',
        index_issue_number: 99,
      });

      expect(groupId).not.toBeNull();
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1); // 2 - 1 = 1
      expect(tasks[0].feature).toBe('dedup_pr');
      expect(tasks[0].dedup_target).toBe('pr');
      expect(tasks[0].index_issue_number).toBe(99);
    });
  });

  // ── createTaskForPR backward compat ─────────────────────────

  describe('createTaskForPR (backward compat)', () => {
    it('creates a task group for a PR', async () => {
      const groupId = await createTaskForPR(
        store,
        999,
        'acme',
        'widget',
        42,
        'https://github.com/acme/widget/pull/42',
        'https://github.com/acme/widget/pull/42.diff',
        'main',
        'feat/test',
        DEFAULT_REVIEW_CONFIG,
        false,
        logger,
      );

      expect(groupId).not.toBeNull();
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('review');
      expect(tasks[0].task_type).toBe('summary');
    });

    it('returns null on duplicate', async () => {
      await createTaskForPR(
        store,
        999,
        'acme',
        'widget',
        42,
        'https://github.com/acme/widget/pull/42',
        'https://github.com/acme/widget/pull/42.diff',
        'main',
        'feat/test',
        DEFAULT_REVIEW_CONFIG,
        false,
        logger,
      );

      const second = await createTaskForPR(
        store,
        999,
        'acme',
        'widget',
        42,
        'https://github.com/acme/widget/pull/42',
        'https://github.com/acme/widget/pull/42.diff',
        'main',
        'feat/test',
        DEFAULT_REVIEW_CONFIG,
        false,
        logger,
      );

      expect(second).toBeNull();
    });
  });

  // ── PR webhook with multi-agent ─────────────────────────────

  describe('PR webhook — multi-agent task creation', () => {
    it('creates separate review tasks for agentCount=3', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({ agentCount: 3 }),
      };

      const res = await sendWebhook(app, 'pull_request', makePRPayload(), env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(2); // 3 - 1 = 2
      for (const task of tasks) {
        expect(task.task_type).toBe('review');
        expect(task.feature).toBe('review');
      }
      // All share the same group_id
      const groupIds = new Set(tasks.map((t) => t.group_id));
      expect(groupIds.size).toBe(1);
    });

    it('creates 1 summary task for agentCount=1', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({ agentCount: 1 }),
      };

      const res = await sendWebhook(app, 'pull_request', makePRPayload(), env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].task_type).toBe('summary');
    });

    it('assigns per-agent prompts in PR webhook', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({
          agentCount: 3,
          prompt: 'Default review prompt',
          agents: [{ prompt: 'Security-focused review' }, { prompt: 'Performance review' }],
        }),
      };

      const res = await sendWebhook(app, 'pull_request', makePRPayload(), env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(2);
      const prompts = tasks.map((t) => t.prompt).sort();
      expect(prompts).toContain('Security-focused review');
      expect(prompts).toContain('Performance review');
    });
  });

  // ── PR webhook with dedup.prs ───────────────────────────────

  describe('PR webhook — dedup PR tasks', () => {
    it('creates dedup tasks alongside review tasks when dedup.prs.enabled', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({ agentCount: 2 }),
        dedup: {
          prs: {
            enabled: true,
            prompt: 'Check for duplicate PRs',
            agentCount: 1,
            timeout: '10m',
            preferredModels: [],
            preferredTools: [],
          },
        },
      };

      const res = await sendWebhook(app, 'pull_request', makePRPayload(), env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      // 1 review task (2 - 1) + 1 dedup task
      expect(tasks).toHaveLength(2);

      const reviewTasks = tasks.filter((t) => t.feature === 'review');
      const dedupTasks = tasks.filter((t) => t.feature === 'dedup_pr');
      expect(reviewTasks).toHaveLength(1);
      expect(dedupTasks).toHaveLength(1);

      // Different group IDs
      expect(reviewTasks[0].group_id).not.toBe(dedupTasks[0].group_id);

      // Dedup task properties
      expect(dedupTasks[0].dedup_target).toBe('pr');
      expect(dedupTasks[0].task_type).toBe('summary');
    });

    it('skips dedup tasks when dedup.prs.enabled is false', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({ agentCount: 1 }),
        dedup: {
          prs: {
            enabled: false,
            prompt: 'Check for duplicate PRs',
            agentCount: 1,
            timeout: '10m',
            preferredModels: [],
            preferredTools: [],
          },
        },
      };

      const res = await sendWebhook(app, 'pull_request', makePRPayload(), env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('review');
    });

    it('sets index_issue_number on dedup tasks when configured', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({ agentCount: 1 }),
        dedup: {
          prs: {
            enabled: true,
            prompt: 'Check for duplicate PRs',
            agentCount: 1,
            timeout: '10m',
            preferredModels: [],
            preferredTools: [],
            indexIssue: 42,
          },
        },
      };

      await sendWebhook(app, 'pull_request', makePRPayload(), env);
      const tasks = await store.listTasks();
      const dedupTask = tasks.find((t) => t.feature === 'dedup_pr');
      expect(dedupTask).toBeDefined();
      expect(dedupTask!.index_issue_number).toBe(42);
    });
  });

  // ── Issue webhook handler ───────────────────────────────────

  describe('Issue webhook — handleIssueEvent', () => {
    it('skips when issue has pull_request field (is a PR)', async () => {
      const payload = makeIssuePayload({
        issue: {
          number: 10,
          html_url: 'https://github.com/acme/widget/issues/10',
          title: 'Bug',
          body: 'Body',
          user: { login: 'alice' },
          pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/10' },
        },
      });

      const res = await sendWebhook(app, 'issues', payload, env);
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('skips when action is not opened/edited', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: {
          enabled: true,
          prompt: 'Triage this issue',
          agentCount: 1,
          timeout: '10m',
          preferredModels: [],
          preferredTools: [],
          defaultMode: 'comment',
          autoLabel: false,
          triggers: ['opened'],
        },
      };

      const payload = makeIssuePayload({ action: 'closed' });
      const res = await sendWebhook(app, 'issues', payload, env);
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('skips when no installation is present', async () => {
      const payload = makeIssuePayload({ installation: undefined });
      const res = await sendWebhook(app, 'issues', payload, env);
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('skips when no issue features are enabled', async () => {
      github.openCaraConfig = { version: 1 }; // no triage, no dedup

      const res = await sendWebhook(app, 'issues', makeIssuePayload(), env);
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('creates triage task when triage.enabled and action in triage.triggers', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: {
          enabled: true,
          prompt: 'Triage this issue',
          agentCount: 1,
          timeout: '10m',
          preferredModels: [],
          preferredTools: [],
          defaultMode: 'comment',
          autoLabel: false,
          triggers: ['opened'],
        },
      };

      const res = await sendWebhook(app, 'issues', makeIssuePayload(), env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('triage');
      expect(tasks[0].task_type).toBe('summary');
      expect(tasks[0].issue_number).toBe(10);
      expect(tasks[0].issue_title).toBe('Bug: something is broken');
      expect(tasks[0].issue_body).toBe('Steps to reproduce...');
      expect(tasks[0].issue_author).toBe('alice');
      expect(tasks[0].pr_number).toBe(0); // Not a PR
    });

    it('creates dedup issue task when dedup.issues.enabled', async () => {
      github.openCaraConfig = {
        version: 1,
        dedup: {
          issues: {
            enabled: true,
            prompt: 'Check for duplicate issues',
            agentCount: 1,
            timeout: '10m',
            preferredModels: [],
            preferredTools: [],
            indexIssue: 5,
          },
        },
      };

      const res = await sendWebhook(app, 'issues', makeIssuePayload(), env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('dedup_issue');
      expect(tasks[0].dedup_target).toBe('issue');
      expect(tasks[0].index_issue_number).toBe(5);
      expect(tasks[0].issue_number).toBe(10);
    });

    it('creates both triage and dedup tasks when both enabled', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: {
          enabled: true,
          prompt: 'Triage this issue',
          agentCount: 1,
          timeout: '10m',
          preferredModels: [],
          preferredTools: [],
          defaultMode: 'comment',
          autoLabel: false,
          triggers: ['opened'],
        },
        dedup: {
          issues: {
            enabled: true,
            prompt: 'Check for duplicates',
            agentCount: 1,
            timeout: '10m',
            preferredModels: [],
            preferredTools: [],
          },
        },
      };

      const res = await sendWebhook(app, 'issues', makeIssuePayload(), env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(2);

      const triageTask = tasks.find((t) => t.feature === 'triage');
      const dedupTask = tasks.find((t) => t.feature === 'dedup_issue');
      expect(triageTask).toBeDefined();
      expect(dedupTask).toBeDefined();

      // Different group IDs
      expect(triageTask!.group_id).not.toBe(dedupTask!.group_id);
    });

    it('does not create triage task when action not in triggers', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: {
          enabled: true,
          prompt: 'Triage this issue',
          agentCount: 1,
          timeout: '10m',
          preferredModels: [],
          preferredTools: [],
          defaultMode: 'comment',
          autoLabel: false,
          triggers: ['opened'], // only 'opened'
        },
      };

      const payload = makeIssuePayload({ action: 'edited' });
      const res = await sendWebhook(app, 'issues', payload, env);
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('creates triage task for edited action when in triggers', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: {
          enabled: true,
          prompt: 'Triage this issue',
          agentCount: 1,
          timeout: '10m',
          preferredModels: [],
          preferredTools: [],
          defaultMode: 'comment',
          autoLabel: false,
          triggers: ['opened', 'edited'],
        },
      };

      const payload = makeIssuePayload({ action: 'edited' });
      const res = await sendWebhook(app, 'issues', payload, env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('triage');
    });

    it('handles issue with null body', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: {
          enabled: true,
          prompt: 'Triage this',
          agentCount: 1,
          timeout: '10m',
          preferredModels: [],
          preferredTools: [],
          defaultMode: 'comment',
          autoLabel: false,
          triggers: ['opened'],
        },
      };

      const payload = makeIssuePayload({
        issue: {
          number: 10,
          html_url: 'https://github.com/acme/widget/issues/10',
          title: 'No body issue',
          body: null,
          user: { login: 'alice' },
        },
      });

      const res = await sendWebhook(app, 'issues', payload, env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].issue_body).toBeUndefined();
    });

    it('returns 503 when config parse fails', async () => {
      github.openCaraConfigParseError = true;
      github.openCaraConfig = {
        version: 1,
        triage: {
          enabled: true,
          prompt: 'Triage this',
          agentCount: 1,
          timeout: '10m',
          preferredModels: [],
          preferredTools: [],
          defaultMode: 'comment',
          autoLabel: false,
          triggers: ['opened'],
        },
      };

      const res = await sendWebhook(app, 'issues', makeIssuePayload(), env);
      expect(res.status).toBe(503);
    });
  });

  // ── Multi-agent dedup issue tasks ───────────────────────────

  describe('Issue webhook — multi-agent dedup', () => {
    it('creates multiple dedup tasks when agentCount > 1', async () => {
      github.openCaraConfig = {
        version: 1,
        dedup: {
          issues: {
            enabled: true,
            prompt: 'Check for duplicates',
            agentCount: 3,
            timeout: '10m',
            preferredModels: [],
            preferredTools: [],
          },
        },
      };

      const res = await sendWebhook(app, 'issues', makeIssuePayload(), env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(2); // 3 - 1 = 2
      for (const task of tasks) {
        expect(task.feature).toBe('dedup_issue');
        expect(task.task_type).toBe('review');
      }
    });
  });

  // ── Group queries ───────────────────────────────────────────

  describe('Group ID queries', () => {
    it('getTasksByGroup returns all tasks in a group', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({ agentCount: 4 }),
      };

      await sendWebhook(app, 'pull_request', makePRPayload(), env);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(3); // 4 - 1 = 3

      const groupId = tasks[0].group_id;
      const groupTasks = await store.getTasksByGroup(groupId);
      expect(groupTasks).toHaveLength(3);
    });
  });
});
