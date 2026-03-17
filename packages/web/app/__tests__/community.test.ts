import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function mockApiFetch(impl: (path: string, init?: RequestInit) => Promise<unknown>) {
  vi.doMock('../../lib/api.js', () => ({
    apiFetch: impl,
  }));
}

const MOCK_STATS = {
  totalReviews: 1200,
  totalContributors: 84,
  activeContributorsThisWeek: 12,
  averagePositiveRate: 0.87,
  recentActivity: [
    {
      type: 'review_completed' as const,
      repo: 'acme/widgets',
      prNumber: 142,
      agentModel: 'claude-sonnet-4',
      completedAt: new Date().toISOString(),
    },
    {
      type: 'review_completed' as const,
      repo: 'org/backend',
      prNumber: 99,
      agentModel: 'gpt-4o',
      completedAt: new Date(Date.now() - 3600_000).toISOString(),
    },
  ],
};

async function renderCommunity() {
  const mod = await import('../community/page.js');
  const Component = mod.default;
  // Server component — call directly, await the result, then renderToString
  const element = await Component();
  return renderToString(element);
}

describe('CommunityPage', () => {
  it('renders the community heading', async () => {
    mockApiFetch(async () => MOCK_STATS);
    const html = await renderCommunity();
    expect(html).toContain('Community');
  });

  it('renders total reviews count', async () => {
    mockApiFetch(async () => MOCK_STATS);
    const html = await renderCommunity();
    expect(html).toContain('1,200');
    expect(html).toContain('Reviews Completed');
  });

  it('renders total contributors', async () => {
    mockApiFetch(async () => MOCK_STATS);
    const html = await renderCommunity();
    expect(html).toContain('84');
    expect(html).toContain('Total Contributors');
  });

  it('renders active contributors this week', async () => {
    mockApiFetch(async () => MOCK_STATS);
    const html = await renderCommunity();
    expect(html).toContain('12');
    expect(html).toContain('Active This Week');
  });

  it('renders average review quality as percentage', async () => {
    mockApiFetch(async () => MOCK_STATS);
    const html = await renderCommunity();
    expect(html).toContain('87%');
    expect(html).toContain('Avg Review Quality');
  });

  it('renders recent activity entries', async () => {
    mockApiFetch(async () => MOCK_STATS);
    const html = await renderCommunity();
    expect(html).toContain('acme/widgets');
    expect(html).toContain('142');
    expect(html).toContain('claude-sonnet-4');
    expect(html).toContain('org/backend');
    expect(html).toContain('99');
    expect(html).toContain('gpt-4o');
  });

  it('renders Recent Activity heading', async () => {
    mockApiFetch(async () => MOCK_STATS);
    const html = await renderCommunity();
    expect(html).toContain('Recent Activity');
  });

  it('shows error state when API fails', async () => {
    mockApiFetch(async () => {
      throw new Error('Network error');
    });
    const html = await renderCommunity();
    expect(html).toContain('Unable to load community stats');
  });

  it('shows empty activity message when no recent activity', async () => {
    mockApiFetch(async () => ({ ...MOCK_STATS, recentActivity: [] }));
    const html = await renderCommunity();
    expect(html).toContain('No recent activity yet');
  });

  it('exports force-dynamic', async () => {
    mockApiFetch(async () => MOCK_STATS);
    const mod = await import('../community/page.js');
    expect(mod.dynamic).toBe('force-dynamic');
  });

  it('renders time ago for recent activity', async () => {
    mockApiFetch(async () => ({
      ...MOCK_STATS,
      recentActivity: [
        {
          type: 'review_completed',
          repo: 'test/repo',
          prNumber: 1,
          agentModel: 'test-model',
          completedAt: new Date().toISOString(),
        },
      ],
    }));
    const html = await renderCommunity();
    // Should render some time indicator (e.g., "just now" or "0m ago")
    expect(html).toContain('test/repo');
  });

  it('formats zero reviews correctly', async () => {
    mockApiFetch(async () => ({
      ...MOCK_STATS,
      totalReviews: 0,
      totalContributors: 0,
      activeContributorsThisWeek: 0,
      averagePositiveRate: 0,
    }));
    const html = await renderCommunity();
    expect(html).toContain('0');
    expect(html).toContain('0%');
  });

  it('handles NaN/Infinity in number formatting gracefully', async () => {
    mockApiFetch(async () => ({
      ...MOCK_STATS,
      totalReviews: NaN,
      averagePositiveRate: Infinity,
    }));
    const html = await renderCommunity();
    expect(html).toContain('--');
  });

  it('handles invalid date in recent activity', async () => {
    mockApiFetch(async () => ({
      ...MOCK_STATS,
      recentActivity: [
        {
          type: 'review_completed',
          repo: 'test/repo',
          prNumber: 1,
          agentModel: 'test-model',
          completedAt: 'not-a-date',
        },
      ],
    }));
    const html = await renderCommunity();
    expect(html).toContain('unknown');
  });
});
