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

  it('renders nav bar with OpenCrust brand link', () => {
    const child = createElement('span', null, 'test');
    const html = renderToString(createElement(RootLayout, { children: child }));
    expect(html).toContain('OpenCrust');
    expect(html).toContain('href="/"');
  });

  it('renders nav links for Leaderboard and Dashboard', () => {
    const child = createElement('span', null, 'test');
    const html = renderToString(createElement(RootLayout, { children: child }));
    expect(html).toContain('href="/leaderboard"');
    expect(html).toContain('Leaderboard');
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain('Dashboard');
  });

  it('renders Login button', () => {
    const child = createElement('span', null, 'test');
    const html = renderToString(createElement(RootLayout, { children: child }));
    expect(html).toContain('Login');
  });

  it('renders footer with GitHub link', () => {
    const child = createElement('span', null, 'test');
    const html = renderToString(createElement(RootLayout, { children: child }));
    expect(html).toContain('GitHub');
    expect(html).toContain('https://github.com/yugoo-ai/OpenCrust');
  });

  it('renders footer with current year', () => {
    const child = createElement('span', null, 'test');
    const html = renderToString(createElement(RootLayout, { children: child }));
    const year = new Date().getFullYear().toString();
    expect(html).toContain(year);
  });

  it('renders semantic HTML elements', () => {
    const child = createElement('span', null, 'test');
    const html = renderToString(createElement(RootLayout, { children: child }));
    expect(html).toContain('<header');
    expect(html).toContain('<nav');
    expect(html).toContain('<main');
    expect(html).toContain('<footer');
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
