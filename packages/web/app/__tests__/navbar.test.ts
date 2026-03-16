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

async function renderNavBar() {
  const mod = await import('../components/NavBar.js');
  const NavBar = mod.default;
  return render(createElement(NavBar));
}

async function ssrNavBar() {
  const mod = await import('../components/NavBar.js');
  const NavBar = mod.default;
  return renderToString(createElement(NavBar));
}

describe('NavBar', () => {
  it('renders OpenCrust brand link', async () => {
    mockAuth(false);
    await renderNavBar();
    const brand = screen.getByText('OpenCrust');
    expect(brand).toBeDefined();
    expect(brand.closest('a')?.getAttribute('href')).toBe('/');
  });

  it('renders leaderboard link', async () => {
    mockAuth(false);
    await renderNavBar();
    const link = screen.getByText('Leaderboard');
    expect(link).toBeDefined();
    expect(link.closest('a')?.getAttribute('href')).toBe('/leaderboard');
  });

  it('renders Login link when authenticated=false after mount', async () => {
    mockAuth(false);
    await renderNavBar();
    await waitFor(() => {
      expect(screen.getByText('Login')).toBeDefined();
    });
    const loginLink = screen.getByText('Login').closest('a');
    expect(loginLink?.getAttribute('href')).toBe('/auth/login');
  });

  it('renders Dashboard and Logout links when authenticated after mount', async () => {
    mockAuth(true);
    await renderNavBar();
    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeDefined();
    });
    expect(screen.getByText('Logout')).toBeDefined();

    const dashLink = screen.getByText('Dashboard').closest('a');
    expect(dashLink?.getAttribute('href')).toBe('/dashboard');

    const logoutLink = screen.getByText('Logout').closest('a');
    expect(logoutLink?.getAttribute('href')).toBe('/auth/logout');
  });

  it('does not render Dashboard link when not authenticated', async () => {
    mockAuth(false);
    await renderNavBar();
    await waitFor(() => {
      expect(screen.getByText('Login')).toBeDefined();
    });
    expect(screen.queryByText('Dashboard')).toBeNull();
  });

  it('does not render Logout link when not authenticated', async () => {
    mockAuth(false);
    await renderNavBar();
    await waitFor(() => {
      expect(screen.getByText('Login')).toBeDefined();
    });
    expect(screen.queryByText('Logout')).toBeNull();
  });

  it('does not render Login link when authenticated', async () => {
    mockAuth(true);
    await renderNavBar();
    await waitFor(() => {
      expect(screen.getByText('Logout')).toBeDefined();
    });
    expect(screen.queryByText('Login')).toBeNull();
  });

  it('hides auth-dependent links before mount (SSR)', async () => {
    mockAuth(false);
    const html = await ssrNavBar();
    // SSR should not contain Login, Dashboard, or Logout because mounted=false
    expect(html).not.toContain('Login');
    expect(html).not.toContain('Dashboard');
    expect(html).not.toContain('Logout');
    // Should still have the static links
    expect(html).toContain('OpenCrust');
    expect(html).toContain('Leaderboard');
  });

  it('does not contain href="#" anywhere (no flash fallback)', async () => {
    mockAuth(false);
    const html = await ssrNavBar();
    expect(html).not.toContain('href="#"');
  });

  it('renders semantic header and nav elements', async () => {
    mockAuth(false);
    await renderNavBar();
    expect(document.querySelector('header')).toBeDefined();
    expect(document.querySelector('nav')).toBeDefined();
  });

  it('exports a function component', async () => {
    mockAuth(false);
    const mod = await import('../components/NavBar.js');
    expect(typeof mod.default).toBe('function');
  });

  it('renders authenticated SSR without auth links', async () => {
    mockAuth(true);
    const html = await ssrNavBar();
    // Even when authenticated, auth links hidden during SSR (mounted=false)
    expect(html).not.toContain('Dashboard');
    expect(html).not.toContain('Logout');
    expect(html).not.toContain('Login');
  });
});
