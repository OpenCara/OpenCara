/**
 * FakeServer — wraps the real Hono server with MemoryDataStore,
 * intercepting globalThis.fetch to route CLI API calls through app.request().
 *
 * Handles three categories of fetch:
 * 1. CLI API calls (http://fake-server/api/*) → routed to Hono app
 * 2. GitHub diff URLs (*.diff) → return canned diff content
 * 3. Server GitHub API calls (api.github.com/*) → mock responses
 */
import { generateKeyPairSync } from 'node:crypto';
import { vi } from 'vitest';
import type { ReviewConfig, ReviewTask, TaskClaim } from '@opencara/shared';
import { DEFAULT_REVIEW_CONFIG } from '@opencara/shared';
import { MemoryDataStore } from '../../../../server/src/store/memory.js';
import { createTestApp } from '../../../../server/src/__tests__/helpers/test-server.js';
import { resetTimeoutThrottle } from '../../../../server/src/routes/tasks.js';
import { resetRateLimits } from '../../../../server/src/middleware/rate-limit.js';
import type { Env } from '../../../../server/src/types.js';

export const FAKE_SERVER_URL = 'http://fake-server';

const CANNED_DIFF = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,5 @@
 import { foo } from './foo';
+import { bar } from './bar';

-export function main() {}
+export function main() {
+  bar();
+}
`;

// Generate RSA key once for JWT signing in server's getInstallationToken
let testPem: string;
function getTestPem(): string {
  if (!testPem) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    testPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  }
  return testPem;
}

export class FakeServer {
  store: MemoryDataStore;
  env: Env;
  app: ReturnType<typeof createTestApp>;
  private originalFetch: typeof globalThis.fetch;
  /** Optionally make diff fetch fail */
  diffFetchError: boolean = false;
  /** Canned diff content (can be overridden per test) */
  diffContent: string = CANNED_DIFF;

  constructor() {
    this.store = new MemoryDataStore();
    this.env = {
      GITHUB_WEBHOOK_SECRET: 'test-secret',
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY: getTestPem(),
      TASK_STORE: {} as KVNamespace,
      WEB_URL: 'https://test.opencara.com',
    };
    this.app = createTestApp(this.store);
    this.originalFetch = globalThis.fetch;
  }

  /** Replace globalThis.fetch with interceptor. Resets rate limiter state. */
  install(): void {
    resetRateLimits();
    const { app, env, diffContent: _dc, diffFetchError: _de } = this;
    // Use closures to reference mutable properties
    const getDiffError = () => this.diffFetchError;
    const getDiffContent = () => this.diffContent;

    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const headers = init?.headers as Record<string, string> | undefined;

      // 1. CLI API calls → route to Hono app
      if (url.startsWith(FAKE_SERVER_URL)) {
        // Reset rate limiter before each request so rate limits never fire during CLI tests
        resetRateLimits();
        const path = url.slice(FAKE_SERVER_URL.length);
        const response = await app.request(
          path,
          {
            method,
            headers: { 'Content-Type': 'application/json', ...headers },
            body: init?.body as string | undefined,
          },
          env,
        );

        // Convert Hono Response to standard Response for ApiClient
        const body = await response.text();
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
        });
      }

      // 2. Diff URL fetches (GitHub .diff URLs)
      if (url.includes('.diff') || url.includes('/pull/')) {
        if (getDiffError()) {
          return new Response('Internal Server Error', { status: 500 });
        }
        return new Response(getDiffContent(), { status: 200 });
      }

      // 3. Server GitHub API calls (installation tokens, review posting, etc.)
      if (url.includes('api.github.com') || url.includes('/access_tokens')) {
        // Installation token
        if (url.includes('/access_tokens')) {
          return new Response(JSON.stringify({ token: 'ghs_mock_token' }), { status: 200 });
        }

        // Fetch .review.toml
        if (url.includes('/contents/.review.toml')) {
          return new Response('Not Found', { status: 404 });
        }

        // Post PR review
        if (url.includes('/pulls/') && url.includes('/reviews') && method === 'POST') {
          return new Response(
            JSON.stringify({ html_url: 'https://github.com/test/repo/pull/1#review-123' }),
            { status: 200 },
          );
        }

        // Post PR comment
        if (url.includes('/issues/') && url.includes('/comments') && method === 'POST') {
          return new Response(
            JSON.stringify({ html_url: 'https://github.com/test/repo/pull/1#comment-456' }),
            { status: 200 },
          );
        }

        // Fetch PR diff (for comment validation)
        if (
          url.includes('/pulls/') &&
          !url.includes('/reviews') &&
          !url.includes('/comments') &&
          headers?.Accept === 'application/vnd.github.diff'
        ) {
          return new Response(getDiffContent(), { status: 200 });
        }

        // Fetch PR details
        if (url.includes('/pulls/') && !url.includes('/reviews') && method === 'GET') {
          return new Response(
            JSON.stringify({
              number: 1,
              html_url: 'https://github.com/test/repo/pull/1',
              diff_url: 'https://github.com/test/repo/pull/1.diff',
              base: { ref: 'main' },
              head: { ref: 'feat/test' },
              draft: false,
              labels: [],
            }),
            { status: 200 },
          );
        }
      }

      // Default 404
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;
  }

  /** Restore original fetch only (does not restore other mocks). */
  uninstallFetch(): void {
    globalThis.fetch = this.originalFetch;
  }

  /** Full cleanup: restore fetch + all mocks. Use in afterEach. */
  restore(): void {
    globalThis.fetch = this.originalFetch;
    vi.restoreAllMocks();
  }

  /** Reset store and timeout throttle. */
  reset(): void {
    this.store.reset();
    resetTimeoutThrottle();
    resetRateLimits();
    this.diffFetchError = false;
    this.diffContent = CANNED_DIFF;
  }

  /** Inject a task via test routes. Returns the task ID. */
  async injectTask(opts?: {
    owner?: string;
    repo?: string;
    prNumber?: number;
    reviewCount?: number;
    timeout?: string;
    private?: boolean;
  }): Promise<string> {
    const config: ReviewConfig = {
      ...DEFAULT_REVIEW_CONFIG,
      agents: {
        ...DEFAULT_REVIEW_CONFIG.agents,
        reviewCount: opts?.reviewCount ?? 1,
      },
      ...(opts?.timeout ? { timeout: opts.timeout } : {}),
    };

    const res = await this.app.request(
      '/test/events/pr',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner: opts?.owner ?? 'test-org',
          repo: opts?.repo ?? 'test-repo',
          pr_number: opts?.prNumber ?? 1,
          ...(opts?.private !== undefined ? { private: opts.private } : {}),
          config,
        }),
      },
      this.env,
    );
    const body = (await res.json()) as { created: boolean; task_id?: string };
    if (!body.created || !body.task_id) {
      throw new Error(`Failed to inject task: ${JSON.stringify(body)}`);
    }
    return body.task_id;
  }

  /** Get a task from the store. */
  async getTask(id: string): Promise<ReviewTask | null> {
    return this.store.getTask(id);
  }

  /** Get claims for a task. */
  async getClaims(taskId: string): Promise<TaskClaim[]> {
    return this.store.getClaims(taskId);
  }
}
