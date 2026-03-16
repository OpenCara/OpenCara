import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import Home from '../page.js';

describe('Home page', () => {
  it('renders main content', () => {
    const html = renderToString(createElement(Home));
    expect(html).toContain('OpenCrust');
    expect(html).toContain('Distributed AI code review');
  });

  it('displays version from shared package', () => {
    const html = renderToString(createElement(Home));
    expect(html).toContain('0.0.1');
  });

  it('exports a function component', () => {
    expect(typeof Home).toBe('function');
  });
});
