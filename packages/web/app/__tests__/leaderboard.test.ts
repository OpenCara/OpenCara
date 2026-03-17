import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

const mockLeaderboardData = {
  agents: [
    {
      id: 'agent-1',
      model: 'claude-sonnet-4',
      tool: 'claude-code',
      userName: 'alice',
      trustTier: {
        tier: 'trusted',
        label: 'Trusted',
        reviewCount: 42,
        positiveRate: 0.9,
        nextTier: 'expert',
        progressToNext: 0.8,
      },
      totalReviews: 42,
      thumbsUp: 38,
      thumbsDown: 4,
    },
    {
      id: 'agent-2',
      model: 'gpt-4o',
      tool: 'copilot',
      userName: 'bob',
      trustTier: {
        tier: 'newcomer',
        label: 'Newcomer',
        reviewCount: 15,
        positiveRate: 0.73,
        nextTier: 'trusted',
        progressToNext: 0.5,
      },
      totalReviews: 15,
      thumbsUp: 11,
      thumbsDown: 4,
    },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

async function renderLeaderboard() {
  const mod = await import('../leaderboard/page.js');
  const Component = mod.default;
  const element = await Component();
  return renderToString(createElement(() => element));
}

describe('Leaderboard page', () => {
  it('renders leaderboard heading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockLeaderboardData),
      }),
    );
    const html = await renderLeaderboard();
    expect(html).toContain('Leaderboard');
  });

  it('renders table with agent data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockLeaderboardData),
      }),
    );
    const html = await renderLeaderboard();
    expect(html).toContain('claude-sonnet-4');
    expect(html).toContain('claude-code');
    expect(html).toContain('alice');
    expect(html).toContain('Trusted');
    expect(html).toContain('42');
    expect(html).toContain('gpt-4o');
    expect(html).toContain('bob');
  });

  it('renders correct column headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockLeaderboardData),
      }),
    );
    const html = await renderLeaderboard();
    expect(html).toContain('Agent');
    expect(html).toContain('Contributor');
    expect(html).toContain('Tier');
    expect(html).toContain('Reviews');
    expect(html).toContain('Ratings');
  });

  it('renders rank numbers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockLeaderboardData),
      }),
    );
    const html = await renderLeaderboard();
    // Check rank column header exists
    expect(html).toContain('#');
  });

  it('renders thumbs up and thumbs down counts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockLeaderboardData),
      }),
    );
    const html = await renderLeaderboard();
    expect(html).toContain('38');
    expect(html).toContain('4');
    expect(html).toContain('11');
  });

  it('renders empty state when no agents', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: [] }),
      }),
    );
    const html = await renderLeaderboard();
    expect(html).toContain('No agents ranked yet');
    expect(html).not.toContain('<table');
  });

  it('renders error state on API failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );
    const html = await renderLeaderboard();
    expect(html).toContain('Unable to load leaderboard');
    expect(html).not.toContain('<table');
  });

  it('renders error state on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const html = await renderLeaderboard();
    expect(html).toContain('Unable to load leaderboard');
  });

  it('renders trust tier label', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            agents: [
              {
                id: 'a1',
                model: 'test',
                tool: 'tool',
                userName: 'user',
                trustTier: {
                  tier: 'expert',
                  label: 'Expert',
                  reviewCount: 100,
                  positiveRate: 0.95,
                  nextTier: null,
                  progressToNext: 1,
                },
                totalReviews: 100,
                thumbsUp: 95,
                thumbsDown: 5,
              },
            ],
          }),
      }),
    );
    const html = await renderLeaderboard();
    expect(html).toContain('Expert');
  });
});
