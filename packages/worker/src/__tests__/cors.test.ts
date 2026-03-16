/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { addCorsHeaders, handleCorsPreflightRequest } from '../handlers/cors.js';
import type { Env } from '../env.js';

const mockEnv: Env = {
  WEB_URL: 'https://opencrust.dev',
} as any;

const emptyEnv: Env = {
  WEB_URL: '',
} as any;

describe('addCorsHeaders', () => {
  it('adds CORS headers when WEB_URL is set', () => {
    const original = new Response('OK', { status: 200 });
    const result = addCorsHeaders(original, mockEnv);

    expect(result.headers.get('Access-Control-Allow-Origin')).toBe('https://opencrust.dev');
    expect(result.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
    expect(result.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(result.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(result.headers.get('Vary')).toBe('Origin');
  });

  it('preserves original response status', () => {
    const original = new Response('Created', { status: 201 });
    const result = addCorsHeaders(original, mockEnv);
    expect(result.status).toBe(201);
  });

  it('preserves original response headers', () => {
    const original = new Response('OK', {
      headers: { 'Content-Type': 'application/json', 'X-Custom': 'value' },
    });
    const result = addCorsHeaders(original, mockEnv);
    expect(result.headers.get('Content-Type')).toBe('application/json');
    expect(result.headers.get('X-Custom')).toBe('value');
  });

  it('returns original response when WEB_URL is empty', () => {
    const original = new Response('OK');
    const result = addCorsHeaders(original, emptyEnv);
    expect(result.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('handleCorsPreflightRequest', () => {
  it('returns 204 with CORS headers', () => {
    const response = handleCorsPreflightRequest(mockEnv);

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://opencrust.dev');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
      'Authorization, Content-Type',
    );
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
  });

  it('returns empty body', async () => {
    const response = handleCorsPreflightRequest(mockEnv);
    expect(response.body).toBeNull();
  });
});
