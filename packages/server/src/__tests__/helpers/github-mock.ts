/**
 * Reusable GitHub API mocks for tests.
 *
 * - createGitHubMock(): Intercepts globalThis.fetch (legacy, for webhook tests)
 * - MockGitHubService: Implements GitHubService interface with call tracking
 */
import { vi } from 'vitest';
import { DEFAULT_REVIEW_CONFIG, DEFAULT_OPENCARA_CONFIG } from '@opencara/shared';
import type { ReviewConfig, OpenCaraConfig } from '@opencara/shared';
import type { GitHubService, PrDetails, IssueDetails } from '../../github/service.js';
import type { PostedCommentResult, Reaction } from '../../github/reviews.js';

export interface GitHubCall {
  url: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface GitHubMock {
  /** All intercepted GitHub API calls, in order. */
  calls: GitHubCall[];
  /** Install the mock (replace globalThis.fetch). Call in beforeEach. */
  install(): void;
  /** Restore original fetch. Call in afterEach. */
  restore(): void;
}

/**
 * Create a GitHub API fetch mock.
 *
 * Handles:
 * - Installation access tokens
 * - .opencara.toml fetch (returns 404 → defaults)
 * - PR comment posting
 * - PR details fetching
 */
export function createGitHubMock(): GitHubMock {
  const originalFetch = globalThis.fetch;
  const calls: GitHubCall[] = [];

  function install(): void {
    calls.length = 0;

    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const headers = init?.headers as Record<string, string> | undefined;

      const call: GitHubCall = { url, method };
      if (init?.body) {
        try {
          call.body = JSON.parse(init.body as string);
        } catch {
          call.body = init.body;
        }
      }
      if (headers) call.headers = headers;
      calls.push(call);

      // Installation token
      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'ghs_mock_token' }), { status: 200 });
      }

      // Fetch .opencara.toml — return 404 (use defaults)
      if (url.includes('/contents/.opencara.toml')) {
        return new Response('Not Found', { status: 404 });
      }

      // Post PR comment (issue comment)
      if (url.includes('/issues/') && url.includes('/comments') && method === 'POST') {
        return new Response(
          JSON.stringify({
            html_url: 'https://github.com/test/repo/pull/1#comment-456',
            id: 456,
          }),
          { status: 200 },
        );
      }

      // Fetch PR details (for issue_comment trigger)
      if (url.includes('/pulls/') && !url.includes('/reviews') && method === 'GET') {
        // Extract PR number from URL
        const prMatch = url.match(/\/pulls\/(\d+)/);
        const prNumber = prMatch ? parseInt(prMatch[1], 10) : 1;
        return new Response(
          JSON.stringify({
            number: prNumber,
            html_url: `https://github.com/test/repo/pull/${prNumber}`,
            diff_url: `https://github.com/test/repo/pull/${prNumber}.diff`,
            base: { ref: 'main' },
            head: { ref: 'feat/test', sha: 'abc123' },
            draft: false,
            labels: [],
          }),
          { status: 200 },
        );
      }

      // Default 404
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;
  }

  function restore(): void {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  }

  return { calls, install, restore };
}

/**
 * GitHubService implementation for tests — tracks all calls for assertion.
 * No real HTTP, no globalThis.fetch interception.
 */
export interface GitHubServiceCall {
  method: string;
  args: Record<string, unknown>;
}

export class MockGitHubService implements GitHubService {
  readonly calls: GitHubServiceCall[] = [];

  reset(): void {
    this.calls.length = 0;
  }

  async getInstallationToken(installationId: number): Promise<string> {
    this.calls.push({ method: 'getInstallationToken', args: { installationId } });
    return 'ghs_mock_token';
  }

  async postPrComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    token: string,
  ): Promise<PostedCommentResult> {
    this.calls.push({ method: 'postPrComment', args: { owner, repo, prNumber, body, token } });
    return {
      html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}#comment-mock`,
      comment_id: 12345,
    };
  }

  async getCommentReactions(
    owner: string,
    repo: string,
    commentId: number,
    token: string,
  ): Promise<Reaction[]> {
    this.calls.push({
      method: 'getCommentReactions',
      args: { owner, repo, commentId, token },
    });
    return [];
  }

  async fetchPrDetails(owner: string, repo: string, prNumber: number): Promise<PrDetails | null> {
    this.calls.push({ method: 'fetchPrDetails', args: { owner, repo, prNumber } });
    return {
      number: prNumber,
      html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      diff_url: `https://github.com/${owner}/${repo}/pull/${prNumber}.diff`,
      base: { ref: 'main' },
      head: { ref: 'feat/test', sha: 'abc123' },
      user: { login: 'pr-author' },
      draft: false,
      labels: [],
    };
  }

  async loadReviewConfig(
    owner: string,
    repo: string,
    baseRef: string,
    prNumber: number,
    token: string,
  ): Promise<{ config: ReviewConfig; parseError: boolean }> {
    this.calls.push({
      method: 'loadReviewConfig',
      args: { owner, repo, baseRef, prNumber, token },
    });
    return { config: DEFAULT_REVIEW_CONFIG, parseError: false };
  }

  /** Override to return custom OpenCaraConfig in tests */
  openCaraConfig: OpenCaraConfig = DEFAULT_OPENCARA_CONFIG;
  openCaraConfigParseError = false;

  async loadOpenCaraConfig(
    owner: string,
    repo: string,
    ref: string,
    token: string,
  ): Promise<{ config: OpenCaraConfig; parseError: boolean }> {
    this.calls.push({
      method: 'loadOpenCaraConfig',
      args: { owner, repo, ref, token },
    });
    return { config: this.openCaraConfig, parseError: this.openCaraConfigParseError };
  }

  async fetchPrReviewComments(
    owner: string,
    repo: string,
    prNumber: number,
    token: string,
  ): Promise<string> {
    this.calls.push({ method: 'fetchPrReviewComments', args: { owner, repo, prNumber, token } });
    return '[mock-reviewer] src/index.ts:10\nPlease fix this bug';
  }

  async updateIssue(
    owner: string,
    repo: string,
    number: number,
    updates: { title?: string; body?: string; labels?: string[] },
    token: string,
  ): Promise<void> {
    this.calls.push({ method: 'updateIssue', args: { owner, repo, number, updates, token } });
  }

  async fetchIssueBody(
    owner: string,
    repo: string,
    number: number,
    token: string,
  ): Promise<string | null> {
    this.calls.push({ method: 'fetchIssueBody', args: { owner, repo, number, token } });
    return `Mock issue body for #${number}`;
  }

  async fetchIssueDetails(
    owner: string,
    repo: string,
    number: number,
    token: string,
  ): Promise<IssueDetails | null> {
    this.calls.push({ method: 'fetchIssueDetails', args: { owner, repo, number, token } });
    return {
      number,
      html_url: `https://github.com/${owner}/${repo}/issues/${number}`,
      title: `Mock issue #${number}`,
      body: `Mock issue body for #${number}`,
      user: { login: 'mock-user' },
    };
  }

  async createIssue(
    owner: string,
    repo: string,
    fields: { title: string; body: string; labels?: string[] },
    token: string,
  ): Promise<number> {
    this.calls.push({ method: 'createIssue', args: { owner, repo, fields, token } });
    return 42;
  }

  // ── Comment management (for dedup index) ────────────────────

  private commentIdCounter = 1000;
  private issueComments = new Map<string, Array<{ id: number; body: string }>>();

  async listIssueComments(
    owner: string,
    repo: string,
    number: number,
    token: string,
  ): Promise<Array<{ id: number; body: string }>> {
    this.calls.push({ method: 'listIssueComments', args: { owner, repo, number, token } });
    const key = `${owner}/${repo}#${number}`;
    return this.issueComments.get(key) ?? [];
  }

  async createIssueComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
    token: string,
  ): Promise<number> {
    this.calls.push({ method: 'createIssueComment', args: { owner, repo, number, body, token } });
    const key = `${owner}/${repo}#${number}`;
    const id = this.commentIdCounter++;
    const list = this.issueComments.get(key) ?? [];
    list.push({ id, body });
    this.issueComments.set(key, list);
    return id;
  }

  async updateIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string,
    token: string,
  ): Promise<void> {
    this.calls.push({
      method: 'updateIssueComment',
      args: { owner, repo, commentId, body, token },
    });
    for (const [, list] of this.issueComments) {
      const comment = list.find((c) => c.id === commentId);
      if (comment) {
        comment.body = body;
        return;
      }
    }
  }

  resolveProjectItemResult: {
    type: 'Issue' | 'PullRequest';
    owner: string;
    repo: string;
    number: number;
  } | null = null;

  async resolveProjectItemContent(
    nodeId: string,
    token: string,
  ): Promise<{
    type: 'Issue' | 'PullRequest';
    owner: string;
    repo: string;
    number: number;
  } | null> {
    this.calls.push({ method: 'resolveProjectItemContent', args: { nodeId, token } });
    return this.resolveProjectItemResult;
  }

  /** Count postPrComment calls (convenience for assertions). */
  get commentCount(): number {
    return this.calls.filter((c) => c.method === 'postPrComment').length;
  }
}
