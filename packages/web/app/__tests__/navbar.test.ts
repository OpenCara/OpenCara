import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function mockAuth(authenticated: boolean) {
  vi.doMock('../../lib/auth.js', () => ({
    isAuthenticated: () => authenticated,
    getLoginUrl: () => '/auth/login',
    getLogoutUrl: () => '/auth/logout',
    getSessionToken: () => (authenticated ? 'token' : null),
  }));
}

async function renderNavBar() {
  const mod = await import('../components/NavBar.js');
  const NavBar = mod.default;
  return renderToString(createElement(NavBar));
}

describe('NavBar', () => {
  it('renders OpenCrust brand link', async () => {
    mockAuth(false);
    const html = await renderNavBar();
    expect(html).toContain('OpenCrust');
    expect(html).toContain('href="/"');
  });

  it('renders leaderboard link', async () => {
    mockAuth(false);
    const html = await renderNavBar();
    expect(html).toContain('Leaderboard');
    expect(html).toContain('href="/leaderboard"');
  });

  it('renders Login link when not mounted (SSR initial)', async () => {
    mockAuth(false);
    const html = await renderNavBar();
    // Before useEffect runs (SSR), shows Login
    expect(html).toContain('Login');
  });

  it('renders semantic header and nav elements', async () => {
    mockAuth(false);
    const html = await renderNavBar();
    expect(html).toContain('<header');
    expect(html).toContain('<nav');
  });

  it('exports a function component', async () => {
    mockAuth(false);
    const mod = await import('../components/NavBar.js');
    expect(typeof mod.default).toBe('function');
  });
});
