/**
 * Reusable GitHub API fetch mock for tests.
 *
 * Intercepts globalThis.fetch and routes GitHub API calls to stub responses.
 * Tracks all calls for assertion.
 */
import { vi } from 'vitest';

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
 * - .review.yml fetch (returns 404 → defaults)
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

      // Fetch .review.yml — return 404 (use defaults)
      if (url.includes('/contents/.review.yml')) {
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
