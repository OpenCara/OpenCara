import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type {
  DeviceFlowInitResponse,
  DeviceFlowTokenResponse,
  RefreshTokenResponse,
  ErrorResponse,
} from '@opencara/shared';

/** Stored auth token data persisted to ~/.opencara/auth.json */
export interface StoredAuth {
  access_token: string;
  /** Optional — present for GitHub App tokens that support refresh. */
  refresh_token?: string;
  expires_at: number; // unix ms
  github_username: string;
  github_user_id: number;
}

/** Default auth directory — same as config */
const AUTH_DIR = path.join(os.homedir(), '.opencara');

/** Resolve the auth file path (supports OPENCARA_AUTH_FILE env override). */
export function getAuthFilePath(): string {
  const envPath = process.env.OPENCARA_AUTH_FILE?.trim();
  return envPath || path.join(AUTH_DIR, 'auth.json');
}

/** Load stored auth from ~/.opencara/auth.json. Returns null if not found or invalid. */
export function loadAuth(): StoredAuth | null {
  const filePath = getAuthFilePath();
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof data.access_token === 'string' &&
      typeof data.expires_at === 'number' &&
      typeof data.github_username === 'string' &&
      typeof data.github_user_id === 'number' &&
      // refresh_token is optional — tolerate non-refreshable tokens, but validate type when present
      (data.refresh_token === undefined || typeof data.refresh_token === 'string')
    ) {
      return data as unknown as StoredAuth;
    }
    return null;
  } catch {
    return null;
  }
}

/** Save auth to ~/.opencara/auth.json atomically (creates dir if needed). */
export function saveAuth(auth: StoredAuth): void {
  const filePath = getAuthFilePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Atomic write: write to temp file, then rename
  const tmpPath = path.join(dir, `.auth-${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(auth, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

/** Delete ~/.opencara/auth.json (logout). */
export function deleteAuth(): void {
  const filePath = getAuthFilePath();
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

/** Check if auth exists and token is not expired. */
export function isAuthenticated(): boolean {
  const auth = loadAuth();
  if (!auth) return false;
  return auth.expires_at > Date.now();
}

/** Error thrown during device flow authentication. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Delay helper — returns a promise that resolves after ms milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Dependencies for login() — allows injection for testing. */
export interface LoginDeps {
  fetchFn?: typeof fetch;
  delayFn?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * Initiate Device Flow:
 * 1. POST /api/auth/device -> get device_code + user_code
 * 2. Print user_code and verification_uri to user
 * 3. Poll POST /api/auth/device/token every `interval` seconds
 * 4. On success: resolve /user to get github_username + github_user_id
 * 5. Save to auth.json
 */
export async function login(platformUrl: string, deps: LoginDeps = {}): Promise<StoredAuth> {
  const fetchFn = deps.fetchFn ?? fetch;
  const delayFn = deps.delayFn ?? delay;
  const log = deps.log ?? console.log;

  // Step 1: Initiate device flow
  const initRes = await fetchFn(`${platformUrl}/api/auth/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!initRes.ok) {
    const errorBody = await initRes.text();
    throw new AuthError(`Failed to initiate device flow: ${initRes.status} ${errorBody}`);
  }

  const initData = (await initRes.json()) as DeviceFlowInitResponse;

  // Step 2: Print instructions
  log(`\nTo authenticate, visit: ${initData.verification_uri}`);
  log(`Enter code: ${initData.user_code}\n`);
  log('Waiting for authorization...');

  // Step 3: Poll for token
  let interval = initData.interval * 1000; // convert to ms
  const deadline = Date.now() + initData.expires_in * 1000;

  while (Date.now() < deadline) {
    await delayFn(interval);

    // Re-check deadline after delay to avoid unnecessary requests
    if (Date.now() >= deadline) {
      break;
    }

    const tokenRes = await fetchFn(`${platformUrl}/api/auth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: initData.device_code }),
    });

    if (!tokenRes.ok) {
      // Non-200: transient error — continue polling
      try {
        await tokenRes.text(); // consume body
      } catch {
        // ignore
      }
      continue;
    }

    // Server returns 200 for both success and GitHub error states
    // (authorization_pending, slow_down, expired_token, access_denied).
    // Parse the response and check for the error field.
    let body: Record<string, unknown>;
    try {
      body = (await tokenRes.json()) as Record<string, unknown>;
    } catch {
      // Malformed 200 body — treat as transient, continue polling
      continue;
    }

    // Check if this is a GitHub error response (has "error" field, no "access_token")
    if (body.error) {
      const errorStr = body.error as string;

      if (errorStr === 'expired_token') {
        throw new AuthError('Authorization timed out, please try again');
      }

      if (errorStr === 'access_denied') {
        throw new AuthError('Authorization denied by user');
      }

      if (errorStr === 'slow_down') {
        // slow_down — increase interval by 5 seconds
        interval += 5000;
      }

      // authorization_pending or other — continue polling
      continue;
    }

    // Success — response has access_token
    const tokenData = body as unknown as DeviceFlowTokenResponse;
    if (!tokenData.access_token) {
      // Unexpected response shape — continue polling
      continue;
    }

    // Step 4: Resolve GitHub user info
    const user = await resolveUser(tokenData.access_token, fetchFn);

    const auth: StoredAuth = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + tokenData.expires_in * 1000,
      github_username: user.login,
      github_user_id: user.id,
    };

    // Step 5: Save
    saveAuth(auth);
    log(`\nAuthenticated as ${user.login}`);
    return auth;
  }

  throw new AuthError('Authorization timed out, please try again');
}

/** Buffer before token expiry to trigger refresh (5 minutes). */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** Dependencies for getValidToken() — allows injection for testing. */
export interface GetTokenDeps {
  fetchFn?: typeof fetch;
  loadAuthFn?: () => StoredAuth | null;
  saveAuthFn?: (auth: StoredAuth) => void;
  nowFn?: () => number;
}

/**
 * Get a valid access token, refreshing if expired.
 * 1. Load stored auth
 * 2. If expires_at > now + buffer: return access_token
 * 3. If expired: POST /api/auth/refresh -> save new tokens -> return
 * 4. If refresh fails: throw (user needs to re-login)
 */
export async function getValidToken(platformUrl: string, deps: GetTokenDeps = {}): Promise<string> {
  const fetchFn = deps.fetchFn ?? fetch;
  const loadAuthFn = deps.loadAuthFn ?? loadAuth;
  const saveAuthFn = deps.saveAuthFn ?? saveAuth;
  const nowFn = deps.nowFn ?? Date.now;

  const auth = loadAuthFn();
  if (!auth) {
    throw new AuthError('Not authenticated. Run `opencara auth login` first.');
  }

  // Token still valid (with buffer)
  if (auth.expires_at > nowFn() + REFRESH_BUFFER_MS) {
    return auth.access_token;
  }

  // Token expired or expiring soon — refresh (requires refresh_token)
  if (!auth.refresh_token) {
    throw new AuthError(
      'Token expired and no refresh token available. Run `opencara auth login` to re-authenticate.',
    );
  }

  const refreshRes = await fetchFn(`${platformUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: auth.refresh_token }),
  });

  if (!refreshRes.ok) {
    let message = `Token refresh failed (${refreshRes.status})`;
    try {
      const errorBody = (await refreshRes.json()) as ErrorResponse;
      if (errorBody.error?.message) {
        message = errorBody.error.message;
      }
    } catch {
      // JSON parse failed — try text fallback
      try {
        const text = await refreshRes.text();
        if (text) {
          message = `Token refresh failed (${refreshRes.status}): ${text.slice(0, 200)}`;
        }
      } catch {
        // ignore — keep generic message
      }
    }
    throw new AuthError(`${message}. Run \`opencara auth login\` to re-authenticate.`);
  }

  const refreshData = (await refreshRes.json()) as RefreshTokenResponse;

  const updated: StoredAuth = {
    ...auth,
    access_token: refreshData.access_token,
    // Use new refresh_token if provided, otherwise keep existing
    refresh_token: refreshData.refresh_token ?? auth.refresh_token,
    expires_at: nowFn() + refreshData.expires_in * 1000,
  };

  saveAuthFn(updated);
  return updated.access_token;
}

/**
 * Resolve GitHub user info from an access token.
 * GET https://api.github.com/user with Bearer token.
 */
export async function resolveUser(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ login: string; id: number }> {
  const res = await fetchFn('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!res.ok) {
    throw new AuthError(`Failed to resolve GitHub user: ${res.status}`);
  }

  const data = (await res.json()) as { login?: string; id?: number };
  if (typeof data.login !== 'string' || typeof data.id !== 'number') {
    throw new AuthError('Invalid GitHub user response');
  }

  return { login: data.login, id: data.id };
}
