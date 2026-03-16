import type { AgentStatsResponse, LeaderboardResponse, User } from '@opencrust/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** GET /api/stats/:agentId — returns agent statistics (authenticated) */
export async function handleGetStats(
  agentId: string,
  user: User,
  supabase: SupabaseClient,
): Promise<Response> {
  // Fetch agent and verify ownership
  const { data: agent, error: agentError } = await supabase
    .from('agents')
    .select('id, model, tool, reputation_score, status, user_id')
    .eq('id', agentId)
    .single();

  if (agentError || !agent) {
    return json({ error: 'Agent not found' }, 404);
  }

  if ((agent.user_id as string) !== user.id) {
    return json({ error: 'Agent not found' }, 404);
  }

  // Count total reviews
  const { count: totalReviews } = await supabase
    .from('review_results')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId)
    .eq('status', 'completed');

  // Count total summaries
  const { count: totalSummaries } = await supabase
    .from('review_summaries')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId);

  // Get all review result IDs for this agent
  const { data: resultIds } = await supabase
    .from('review_results')
    .select('id')
    .eq('agent_id', agentId);

  const ids = (resultIds ?? []).map((r: { id: string }) => r.id);

  let totalRatings = 0;
  let thumbsUp = 0;
  let thumbsDown = 0;

  if (ids.length > 0) {
    const { count: ratingsCount } = await supabase
      .from('ratings')
      .select('id', { count: 'exact', head: true })
      .in('review_result_id', ids);
    totalRatings = ratingsCount ?? 0;

    const { count: upCount } = await supabase
      .from('ratings')
      .select('id', { count: 'exact', head: true })
      .eq('emoji', 'thumbs_up')
      .in('review_result_id', ids);
    thumbsUp = upCount ?? 0;

    const { count: downCount } = await supabase
      .from('ratings')
      .select('id', { count: 'exact', head: true })
      .eq('emoji', 'thumbs_down')
      .in('review_result_id', ids);
    thumbsDown = downCount ?? 0;
  }

  // Sum tokens used
  const { data: consumptionData } = await supabase
    .from('consumption_logs')
    .select('tokens_used')
    .eq('agent_id', agentId);

  const tokensUsed = (consumptionData ?? []).reduce(
    (sum: number, log: { tokens_used: number }) => sum + log.tokens_used,
    0,
  );

  const response: AgentStatsResponse = {
    agent: {
      id: agent.id as string,
      model: agent.model as string,
      tool: agent.tool as string,
      reputationScore: agent.reputation_score as number,
      status: agent.status as 'online' | 'offline',
    },
    stats: {
      totalReviews: totalReviews ?? 0,
      totalSummaries: totalSummaries ?? 0,
      totalRatings,
      thumbsUp,
      thumbsDown,
      tokensUsed,
    },
  };

  return json(response);
}

/** GET /api/leaderboard — returns top agents by reputation (public) */
export async function handleGetLeaderboard(supabase: SupabaseClient): Promise<Response> {
  // Fetch top 50 agents sorted by reputation
  const { data: agents, error } = await supabase
    .from('agents')
    .select('id, model, tool, reputation_score, user_id, users!inner(name)')
    .order('reputation_score', { ascending: false })
    .limit(50);

  if (error) {
    return json({ error: 'Failed to fetch leaderboard' }, 500);
  }

  // TODO: Optimize with a single aggregated SQL query or Supabase RPC to avoid N+1 queries.
  // Current approach makes ~4 queries per agent (up to 200 total for 50 agents).
  // For each agent, count reviews and ratings
  const entries = [];
  for (const agent of (agents ?? []) as Record<string, unknown>[]) {
    const agentId = agent.id as string;

    const { count: totalReviews } = await supabase
      .from('review_results')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId)
      .eq('status', 'completed');

    const { data: resultIds } = await supabase
      .from('review_results')
      .select('id')
      .eq('agent_id', agentId);

    const ids = (resultIds ?? []).map((r: { id: string }) => r.id);

    let thumbsUp = 0;
    let thumbsDown = 0;

    if (ids.length > 0) {
      const { count: upCount } = await supabase
        .from('ratings')
        .select('id', { count: 'exact', head: true })
        .eq('emoji', 'thumbs_up')
        .in('review_result_id', ids);
      thumbsUp = upCount ?? 0;

      const { count: downCount } = await supabase
        .from('ratings')
        .select('id', { count: 'exact', head: true })
        .eq('emoji', 'thumbs_down')
        .in('review_result_id', ids);
      thumbsDown = downCount ?? 0;
    }

    entries.push({
      id: agentId,
      model: agent.model as string,
      tool: agent.tool as string,
      userName: (agent.users as Record<string, unknown>).name as string,
      reputationScore: agent.reputation_score as number,
      totalReviews: totalReviews ?? 0,
      thumbsUp,
      thumbsDown,
    });
  }

  return json({ agents: entries } satisfies LeaderboardResponse);
}
