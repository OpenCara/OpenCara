import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('node:crypto', () => ({
  randomBytes: vi.fn(() => ({
    toString: () => 'abcdef0123456789',
  })),
}));

import {
  loadAuth,
  saveAuth,
  deleteAuth,
  isAuthenticated,
  login,
  getValidToken,
  ensureAuth,
  resolveUser,
  fetchUserOrgs,
  fetchUserOrgsViaGh,
  getAuthFilePath,
  AuthError,
  type StoredAuth,
} from '../auth.js';

const MOCK_AUTH: StoredAuth = {
  access_token: 'ghu_test_token',
  refresh_token: 'ghr_test_refresh',
  expires_at: Date.now() + 3600_000, // 1 hour from now
  github_username: 'testuser',
  github_user_id: 12345,
};

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

describe('auth', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.OPENCARA_AUTH_FILE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('getAuthFilePath', () => {
    it('returns default path when env not set', () => {
      delete process.env.OPENCARA_AUTH_FILE;
      const result = getAuthFilePath();
      expect(result).toBe(path.join(os.homedir(), '.opencara', 'auth.json'));
    });

    it('returns env override when OPENCARA_AUTH_FILE is set', () => {
      process.env.OPENCARA_AUTH_FILE = '/tmp/test-auth.json';
      const result = getAuthFilePath();
      expect(result).toBe('/tmp/test-auth.json');
    });

    it('trims whitespace from env var', () => {
      process.env.OPENCARA_AUTH_FILE = '  /tmp/test-auth.json  ';
      const result = getAuthFilePath();
      expect(result).toBe('/tmp/test-auth.json');
    });

    it('ignores empty env var', () => {
      process.env.OPENCARA_AUTH_FILE = '   ';
      const result = getAuthFilePath();
      expect(result).toBe(path.join(os.homedir(), '.opencara', 'auth.json'));
    });

    it('returns configPath when env is not set', () => {
      delete process.env.OPENCARA_AUTH_FILE;
      const result = getAuthFilePath('/custom/auth.json');
      expect(result).toBe('/custom/auth.json');
    });

    it('env var takes priority over configPath', () => {
      process.env.OPENCARA_AUTH_FILE = '/env/auth.json';
      const result = getAuthFilePath('/config/auth.json');
      expect(result).toBe('/env/auth.json');
    });

    it('falls back to default when configPath is null', () => {
      delete process.env.OPENCARA_AUTH_FILE;
      const result = getAuthFilePath(null);
      expect(result).toBe(path.join(os.homedir(), '.opencara', 'auth.json'));
    });

    it('falls back to default when configPath is undefined', () => {
      delete process.env.OPENCARA_AUTH_FILE;
      const result = getAuthFilePath(undefined);
      expect(result).toBe(path.join(os.homedir(), '.opencara', 'auth.json'));
    });
  });

  describe('loadAuth', () => {
    it('returns parsed auth when file exists and is valid', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(MOCK_AUTH));
      const result = loadAuth();
      expect(result).toEqual(MOCK_AUTH);
    });

    it('returns null when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      expect(loadAuth()).toBeNull();
    });

    it('returns null when file contains invalid JSON', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('not json');
      expect(loadAuth()).toBeNull();
    });

    it('returns null when required fields are missing', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ access_token: 'test' }));
      expect(loadAuth()).toBeNull();
    });

    it('returns null when field types are wrong', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          access_token: 123, // should be string
          refresh_token: 'ghr_test',
          expires_at: Date.now(),
          github_username: 'user',
          github_user_id: 1,
        }),
      );
      expect(loadAuth()).toBeNull();
    });

    it('returns null when github_user_id is a string', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          ...MOCK_AUTH,
          github_user_id: '12345', // should be number
        }),
      );
      expect(loadAuth()).toBeNull();
    });

    it('returns null when refresh_token is present but not a string', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          access_token: 'ghu_test',
          refresh_token: 42, // should be string or undefined
          expires_at: Date.now() + 3600_000,
          github_username: 'user',
          github_user_id: 1,
        }),
      );
      expect(loadAuth()).toBeNull();
    });

    it('loads auth without refresh_token (non-refreshable token)', () => {
      const authWithoutRefresh = {
        access_token: 'ghu_test',
        expires_at: Date.now() + 3600_000,
        github_username: 'user',
        github_user_id: 1,
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(authWithoutRefresh));
      const result = loadAuth();
      expect(result).toEqual(authWithoutRefresh);
      expect(result?.refresh_token).toBeUndefined();
    });

    it('uses OPENCARA_AUTH_FILE env var for file path', () => {
      process.env.OPENCARA_AUTH_FILE = '/custom/auth.json';
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(MOCK_AUTH));
      loadAuth();
      expect(fs.readFileSync).toHaveBeenCalledWith('/custom/auth.json', 'utf-8');
    });
  });

  describe('saveAuth', () => {
    it('creates directory and writes file atomically', () => {
      saveAuth(MOCK_AUTH);

      expect(fs.mkdirSync).toHaveBeenCalledWith(path.join(os.homedir(), '.opencara'), {
        recursive: true,
      });

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.auth-'),
        JSON.stringify(MOCK_AUTH, null, 2),
        { encoding: 'utf-8', mode: 0o600 },
      );

      expect(fs.renameSync).toHaveBeenCalledWith(
        expect.stringContaining('.auth-'),
        path.join(os.homedir(), '.opencara', 'auth.json'),
      );
    });

    it('sets file permissions to 0o600', () => {
      saveAuth(MOCK_AUTH);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ mode: 0o600 }),
      );
    });

    it('cleans up temp file on write failure', () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('disk full');
      });

      expect(() => saveAuth(MOCK_AUTH)).toThrow('disk full');
      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('.auth-'));
    });

    it('cleans up temp file on rename failure', () => {
      vi.mocked(fs.renameSync).mockImplementation(() => {
        throw new Error('rename failed');
      });

      expect(() => saveAuth(MOCK_AUTH)).toThrow('rename failed');
      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('.auth-'));
    });

    it('ignores cleanup errors gracefully', () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('disk full');
      });
      vi.mocked(fs.unlinkSync).mockImplementation(() => {
        throw new Error('cleanup failed too');
      });

      expect(() => saveAuth(MOCK_AUTH)).toThrow('disk full');
    });

    it('uses OPENCARA_AUTH_FILE env var for file path', () => {
      process.env.OPENCARA_AUTH_FILE = '/custom/path/auth.json';
      saveAuth(MOCK_AUTH);

      expect(fs.mkdirSync).toHaveBeenCalledWith('/custom/path', { recursive: true });
      expect(fs.renameSync).toHaveBeenCalledWith(expect.any(String), '/custom/path/auth.json');
    });
  });

  describe('deleteAuth', () => {
    it('deletes the auth file', () => {
      deleteAuth();
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(os.homedir(), '.opencara', 'auth.json'));
    });

    it('ignores ENOENT errors', () => {
      vi.mocked(fs.unlinkSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      expect(() => deleteAuth()).not.toThrow();
    });

    it('rethrows non-ENOENT errors', () => {
      vi.mocked(fs.unlinkSync).mockImplementation(() => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      });
      expect(() => deleteAuth()).toThrow('EPERM');
    });

    it('uses OPENCARA_AUTH_FILE env var for file path', () => {
      process.env.OPENCARA_AUTH_FILE = '/custom/auth.json';
      deleteAuth();
      expect(fs.unlinkSync).toHaveBeenCalledWith('/custom/auth.json');
    });
  });

  describe('isAuthenticated', () => {
    it('returns true when auth exists and token not expired', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(MOCK_AUTH));
      expect(isAuthenticated()).toBe(true);
    });

    it('returns false when auth file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      expect(isAuthenticated()).toBe(false);
    });

    it('returns false when token is expired', () => {
      const expired = { ...MOCK_AUTH, expires_at: Date.now() - 1000 };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(expired));
      expect(isAuthenticated()).toBe(false);
    });
  });

  describe('login', () => {
    const PLATFORM_URL = 'https://api.opencara.com';
    const DEVICE_RESPONSE: DeviceFlowInitResponse = {
      device_code: 'dc_test',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    };

    const TOKEN_RESPONSE: DeviceFlowTokenResponse = {
      access_token: 'ghu_new_token',
      refresh_token: 'ghr_new_refresh',
      expires_in: 28800,
      token_type: 'bearer',
    };

    const USER_RESPONSE = { login: 'testuser', id: 12345 };

    it('completes full device flow successfully', async () => {
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse(DEVICE_RESPONSE)) // initiate
        .mockResolvedValueOnce(mockResponse(TOKEN_RESPONSE)) // token poll
        .mockResolvedValueOnce(mockResponse(USER_RESPONSE)); // resolve user

      const log = vi.fn();

      const result = await login(PLATFORM_URL, {
        fetchFn,
        delayFn: () => Promise.resolve(),
        log,
      });

      expect(result.access_token).toBe('ghu_new_token');
      expect(result.github_username).toBe('testuser');
      expect(result.github_user_id).toBe(12345);

      // Verify UX messages
      expect(log).toHaveBeenCalledWith(expect.stringContaining('https://github.com/login/device'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('ABCD-1234'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Authenticated as testuser'));
    });

    it('handles authorization_pending by continuing to poll', async () => {
      const pendingResponse = mockResponse(
        { error: { code: 'INVALID_REQUEST', message: 'authorization_pending' } },
        400,
      );

      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse(DEVICE_RESPONSE))
        .mockResolvedValueOnce(pendingResponse) // first poll: pending
        .mockResolvedValueOnce(mockResponse(TOKEN_RESPONSE)) // second poll: success
        .mockResolvedValueOnce(mockResponse(USER_RESPONSE));

      const result = await login(PLATFORM_URL, {
        fetchFn,
        delayFn: () => Promise.resolve(),
        log: vi.fn(),
      });

      expect(result.access_token).toBe('ghu_new_token');
      expect(fetchFn).toHaveBeenCalledTimes(4);
    });

    it('handles slow_down by increasing interval', async () => {
      // Server proxies GitHub's error as 200 with error field
      const slowDownResponse = mockResponse(
        { error: 'slow_down', error_description: 'Too many requests' },
        200,
      );

      const delays: number[] = [];
      const delayFn = vi.fn((ms: number) => {
        delays.push(ms);
        return Promise.resolve();
      });

      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse(DEVICE_RESPONSE))
        .mockResolvedValueOnce(slowDownResponse)
        .mockResolvedValueOnce(mockResponse(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse(USER_RESPONSE));

      await login(PLATFORM_URL, { fetchFn, delayFn, log: vi.fn() });

      // First poll at 5s interval, second at 10s (5s + 5s increase)
      expect(delays[0]).toBe(5000);
      expect(delays[1]).toBe(10000);
    });

    it('throws on expired_token', async () => {
      // Server proxies GitHub's error as 200 with error field
      const expiredResponse = mockResponse(
        { error: 'expired_token', error_description: 'The device code has expired' },
        200,
      );

      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse(DEVICE_RESPONSE))
        .mockResolvedValueOnce(expiredResponse);

      await expect(
        login(PLATFORM_URL, { fetchFn, delayFn: () => Promise.resolve(), log: vi.fn() }),
      ).rejects.toThrow('Authorization timed out, please try again');
    });

    it('throws on access_denied', async () => {
      // Server proxies GitHub's error as 200 with error field
      const deniedResponse = mockResponse(
        { error: 'access_denied', error_description: 'User denied access' },
        200,
      );

      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse(DEVICE_RESPONSE))
        .mockResolvedValueOnce(deniedResponse);

      await expect(
        login(PLATFORM_URL, { fetchFn, delayFn: () => Promise.resolve(), log: vi.fn() }),
      ).rejects.toThrow('Authorization denied by user');
    });

    it('throws on failed device flow initiation', async () => {
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse({ error: 'server error' }, 500));

      await expect(
        login(PLATFORM_URL, { fetchFn, delayFn: () => Promise.resolve(), log: vi.fn() }),
      ).rejects.toThrow('Failed to initiate device flow: 500');
    });

    it('times out when deadline is reached', async () => {
      // Set up a device response with very short expiration
      const shortExpiry = { ...DEVICE_RESPONSE, expires_in: 0 };
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse(shortExpiry));

      await expect(
        login(PLATFORM_URL, { fetchFn, delayFn: () => Promise.resolve(), log: vi.fn() }),
      ).rejects.toThrow('Authorization timed out, please try again');
    });

    it('re-checks deadline after delay to avoid unnecessary requests', async () => {
      // Use a short expiry and a delay that "consumes" the remaining time
      const shortExpiry = { ...DEVICE_RESPONSE, expires_in: 1, interval: 5 };
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse(shortExpiry));

      // Simulate delay that takes longer than the deadline
      const delayFn = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 1100)));

      await expect(login(PLATFORM_URL, { fetchFn, delayFn, log: vi.fn() })).rejects.toThrow(
        'Authorization timed out, please try again',
      );

      // Only the device initiation call should have been made, no token poll
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('saves auth to file on success', async () => {
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse(DEVICE_RESPONSE))
        .mockResolvedValueOnce(mockResponse(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse(USER_RESPONSE));

      await login(PLATFORM_URL, {
        fetchFn,
        delayFn: () => Promise.resolve(),
        log: vi.fn(),
      });

      // saveAuth is called which writes to file
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.auth-'),
        expect.stringContaining('ghu_new_token'),
        expect.objectContaining({ mode: 0o600 }),
      );
    });

    it('sends device_code in token poll request', async () => {
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse(DEVICE_RESPONSE))
        .mockResolvedValueOnce(mockResponse(TOKEN_RESPONSE))
        .mockResolvedValueOnce(mockResponse(USER_RESPONSE));

      await login(PLATFORM_URL, {
        fetchFn,
        delayFn: () => Promise.resolve(),
        log: vi.fn(),
      });

      // Second call is the token poll
      const tokenCall = fetchFn.mock.calls[1];
      expect(tokenCall[0]).toBe(`${PLATFORM_URL}/api/auth/device/token`);
      expect(JSON.parse(tokenCall[1]?.body as string)).toEqual({
        device_code: 'dc_test',
      });
    });

    it('continues polling on unparseable error response', async () => {
      // Create a response where json() throws
      const badErrorResponse = {
        ok: false,
        status: 400,
        json: () => Promise.reject(new Error('bad json')),
        text: () => Promise.resolve('not json'),
      } as unknown as Response;

      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse({ ...DEVICE_RESPONSE, expires_in: 10 }))
        .mockResolvedValueOnce(badErrorResponse) // unparseable error
        .mockResolvedValueOnce(mockResponse(TOKEN_RESPONSE)) // success
        .mockResolvedValueOnce(mockResponse(USER_RESPONSE));

      const result = await login(PLATFORM_URL, {
        fetchFn,
        delayFn: () => Promise.resolve(),
        log: vi.fn(),
      });

      expect(result.access_token).toBe('ghu_new_token');
    });
  });

  describe('getValidToken', () => {
    const PLATFORM_URL = 'https://api.opencara.com';

    it('returns token when not expired', async () => {
      const now = Date.now();
      const auth = { ...MOCK_AUTH, expires_at: now + 3600_000 }; // 1 hour from now

      const token = await getValidToken(PLATFORM_URL, {
        loadAuthFn: () => auth,
        nowFn: () => now,
      });

      expect(token).toBe('ghu_test_token');
    });

    it('throws when not authenticated', async () => {
      await expect(getValidToken(PLATFORM_URL, { loadAuthFn: () => null })).rejects.toThrow(
        'Not authenticated',
      );
    });

    it('throws when token expired and no refresh_token available', async () => {
      const now = Date.now();
      const auth: StoredAuth = {
        access_token: 'ghu_test',
        expires_at: now - 1000, // expired
        github_username: 'user',
        github_user_id: 1,
        // no refresh_token
      };

      await expect(
        getValidToken(PLATFORM_URL, {
          loadAuthFn: () => auth,
          nowFn: () => now,
        }),
      ).rejects.toThrow('no refresh token available');
    });

    it('preserves existing refresh_token when refresh response omits it', async () => {
      const now = Date.now();
      const auth = { ...MOCK_AUTH, expires_at: now - 1000 };

      const refreshResponse: RefreshTokenResponse = {
        access_token: 'ghu_new',
        expires_in: 28800,
        token_type: 'bearer',
        // no refresh_token in response
      };

      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse(refreshResponse));

      const saveAuthFn = vi.fn();

      await getValidToken(PLATFORM_URL, {
        fetchFn,
        loadAuthFn: () => auth,
        saveAuthFn,
        nowFn: () => now,
      });

      const saved = saveAuthFn.mock.calls[0][0] as StoredAuth;
      expect(saved.refresh_token).toBe('ghr_test_refresh'); // preserved
    });

    it('refreshes token when within 5-minute buffer', async () => {
      const now = Date.now();
      const auth = {
        ...MOCK_AUTH,
        expires_at: now + 4 * 60 * 1000, // 4 minutes from now (within 5 min buffer)
      };

      const refreshResponse: RefreshTokenResponse = {
        access_token: 'ghu_refreshed',
        refresh_token: 'ghr_refreshed',
        expires_in: 28800,
        token_type: 'bearer',
      };

      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse(refreshResponse));

      const saveAuthFn = vi.fn();

      const token = await getValidToken(PLATFORM_URL, {
        fetchFn,
        loadAuthFn: () => auth,
        saveAuthFn,
        nowFn: () => now,
      });

      expect(token).toBe('ghu_refreshed');
      expect(saveAuthFn).toHaveBeenCalledWith(
        expect.objectContaining({
          access_token: 'ghu_refreshed',
          refresh_token: 'ghr_refreshed',
          github_username: 'testuser',
          github_user_id: 12345,
        }),
      );
    });

    it('refreshes token when already expired', async () => {
      const now = Date.now();
      const auth = { ...MOCK_AUTH, expires_at: now - 1000 }; // expired

      const refreshResponse: RefreshTokenResponse = {
        access_token: 'ghu_refreshed',
        refresh_token: 'ghr_refreshed',
        expires_in: 28800,
        token_type: 'bearer',
      };

      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse(refreshResponse));

      const token = await getValidToken(PLATFORM_URL, {
        fetchFn,
        loadAuthFn: () => auth,
        saveAuthFn: vi.fn(),
        nowFn: () => now,
      });

      expect(token).toBe('ghu_refreshed');
    });

    it('throws AuthError when refresh fails', async () => {
      const now = Date.now();
      const auth = { ...MOCK_AUTH, expires_at: now - 1000 };

      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(
          mockResponse(
            { error: { code: 'AUTH_TOKEN_REVOKED', message: 'Refresh token expired' } },
            401,
          ),
        );

      await expect(
        getValidToken(PLATFORM_URL, {
          fetchFn,
          loadAuthFn: () => auth,
          nowFn: () => now,
        }),
      ).rejects.toThrow('Refresh token expired');
    });

    it('falls back to text body when refresh JSON parse fails', async () => {
      const now = Date.now();
      const auth = { ...MOCK_AUTH, expires_at: now - 1000 };

      const badResponse = {
        ok: false,
        status: 502,
        json: () => Promise.reject(new Error('bad json')),
        text: () => Promise.resolve('Bad Gateway'),
      } as unknown as Response;

      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(badResponse);

      await expect(
        getValidToken(PLATFORM_URL, {
          fetchFn,
          loadAuthFn: () => auth,
          nowFn: () => now,
        }),
      ).rejects.toThrow('Token refresh failed (502): Bad Gateway');
    });

    it('handles fully unparseable refresh error response', async () => {
      const now = Date.now();
      const auth = { ...MOCK_AUTH, expires_at: now - 1000 };

      const badResponse = {
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('bad json')),
        text: () => Promise.reject(new Error('text also failed')),
      } as unknown as Response;

      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(badResponse);

      await expect(
        getValidToken(PLATFORM_URL, {
          fetchFn,
          loadAuthFn: () => auth,
          nowFn: () => now,
        }),
      ).rejects.toThrow('Token refresh failed (500)');
    });

    it('sends refresh_token in POST body', async () => {
      const now = Date.now();
      const auth = { ...MOCK_AUTH, expires_at: now - 1000 };

      const refreshResponse: RefreshTokenResponse = {
        access_token: 'ghu_refreshed',
        refresh_token: 'ghr_refreshed',
        expires_in: 28800,
        token_type: 'bearer',
      };

      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse(refreshResponse));

      await getValidToken(PLATFORM_URL, {
        fetchFn,
        loadAuthFn: () => auth,
        saveAuthFn: vi.fn(),
        nowFn: () => now,
      });

      expect(fetchFn).toHaveBeenCalledWith(
        `${PLATFORM_URL}/api/auth/refresh`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ refresh_token: 'ghr_test_refresh' }),
        }),
      );
    });

    it('preserves username and user_id after refresh', async () => {
      const now = Date.now();
      const auth = { ...MOCK_AUTH, expires_at: now - 1000 };

      const refreshResponse: RefreshTokenResponse = {
        access_token: 'ghu_new',
        refresh_token: 'ghr_new',
        expires_in: 28800,
        token_type: 'bearer',
      };

      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse(refreshResponse));

      const saveAuthFn = vi.fn();

      await getValidToken(PLATFORM_URL, {
        fetchFn,
        loadAuthFn: () => auth,
        saveAuthFn,
        nowFn: () => now,
      });

      const saved = saveAuthFn.mock.calls[0][0] as StoredAuth;
      expect(saved.github_username).toBe('testuser');
      expect(saved.github_user_id).toBe(12345);
    });
  });

  describe('resolveUser', () => {
    it('returns login and id on success', async () => {
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse({ login: 'octocat', id: 42 }));

      const result = await resolveUser('ghu_token', fetchFn);
      expect(result).toEqual({ login: 'octocat', id: 42 });
    });

    it('sends Bearer token in Authorization header', async () => {
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse({ login: 'user', id: 1 }));

      await resolveUser('ghu_my_token', fetchFn);

      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.github.com/user',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer ghu_my_token',
          }),
        }),
      );
    });

    it('throws on HTTP error', async () => {
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse({}, 401));

      await expect(resolveUser('bad_token', fetchFn)).rejects.toThrow(
        'Failed to resolve GitHub user: 401',
      );
    });

    it('throws on missing login field', async () => {
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse({ id: 1 }));

      await expect(resolveUser('ghu_token', fetchFn)).rejects.toThrow(
        'Invalid GitHub user response',
      );
    });

    it('throws on missing id field', async () => {
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse({ login: 'user' }));

      await expect(resolveUser('ghu_token', fetchFn)).rejects.toThrow(
        'Invalid GitHub user response',
      );
    });

    it('throws on wrong field types', async () => {
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse({ login: 123, id: 'not-a-number' }));

      await expect(resolveUser('ghu_token', fetchFn)).rejects.toThrow(
        'Invalid GitHub user response',
      );
    });
  });

  describe('fetchUserOrgs', () => {
    beforeEach(() => {
      // Make execFileSync throw so fetchUserOrgsViaGh returns an empty set,
      // ensuring tests exercise the fetchFn fallback path regardless of
      // whether the developer has gh CLI authenticated locally.
      vi.mocked(childProcess.execFileSync).mockImplementation(() => {
        throw new Error('gh not available');
      });
    });

    it('returns set of org logins on success (lowercased)', async () => {
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(
          mockResponse([{ login: 'Org-A' }, { login: 'org-b' }, { login: 'ORG-C' }]),
        );

      const result = await fetchUserOrgs('ghu_token', fetchFn);
      expect(result).toEqual(new Set(['org-a', 'org-b', 'org-c']));
    });

    it('sends correct headers including API version', async () => {
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse([{ login: 'my-org' }]));

      await fetchUserOrgs('ghu_my_token', fetchFn);

      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.github.com/user/orgs?per_page=100',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer ghu_my_token',
            'X-GitHub-Api-Version': '2022-11-28',
          }),
        }),
      );
    });

    it('returns empty set on HTTP error', async () => {
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse({}, 403));

      const result = await fetchUserOrgs('bad_token', fetchFn);
      expect(result).toEqual(new Set());
    });

    it('returns empty set on network error', async () => {
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockRejectedValueOnce(new Error('network error'));

      const result = await fetchUserOrgs('ghu_token', fetchFn);
      expect(result).toEqual(new Set());
    });

    it('skips entries without string login', async () => {
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(
          mockResponse([{ login: 'Valid-Org' }, { login: 123 }, { name: 'no-login' }]),
        );

      const result = await fetchUserOrgs('ghu_token', fetchFn);
      expect(result).toEqual(new Set(['valid-org']));
    });

    it('returns empty set for empty org list', async () => {
      const fetchFn = vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(mockResponse([]));

      const result = await fetchUserOrgs('ghu_token', fetchFn);
      expect(result).toEqual(new Set());
    });

    it('returns gh orgs directly when fetchUserOrgsViaGh succeeds (skips fetchFn)', async () => {
      vi.mocked(childProcess.execFileSync).mockReturnValue('org-x\norg-y\n');

      const fetchFn =
        vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

      const result = await fetchUserOrgs('ghu_token', fetchFn);
      expect(result).toEqual(new Set(['org-x', 'org-y']));
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe('fetchUserOrgsViaGh', () => {
    it('returns lowercased org logins from gh CLI output', () => {
      vi.mocked(childProcess.execFileSync).mockReturnValue('Org-A\norg-b\nORG-C\n');

      const result = fetchUserOrgsViaGh();
      expect(result).toEqual(new Set(['org-a', 'org-b', 'org-c']));
    });

    it('returns empty set when execFileSync throws', () => {
      vi.mocked(childProcess.execFileSync).mockImplementation(() => {
        throw new Error('gh not found');
      });

      const result = fetchUserOrgsViaGh();
      expect(result).toEqual(new Set());
    });

    it('skips blank lines in output', () => {
      vi.mocked(childProcess.execFileSync).mockReturnValue('\norg-a\n\norg-b\n\n');

      const result = fetchUserOrgsViaGh();
      expect(result).toEqual(new Set(['org-a', 'org-b']));
    });

    it('returns empty set when output is empty', () => {
      vi.mocked(childProcess.execFileSync).mockReturnValue('');

      const result = fetchUserOrgsViaGh();
      expect(result).toEqual(new Set());
    });

    it('verifies gh user matches expectedLogin before fetching orgs', () => {
      // First call: get user login, second call: get orgs
      vi.mocked(childProcess.execFileSync)
        .mockReturnValueOnce('testuser')
        .mockReturnValueOnce('org-a\norg-b\n');

      const result = fetchUserOrgsViaGh('testuser');
      expect(result).toEqual(new Set(['org-a', 'org-b']));
    });

    it('returns empty set when gh user does not match expectedLogin', () => {
      vi.mocked(childProcess.execFileSync).mockReturnValueOnce('differentuser');

      const result = fetchUserOrgsViaGh('testuser');
      expect(result).toEqual(new Set());
      // Should not call execFileSync a second time for orgs
      expect(childProcess.execFileSync).toHaveBeenCalledTimes(1);
    });

    it('matches expectedLogin case-insensitively', () => {
      vi.mocked(childProcess.execFileSync)
        .mockReturnValueOnce('TestUser')
        .mockReturnValueOnce('org-a\n');

      const result = fetchUserOrgsViaGh('testuser');
      expect(result).toEqual(new Set(['org-a']));
    });
  });

  describe('AuthError', () => {
    it('has correct name', () => {
      const err = new AuthError('test');
      expect(err.name).toBe('AuthError');
      expect(err.message).toBe('test');
    });

    it('is instanceof Error', () => {
      const err = new AuthError('test');
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('ensureAuth', () => {
    it('returns token when already authenticated', async () => {
      const auth: StoredAuth = {
        access_token: 'ghu_valid_token',
        refresh_token: 'ghr_refresh',
        expires_at: Date.now() + 3_600_000,
        github_username: 'testuser',
        github_user_id: 1,
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(auth));

      const token = await ensureAuth('https://platform.example.com');
      expect(token).toBe('ghu_valid_token');
    });

    it('auto-triggers login when not authenticated and returns new token', async () => {
      // No stored auth
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      // Mock login flow via global.fetch: device init + token poll + user resolution
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockResponse({
            device_code: 'dev123',
            user_code: 'USER-CODE',
            verification_uri: 'https://github.com/login/device',
            interval: 1,
            expires_in: 300,
          }),
        )
        .mockResolvedValueOnce(mockResponse({ access_token: 'ghu_new_token', expires_in: 3600 }))
        .mockResolvedValueOnce(mockResponse({ login: 'newuser', id: 42 }));

      const originalFetch = global.fetch;
      global.fetch = mockFetch as unknown as typeof fetch;
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        const token = await ensureAuth('https://platform.example.com');
        expect(token).toBe('ghu_new_token');
        expect(mockFetch).toHaveBeenCalledTimes(3);
      } finally {
        global.fetch = originalFetch;
        consoleSpy.mockRestore();
      }
    });

    it('throws AuthError when login is cancelled', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      // Mock login flow that returns access_denied
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          mockResponse({
            device_code: 'dev123',
            user_code: 'USER-CODE',
            verification_uri: 'https://github.com/login/device',
            interval: 1,
            expires_in: 300,
          }),
        )
        .mockResolvedValueOnce(mockResponse({ error: 'access_denied' }));

      const originalFetch = global.fetch;
      global.fetch = mockFetch as unknown as typeof fetch;
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await expect(ensureAuth('https://platform.example.com')).rejects.toThrow(AuthError);
      } finally {
        global.fetch = originalFetch;
        consoleSpy.mockRestore();
      }
    });

    it('re-throws non-AuthError errors from getValidToken', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new TypeError('unexpected error');
      });

      await expect(ensureAuth('https://platform.example.com')).rejects.toThrow(TypeError);
    });
  });
});
