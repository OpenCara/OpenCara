/**
 * Tests for unified trigger modes (label, event, comment, status).
 *
 * Covers:
 * - Label triggers: issues.labeled / pull_request.labeled create tasks per feature
 * - Status triggers: projects_v2_item creates implement tasks when status matches
 * - Comment triggers: /opencara triage, gating for go/fix/review commands
 * - Event triggers: gated by isEventTriggerEnabled()
 * - Backward compatibility: configs without trigger section use defaults
 * - Dedup: no duplicate tasks from combined triggers
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
import { parseTriageCommand } from '../routes/webhook.js';

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
  async createIssueComment(): Promise<number> {
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
      head: { ref: 'feat/test', sha: 'abc123' },
      draft: false,
      labels: [],
    },
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
      // no pull_request field — this is a plain issue, not a PR
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

const DEFAULT_TRIAGE_CONFIG = {
  enabled: true,
  prompt: 'Triage this issue',
  agentCount: 1,
  timeout: '10m',
  preferredModels: [] as string[],
  preferredTools: [] as string[],
  modelDiversityGraceMs: 30_000,
  defaultMode: 'comment' as const,
  autoLabel: false,
  trigger: { events: ['opened'], comment: '/opencara triage' },
};

const DEFAULT_IMPLEMENT_CONFIG = {
  enabled: true,
  prompt: 'Implement the requested changes.',
  agentCount: 1,
  timeout: '10m',
  preferredModels: [] as string[],
  preferredTools: [] as string[],
  modelDiversityGraceMs: 30_000,
  trigger: { comment: '/opencara go', status: 'Ready' },
};

const DEFAULT_FIX_CONFIG = {
  enabled: true,
  prompt: 'Fix the review comments.',
  agentCount: 1,
  timeout: '10m',
  preferredModels: [] as string[],
  preferredTools: [] as string[],
  modelDiversityGraceMs: 30_000,
  trigger: { comment: '/opencara fix' },
};

// ── Tests ──────────────────────────────────────────────────────

describe('Unified trigger modes', () => {
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

  // ── parseTriageCommand ─────────────────────────────────────

  describe('parseTriageCommand', () => {
    it('parses /opencara triage without model', () => {
      expect(parseTriageCommand('/opencara triage')).toEqual({ targetModel: undefined });
    });

    it('parses /opencara triage with model', () => {
      expect(parseTriageCommand('/opencara triage gpt-5.4')).toEqual({ targetModel: 'gpt-5.4' });
    });

    it('parses @opencara triage without model', () => {
      expect(parseTriageCommand('@opencara triage')).toEqual({ targetModel: undefined });
    });

    it('parses @opencara triage with model', () => {
      expect(parseTriageCommand('@opencara triage claude-opus')).toEqual({
        targetModel: 'claude-opus',
      });
    });

    it('is case-insensitive', () => {
      expect(parseTriageCommand('/OpenCara Triage')).toEqual({ targetModel: undefined });
      expect(parseTriageCommand('/OPENCARA TRIAGE gpt-5')).toEqual({ targetModel: 'gpt-5' });
    });

    it('handles leading/trailing whitespace', () => {
      expect(parseTriageCommand('  /opencara triage  ')).toEqual({ targetModel: undefined });
    });

    it('returns null for non-triage commands', () => {
      expect(parseTriageCommand('/opencara review')).toBeNull();
      expect(parseTriageCommand('/opencara go')).toBeNull();
      expect(parseTriageCommand('/opencara fix')).toBeNull();
      expect(parseTriageCommand('hello world')).toBeNull();
      expect(parseTriageCommand('')).toBeNull();
    });

    it('returns null for partial matches', () => {
      expect(parseTriageCommand('opencara triage')).toBeNull();
      expect(parseTriageCommand('/opencaratriage')).toBeNull();
    });

    it('returns null for conversational comments', () => {
      expect(parseTriageCommand('/opencara triage this bug please')).toBeNull();
    });
  });

  // ── Label triggers: PR ────────────────────────────────────

  describe('PR label triggers', () => {
    it('creates review task when label matches trigger.label', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({
          trigger: { events: ['opened'], comment: '/opencara review', label: 'opencara:review' },
        }),
      };

      const res = await sendWebhook(
        app,
        'pull_request',
        makePRLabelPayload('opencara:review'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('review');
    });

    it('ignores label when trigger.label is absent', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({
          trigger: { events: ['opened'], comment: '/opencara review' },
        }),
      };

      const res = await sendWebhook(
        app,
        'pull_request',
        makePRLabelPayload('opencara:review'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(0);
    });

    it('ignores label when it does not match trigger.label', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({
          trigger: { events: ['opened'], comment: '/opencara review', label: 'opencara:review' },
        }),
      };

      const res = await sendWebhook(
        app,
        'pull_request',
        makePRLabelPayload('unrelated-label'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(0);
    });

    it('creates fix task when fix label trigger matches', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        fix: {
          ...DEFAULT_FIX_CONFIG,
          trigger: { comment: '/opencara fix', label: 'opencara:fix' },
        },
      };

      const res = await sendWebhook(app, 'pull_request', makePRLabelPayload('opencara:fix'), env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('fix');
    });

    it('creates both review and fix tasks when label matches both', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({
          trigger: { events: ['opened'], comment: '/opencara review', label: 'opencara:all' },
        }),
        fix: {
          ...DEFAULT_FIX_CONFIG,
          trigger: { comment: '/opencara fix', label: 'opencara:all' },
        },
      };

      const res = await sendWebhook(app, 'pull_request', makePRLabelPayload('opencara:all'), env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(2);
      const features = new Set(tasks.map((t) => t.feature));
      expect(features).toEqual(new Set(['review', 'fix']));
    });

    it('respects skip conditions on label trigger', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({
          trigger: {
            events: ['opened'],
            comment: '/opencara review',
            label: 'opencara:review',
            skip: ['draft'],
          },
        }),
      };

      const payload = makePRLabelPayload('opencara:review', {
        pull_request: {
          number: 42,
          html_url: 'https://github.com/acme/widget/pull/42',
          diff_url: 'https://github.com/acme/widget/pull/42.diff',
          base: { ref: 'main' },
          head: { ref: 'feat/test', sha: 'abc123' },
          draft: true,
          labels: [{ name: 'opencara:review' }],
        },
      });
      const res = await sendWebhook(app, 'pull_request', payload, env);
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });
  });

  // ── Label triggers: Issue ─────────────────────────────────

  describe('Issue label triggers', () => {
    it('creates implement task when label matches trigger.label', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: {
          ...DEFAULT_IMPLEMENT_CONFIG,
          trigger: {
            comment: '/opencara go',
            status: 'Ready',
            label: 'opencara:implement',
          },
        },
      };

      const res = await sendWebhook(
        app,
        'issues',
        makeIssueLabelPayload('opencara:implement'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('implement');
      expect(tasks[0].task_type).toBe('implement');
      expect(tasks[0].issue_number).toBe(10);
    });

    it('creates triage task when label matches trigger.label', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: {
          ...DEFAULT_TRIAGE_CONFIG,
          trigger: {
            events: ['opened'],
            comment: '/opencara triage',
            label: 'opencara:triage',
          },
        },
      };

      const res = await sendWebhook(app, 'issues', makeIssueLabelPayload('opencara:triage'), env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('triage');
      expect(tasks[0].task_type).toBe('issue_triage');
    });

    it('ignores label when no label trigger configured', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: DEFAULT_IMPLEMENT_CONFIG,
        triage: DEFAULT_TRIAGE_CONFIG,
      };

      const res = await sendWebhook(
        app,
        'issues',
        makeIssueLabelPayload('opencara:implement'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('ignores label when it does not match', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: {
          ...DEFAULT_IMPLEMENT_CONFIG,
          trigger: {
            comment: '/opencara go',
            label: 'opencara:implement',
          },
        },
      };

      const res = await sendWebhook(app, 'issues', makeIssueLabelPayload('unrelated-label'), env);
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('skips PR issues on labeled event', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: {
          ...DEFAULT_IMPLEMENT_CONFIG,
          trigger: {
            comment: '/opencara go',
            label: 'opencara:implement',
          },
        },
      };

      const payload = makeIssueLabelPayload('opencara:implement', {
        issue: {
          number: 10,
          html_url: 'https://github.com/acme/widget/issues/10',
          title: 'Bug',
          body: 'Body',
          user: { login: 'alice' },
          pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/10' },
          labels: [{ name: 'opencara:implement' }],
        },
      });

      const res = await sendWebhook(app, 'issues', payload, env);
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });
  });

  // ── Agent label triggers: Issue ──────────────────────────────

  describe('Issue agent:xxx label triggers', () => {
    it('creates implement task when agent:xxx label matches configured agent', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: {
          ...DEFAULT_IMPLEMENT_CONFIG,
          agents: [
            {
              id: 'security-auditor',
              prompt: 'Focus on security.',
              model: 'gpt-5.4',
              tool: 'codex',
            },
          ],
        },
      };

      const res = await sendWebhook(
        app,
        'issues',
        makeIssueLabelPayload('agent:security-auditor'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('implement');
      expect(tasks[0].config.prompt).toBe('Focus on security.');
      expect(tasks[0].config.preferredModels).toEqual(['gpt-5.4']);
      expect(tasks[0].config.preferredTools).toEqual(['codex']);
      expect(tasks[0].target_model).toBe('gpt-5.4');
    });

    it('posts error comment when agent:xxx label does not match any agent', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: {
          ...DEFAULT_IMPLEMENT_CONFIG,
        },
      };

      const createCommentSpy = vi.spyOn(github, 'createIssueComment');

      const res = await sendWebhook(app, 'issues', makeIssueLabelPayload('agent:nonexistent'), env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(0);

      expect(createCommentSpy).toHaveBeenCalledOnce();
      expect(createCommentSpy.mock.calls[0][3]).toContain('Unknown agent ID');
      expect(createCommentSpy.mock.calls[0][3]).toContain('nonexistent');
    });

    it('agent label with only prompt overrides prompt only', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: {
          ...DEFAULT_IMPLEMENT_CONFIG,
          preferredModels: ['default-model'],
          preferredTools: ['default-tool'],
          agents: [
            {
              id: 'simple-agent',
              prompt: 'Custom prompt.',
            },
          ],
        },
      };

      const res = await sendWebhook(
        app,
        'issues',
        makeIssueLabelPayload('agent:simple-agent'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].config.prompt).toBe('Custom prompt.');
      expect(tasks[0].config.preferredModels).toEqual(['default-model']);
      expect(tasks[0].config.preferredTools).toEqual(['default-tool']);
      expect(tasks[0].target_model).toBeUndefined();
    });

    it('agent:xxx is ignored when implement.enabled=false', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: {
          ...DEFAULT_IMPLEMENT_CONFIG,
          enabled: false,
          agents: [
            {
              id: 'security-auditor',
              prompt: 'Security.',
            },
          ],
        },
      };

      const res = await sendWebhook(
        app,
        'issues',
        makeIssueLabelPayload('agent:security-auditor'),
        env,
      );
      expect(res.status).toBe(200);

      // Should be ignored because implement.enabled=false
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(0);
    });

    it('agent:xxx label is ignored when no implement section', async () => {
      github.openCaraConfig = {
        version: 1,
      };

      const res = await sendWebhook(
        app,
        'issues',
        makeIssueLabelPayload('agent:security-auditor'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('exact label match still works alongside agent:xxx support', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: {
          ...DEFAULT_IMPLEMENT_CONFIG,
          trigger: {
            comment: '/opencara go',
            status: 'Ready',
            label: 'opencara:implement',
          },
        },
      };

      const res = await sendWebhook(
        app,
        'issues',
        makeIssueLabelPayload('opencara:implement'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('implement');
      // Uses default config since it's an exact label match, not an agent label
      expect(tasks[0].config.prompt).toBe('Implement the requested changes.');
    });
  });

  // ── Agent label triggers: PR (fix) ─────────────────────────

  describe('PR agent:xxx label triggers for fix', () => {
    it('creates fix task when agent:xxx label matches configured fix agent', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        fix: {
          ...DEFAULT_FIX_CONFIG,
          agents: [
            {
              id: 'security-fixer',
              prompt: 'Focus on security fixes.',
              model: 'gpt-5.4',
              tool: 'codex',
            },
          ],
        },
      };

      const res = await sendWebhook(
        app,
        'pull_request',
        makePRLabelPayload('agent:security-fixer'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('fix');
      expect(tasks[0].config.prompt).toBe('Focus on security fixes.');
      expect(tasks[0].config.preferredModels).toEqual(['gpt-5.4']);
      expect(tasks[0].config.preferredTools).toEqual(['codex']);
      expect(tasks[0].target_model).toBe('gpt-5.4');
    });

    it('posts error comment when agent:xxx label does not match any fix agent', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        fix: {
          ...DEFAULT_FIX_CONFIG,
        },
      };

      const createCommentSpy = vi.spyOn(github, 'createIssueComment');

      const res = await sendWebhook(
        app,
        'pull_request',
        makePRLabelPayload('agent:nonexistent'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(0);

      expect(createCommentSpy).toHaveBeenCalledOnce();
      expect(createCommentSpy.mock.calls[0][3]).toContain('Unknown agent ID');
      expect(createCommentSpy.mock.calls[0][3]).toContain('nonexistent');
    });

    it('agent label with only prompt overrides prompt only for fix', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        fix: {
          ...DEFAULT_FIX_CONFIG,
          preferredModels: ['default-model'],
          preferredTools: ['default-tool'],
          agents: [
            {
              id: 'simple-fixer',
              prompt: 'Custom fix prompt.',
            },
          ],
        },
      };

      const res = await sendWebhook(
        app,
        'pull_request',
        makePRLabelPayload('agent:simple-fixer'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].config.prompt).toBe('Custom fix prompt.');
      expect(tasks[0].config.preferredModels).toEqual(['default-model']);
      expect(tasks[0].config.preferredTools).toEqual(['default-tool']);
      expect(tasks[0].target_model).toBeUndefined();
    });

    it('agent:xxx is ignored when fix.enabled=false', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        fix: {
          ...DEFAULT_FIX_CONFIG,
          enabled: false,
          agents: [
            {
              id: 'security-fixer',
              prompt: 'Security.',
            },
          ],
        },
      };

      const res = await sendWebhook(
        app,
        'pull_request',
        makePRLabelPayload('agent:security-fixer'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('agent:xxx label is ignored when no fix section', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
      };

      const res = await sendWebhook(
        app,
        'pull_request',
        makePRLabelPayload('agent:security-fixer'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('exact fix label match still works alongside agent:xxx support', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        fix: {
          ...DEFAULT_FIX_CONFIG,
          trigger: {
            comment: '/opencara fix',
            label: 'opencara:fix',
          },
        },
      };

      const res = await sendWebhook(app, 'pull_request', makePRLabelPayload('opencara:fix'), env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('fix');
      expect(tasks[0].config.prompt).toBe('Fix the review comments.');
    });
  });

  // ── Status triggers ───────────────────────────────────────

  describe('Status triggers (projects_v2_item)', () => {
    it('creates implement task when status matches trigger.status', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: DEFAULT_IMPLEMENT_CONFIG,
      };
      github.resolveProjectItemResult = {
        type: 'Issue',
        owner: 'acme',
        repo: 'widget',
        number: 10,
      };

      const res = await sendWebhook(
        app,
        'projects_v2_item',
        makeProjectsV2ItemPayload('Ready'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('implement');
      expect(tasks[0].task_type).toBe('implement');
      expect(tasks[0].issue_number).toBe(10);
    });

    it('ignores when status does not match trigger.status', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: DEFAULT_IMPLEMENT_CONFIG,
      };
      github.resolveProjectItemResult = {
        type: 'Issue',
        owner: 'acme',
        repo: 'widget',
        number: 10,
      };

      const res = await sendWebhook(
        app,
        'projects_v2_item',
        makeProjectsV2ItemPayload('In Progress'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('ignores when trigger.status is absent', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: {
          ...DEFAULT_IMPLEMENT_CONFIG,
          trigger: { comment: '/opencara go' }, // no status field
        },
      };
      github.resolveProjectItemResult = {
        type: 'Issue',
        owner: 'acme',
        repo: 'widget',
        number: 10,
      };

      const res = await sendWebhook(
        app,
        'projects_v2_item',
        makeProjectsV2ItemPayload('Ready'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('ignores when content resolves to PullRequest', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: DEFAULT_IMPLEMENT_CONFIG,
      };
      github.resolveProjectItemResult = {
        type: 'PullRequest',
        owner: 'acme',
        repo: 'widget',
        number: 42,
      };

      const res = await sendWebhook(
        app,
        'projects_v2_item',
        makeProjectsV2ItemPayload('Ready'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('ignores when content cannot be resolved', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: DEFAULT_IMPLEMENT_CONFIG,
      };
      github.resolveProjectItemResult = null;

      const res = await sendWebhook(
        app,
        'projects_v2_item',
        makeProjectsV2ItemPayload('Ready'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('ignores when field change is not Status', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: DEFAULT_IMPLEMENT_CONFIG,
      };

      const payload = {
        action: 'edited',
        installation: { id: 999 },
        projects_v2_item: { content_node_id: 'node123' },
        changes: {
          field_value: { field_name: 'Priority', from: 'Low', to: 'High' },
        },
      };

      const res = await sendWebhook(app, 'projects_v2_item', payload, env);
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('ignores non-edited actions', async () => {
      const payload = {
        action: 'created',
        installation: { id: 999 },
        projects_v2_item: { content_node_id: 'node123' },
      };

      const res = await sendWebhook(app, 'projects_v2_item', payload, env);
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('ignores when implement is disabled', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: { ...DEFAULT_IMPLEMENT_CONFIG, enabled: false },
      };
      github.resolveProjectItemResult = {
        type: 'Issue',
        owner: 'acme',
        repo: 'widget',
        number: 10,
      };

      const res = await sendWebhook(
        app,
        'projects_v2_item',
        makeProjectsV2ItemPayload('Ready'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('ignores when no installation', async () => {
      const payload = makeProjectsV2ItemPayload('Ready', { installation: undefined });
      const res = await sendWebhook(app, 'projects_v2_item', payload, env);
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });
  });

  // ── Comment triggers: triage ──────────────────────────────

  describe('Triage comment trigger', () => {
    it('/opencara triage creates triage task when enabled', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: DEFAULT_TRIAGE_CONFIG,
      };

      const res = await sendWebhook(
        app,
        'issue_comment',
        makeIssueCommentPayload('/opencara triage'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('triage');
      expect(tasks[0].task_type).toBe('issue_triage');
      expect(tasks[0].issue_number).toBe(10);
    });

    it('@opencara triage also works', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: DEFAULT_TRIAGE_CONFIG,
      };

      const res = await sendWebhook(
        app,
        'issue_comment',
        makeIssueCommentPayload('@opencara triage'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('triage');
    });

    it('/opencara triage with model sets target_model', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: DEFAULT_TRIAGE_CONFIG,
      };

      const res = await sendWebhook(
        app,
        'issue_comment',
        makeIssueCommentPayload('/opencara triage gpt-5'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].target_model).toBe('gpt-5');
    });

    it('triage command without model does not set target_model', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: DEFAULT_TRIAGE_CONFIG,
      };

      const res = await sendWebhook(
        app,
        'issue_comment',
        makeIssueCommentPayload('/opencara triage'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].target_model).toBeUndefined();
    });

    it('triage command is ignored when triage.enabled=false', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: { ...DEFAULT_TRIAGE_CONFIG, enabled: false },
      };

      const res = await sendWebhook(
        app,
        'issue_comment',
        makeIssueCommentPayload('/opencara triage'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('triage command is ignored when comment trigger disabled', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: {
          ...DEFAULT_TRIAGE_CONFIG,
          trigger: { events: ['opened'] }, // no comment field
        },
      };

      const res = await sendWebhook(
        app,
        'issue_comment',
        makeIssueCommentPayload('/opencara triage'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('triage command from non-trusted user is ignored', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: DEFAULT_TRIAGE_CONFIG,
      };

      const payload = makeIssueCommentPayload('/opencara triage', {
        comment: {
          body: '/opencara triage',
          user: { login: 'random' },
          author_association: 'NONE',
        },
      });

      const res = await sendWebhook(app, 'issue_comment', payload, env);
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('triage command from CONTRIBUTOR is allowed (trusted)', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: DEFAULT_TRIAGE_CONFIG,
      };

      const payload = makeIssueCommentPayload('/opencara triage', {
        comment: {
          body: '/opencara triage',
          user: { login: 'contrib-user' },
          author_association: 'CONTRIBUTOR',
        },
      });

      const res = await sendWebhook(app, 'issue_comment', payload, env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('triage');
    });

    it('triage command on PR is ignored', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: DEFAULT_TRIAGE_CONFIG,
      };

      // PR comment (has pull_request field)
      const res = await sendWebhook(
        app,
        'issue_comment',
        makePrCommentPayload('/opencara triage'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('duplicate triage commands are deduplicated', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: DEFAULT_TRIAGE_CONFIG,
      };

      await sendWebhook(app, 'issue_comment', makeIssueCommentPayload('/opencara triage'), env);
      await sendWebhook(app, 'issue_comment', makeIssueCommentPayload('/opencara triage'), env);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
    });
  });

  // ── Comment trigger gating ────────────────────────────────

  describe('Comment trigger gating', () => {
    it('go command is ignored when comment trigger disabled for implement', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: {
          ...DEFAULT_IMPLEMENT_CONFIG,
          trigger: { status: 'Ready' }, // no comment field
        },
      };

      const res = await sendWebhook(
        app,
        'issue_comment',
        makeIssueCommentPayload('/opencara go'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('fix command is ignored when comment trigger disabled for fix', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig(),
        fix: {
          ...DEFAULT_FIX_CONFIG,
          trigger: { label: 'opencara:fix' }, // no comment field
        },
      };

      const res = await sendWebhook(
        app,
        'issue_comment',
        makePrCommentPayload('/opencara fix'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('review comment trigger is ignored when comment trigger disabled', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({
          trigger: { events: ['opened'] }, // no comment field
        }),
      };

      const res = await sendWebhook(
        app,
        'issue_comment',
        makePrCommentPayload('/opencara review'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });
  });

  // ── Event trigger gating ──────────────────────────────────

  describe('Event trigger gating', () => {
    it('PR event trigger works when events configured', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({
          trigger: { events: ['opened'], comment: '/opencara review' },
        }),
      };

      const res = await sendWebhook(app, 'pull_request', makePRPayload(), env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('review');
    });

    it('PR event trigger skips when events empty', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({
          trigger: { events: [], comment: '/opencara review' },
        }),
      };

      const res = await sendWebhook(app, 'pull_request', makePRPayload(), env);
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('PR event trigger skips when events absent', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({
          trigger: { comment: '/opencara review' }, // no events
        }),
      };

      const res = await sendWebhook(app, 'pull_request', makePRPayload(), env);
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });

    it('issue event trigger for triage works when action in events', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: DEFAULT_TRIAGE_CONFIG,
      };

      const res = await sendWebhook(
        app,
        'issues',
        {
          action: 'opened',
          installation: { id: 999 },
          repository: { owner: { login: 'acme' }, name: 'widget', default_branch: 'main' },
          issue: {
            number: 10,
            html_url: 'https://github.com/acme/widget/issues/10',
            title: 'Bug',
            body: 'Body',
            user: { login: 'alice' },
          },
        },
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('triage');
    });

    it('issue event trigger skips when events absent for triage', async () => {
      github.openCaraConfig = {
        version: 1,
        triage: {
          ...DEFAULT_TRIAGE_CONFIG,
          trigger: { comment: '/opencara triage' }, // no events
        },
      };

      const res = await sendWebhook(
        app,
        'issues',
        {
          action: 'opened',
          installation: { id: 999 },
          repository: { owner: { login: 'acme' }, name: 'widget', default_branch: 'main' },
          issue: {
            number: 10,
            html_url: 'https://github.com/acme/widget/issues/10',
            title: 'Bug',
            body: 'Body',
            user: { login: 'alice' },
          },
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(await store.listTasks()).toHaveLength(0);
    });
  });

  // ── Backward compatibility ────────────────────────────────

  describe('Backward compatibility', () => {
    it('default config works with event triggers', async () => {
      // DEFAULT_OPENCARA_CONFIG has events: ['opened'], comment: '/opencara review'
      github.openCaraConfig = DEFAULT_OPENCARA_CONFIG;

      const res = await sendWebhook(app, 'pull_request', makePRPayload(), env);
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('review');
    });

    it('default config works with comment triggers', async () => {
      github.openCaraConfig = DEFAULT_OPENCARA_CONFIG;

      const res = await sendWebhook(
        app,
        'issue_comment',
        makePrCommentPayload('/opencara review'),
        env,
      );
      expect(res.status).toBe(200);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].feature).toBe('review');
    });
  });

  // ── Dedup across triggers ─────────────────────────────────

  describe('Dedup across triggers', () => {
    it('duplicate label trigger does not create duplicate tasks', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({
          trigger: { events: ['opened'], comment: '/opencara review', label: 'opencara:review' },
        }),
      };

      await sendWebhook(app, 'pull_request', makePRLabelPayload('opencara:review'), env);
      await sendWebhook(app, 'pull_request', makePRLabelPayload('opencara:review'), env);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
    });

    it('duplicate status trigger does not create duplicate tasks', async () => {
      github.openCaraConfig = {
        version: 1,
        implement: DEFAULT_IMPLEMENT_CONFIG,
      };
      github.resolveProjectItemResult = {
        type: 'Issue',
        owner: 'acme',
        repo: 'widget',
        number: 10,
      };

      await sendWebhook(app, 'projects_v2_item', makeProjectsV2ItemPayload('Ready'), env);
      await sendWebhook(app, 'projects_v2_item', makeProjectsV2ItemPayload('Ready'), env);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
    });
  });

  // ── All triggers together ─────────────────────────────────

  describe('All triggers work together', () => {
    it('config with all trigger modes enabled creates correct tasks', async () => {
      github.openCaraConfig = {
        version: 1,
        review: makeReviewConfig({
          trigger: {
            events: ['opened'],
            comment: '/opencara review',
            label: 'opencara:review',
          },
        }),
        triage: {
          ...DEFAULT_TRIAGE_CONFIG,
          trigger: {
            events: ['opened'],
            comment: '/opencara triage',
            label: 'opencara:triage',
          },
        },
        implement: {
          ...DEFAULT_IMPLEMENT_CONFIG,
          trigger: {
            comment: '/opencara go',
            status: 'Ready',
            label: 'opencara:implement',
          },
        },
        fix: {
          ...DEFAULT_FIX_CONFIG,
          trigger: {
            comment: '/opencara fix',
            label: 'opencara:fix',
          },
        },
      };

      // Event trigger: PR opened → review task
      const prRes = await sendWebhook(app, 'pull_request', makePRPayload(), env);
      expect(prRes.status).toBe(200);
      const prTasks = await store.listTasks();
      expect(prTasks).toHaveLength(1);
      expect(prTasks[0].feature).toBe('review');
    });
  });
});
