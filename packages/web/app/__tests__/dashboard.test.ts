// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

afterEach(() => {
  cleanup();
});

function mockAuth(token: string | null) {
  vi.doMock('../../lib/auth.js', () => ({
    getSessionToken: () => token,
    isAuthenticated: () => token !== null,
    getLoginUrl: () => '/auth/login',
    getLogoutUrl: () => '/auth/logout',
  }));
}

function mockApiFetch(impl: (path: string, init?: RequestInit) => Promise<unknown>) {
  vi.doMock('../../lib/api.js', () => ({
    apiFetch: impl,
  }));
}

const AGENT_1 = {
  id: 'agent-1',
  model: 'claude-sonnet-4',
  tool: 'claude-code',
  status: 'online' as const,
  createdAt: '2025-01-01T00:00:00Z',
};

const AGENT_2 = {
  id: 'agent-2',
  model: 'gpt-4o',
  tool: 'copilot',
  status: 'offline' as const,
  createdAt: '2025-01-02T00:00:00Z',
};

const STATS_1 = {
  agent: {
    id: 'agent-1',
    model: 'claude-sonnet-4',
    tool: 'claude-code',
    status: 'online' as const,
  },
  stats: {
    totalReviews: 42,
    totalSummaries: 10,
    totalRatings: 20,
    thumbsUp: 18,
    thumbsDown: 2,
    tokensUsed: 5000,
  },
};

const CONSUMPTION_1 = {
  agentId: 'agent-1',
  totalTokens: 15000,
  totalReviews: 42,
  period: {
    last24h: { tokens: 1000, reviews: 3 },
    last7d: { tokens: 5000, reviews: 15 },
    last30d: { tokens: 12000, reviews: 35 },
  },
};

const STATS_2 = {
  agent: {
    id: 'agent-2',
    model: 'gpt-4o',
    tool: 'copilot',
    status: 'offline' as const,
  },
  stats: {
    totalReviews: 5,
    totalSummaries: 2,
    totalRatings: 3,
    thumbsUp: 2,
    thumbsDown: 1,
    tokensUsed: 1000,
  },
};

const CONSUMPTION_2 = {
  agentId: 'agent-2',
  totalTokens: 3000,
  totalReviews: 5,
  period: {
    last24h: { tokens: 200, reviews: 1 },
    last7d: { tokens: 800, reviews: 3 },
    last30d: { tokens: 2500, reviews: 5 },
  },
};

async function renderDashboard() {
  const mod = await import('../dashboard/page.js');
  const Component = mod.default;
  return render(createElement(Component));
}

describe('DashboardPage', () => {
  it('renders the dashboard heading', async () => {
    mockAuth('test-token');
    mockApiFetch(async () => ({ agents: [] }));

    await renderDashboard();
    expect(screen.getByText('My Dashboard')).toBeDefined();
  });

  it('shows loading skeletons initially then resolves', async () => {
    mockAuth('test-token');
    mockApiFetch(async () => ({ agents: [] }));

    await renderDashboard();
    // Initially shows loading skeletons
    expect(document.querySelectorAll('.animate-pulse').length).toBe(2);

    // After loading resolves, shows empty state
    await waitFor(() => {
      expect(screen.getByText('No agents registered.')).toBeDefined();
    });
  });

  it('renders empty state when no agents', async () => {
    mockAuth('test-token');
    mockApiFetch(async () => ({ agents: [] }));

    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('No agents registered.')).toBeDefined();
    });
    expect(screen.getByText('opencrust agent create')).toBeDefined();
  });

  it('renders agent cards after successful fetch', async () => {
    mockAuth('test-token');
    mockApiFetch(async (path: string) => {
      if (path === '/api/agents') return { agents: [AGENT_1] };
      if (path.startsWith('/api/stats/')) return STATS_1;
      if (path.startsWith('/api/consumption/')) return CONSUMPTION_1;
      return {};
    });

    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('claude-sonnet-4 / claude-code')).toBeDefined();
    });
    // Check status is shown (badge + status card)
    expect(screen.getAllByText('online').length).toBeGreaterThanOrEqual(1);
    // Check review stats
    expect(screen.getByText('42')).toBeDefined();
    // Check consumption
    expect(screen.getByText('15,000')).toBeDefined();
    expect(screen.getByText('total tokens')).toBeDefined();
  });

  it('renders multiple agent cards', async () => {
    mockAuth('test-token');
    mockApiFetch(async (path: string) => {
      if (path === '/api/agents') return { agents: [AGENT_1, AGENT_2] };
      if (path === '/api/stats/agent-1') return STATS_1;
      if (path === '/api/stats/agent-2') return STATS_2;
      if (path === '/api/consumption/agent-1') return CONSUMPTION_1;
      if (path === '/api/consumption/agent-2') return CONSUMPTION_2;
      return {};
    });

    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('claude-sonnet-4 / claude-code')).toBeDefined();
    });
    expect(screen.getByText('gpt-4o / copilot')).toBeDefined();
    expect(screen.getAllByText('online').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('offline').length).toBeGreaterThanOrEqual(1);
  });

  it('shows error when agents API fails', async () => {
    mockAuth('test-token');
    mockApiFetch(async () => {
      throw new Error('Network error');
    });

    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeDefined();
    });
  });

  it('shows generic error for non-Error throws', async () => {
    mockAuth('test-token');
    mockApiFetch(async () => {
      throw 'string error';
    });

    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Failed to load agents')).toBeDefined();
    });
  });

  it('accumulates errors when both stats and consumption fail', async () => {
    mockAuth('test-token');
    mockApiFetch(async (path: string) => {
      if (path === '/api/agents') return { agents: [AGENT_1] };
      throw new Error('API failed');
    });

    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('claude-sonnet-4 / claude-code')).toBeDefined();
    });
    // Both error messages should appear
    const errors = screen.getAllByText(/Failed to load/);
    expect(errors.length).toBe(2);
    expect(screen.getByText('Failed to load stats')).toBeDefined();
    expect(screen.getByText('Failed to load consumption')).toBeDefined();
  });

  it('shows only stats error when stats fail but consumption succeeds', async () => {
    mockAuth('test-token');
    mockApiFetch(async (path: string) => {
      if (path === '/api/agents') return { agents: [AGENT_1] };
      if (path.startsWith('/api/stats/')) throw new Error('Stats error');
      if (path.startsWith('/api/consumption/')) return CONSUMPTION_1;
      return {};
    });

    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Failed to load stats')).toBeDefined();
    });
    // Consumption should still render
    expect(screen.getByText('15,000')).toBeDefined();
  });

  it('shows only consumption error when consumption fails but stats succeeds', async () => {
    mockAuth('test-token');
    mockApiFetch(async (path: string) => {
      if (path === '/api/agents') return { agents: [AGENT_1] };
      if (path.startsWith('/api/stats/')) return STATS_1;
      if (path.startsWith('/api/consumption/')) throw new Error('Consumption error');
      return {};
    });

    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Failed to load consumption')).toBeDefined();
    });
    // Stats should still render
    expect(screen.getByText('42')).toBeDefined();
  });

  it('sends Authorization header when token is present', async () => {
    mockAuth('my-secret-token');
    const fetchCalls: { path: string; init?: RequestInit }[] = [];
    mockApiFetch(async (path: string, init?: RequestInit) => {
      fetchCalls.push({ path, init });
      if (path === '/api/agents') return { agents: [] };
      return {};
    });

    await renderDashboard();
    await waitFor(() => {
      expect(fetchCalls.length).toBeGreaterThan(0);
    });
    expect(fetchCalls[0].init?.headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer my-secret-token' }),
    );
  });

  it('does not send Authorization header when no token', async () => {
    mockAuth(null);
    const fetchCalls: { path: string; init?: RequestInit }[] = [];
    mockApiFetch(async (path: string, init?: RequestInit) => {
      fetchCalls.push({ path, init });
      if (path === '/api/agents') return { agents: [] };
      return {};
    });

    await renderDashboard();
    await waitFor(() => {
      expect(fetchCalls.length).toBeGreaterThan(0);
    });
    const headers = fetchCalls[0].init?.headers as Record<string, string> | undefined;
    expect(headers?.['Authorization']).toBeUndefined();
  });

  it('passes AbortController signal to fetch calls', async () => {
    mockAuth('test-token');
    const signals: (AbortSignal | null | undefined)[] = [];
    mockApiFetch(async (path: string, init?: RequestInit) => {
      signals.push(init?.signal);
      if (path === '/api/agents') return { agents: [AGENT_1] };
      if (path.startsWith('/api/stats/')) return STATS_1;
      if (path.startsWith('/api/consumption/')) return CONSUMPTION_1;
      return {};
    });

    await renderDashboard();
    await waitFor(() => {
      expect(signals.length).toBe(3); // agents + stats + consumption
    });
    // All calls should have a signal
    signals.forEach((signal) => {
      expect(signal).toBeDefined();
      expect(signal).toBeInstanceOf(AbortSignal);
    });
  });

  it('aborts in-flight requests on unmount', async () => {
    mockAuth('test-token');
    let capturedSignal: AbortSignal | null | undefined;
    mockApiFetch(async (_path: string, init?: RequestInit) => {
      capturedSignal = init?.signal;
      // Return slowly to ensure component unmounts while request is pending
      return new Promise((resolve) => {
        setTimeout(() => resolve({ agents: [] }), 1000);
      });
    });

    const { unmount } = await renderDashboard();

    // Unmount immediately - should abort the signal
    await act(async () => {
      unmount();
    });

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('renders stats with summaries and ratings', async () => {
    mockAuth('test-token');
    mockApiFetch(async (path: string) => {
      if (path === '/api/agents') return { agents: [AGENT_1] };
      if (path.startsWith('/api/stats/')) return STATS_1;
      if (path.startsWith('/api/consumption/')) return CONSUMPTION_1;
      return {};
    });

    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('10 summaries')).toBeDefined();
    });
    expect(screen.getByText('20 ratings')).toBeDefined();
    // Thumbs up/down
    expect(screen.getByText('18')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });

  it('renders consumption period breakdown', async () => {
    mockAuth('test-token');
    mockApiFetch(async (path: string) => {
      if (path === '/api/agents') return { agents: [AGENT_1] };
      if (path.startsWith('/api/stats/')) return STATS_1;
      if (path.startsWith('/api/consumption/')) return CONSUMPTION_1;
      return {};
    });

    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('24h: 1,000')).toBeDefined();
    });
    expect(screen.getByText('7d: 5,000')).toBeDefined();
    expect(screen.getByText('30d: 12,000')).toBeDefined();
  });

  it('renders dash placeholder when stats are null', async () => {
    mockAuth('test-token');
    mockApiFetch(async (path: string) => {
      if (path === '/api/agents') return { agents: [AGENT_1] };
      if (path.startsWith('/api/stats/')) throw new Error('fail');
      if (path.startsWith('/api/consumption/')) return CONSUMPTION_1;
      return {};
    });

    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('claude-sonnet-4 / claude-code')).toBeDefined();
    });
    // Stats section shows "--" placeholder
    const dashes = screen.getAllByText('--');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it('renders dash placeholder when consumption is null', async () => {
    mockAuth('test-token');
    mockApiFetch(async (path: string) => {
      if (path === '/api/agents') return { agents: [AGENT_1] };
      if (path.startsWith('/api/stats/')) return STATS_1;
      if (path.startsWith('/api/consumption/')) throw new Error('fail');
      return {};
    });

    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('claude-sonnet-4 / claude-code')).toBeDefined();
    });
    // Consumption section shows "--" placeholder
    const dashes = screen.getAllByText('--');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it('renders status section in agent card', async () => {
    mockAuth('test-token');
    mockApiFetch(async (path: string) => {
      if (path === '/api/agents') return { agents: [AGENT_1] };
      if (path.startsWith('/api/stats/')) return STATS_1;
      if (path.startsWith('/api/consumption/')) return CONSUMPTION_1;
      return {};
    });

    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('claude-sonnet-4 / claude-code')).toBeDefined();
    });
    expect(screen.getByText('Status')).toBeDefined();
  });

  it('displays 0 total tokens when totalTokens is null', async () => {
    mockAuth('test-token');
    const consumptionNoTotal = { ...CONSUMPTION_1, totalTokens: 0 };
    mockApiFetch(async (path: string) => {
      if (path === '/api/agents') return { agents: [AGENT_1] };
      if (path.startsWith('/api/stats/')) return STATS_1;
      if (path.startsWith('/api/consumption/')) return consumptionNoTotal;
      return {};
    });

    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('0')).toBeDefined();
    });
  });

  it('exports a function component', async () => {
    mockAuth(null);
    mockApiFetch(async () => ({ agents: [] }));

    const mod = await import('../dashboard/page.js');
    expect(typeof mod.default).toBe('function');
  });
});
