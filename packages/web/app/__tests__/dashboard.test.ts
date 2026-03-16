import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

// Helper: mock auth module so dashboard page sees desired auth state
function mockAuth(token: string | null) {
  vi.doMock('../../lib/auth.js', () => ({
    getSessionToken: () => token,
    isAuthenticated: () => token !== null,
    getLoginUrl: () => '/auth/login',
    getLogoutUrl: () => '/auth/logout',
  }));
}

// Helper: mock apiFetch
function mockApiFetch(impl: (path: string, init?: RequestInit) => Promise<unknown>) {
  vi.doMock('../../lib/api.js', () => ({
    apiFetch: impl,
  }));
}

async function renderDashboard() {
  const mod = await import('../dashboard/page.js');
  const Component = mod.default;
  return renderToString(createElement(Component));
}

describe('DashboardPage', () => {
  it('renders the dashboard heading', async () => {
    mockAuth('test-token');
    mockApiFetch(async () => ({ agents: [] }));

    const html = await renderDashboard();
    expect(html).toContain('My Dashboard');
  });

  it('renders loading skeletons initially', async () => {
    mockAuth('test-token');
    mockApiFetch(async () => ({ agents: [] }));

    const html = await renderDashboard();
    // SSR renders with loading=true initially
    expect(html).toContain('animate-pulse');
  });

  it('exports a function component', async () => {
    mockAuth(null);
    mockApiFetch(async () => ({ agents: [] }));

    const mod = await import('../dashboard/page.js');
    expect(typeof mod.default).toBe('function');
  });
});
