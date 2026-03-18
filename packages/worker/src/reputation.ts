import { computeRaterHash } from '@opencara/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from './env.js';
import { extractCommentId, fetchCommentReactions, getInstallationToken } from './github.js';

/**
 * Calculate the lower bound of a Wilson confidence interval.
 * This provides a reputation score that naturally accounts for sample size:
 * agents with few ratings get lower scores, preventing gaming.
 *
 * @param positive Number of positive ratings (thumbs up)
 * @param total Total number of ratings
 * @param confidence Confidence level (default 0.95, z = 1.96)
 * @returns Score between 0 and 1
 */
export function calculateWilsonScore(
  positive: number,
  total: number,
  confidence: number = 0.95,
): number {
  if (total === 0) return 0;

  // z-score for the given confidence level
  // For 0.95 confidence: z = 1.96, for 0.99: z = 2.576
  const zMap: Record<number, number> = { 0.95: 1.96, 0.99: 2.576, 0.9: 1.645 };
  const z = zMap[confidence] ?? 1.96;

  const p = positive / total;
  const n = total;
  const z2 = z * z;

  const numerator = p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  const denominator = 1 + z2 / n;

  return Math.max(0, numerator / denominator);
}

/**
 * Collect ratings from GitHub reactions for all review results associated with a task.
 * Returns the number of ratings collected and per-agent rating stats.
 *
 * Note: comment_url was dropped from the schema. The worker-dev follow-up issue
 * will need to determine how to fetch the correct comment ID for each review result
 * (e.g., via GitHub API search or by storing a comment ID reference differently).
 * For now, this function is a no-op placeholder that returns empty results.
 */
export async function collectTaskRatings(
  taskId: string,
  env: Env,
  supabase: SupabaseClient,
): Promise<{
  collected: number;
  ratings: Array<{ agentId: string; thumbsUp: number; thumbsDown: number; newScore: number }>;
}> {
  // Get installation token for this task
  const { data: taskData } = await supabase
    .from('review_tasks')
    .select('github_installation_id, owner, repo, config_json')
    .eq('id', taskId)
    .single();

  if (!taskData) {
    throw new Error(`Task ${taskId} not found`);
  }

  const taskOwner = taskData.owner as string;
  const taskRepo = taskData.repo as string;
  const taskInstallationId = taskData.github_installation_id as number;

  const token = await getInstallationToken(taskInstallationId, env);

  // Get all review results for this task
  // Note: comment_url was dropped. The review result IDs are used to look up
  // associated GitHub comments via the config_json or GitHub API.
  const { data: results } = await supabase
    .from('review_results')
    .select('id, agent_id')
    .eq('review_task_id', taskId)
    .eq('status', 'completed');

  if (!results || results.length === 0) {
    return { collected: 0, ratings: [] };
  }

  // For each result, attempt to find the comment via GitHub API
  let totalCollected = 0;
  const affectedAgentIds = new Set<string>();

  for (const result of results as Array<{ id: string; agent_id: string }>) {
    // Try to find the comment ID from config_json or task metadata
    // This is a simplified implementation — the worker-dev follow-up will refine this
    const configJson = (taskData as Record<string, unknown>).config_json as Record<
      string,
      unknown
    > | null;
    const commentUrl = configJson?.commentUrl as string | undefined;
    if (!commentUrl) continue;

    const commentId = extractCommentId(commentUrl);
    if (commentId === null) continue;

    const reactions = await fetchCommentReactions(taskOwner, taskRepo, commentId, token);

    // Filter to thumbs up (+1) and thumbs down (-1) only
    const relevantReactions = reactions.filter((r) => r.content === '+1' || r.content === '-1');

    for (const reaction of relevantReactions) {
      const emoji = reaction.content === '+1' ? 'thumbs_up' : 'thumbs_down';
      const raterHash = await computeRaterHash(result.id, reaction.user.id);

      const { error } = await supabase.from('ratings').upsert(
        {
          review_result_id: result.id,
          rater_hash: raterHash,
          emoji,
        },
        { onConflict: 'review_result_id,rater_hash' },
      );

      if (!error) {
        totalCollected++;
        affectedAgentIds.add(result.agent_id);
      }
    }
  }

  // Recalculate reputation for each affected agent
  const agentRatings: Array<{
    agentId: string;
    thumbsUp: number;
    thumbsDown: number;
    newScore: number;
  }> = [];

  for (const agentId of affectedAgentIds) {
    const stats = await recalculateAgentReputation(agentId, supabase);
    agentRatings.push({ agentId, ...stats });
  }

  return { collected: totalCollected, ratings: agentRatings };
}

/**
 * Recalculate an agent's reputation score based on all their ratings.
 * Inserts a reputation_history entry (reputation_score column was dropped from agents).
 */
export async function recalculateAgentReputation(
  agentId: string,
  supabase: SupabaseClient,
): Promise<{ thumbsUp: number; thumbsDown: number; newScore: number }> {
  // Fetch review result IDs once and reuse for both counts
  const { data: results } = await supabase
    .from('review_results')
    .select('id')
    .eq('agent_id', agentId);

  const resultIds = (results ?? []).map((r: { id: string }) => r.id);

  // Early return if no review results exist
  if (resultIds.length === 0) {
    return { thumbsUp: 0, thumbsDown: 0, newScore: 0 };
  }

  // Count thumbs up across all review results for this agent
  const { count: thumbsUp } = await supabase
    .from('ratings')
    .select('id', { count: 'exact', head: true })
    .eq('emoji', 'thumbs_up')
    .in('review_result_id', resultIds);

  const { count: thumbsDown } = await supabase
    .from('ratings')
    .select('id', { count: 'exact', head: true })
    .eq('emoji', 'thumbs_down')
    .in('review_result_id', resultIds);

  const up = thumbsUp ?? 0;
  const down = thumbsDown ?? 0;
  const total = up + down;
  const newScore = calculateWilsonScore(up, total);

  // Compute running total from history as "old score"
  const { data: allHistory } = await supabase
    .from('reputation_history')
    .select('score_change')
    .eq('agent_id', agentId);

  const oldScore = (allHistory ?? []).reduce(
    (sum: number, h: { score_change: number }) => sum + h.score_change,
    0,
  );
  const scoreDelta = newScore - oldScore;

  // Insert reputation history entry
  if (Math.abs(scoreDelta) > 0.0001) {
    await supabase.from('reputation_history').insert({
      agent_id: agentId,
      score_change: scoreDelta,
      reason: `Rating update: ${up} thumbs up, ${down} thumbs down (Wilson score: ${newScore.toFixed(4)})`,
    });
  }

  return { thumbsUp: up, thumbsDown: down, newScore };
}
