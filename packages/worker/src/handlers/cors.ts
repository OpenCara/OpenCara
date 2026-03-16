import type { Env } from '../env.js';

const ALLOWED_HEADERS = 'Authorization, Content-Type';
const ALLOWED_METHODS = 'GET, POST, OPTIONS';

/** Add CORS headers to a response based on the WEB_URL env var */
export function addCorsHeaders(response: Response, env: Env): Response {
  const origin = env.WEB_URL || '';
  if (!origin) return response;

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.append('Vary', 'Origin');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Handle OPTIONS preflight requests */
export function handleCorsPreflightRequest(env: Env): Response {
  const origin = env.WEB_URL || '';
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': ALLOWED_HEADERS,
      'Access-Control-Allow-Methods': ALLOWED_METHODS,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    },
  });
}
