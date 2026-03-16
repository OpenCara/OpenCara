import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Env } from './env.js';

export function createSupabaseClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

export type { SupabaseClient };
