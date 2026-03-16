import type { ConsumptionStatsResponse, User } from '@opencrust/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** GET /api/consumption/:agentId — aggregated consumption stats for an agent */
export async function handleGetConsumption(
  agentId: string,
  user: User,
  supabase: SupabaseClient,
): Promise<Response> {
  // 1. Verify agent belongs to user
  const { data: agent } = await supabase
    .from('agents')
    .select('id')
    .eq('id', agentId)
    .eq('user_id', user.id)
    .single();

  if (!agent) {
    return json({ error: 'Agent not found' }, 404);
  }

  // 2. Query all consumption_logs for this agent
  const { data: logs } = await supabase
    .from('consumption_logs')
    .select('tokens_used, review_task_id, created_at')
    .eq('agent_id', agentId);

  const entries = (logs ?? []) as Array<{
    tokens_used: number;
    review_task_id: string;
    created_at: string;
  }>;

  // 3. Compute aggregations
  const now = Date.now();
  const MS_24H = 24 * 60 * 60 * 1000;
  const MS_7D = 7 * MS_24H;
  const MS_30D = 30 * MS_24H;

  let totalTokens = 0;
  const allTaskIds = new Set<string>();
  const period24h = { tokens: 0, taskIds: new Set<string>() };
  const period7d = { tokens: 0, taskIds: new Set<string>() };
  const period30d = { tokens: 0, taskIds: new Set<string>() };

  for (const entry of entries) {
    const age = now - new Date(entry.created_at).getTime();

    totalTokens += entry.tokens_used;
    allTaskIds.add(entry.review_task_id);

    if (age <= MS_30D) {
      period30d.tokens += entry.tokens_used;
      period30d.taskIds.add(entry.review_task_id);
    }
    if (age <= MS_7D) {
      period7d.tokens += entry.tokens_used;
      period7d.taskIds.add(entry.review_task_id);
    }
    if (age <= MS_24H) {
      period24h.tokens += entry.tokens_used;
      period24h.taskIds.add(entry.review_task_id);
    }
  }

  return json({
    agentId,
    totalTokens,
    totalReviews: allTaskIds.size,
    period: {
      last24h: { tokens: period24h.tokens, reviews: period24h.taskIds.size },
      last7d: { tokens: period7d.tokens, reviews: period7d.taskIds.size },
      last30d: { tokens: period30d.tokens, reviews: period30d.taskIds.size },
    },
  } satisfies ConsumptionStatsResponse);
}
