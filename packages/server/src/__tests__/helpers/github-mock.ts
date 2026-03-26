/**
 * Reusable GitHub API mocks for tests.
 *
 * - createGitHubMock(): Intercepts globalThis.fetch (legacy, for webhook tests)
 * - MockGitHubService: Implements GitHubService interface with call tracking
 */
import { vi } from 'vitest';
import { DEFAULT_REVIEW_CONFIG } from '@opencara/shared';
import type { ReviewConfig } from '@opencara/shared';
import type { GitHubService, PrDetails } from '../../github/service.js';

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
          JSON.stringify({ html_url: 'https://github.com/test/repo/pull/1#comment-456' }),
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
            head: { ref: 'feat/test' },
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
  ): Promise<string> {
    this.calls.push({ method: 'postPrComment', args: { owner, repo, prNumber, body, token } });
    return `https://github.com/${owner}/${repo}/pull/${prNumber}#comment-mock`;
  }

  async fetchPrDetails(owner: string, repo: string, prNumber: number): Promise<PrDetails | null> {
    this.calls.push({ method: 'fetchPrDetails', args: { owner, repo, prNumber } });
    return {
      number: prNumber,
      html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      diff_url: `https://github.com/${owner}/${repo}/pull/${prNumber}.diff`,
      base: { ref: 'main' },
      head: { ref: 'feat/test' },
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

  /** Count postPrComment calls (convenience for assertions). */
  get commentCount(): number {
    return this.calls.filter((c) => c.method === 'postPrComment').length;
  }
}
