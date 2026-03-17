import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

async function renderLayout(children: React.ReactNode) {
  const mod = await import('../layout.js');
  return renderToString(createElement(mod.default, { children }));
}

async function getMetadata() {
  const mod = await import('../layout.js');
  return mod.metadata;
}

describe('RootLayout', () => {
  it('renders children inside html and body tags', async () => {
    const child = createElement('p', null, 'Hello World');
    const html = await renderLayout(child);
    expect(html).toContain('<html');
    expect(html).toContain('<body');
    expect(html).toContain('Hello World');
  });

  it('sets lang attribute to en', async () => {
    const child = createElement('span', null, 'test');
    const html = await renderLayout(child);
    expect(html).toContain('lang="en"');
  });

  it('exports a function component', async () => {
    const mod = await import('../layout.js');
    expect(typeof mod.default).toBe('function');
  });

  it('renders nav bar with OpenCrust brand link', async () => {
    const child = createElement('span', null, 'test');
    const html = await renderLayout(child);
    expect(html).toContain('OpenCrust');
    expect(html).toContain('href="/"');
  });

  it('renders nav link for Community', async () => {
    const child = createElement('span', null, 'test');
    const html = await renderLayout(child);
    expect(html).toContain('href="/community"');
    expect(html).toContain('Community');
  });

  it('does not render leaderboard or auth links', async () => {
    const child = createElement('span', null, 'test');
    const html = await renderLayout(child);
    expect(html).not.toContain('Leaderboard');
    expect(html).not.toContain('/leaderboard');
    expect(html).not.toContain('Login');
    expect(html).not.toContain('Logout');
    expect(html).not.toContain('Dashboard');
  });

  it('renders footer with GitHub link', async () => {
    const child = createElement('span', null, 'test');
    const html = await renderLayout(child);
    expect(html).toContain('GitHub');
    expect(html).toContain('https://github.com/yugoo-ai/OpenCrust');
  });

  it('renders footer with current year', async () => {
    const child = createElement('span', null, 'test');
    const html = await renderLayout(child);
    const year = new Date().getFullYear().toString();
    expect(html).toContain(year);
  });

  it('renders semantic HTML elements', async () => {
    const child = createElement('span', null, 'test');
    const html = await renderLayout(child);
    expect(html).toContain('<header');
    expect(html).toContain('<nav');
    expect(html).toContain('<main');
    expect(html).toContain('<footer');
  });
});

describe('metadata', () => {
  it('has correct title', async () => {
    const metadata = await getMetadata();
    expect(metadata.title).toBe('OpenCrust');
  });

  it('has correct description', async () => {
    const metadata = await getMetadata();
    expect(metadata.description).toBe('Distributed AI code review');
  });
});
