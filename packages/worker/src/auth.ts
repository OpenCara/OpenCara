import { API_KEY_PREFIX } from '@opencrust/shared';
import type { User } from '@opencrust/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

const API_KEY_HEX_LENGTH = 40;

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

/**
 * Validate the Authorization header and return the matching user, or null.
 * Expected format: "Bearer cr_<40 hex chars>"
 */
export async function authenticateRequest(
  request: Request,
  supabase: SupabaseClient,
): Promise<User | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  const apiKey = authHeader.slice('Bearer '.length);
  if (!apiKey.startsWith(API_KEY_PREFIX)) {
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
