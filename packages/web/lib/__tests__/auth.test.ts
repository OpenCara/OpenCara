import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getSessionToken', () => {
  it('returns null when document is undefined (SSR)', async () => {
    const origDoc = globalThis.document;
    // @ts-expect-error - testing SSR
    delete globalThis.document;
    const { getSessionToken } = await import('../auth.js');
    expect(getSessionToken()).toBeNull();
    globalThis.document = origDoc;
  });

  it('returns null when cookie is not set', async () => {
    Object.defineProperty(globalThis, 'document', {
      value: { cookie: '' },
      writable: true,
      configurable: true,
    });
    const { getSessionToken } = await import('../auth.js');
    expect(getSessionToken()).toBeNull();
  });

  it('returns the session token from cookie', async () => {
    Object.defineProperty(globalThis, 'document', {
      value: { cookie: 'opencrust_session=test-token-123; other=value' },
      writable: true,
      configurable: true,
    });
    const { getSessionToken } = await import('../auth.js');
    expect(getSessionToken()).toBe('test-token-123');
  });

  it('decodes URI-encoded cookie values', async () => {
    Object.defineProperty(globalThis, 'document', {
      value: { cookie: 'opencrust_session=token%20with%20spaces' },
      writable: true,
      configurable: true,
    });
    const { getSessionToken } = await import('../auth.js');
    expect(getSessionToken()).toBe('token with spaces');
  });
});

describe('isAuthenticated', () => {
  it('returns false when no session token', async () => {
    Object.defineProperty(globalThis, 'document', {
      value: { cookie: '' },
      writable: true,
      configurable: true,
    });
    const { isAuthenticated } = await import('../auth.js');
    expect(isAuthenticated()).toBe(false);
  });

  it('returns true when session token exists', async () => {
    Object.defineProperty(globalThis, 'document', {
      value: { cookie: 'opencrust_session=abc' },
      writable: true,
      configurable: true,
    });
    const { isAuthenticated } = await import('../auth.js');
    expect(isAuthenticated()).toBe(true);
  });
});

describe('getLoginUrl', () => {
  it('returns /auth/login when no API URL configured', async () => {
    const { getLoginUrl } = await import('../auth.js');
    expect(getLoginUrl()).toBe('/auth/login');
  });

  it('prepends API URL when configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com');
    vi.resetModules();
    const { getLoginUrl } = await import('../auth.js');
    expect(getLoginUrl()).toBe('https://api.example.com/auth/login');
  });
});

describe('getLogoutUrl', () => {
  it('returns /auth/logout when no API URL configured', async () => {
    const { getLogoutUrl } = await import('../auth.js');
    expect(getLogoutUrl()).toBe('/auth/logout');
  });

  it('prepends API URL when configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com');
    vi.resetModules();
    const { getLogoutUrl } = await import('../auth.js');
    expect(getLogoutUrl()).toBe('https://api.example.com/auth/logout');
  });
});
