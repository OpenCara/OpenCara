import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import RootLayout, { metadata } from '../layout.js';

describe('RootLayout', () => {
  it('renders children inside html and body tags', () => {
    const child = createElement('p', null, 'Hello World');
    const html = renderToString(createElement(RootLayout, { children: child }));
    expect(html).toContain('<html');
    expect(html).toContain('<body');
    expect(html).toContain('Hello World');
  });

  it('sets lang attribute to en', () => {
    const child = createElement('span', null, 'test');
    const html = renderToString(createElement(RootLayout, { children: child }));
    expect(html).toContain('lang="en"');
  });

  it('exports a function component', () => {
    expect(typeof RootLayout).toBe('function');
  });
});

describe('metadata', () => {
  it('has correct title', () => {
    expect(metadata.title).toBe('OpenCrust');
  });

  it('has correct description', () => {
    expect(metadata.description).toBe('Distributed AI code review');
  });
});
