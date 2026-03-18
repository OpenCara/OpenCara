// consumption_logs table was dropped in migration 005.
// This handler is kept as a stub returning 410 Gone for backward compatibility.

import type { User } from '@opencara/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** GET /api/consumption/:agentId — consumption_logs table was dropped */
export async function handleGetConsumption(
  _agentId: string,
  _user: User,
  _supabase: SupabaseClient,
): Promise<Response> {
  return json(
    {
      error:
        'Consumption tracking has been removed. Token counts are self-reported and not stored.',
    },
    410,
  );
}
