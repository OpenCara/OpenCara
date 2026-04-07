/**
 * Tests for agent_field resolution — reading a project board field value
 * to resolve a named agent for implement/fix tasks.
 *
 * Covers:
 * - Explicit agent ID overrides field value
 * - Field value resolves to named agent
 * - Empty/missing field falls back to default config
 * - Invalid field value posts error comment
 * - agent_field not configured → no project query made
 * - All trigger paths: comment, label, status
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_REVIEW_CONFIG,
  DEFAULT_OPENCARA_CONFIG,
  type OpenCaraConfig,
  type ReviewConfig,
  type ReviewSectionConfig,
} from '@opencara/shared';
import type { GitHubService, PrDetails, IssueDetails } from '../github/service.js';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import { resetTimeoutThrottle } from '../routes/tasks.js';

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
    head: { ref: 'feat/test', sha: 'abc123' },
    user: { login: 'pr-author' },
    draft: false,
    labels: [],
  };
  resolveProjectItemResult: {
    type: 'Issue' | 'PullRequest';
    owner: string;
    repo: string;
    number: number;
  } | null = null;

  /** Configurable return value for readProjectFieldValue */
  projectFieldValue: string | null = null;
  readProjectFieldValueSpy = vi.fn<
    [string, string, number, string, string],
    Promise<string | null>
  >();

  /** Spy for createIssueComment to check error messages */
  createIssueCommentSpy = vi.fn<[string, string, number, string, string], Promise<number>>();

  async getInstallationToken(): Promise<string> {
    return 'ghs_mock_token';
  }
  async postPrComment(): Promise<{ html_url: string; comment_id: number }> {
    return { html_url: 'https://github.com/test/repo/pull/1#comment-mock', comment_id: 12345 };
  }
  async getCommentReactions(): Promise<Array<{ user_id: number; content: string }>> {
    return [];
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
  async fetchPrReviewComments(): Promise<string> {
    return '[mock-reviewer] src/index.ts:10\nPlease fix this bug';
  }
  async updateIssue(): Promise<void> {}
  async fetchIssueBody(): Promise<string | null> {
    return null;
  }
  async fetchIssueDetails(
    _owner: string,
    _repo: string,
    number: number,
  ): Promise<IssueDetails | null> {
    return {
      number,
      html_url: `https://github.com/acme/widget/issues/${number}`,
      title: `Test issue #${number}`,
      body: 'Test issue body content',
      user: { login: 'alice' },
    };
  }
  async createIssue(): Promise<number> {
    return 0;
  }
  async listIssueComments(): Promise<Array<{ id: number; body: string }>> {
    return [];
  }
  async createIssueComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
    token: string,
  ): Promise<number> {
    this.createIssueCommentSpy(owner, repo, number, body, token);
    return 0;
  }
  async updateIssueComment(): Promise<void> {}
  async resolveProjectItemContent(): Promise<{
    type: 'Issue' | 'PullRequest';
    owner: string;
    repo: string;
    number: number;
  } | null> {
    return this.resolveProjectItemResult;
  }
  async readProjectFieldValue(
    owner: string,
    repo: string,
    issueNumber: number,
    fieldName: string,
    token: string,
  ): Promise<string | null> {
    this.readProjectFieldValueSpy(owner, repo, issueNumber, fieldName, token);
    return this.projectFieldValue;
  }
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

function makeIssueCommentPayload(commentBody: string, overrides: Record<string, unknown> = {}) {
  return {
    action: 'created',
    installation: { id: 999 },
    repository: {
      owner: { login: 'acme' },
      name: 'widget',
      default_branch: 'main',
      private: false,
    },
    issue: {
      number: 10,
    },
    comment: {
      body: commentBody,
      user: { login: 'alice' },
      author_association: 'OWNER',
    },
    ...overrides,
  };
}

function makePrCommentPayload(commentBody: string, overrides: Record<string, unknown> = {}) {
  return {
    action: 'created',
    installation: { id: 999 },
    repository: {
      owner: { login: 'acme' },
      name: 'widget',
      default_branch: 'main',
      private: false,
    },
    issue: {
      number: 42,
      pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/42' },
    },
    comment: {
      body: commentBody,
      user: { login: 'alice' },
      author_association: 'OWNER',
    },
    ...overrides,
  };
}

function makeIssueLabelPayload(labelName: string, overrides: Record<string, unknown> = {}) {
  return {
    action: 'labeled',
    installation: { id: 999 },
    repository: {
      owner: { login: 'acme' },
      name: 'widget',
      default_branch: 'main',
      private: false,
    },
    issue: {
      number: 10,
      html_url: 'https://github.com/acme/widget/issues/10',
      title: 'Bug: something is broken',
      body: 'Steps to reproduce...',
      user: { login: 'alice' },
      labels: [{ name: labelName }],
    },
    label: { name: labelName },
    ...overrides,
  };
}

function makePRLabelPayload(labelName: string, overrides: Record<string, unknown> = {}) {
  return {
    action: 'labeled',
    installation: { id: 999 },
    repository: {
      owner: { login: 'acme' },
      name: 'widget',
      default_branch: 'main',
      private: false,
    },
    pull_request: {
      number: 42,
      html_url: 'https://github.com/acme/widget/pull/42',
      diff_url: 'https://github.com/acme/widget/pull/42.diff',
      base: { ref: 'main' },
      head: { ref: 'feat/test', sha: 'abc123' },
      draft: false,
      labels: [{ name: labelName }],
    },
    label: { name: labelName },
    ...overrides,
  };
}

function makeProjectsV2ItemPayload(statusTo: string, overrides: Record<string, unknown> = {}) {
  return {
    action: 'edited',
    installation: { id: 999 },
    projects_v2_item: { content_node_id: 'node123' },
    changes: {
      field_value: {
        field_name: 'Status',
        from: 'Backlog',
        to: statusTo,
      },
    },
    ...overrides,
  };
}

const IMPLEMENT_CONFIG_WITH_AGENTS = {
  enabled: true,
  prompt: 'Implement the requested changes.',
  agentCount: 1,
  timeout: '10m',
  preferredModels: [] as string[],
  preferredTools: [] as string[],
  modelDiversityGraceMs: 30_000,
  trigger: { comment: '/opencara go', status: 'Ready' },
  agents: [
    {
      id: 'security-auditor',
      prompt: 'Security audit this.',
      model: 'claude-opus',
      tool: 'claude',
    },
    { id: 'perf-reviewer', prompt: 'Performance review.', model: 'gpt-5', tool: 'codex' },
  ],
  agent_field: 'Agent',
};

const FIX_CONFIG_WITH_AGENTS = {
  enabled: true,
  prompt: 'Fix the review comments.',
  agentCount: 1,
  timeout: '10m',
  preferredModels: [] as string[],
  preferredTools: [] as string[],
  modelDiversityGraceMs: 30_000,
  trigger: { comment: '/opencara fix', label: 'opencara:fix' },
  agents: [
    { id: 'security-auditor', prompt: 'Security fix audit.', model: 'claude-opus', tool: 'claude' },
    { id: 'perf-reviewer', prompt: 'Performance fix.', model: 'gpt-5', tool: 'codex' },
  ],
  agent_field: 'Agent',
};

// ── Tests ──────────────────────────────────────────────────────

describe('Agent field resolution', () => {
  let store: MemoryDataStore;
  let github: TestGitHubService;
  let app: ReturnType<typeof createApp>;
  let env: ReturnType<typeof getMockEnv>;

  beforeEach(() => {
    resetTimeoutThrottle();
    resetRateLimits();
    store = new MemoryDataStore();
    github = new TestGitHubService();
    app = createApp(store, github);
    env = getMockEnv();
  });

  // ── /opencara go (comment trigger) ─────────────────────────

  describe('/opencara go — comment trigger', () => {
    it('explicit agent ID takes priority over field value', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        implement: IMPLEMENT_CONFIG_WITH_AGENTS,
      };
      github.projectFieldValue = 'perf-reviewer'; // field says perf-reviewer

      const res = await sendWebhook(
        app,
        'issue_comment',
        makeIssueCommentPayload('/opencara go security-auditor'), // command says security-auditor
        env,
      );
      expect(res.status).toBe(200);

      // readProjectFieldValue should NOT be called when explicit agent is given
      expect(github.readProjectFieldValueSpy).not.toHaveBeenCalled();

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('implement');
      expect(tasks[0].config.prompt).toBe('Security audit this.');
      expect(tasks[0].config.preferredModels).toEqual(['claude-opus']);
    });

    it('field value resolves to named agent when no explicit agent', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        implement: IMPLEMENT_CONFIG_WITH_AGENTS,
      };
      github.projectFieldValue = 'security-auditor';

      const res = await sendWebhook(
        app,
        'issue_comment',
        makeIssueCommentPayload('/opencara go'),
        env,
      );
      expect(res.status).toBe(200);

      expect(github.readProjectFieldValueSpy).toHaveBeenCalledWith(
        'acme',
        'widget',
        10,
        'Agent',
        'ghs_mock_token',
      );

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].config.prompt).toBe('Security audit this.');
      expect(tasks[0].config.preferredModels).toEqual(['claude-opus']);
      expect(tasks[0].config.preferredTools).toEqual(['claude']);
    });

    it('empty/missing field falls back to default config', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        implement: IMPLEMENT_CONFIG_WITH_AGENTS,
      };
      github.projectFieldValue = null; // field is empty

      const res = await sendWebhook(
        app,
        'issue_comment',
        makeIssueCommentPayload('/opencara go'),
        env,
      );
      expect(res.status).toBe(200);

      expect(github.readProjectFieldValueSpy).toHaveBeenCalled();

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].config.prompt).toBe('Implement the requested changes.');
      expect(tasks[0].config.preferredModels).toEqual([]);
    });

    it('invalid field value posts error comment', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        implement: IMPLEMENT_CONFIG_WITH_AGENTS,
      };
      github.projectFieldValue = 'nonexistent-agent';

      const res = await sendWebhook(
        app,
        'issue_comment',
        makeIssueCommentPayload('/opencara go'),
        env,
      );
      expect(res.status).toBe(200);

      // Should post error comment
      expect(github.createIssueCommentSpy).toHaveBeenCalled();
      const commentBody = github.createIssueCommentSpy.mock.calls[0][3];
      expect(commentBody).toContain('nonexistent-agent');
      expect(commentBody).toContain('does not match any configured agent');
      expect(commentBody).toContain('security-auditor, perf-reviewer');

      // No task should be created
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(0);
    });

    it('agent_field not configured — no project query made', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        implement: {
          ...IMPLEMENT_CONFIG_WITH_AGENTS,
          agent_field: undefined, // no agent_field
        },
      };

      const res = await sendWebhook(
        app,
        'issue_comment',
        makeIssueCommentPayload('/opencara go'),
        env,
      );
      expect(res.status).toBe(200);

      expect(github.readProjectFieldValueSpy).not.toHaveBeenCalled();

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].config.prompt).toBe('Implement the requested changes.');
    });
  });

  // ── /opencara fix (comment trigger) ────────────────────────

  describe('/opencara fix — comment trigger', () => {
    it('explicit agent ID takes priority over field value', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        fix: FIX_CONFIG_WITH_AGENTS,
      };
      github.projectFieldValue = 'perf-reviewer';

      const res = await sendWebhook(
        app,
        'issue_comment',
        makePrCommentPayload('/opencara fix security-auditor'),
        env,
      );
      expect(res.status).toBe(200);

      expect(github.readProjectFieldValueSpy).not.toHaveBeenCalled();

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('fix');
      expect(tasks[0].config.prompt).toBe('Security fix audit.');
    });

    it('field value resolves to named agent when no explicit agent', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        fix: FIX_CONFIG_WITH_AGENTS,
      };
      github.projectFieldValue = 'perf-reviewer';

      const res = await sendWebhook(
        app,
        'issue_comment',
        makePrCommentPayload('/opencara fix'),
        env,
      );
      expect(res.status).toBe(200);

      expect(github.readProjectFieldValueSpy).toHaveBeenCalledWith(
        'acme',
        'widget',
        42,
        'Agent',
        'ghs_mock_token',
      );

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].config.prompt).toBe('Performance fix.');
      expect(tasks[0].config.preferredModels).toEqual(['gpt-5']);
    });

    it('empty field falls back to default fix config', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        fix: FIX_CONFIG_WITH_AGENTS,
      };
      github.projectFieldValue = null;

      const res = await sendWebhook(
        app,
        'issue_comment',
        makePrCommentPayload('/opencara fix'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].config.prompt).toBe('Fix the review comments.');
    });

    it('invalid field value posts error comment for fix', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        fix: FIX_CONFIG_WITH_AGENTS,
      };
      github.projectFieldValue = 'unknown-agent';

      const res = await sendWebhook(
        app,
        'issue_comment',
        makePrCommentPayload('/opencara fix'),
        env,
      );
      expect(res.status).toBe(200);

      expect(github.createIssueCommentSpy).toHaveBeenCalled();
      const commentBody = github.createIssueCommentSpy.mock.calls[0][3];
      expect(commentBody).toContain('unknown-agent');
      expect(commentBody).toContain('does not match any configured agent');

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(0);
    });
  });

  // ── Issue label triggers ───────────────────────────────────

  describe('Issue label triggers', () => {
    it('field value resolves agent on exact label match (no agent:xxx)', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        implement: {
          ...IMPLEMENT_CONFIG_WITH_AGENTS,
          trigger: { comment: '/opencara go', label: 'opencara:implement' },
        },
      };
      github.projectFieldValue = 'security-auditor';

      const res = await sendWebhook(
        app,
        'issues',
        makeIssueLabelPayload('opencara:implement'),
        env,
      );
      expect(res.status).toBe(200);

      expect(github.readProjectFieldValueSpy).toHaveBeenCalledWith(
        'acme',
        'widget',
        10,
        'Agent',
        'ghs_mock_token',
      );

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('implement');
      expect(tasks[0].config.prompt).toBe('Security audit this.');
    });

    it('agent:xxx label takes priority over field value', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        implement: IMPLEMENT_CONFIG_WITH_AGENTS,
      };
      github.projectFieldValue = 'security-auditor';

      const res = await sendWebhook(
        app,
        'issues',
        makeIssueLabelPayload('agent:perf-reviewer'),
        env,
      );
      expect(res.status).toBe(200);

      // readProjectFieldValue should NOT be called when agent:xxx label is used
      expect(github.readProjectFieldValueSpy).not.toHaveBeenCalled();

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].config.prompt).toBe('Performance review.');
    });

    it('invalid field value posts error on label trigger', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        implement: {
          ...IMPLEMENT_CONFIG_WITH_AGENTS,
          trigger: { comment: '/opencara go', label: 'opencara:implement' },
        },
      };
      github.projectFieldValue = 'bad-agent';

      const res = await sendWebhook(
        app,
        'issues',
        makeIssueLabelPayload('opencara:implement'),
        env,
      );
      expect(res.status).toBe(200);

      expect(github.createIssueCommentSpy).toHaveBeenCalled();
      const commentBody = github.createIssueCommentSpy.mock.calls[0][3];
      expect(commentBody).toContain('bad-agent');

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(0);
    });
  });

  // ── PR label triggers ──────────────────────────────────────

  describe('PR label triggers', () => {
    it('field value resolves agent on exact fix label match', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        fix: FIX_CONFIG_WITH_AGENTS,
      };
      github.projectFieldValue = 'perf-reviewer';

      const res = await sendWebhook(app, 'pull_request', makePRLabelPayload('opencara:fix'), env);
      expect(res.status).toBe(200);

      expect(github.readProjectFieldValueSpy).toHaveBeenCalledWith(
        'acme',
        'widget',
        42,
        'Agent',
        'ghs_mock_token',
      );

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('fix');
      expect(tasks[0].config.prompt).toBe('Performance fix.');
    });

    it('agent:xxx label takes priority over fix field value', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        fix: FIX_CONFIG_WITH_AGENTS,
      };
      github.projectFieldValue = 'perf-reviewer';

      const res = await sendWebhook(
        app,
        'pull_request',
        makePRLabelPayload('agent:security-auditor'),
        env,
      );
      expect(res.status).toBe(200);

      expect(github.readProjectFieldValueSpy).not.toHaveBeenCalled();

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].config.prompt).toBe('Security fix audit.');
    });
  });

  // ── Status triggers ────────────────────────────────────────

  describe('Status triggers (projects_v2_item)', () => {
    it('field value resolves agent on status trigger', async () => {
      github.resolveProjectItemResult = {
        type: 'Issue',
        owner: 'acme',
        repo: 'widget',
        number: 10,
      };
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        implement: IMPLEMENT_CONFIG_WITH_AGENTS,
      };
      github.projectFieldValue = 'perf-reviewer';

      const res = await sendWebhook(
        app,
        'projects_v2_item',
        makeProjectsV2ItemPayload('Ready'),
        env,
      );
      expect(res.status).toBe(200);

      expect(github.readProjectFieldValueSpy).toHaveBeenCalledWith(
        'acme',
        'widget',
        10,
        'Agent',
        'ghs_mock_token',
      );

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('implement');
      expect(tasks[0].config.prompt).toBe('Performance review.');
      expect(tasks[0].config.preferredModels).toEqual(['gpt-5']);
    });

    it('empty field falls back to default on status trigger', async () => {
      github.resolveProjectItemResult = {
        type: 'Issue',
        owner: 'acme',
        repo: 'widget',
        number: 10,
      };
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        implement: IMPLEMENT_CONFIG_WITH_AGENTS,
      };
      github.projectFieldValue = null;

      const res = await sendWebhook(
        app,
        'projects_v2_item',
        makeProjectsV2ItemPayload('Ready'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].config.prompt).toBe('Implement the requested changes.');
      expect(tasks[0].config.preferredModels).toEqual([]);
    });

    it('invalid field value posts error on status trigger', async () => {
      github.resolveProjectItemResult = {
        type: 'Issue',
        owner: 'acme',
        repo: 'widget',
        number: 10,
      };
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        implement: IMPLEMENT_CONFIG_WITH_AGENTS,
      };
      github.projectFieldValue = 'nonexistent';

      const res = await sendWebhook(
        app,
        'projects_v2_item',
        makeProjectsV2ItemPayload('Ready'),
        env,
      );
      expect(res.status).toBe(200);

      expect(github.createIssueCommentSpy).toHaveBeenCalled();
      const commentBody = github.createIssueCommentSpy.mock.calls[0][3];
      expect(commentBody).toContain('nonexistent');
      expect(commentBody).toContain('does not match any configured agent');

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(0);
    });

    it('no agent_field config — no project query on status trigger', async () => {
      github.resolveProjectItemResult = {
        type: 'Issue',
        owner: 'acme',
        repo: 'widget',
        number: 10,
      };
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        implement: {
          ...IMPLEMENT_CONFIG_WITH_AGENTS,
          agent_field: undefined,
        },
      };

      const res = await sendWebhook(
        app,
        'projects_v2_item',
        makeProjectsV2ItemPayload('Ready'),
        env,
      );
      expect(res.status).toBe(200);

      expect(github.readProjectFieldValueSpy).not.toHaveBeenCalled();

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].config.prompt).toBe('Implement the requested changes.');
    });

    it('status trigger passes target_model from resolved agent', async () => {
      github.resolveProjectItemResult = {
        type: 'Issue',
        owner: 'acme',
        repo: 'widget',
        number: 10,
      };
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        implement: IMPLEMENT_CONFIG_WITH_AGENTS,
      };
      github.projectFieldValue = 'security-auditor';

      const res = await sendWebhook(
        app,
        'projects_v2_item',
        makeProjectsV2ItemPayload('Ready'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].target_model).toBe('claude-opus');
    });
  });
});
