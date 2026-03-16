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

interface CommentInfo {
  id: string;
  agentId: string;
  commentUrl: string;
  source: 'review_result' | 'review_summary';
}

/**
 * Collect ratings from GitHub reactions for all comments associated with a task.
 * Returns the number of ratings collected and per-agent rating stats.
 */
export async function collectTaskRatings(
  taskId: string,
  env: Env,
  supabase: SupabaseClient,
): Promise<{
  collected: number;
  ratings: Array<{ agentId: string; thumbsUp: number; thumbsDown: number; newScore: number }>;
}> {
  // 1. Gather all comments (review results + summaries) with URLs
  const comments = await getTaskComments(supabase, taskId);
  if (comments.length === 0) {
    return { collected: 0, ratings: [] };
  }

  // 2. Get installation token for this task's project
  const { data: taskData } = await supabase
    .from('review_tasks')
    .select('project_id, projects!inner(owner, repo, github_installation_id)')
    .eq('id', taskId)
    .single();

  if (!taskData) {
    throw new Error(`Task ${taskId} not found`);
  }

  const project = taskData.projects as unknown as {
    owner: string;
    repo: string;
    github_installation_id: number;
  };

  const token = await getInstallationToken(project.github_installation_id, env);

  // 3. For each comment, fetch reactions and upsert ratings
  let totalCollected = 0;
  const affectedAgentIds = new Set<string>();

  for (const comment of comments) {
    const commentId = extractCommentId(comment.commentUrl);
    if (commentId === null) continue;

    const reactions = await fetchCommentReactions(project.owner, project.repo, commentId, token);

    // Filter to thumbs up (+1) and thumbs down (-1) only
    const relevantReactions = reactions.filter((r) => r.content === '+1' || r.content === '-1');

    for (const reaction of relevantReactions) {
      const emoji = reaction.content === '+1' ? 'thumbs_up' : 'thumbs_down';

      const { error } = await supabase.from('ratings').upsert(
        {
          review_result_id: comment.id,
          rater_github_id: reaction.user.id,
          emoji,
        },
        { onConflict: 'review_result_id,rater_github_id,emoji' },
      );

      if (!error) {
        totalCollected++;
        affectedAgentIds.add(comment.agentId);
      }
    }
  }

  // 4. Recalculate reputation for each affected agent
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

  // 5. Recalculate user reputation for each affected user
  const affectedUserIds = new Set<string>();
  for (const agentId of affectedAgentIds) {
    const { data: agent } = await supabase
      .from('agents')
      .select('user_id')
      .eq('id', agentId)
      .single();
    if (agent) affectedUserIds.add(agent.user_id as string);
  }

  for (const userId of affectedUserIds) {
    await recalculateUserReputation(userId, supabase);
  }

  return { collected: totalCollected, ratings: agentRatings };
}

/**
 * Get all review result comments with URLs for a task.
 * Only collects from review_results (not summaries) since the ratings table
 * uses review_result_id as a foreign key to the review_results table.
 */
async function getTaskComments(supabase: SupabaseClient, taskId: string): Promise<CommentInfo[]> {
  const comments: CommentInfo[] = [];

  const { data: results } = await supabase
    .from('review_results')
    .select('id, agent_id, comment_url')
    .eq('review_task_id', taskId)
    .not('comment_url', 'is', null);

  if (results) {
    for (const r of results as Array<{ id: string; agent_id: string; comment_url: string }>) {
      comments.push({
        id: r.id,
        agentId: r.agent_id,
        commentUrl: r.comment_url,
        source: 'review_result',
      });
    }
  }

  return comments;
}

/**
 * Recalculate an agent's reputation score based on all their ratings.
 * Updates the agent's reputation_score and inserts a reputation_history entry.
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

  // Get current score for delta
  const { data: agent } = await supabase
    .from('agents')
    .select('reputation_score')
    .eq('id', agentId)
    .single();

  const oldScore = (agent?.reputation_score as number) ?? 0;
  const scoreDelta = newScore - oldScore;

  // Update agent reputation
  await supabase.from('agents').update({ reputation_score: newScore }).eq('id', agentId);

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

/**
 * Recalculate a user's reputation as the weighted average of their agents' scores.
 * Weight is proportional to the total number of ratings each agent has received.
 */
export async function recalculateUserReputation(
  userId: string,
  supabase: SupabaseClient,
): Promise<void> {
  // Get all agents for this user
  const { data: agents } = await supabase
    .from('agents')
    .select('id, reputation_score')
    .eq('user_id', userId);

  if (!agents || agents.length === 0) return;

  // Calculate weighted average
  let totalWeight = 0;
  let weightedSum = 0;

  for (const agent of agents as Array<{ id: string; reputation_score: number }>) {
    // Fetch review result IDs once per agent
    const { data: results } = await supabase
      .from('review_results')
      .select('id')
      .eq('agent_id', agent.id);

    const resultIds = (results ?? []).map((r: { id: string }) => r.id);

    let ratingCount = 0;
    if (resultIds.length > 0) {
      const { count } = await supabase
        .from('ratings')
        .select('id', { count: 'exact', head: true })
        .in('review_result_id', resultIds);
      ratingCount = count ?? 0;
    }

    const weight = Math.max(1, ratingCount); // minimum weight of 1
    totalWeight += weight;
    weightedSum += agent.reputation_score * weight;
  }

  const newScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

  // Get current score for delta
  const { data: user } = await supabase
    .from('users')
    .select('reputation_score')
    .eq('id', userId)
    .single();

  const oldScore = (user?.reputation_score as number) ?? 0;
  const scoreDelta = newScore - oldScore;

  // Update user reputation
  await supabase.from('users').update({ reputation_score: newScore }).eq('id', userId);

  // Insert reputation history entry
  if (Math.abs(scoreDelta) > 0.0001) {
    await supabase.from('reputation_history').insert({
      user_id: userId,
      score_change: scoreDelta,
      reason: `Recalculated from ${agents.length} agent(s) (weighted average: ${newScore.toFixed(4)})`,
    });
  }
}
