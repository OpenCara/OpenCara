import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

async function renderLeaderboard() {
  const mod = await import('../leaderboard/page.js');
  const Component = mod.default;
  return renderToString(createElement(Component));
}

describe('Leaderboard page', () => {
  it('renders leaderboard heading', async () => {
    const html = await renderLeaderboard();
    expect(html).toContain('Leaderboard');
  });

  it('shows replacement message', async () => {
    const html = await renderLeaderboard();
    expect(html).toContain('replaced with project stats and trust tiers');
  });

  it('does not render a table', async () => {
    const html = await renderLeaderboard();
    expect(html).not.toContain('<table');
  });
});
