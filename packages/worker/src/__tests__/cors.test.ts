/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import {
  addCorsHeaders,
  addSecurityHeaders,
  handleCorsPreflightRequest,
} from '../handlers/cors.js';
import type { Env } from '../env.js';

const mockEnv: Env = {
  WEB_URL: 'https://opencara.dev',
} as any;

const emptyEnv: Env = {
  WEB_URL: '',
} as any;

function requestWithOrigin(origin: string): Request {
  return new Request('http://localhost/api/test', {
    headers: { Origin: origin },
  });
}

describe('addCorsHeaders', () => {
  it('adds CORS headers when request Origin matches WEB_URL', () => {
    const req = requestWithOrigin('https://opencara.dev');
    const original = new Response('OK', { status: 200 });
    const result = addCorsHeaders(req, original, mockEnv);

    expect(result.headers.get('Access-Control-Allow-Origin')).toBe('https://opencara.dev');
    expect(result.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
    expect(result.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(result.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(result.headers.get('Vary')).toBe('Origin');
  });

  it('preserves original response status', () => {
    const req = requestWithOrigin('https://opencara.dev');
    const original = new Response('Created', { status: 201 });
    const result = addCorsHeaders(req, original, mockEnv);
    expect(result.status).toBe(201);
  });

  it('preserves original response headers', () => {
    const req = requestWithOrigin('https://opencara.dev');
    const original = new Response('OK', {
      headers: { 'Content-Type': 'application/json', 'X-Custom': 'value' },
    });
    const result = addCorsHeaders(req, original, mockEnv);
    expect(result.headers.get('Content-Type')).toBe('application/json');
    expect(result.headers.get('X-Custom')).toBe('value');
  });

  it('does not add CORS headers when Origin does not match WEB_URL', () => {
    const req = requestWithOrigin('https://evil.com');
    const original = new Response('OK');
    const result = addCorsHeaders(req, original, mockEnv);
    expect(result.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('does not add CORS headers when Origin header is missing', () => {
    const req = new Request('http://localhost/api/test');
    const original = new Response('OK');
    const result = addCorsHeaders(req, original, mockEnv);
    expect(result.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('does not add CORS headers when WEB_URL is empty', () => {
    const req = requestWithOrigin('https://opencara.dev');
    const original = new Response('OK');
    const result = addCorsHeaders(req, original, emptyEnv);
    expect(result.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('handleCorsPreflightRequest', () => {
  it('returns 204 with CORS headers when Origin matches', () => {
    const req = requestWithOrigin('https://opencara.dev');
    const response = handleCorsPreflightRequest(req, mockEnv);

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://opencara.dev');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
      'Authorization, Content-Type',
    );
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it('returns empty body', async () => {
    const req = requestWithOrigin('https://opencara.dev');
    const response = handleCorsPreflightRequest(req, mockEnv);
    expect(response.body).toBeNull();
  });

  it('returns 204 without CORS headers when Origin does not match', () => {
    const req = requestWithOrigin('https://evil.com');
    const response = handleCorsPreflightRequest(req, mockEnv);

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Methods')).toBeNull();
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it('returns 204 without CORS headers when Origin is missing', () => {
    const req = new Request('http://localhost/api/test', { method: 'OPTIONS' });
    const response = handleCorsPreflightRequest(req, mockEnv);

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('Vary')).toBe('Origin');
  });
});

describe('addSecurityHeaders', () => {
  it('adds X-Content-Type-Options header', () => {
    const response = addSecurityHeaders(new Response('OK'));
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('adds X-Frame-Options header', () => {
    const response = addSecurityHeaders(new Response('OK'));
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('adds Referrer-Policy header', () => {
    const response = addSecurityHeaders(new Response('OK'));
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('preserves original response status and headers', () => {
    const original = new Response('Created', {
      status: 201,
      headers: { 'Content-Type': 'application/json', 'X-Custom': 'value' },
    });
    const result = addSecurityHeaders(original);
    expect(result.status).toBe(201);
    expect(result.headers.get('Content-Type')).toBe('application/json');
    expect(result.headers.get('X-Custom')).toBe('value');
  });
});
