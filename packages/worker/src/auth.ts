import { API_KEY_PREFIX } from '@opencara/shared';
import type { User } from '@opencara/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

const API_KEY_HEX_LENGTH = 40;
const SESSION_COOKIE_NAME = 'opencara_session';

/** Generate a new API key: "cr_" + 40 random hex chars */
export async function generateApiKey(): Promise<string> {
  const bytes = new Uint8Array(API_KEY_HEX_LENGTH / 2);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${API_KEY_PREFIX}${hex}`;
}

/** SHA-256 hash of an API key, returned as lowercase hex */
export async function hashApiKey(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Parse cookies from a Cookie header string */
export function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name && rest.length > 0) {
      cookies[name.trim()] = rest.join('=').trim();
    }
  }
  return cookies;
}

/**
 * Extract API key from Authorization header or session cookie.
 * Priority: Authorization header > opencara_session cookie.
 */
function extractApiKey(request: Request): string | null {
  // Try Authorization header first
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const key = authHeader.slice('Bearer '.length);
    if (key.startsWith(API_KEY_PREFIX)) {
      return key;
    }
  }

  // Fall back to session cookie
  const cookies = parseCookies(request.headers.get('Cookie'));
  const value = cookies[SESSION_COOKIE_NAME];
  if (value?.startsWith(API_KEY_PREFIX)) {
    return value;
  }

  return null;
}

/**
 * Validate the Authorization header (or session cookie) and return the matching user, or null.
 * Checks Authorization: Bearer header first, then opencara_session cookie.
 */
export async function authenticateRequest(
  request: Request,
  supabase: SupabaseClient,
): Promise<User | null> {
  const apiKey = extractApiKey(request);
  if (!apiKey) {
    return null;
  }

  const hash = await hashApiKey(apiKey);
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('api_key_hash', hash)
    .single();

  if (error || !data) {
    return null;
  }

  return data as User;
}
