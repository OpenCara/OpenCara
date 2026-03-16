// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { renderToString } from 'react-dom/server';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

afterEach(() => {
  cleanup();
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
  return render(createElement(Layout, { children }));
}

async function ssrLayout(children: React.ReactNode) {
  const mod = await import('../dashboard/layout.js');
  const Layout = mod.default;
  return renderToString(createElement(Layout, { children }));
}

describe('DashboardLayout', () => {
  it('shows loading skeleton during SSR (before mount)', async () => {
    mockAuth(true);
    const child = createElement('p', null, 'dashboard content');
    const html = await ssrLayout(child);
    // Should show loading skeleton, not children or login prompt
    expect(html).toContain('animate-pulse');
    expect(html).not.toContain('dashboard content');
    expect(html).not.toContain('Sign in to view your dashboard');
  });

  it('shows login prompt when not authenticated (after mount)', async () => {
    mockAuth(false);
    const child = createElement('p', null, 'secret content');
    await renderLayout(child);

    await waitFor(() => {
      expect(screen.getByText('Sign in to view your dashboard')).toBeDefined();
    });
    expect(screen.getByText('Login with GitHub')).toBeDefined();
    expect(screen.queryByText('secret content')).toBeNull();

    const loginLink = screen.getByText('Login with GitHub').closest('a');
    expect(loginLink?.getAttribute('href')).toBe('/auth/login');
  });

  it('renders children when authenticated (after mount)', async () => {
    mockAuth(true);
    const child = createElement('p', null, 'dashboard content');
    await renderLayout(child);

    await waitFor(() => {
      expect(screen.getByText('dashboard content')).toBeDefined();
    });
    expect(screen.queryByText('Sign in to view your dashboard')).toBeNull();
  });

  it('does not show login prompt during SSR regardless of auth state', async () => {
    mockAuth(false);
    const child = createElement('p', null, 'content');
    const html = await ssrLayout(child);
    // SSR should show skeleton, not login prompt (hydration safe)
    expect(html).toContain('animate-pulse');
    expect(html).not.toContain('Sign in to view your dashboard');
  });

  it('exports a function component', async () => {
    mockAuth(false);
    const mod = await import('../dashboard/layout.js');
    expect(typeof mod.default).toBe('function');
  });

  it('renders login prompt with descriptive text', async () => {
    mockAuth(false);
    await renderLayout(createElement('div'));

    await waitFor(() => {
      expect(screen.getByText(/Log in with GitHub to see your agents/)).toBeDefined();
    });
  });
});
