const GITHUB_USER_AGENT = 'OpenCara-Server';
const GITHUB_API_VERSION = '2022-11-28';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/** Default timeout for GitHub API calls (30 seconds). */
export const GITHUB_FETCH_TIMEOUT_MS = 30_000;

export interface GitHubFetchOptions extends RequestInit {
  token?: string;
  accept?: string;
  /** Per-attempt timeout in milliseconds. Defaults to GITHUB_FETCH_TIMEOUT_MS (30s). */
  timeoutMs?: number;
}

/**
 * Centralized GitHub API fetch with retry on transient errors.
 * Retries on 429 (rate limit) and 5xx (server errors) with exponential backoff.
 * Does NOT retry 400/401/404 — these are not transient.
 * Respects the Retry-After header when present.
 */
export async function githubFetch(
  url: string,
  options: GitHubFetchOptions = {},
): Promise<Response> {
  const { token, accept, timeoutMs = GITHUB_FETCH_TIMEOUT_MS, ...fetchOptions } = options;

  const headers: Record<string, string> = {
    'User-Agent': GITHUB_USER_AGENT,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    Accept: accept ?? 'application/vnd.github+json',
    ...(fetchOptions.method === 'POST' ||
    fetchOptions.method === 'PUT' ||
    fetchOptions.method === 'PATCH'
      ? { 'Content-Type': 'application/json' }
      : {}),
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.ok) return response;

      // Retry on transient errors only
      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_RETRIES) {
          const retryAfter = response.headers.get('Retry-After');
          const delay = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : Math.round(BASE_DELAY_MS * Math.pow(2, attempt) * (0.7 + Math.random() * 0.6));
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }

      // Non-retryable error or retries exhausted
      return response;
    } catch (err) {
      clearTimeout(timer);
      // Network errors and timeouts are transient — retry
      if (attempt < MAX_RETRIES) {
        const baseDelay = BASE_DELAY_MS * Math.pow(2, attempt);
        const delay = Math.round(baseDelay * (0.7 + Math.random() * 0.6));
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }

  // Unreachable — the loop always returns or throws
  throw new Error('githubFetch: unreachable');
}
