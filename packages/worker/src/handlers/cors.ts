import type { Env } from '../env.js';

const ALLOWED_HEADERS = 'Authorization, Content-Type';
const ALLOWED_METHODS = 'GET, POST, OPTIONS';

/** Security headers added to all responses */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/** Check if the request Origin matches the allowed origin (env.WEB_URL) */
function isOriginAllowed(request: Request, env: Env): boolean {
  const allowedOrigin = env.WEB_URL || '';
  if (!allowedOrigin) return false;
  const requestOrigin = request.headers.get('Origin') || '';
  return requestOrigin === allowedOrigin;
}

/** Add security headers to any response */
export function addSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Add CORS headers to a response only if the request Origin matches WEB_URL */
export function addCorsHeaders(request: Request, response: Response, env: Env): Response {
  if (!isOriginAllowed(request, env)) return response;

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', env.WEB_URL);
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

/** Handle OPTIONS preflight requests — only sets CORS headers if Origin matches */
export function handleCorsPreflightRequest(request: Request, env: Env): Response {
  if (!isOriginAllowed(request, env)) {
    return new Response(null, { status: 204 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': env.WEB_URL,
      'Access-Control-Allow-Headers': ALLOWED_HEADERS,
      'Access-Control-Allow-Methods': ALLOWED_METHODS,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    },
  });
}
