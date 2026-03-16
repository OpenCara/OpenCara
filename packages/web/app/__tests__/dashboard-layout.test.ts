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

async function renderLayout(children: React.ReactNode) {
  const mod = await import('../dashboard/layout.js');
  const Layout = mod.default;
  return renderToString(createElement(Layout, { children }));
}

describe('DashboardLayout', () => {
  it('shows login prompt when not authenticated', async () => {
    mockAuth(false);
    const child = createElement('p', null, 'secret content');
    const html = await renderLayout(child);
    expect(html).toContain('Sign in to view your dashboard');
    expect(html).toContain('Login with GitHub');
    expect(html).toContain('/auth/login');
    expect(html).not.toContain('secret content');
  });

  it('renders children when authenticated', async () => {
    mockAuth(true);
    const child = createElement('p', null, 'dashboard content');
    const html = await renderLayout(child);
    expect(html).toContain('dashboard content');
    expect(html).not.toContain('Sign in to view your dashboard');
  });

  it('exports a function component', async () => {
    mockAuth(false);
    const mod = await import('../dashboard/layout.js');
    expect(typeof mod.default).toBe('function');
  });
});
