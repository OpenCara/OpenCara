/**
 * GitHub API fetch interceptor for E2E tests.
 *
 * Intercepts all fetch() calls to github.com / api.github.com
 * and returns controlled responses. Non-GitHub calls pass through.
 */

export interface PostedReview {
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
  event: string;
  comments?: unknown[];
}

export interface PostedComment {
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
}

export interface GitHubReaction {
  content: string;
  user: { id: number; login: string };
}

export interface GitHubMockOptions {
  installationToken?: string;
  diffs?: Record<string, string>; // "owner/repo/prNumber" → diff
  reviewConfigs?: Record<string, string | null>; // "owner/repo" → YAML or null (404)
  prDetails?: Record<
    string,
    {
      number: number;
      html_url: string;
      diff_url: string;
      base: { ref: string };
      head: { ref: string };
      draft?: boolean;
      labels?: Array<{ name: string }>;
    }
  >;
  deviceCode?: {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };
  deviceTokenStatus?: 'pending' | 'complete' | 'expired';
  accessToken?: string;
  githubUser?: { id: number; login: string; avatar_url: string };
  reactions?: Record<string, GitHubReaction[]>; // "owner/repo/commentId" → reactions
}

export interface GitHubMock {
  postedReviews: PostedReview[];
  postedComments: PostedComment[];
  options: GitHubMockOptions;
  interceptFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> | null;
  reset(): void;
}

export function createGitHubMock(options: GitHubMockOptions = {}): GitHubMock {
  const mock: GitHubMock = {
    postedReviews: [],
    postedComments: [],
    options,

    interceptFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> | null {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method?.toUpperCase() ?? 'GET';
      const headers = new Headers(init?.headers);

      // --- GitHub OAuth ---
      if (url.includes('github.com/login/device/code') && method === 'POST') {
        if (options.deviceCode) {
          return jsonResponse(options.deviceCode);
        }
        return jsonResponse({
          device_code: 'test-device-code',
          user_code: 'TEST-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        });
      }

      if (url.includes('github.com/login/oauth/access_token') && method === 'POST') {
        const body = init?.body ? JSON.parse(init.body as string) : {};

        // Device flow token polling
        if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
          if (options.deviceTokenStatus === 'expired') {
            return jsonResponse({ error: 'expired_token' });
          }
          if (options.deviceTokenStatus === 'complete' || options.accessToken) {
            return jsonResponse({ access_token: options.accessToken ?? 'gho_test_token' });
          }
          return jsonResponse({ error: 'authorization_pending' });
        }

        // Web OAuth code exchange
        if (body.code) {
          if (options.accessToken) {
            return jsonResponse({ access_token: options.accessToken });
          }
          return jsonResponse({ access_token: 'gho_test_token' });
        }

        return jsonResponse({ error: 'bad_verification_code' });
      }

      // --- Installation tokens ---
      if (
        url.match(/api\.github\.com\/app\/installations\/\d+\/access_tokens/) &&
        method === 'POST'
      ) {
        return jsonResponse({ token: options.installationToken ?? 'ghs_test_installation_token' });
      }

      // --- GitHub User API ---
      if (url === 'https://api.github.com/user' && method === 'GET') {
        if (options.githubUser) {
          return jsonResponse(options.githubUser);
        }
        return jsonResponse({
          id: 12345,
          login: 'testuser',
          avatar_url: 'https://example.com/avatar.png',
        });
      }

      // --- PR diff ---
      const diffMatch = url.match(/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
      if (diffMatch && method === 'GET') {
        const [, owner, repo, prNum] = diffMatch;
        const accept = headers.get('Accept') ?? '';

        if (accept.includes('application/vnd.github.diff')) {
          const key = `${owner}/${repo}/${prNum}`;
          const diff =
            options.diffs?.[key] ??
            `diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line`;
          return Promise.resolve(new Response(diff, { status: 200 }));
        }

        // PR details
        const detailKey = `${owner}/${repo}/${prNum}`;
        if (options.prDetails?.[detailKey]) {
          return jsonResponse(options.prDetails[detailKey]);
        }
        return jsonResponse({
          number: parseInt(prNum),
          html_url: `https://github.com/${owner}/${repo}/pull/${prNum}`,
          diff_url: `https://github.com/${owner}/${repo}/pull/${prNum}.diff`,
          base: { ref: 'main' },
          head: { ref: 'feature-branch' },
        });
      }

      // --- Review config (.review.yml) ---
      const configMatch = url.match(
        /api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/\.review\.yml/,
      );
      if (configMatch && method === 'GET') {
        const [, owner, repo] = configMatch;
        const key = `${owner}/${repo}`;
        const yaml = options.reviewConfigs?.[key];
        if (yaml === null || yaml === undefined) {
          return jsonResponse({ message: 'Not Found' }, 404);
        }
        // fetchReviewConfig uses Accept: application/vnd.github.raw+json
        // which returns the raw file content as text
        return Promise.resolve(new Response(yaml, { status: 200 }));
      }

      // --- Post PR review ---
      const reviewMatch = url.match(
        /api\.github\.com\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews/,
      );
      if (reviewMatch && method === 'POST') {
        const [, owner, repo, prNum] = reviewMatch;
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const review: PostedReview = {
          owner,
          repo,
          prNumber: parseInt(prNum),
          body: body.body ?? '',
          event: body.event ?? 'COMMENT',
          comments: body.comments,
        };
        mock.postedReviews.push(review);
        return jsonResponse({
          html_url: `https://github.com/${owner}/${repo}/pull/${prNum}#pullrequestreview-${Date.now()}`,
        });
      }

      // --- Post PR comment ---
      const commentMatch = url.match(
        /api\.github\.com\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments/,
      );
      if (commentMatch && method === 'POST') {
        const [, owner, repo, prNum] = commentMatch;
        const body = init?.body ? JSON.parse(init.body as string) : {};
        mock.postedComments.push({
          owner,
          repo,
          prNumber: parseInt(prNum),
          body: body.body ?? '',
        });
        return jsonResponse({
          html_url: `https://github.com/${owner}/${repo}/issues/${prNum}#issuecomment-${Date.now()}`,
        });
      }

      // --- Fetch comment reactions ---
      const reactionMatch = url.match(
        /api\.github\.com\/repos\/([^/]+)\/([^/]+)\/issues\/comments\/(\d+)\/reactions/,
      );
      if (reactionMatch && method === 'GET') {
        const [, owner, repo, commentId] = reactionMatch;
        const key = `${owner}/${repo}/${commentId}`;
        return jsonResponse(options.reactions?.[key] ?? []);
      }

      // Not a GitHub URL — pass through
      return null;
    },

    reset() {
      mock.postedReviews.length = 0;
      mock.postedComments.length = 0;
    },
  };

  return mock;
}

function jsonResponse(data: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

/**
 * Install a GitHub fetch interceptor on globalThis.fetch.
 * Non-GitHub requests pass through to the original fetch (which should be mocked
 * away by the Supabase mock at the module level).
 */
export function installGitHubFetchInterceptor(mock: GitHubMock) {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const intercepted = mock.interceptFetch(input, init);
    if (intercepted) return intercepted;
    // Pass through — in E2E tests, non-GitHub fetches shouldn't happen
    // (Supabase is mocked at the module level)
    return originalFetch(input, init);
  };

  return {
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}
