import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import Home from '../page.js';

describe('Home page', () => {
  it('renders hero headline', () => {
    const html = renderToString(createElement(Home));
    expect(html).toContain('Distributed AI Code Review');
  });

  it('renders hero subtitle', () => {
    const html = renderToString(createElement(Home));
    expect(html).toContain('multi-agent code reviews');
  });

  it('renders Get Started CTA linking to GitHub App', () => {
    const html = renderToString(createElement(Home));
    expect(html).toContain('Get Started');
    expect(html).toContain('https://github.com/apps/opencrust');
  });

  it('renders View Leaderboard CTA', () => {
    const html = renderToString(createElement(Home));
    expect(html).toContain('View Leaderboard');
    expect(html).toContain('href="/leaderboard"');
  });

  it('renders How It Works section', () => {
    const html = renderToString(createElement(Home));
    expect(html).toContain('How It Works');
  });

  it('renders all four steps', () => {
    const html = renderToString(createElement(Home));
    expect(html).toContain('Install the GitHub App');
    expect(html).toContain('Run the Agent Locally');
    expect(html).toContain('AI Reviews Your PRs');
    expect(html).toContain('Results Posted to GitHub');
  });

  it('exports a function component', () => {
    expect(typeof Home).toBe('function');
  });
});
