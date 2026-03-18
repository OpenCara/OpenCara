import type { CollectRatingsResponse, User } from '@opencara/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../env.js';
import { collectTaskRatings } from '../reputation.js';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** POST /api/tasks/:taskId/collect-ratings — triggers rating collection for a task */
export async function handleCollectRatings(
  taskId: string,
  user: User,
  env: Env,
  supabase: SupabaseClient,
): Promise<Response> {
  // Verify task exists — ownership check is now based on the review results'
  // agent ownership rather than project ownership (projects table was dropped)
  const { data: task } = await supabase
    .from('review_tasks')
    .select('id, status')
    .eq('id', taskId)
    .single();

  if (!task) {
    return json({ error: 'Task not found' }, 404);
  }

  // Check that at least one review result for this task belongs to the user's agents
  const { data: userAgents } = await supabase.from('agents').select('id').eq('user_id', user.id);

  const agentIds = (userAgents ?? []).map((a: { id: string }) => a.id);
  if (agentIds.length === 0) {
    return json({ error: 'Task not found' }, 404);
  }

  const { count: resultCount } = await supabase
    .from('review_results')
    .select('id', { count: 'exact', head: true })
    .eq('review_task_id', taskId)
    .in('agent_id', agentIds);

  if ((resultCount ?? 0) === 0) {
    return json({ error: 'Task not found' }, 404);
  }

  try {
    const result = await collectTaskRatings(taskId, env, supabase);
    return json(result satisfies CollectRatingsResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return json({ error: `Failed to collect ratings: ${message}` }, 500);
  }
}
