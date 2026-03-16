import type { CollectRatingsResponse, User } from '@opencrust/shared';
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
  // Verify task exists and user has access via project ownership
  const { data: task } = await supabase
    .from('review_tasks')
    .select('id, status, projects!inner(user_id)')
    .eq('id', taskId)
    .single();

  if (!task) {
    return json({ error: 'Task not found' }, 404);
  }

  const project = task.projects as unknown as { user_id: string };
  if (project.user_id !== user.id) {
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
