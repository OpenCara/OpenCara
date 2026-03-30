/**
 * Shared test helper for OAuth authentication.
 * Provides a fetch stub that simulates successful GitHub token verification,
 * and standard auth headers for use in test requests.
 */
import { vi } from 'vitest';

/** Standard OAuth Authorization header for test requests. */
export const OAUTH_HEADERS = { Authorization: 'Bearer ghu_test_token' };

/**
 * Stub global fetch to return a successful GitHub token verification response.
 * Call in beforeEach() for tests that hit OAuth-protected endpoints.
 */
export function stubOAuthFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ user: { id: 42, login: 'test-user' } }),
    }),
  );
}
