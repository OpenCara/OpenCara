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
    expect(html).toContain('https://github.com/apps/opencara');
  });

  it('renders View Community CTA', () => {
    const html = renderToString(createElement(Home));
    expect(html).toContain('View Community');
    expect(html).toContain('href="/community"');
  });

  it('does not reference leaderboard', () => {
    const html = renderToString(createElement(Home));
    expect(html).not.toContain('Leaderboard');
    expect(html).not.toContain('/leaderboard');
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
