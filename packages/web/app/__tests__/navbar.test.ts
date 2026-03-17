import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

async function renderNavBar() {
  const mod = await import('../components/NavBar.js');
  return renderToString(createElement(mod.default));
}

describe('NavBar', () => {
  it('renders OpenCrust brand link', async () => {
    const html = await renderNavBar();
    expect(html).toContain('OpenCrust');
    expect(html).toContain('href="/"');
  });

  it('renders Community link', async () => {
    const html = await renderNavBar();
    expect(html).toContain('Community');
    expect(html).toContain('href="/community"');
  });

  it('renders GitHub link', async () => {
    const html = await renderNavBar();
    expect(html).toContain('GitHub');
    expect(html).toContain('https://github.com/yugoo-ai/OpenCrust');
  });

  it('does not render Leaderboard link', async () => {
    const html = await renderNavBar();
    expect(html).not.toContain('Leaderboard');
    expect(html).not.toContain('/leaderboard');
  });

  it('does not render auth links', async () => {
    const html = await renderNavBar();
    expect(html).not.toContain('Login');
    expect(html).not.toContain('Logout');
    expect(html).not.toContain('Dashboard');
  });

  it('renders semantic header and nav elements', async () => {
    const html = await renderNavBar();
    expect(html).toContain('<header');
    expect(html).toContain('<nav');
  });

  it('GitHub link opens in new tab', async () => {
    const html = await renderNavBar();
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('exports a function component', async () => {
    const mod = await import('../components/NavBar.js');
    expect(typeof mod.default).toBe('function');
  });
});
