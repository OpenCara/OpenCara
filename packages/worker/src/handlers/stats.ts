import type {
  AgentStatsResponse,
  ProjectStatsResponse,
  ProjectActivityEntry,
  TrustTier,
  TrustTierInfo,
  User,
} from '@opencara/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TIER_THRESHOLDS = {
  trusted: { reviews: 5, positiveRate: 0.6 },
  expert: { reviews: 20, positiveRate: 0.8 },
};

/** Calculate the trust tier for an agent based on review count and positive rate */
export function calculateTrustTier(
  totalReviews: number,
  thumbsUp: number,
  thumbsDown: number,
): TrustTierInfo {
  const totalRatings = thumbsUp + thumbsDown;
  const positiveRate = totalRatings > 0 ? thumbsUp / totalRatings : 0;

  let tier: TrustTier = 'newcomer';
  if (
    totalReviews >= TIER_THRESHOLDS.expert.reviews &&
    positiveRate >= TIER_THRESHOLDS.expert.positiveRate
  ) {
    tier = 'expert';
  } else if (
    totalReviews >= TIER_THRESHOLDS.trusted.reviews &&
    positiveRate >= TIER_THRESHOLDS.trusted.positiveRate
  ) {
    tier = 'trusted';
  }

  const labels: Record<TrustTier, string> = {
    newcomer: 'Newcomer',
    trusted: 'Trusted',
    expert: 'Expert',
  };

  let nextTier: TrustTier | null;
  let progressToNext: number;

  if (tier === 'expert') {
    nextTier = null;
    progressToNext = 1;
  } else if (tier === 'trusted') {
    nextTier = 'expert';
    const reviewProgress = Math.min(totalReviews / TIER_THRESHOLDS.expert.reviews, 1);
    const rateProgress = Math.min(positiveRate / TIER_THRESHOLDS.expert.positiveRate, 1);
    progressToNext = (reviewProgress + rateProgress) / 2;
  } else {
    nextTier = 'trusted';
    const reviewProgress = Math.min(totalReviews / TIER_THRESHOLDS.trusted.reviews, 1);
    const rateProgress =
      totalRatings > 0 ? Math.min(positiveRate / TIER_THRESHOLDS.trusted.positiveRate, 1) : 0;
    progressToNext = (reviewProgress + rateProgress) / 2;
  }

  return {
    tier,
    label: labels[tier],
    reviewCount: totalReviews,
    positiveRate,
    nextTier,
    progressToNext,
  };
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
    .select('id, model, tool, status, user_id')
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

  const trustTier = calculateTrustTier(totalReviews ?? 0, thumbsUp, thumbsDown);

  const response: AgentStatsResponse = {
    agent: {
      id: agent.id as string,
      model: agent.model as string,
      tool: agent.tool as string,
      status: agent.status as 'online' | 'offline',
      trustTier,
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

/** GET /api/projects/stats — returns aggregate project statistics (public) */
export async function handleGetProjectStats(supabase: SupabaseClient): Promise<Response> {
  // Total completed reviews
  const { count: totalReviews } = await supabase
    .from('review_results')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'completed');

  // Count distinct contributor users (users who have at least one agent)
  const { data: contributorData } = await supabase.from('agents').select('user_id');

  const uniqueUserIds = new Set((contributorData ?? []).map((a: { user_id: string }) => a.user_id));
  const totalContributors = uniqueUserIds.size;

  // Active contributors this week (users whose agents completed reviews in last 7 days)
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentResults } = await supabase
    .from('review_results')
    .select('agent_id, agents!inner(user_id)')
    .eq('status', 'completed')
    .gte('completed_at', oneWeekAgo);

  const activeUserIds = new Set(
    (recentResults ?? []).map(
      (r: Record<string, unknown>) => (r.agents as Record<string, unknown>).user_id as string,
    ),
  );
  const activeContributorsThisWeek = activeUserIds.size;

  // Average positive rate across all agents
  const { data: allRatings } = await supabase.from('ratings').select('emoji');

  let averagePositiveRate = 0;
  if (allRatings && allRatings.length > 0) {
    const totalUp = allRatings.filter((r: { emoji: string }) => r.emoji === 'thumbs_up').length;
    averagePositiveRate = totalUp / allRatings.length;
  }

  // Last 10 completed reviews with repo + PR info
  const { data: recentReviews } = await supabase
    .from('review_results')
    .select(
      'completed_at, agents!inner(model), review_tasks!inner(pr_number, projects!inner(repo_full_name))',
    )
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(10);

  const recentActivity: ProjectActivityEntry[] = (recentReviews ?? []).map(
    (r: Record<string, unknown>) => {
      const agents = r.agents as Record<string, unknown>;
      const tasks = r.review_tasks as Record<string, unknown>;
      const projects = tasks.projects as Record<string, unknown>;
      return {
        type: 'review_completed' as const,
        repo: projects.repo_full_name as string,
        prNumber: tasks.pr_number as number,
        agentModel: agents.model as string,
        completedAt: r.completed_at as string,
      };
    },
  );

  const response: ProjectStatsResponse = {
    totalReviews: totalReviews ?? 0,
    totalContributors,
    activeContributorsThisWeek,
    averagePositiveRate,
    recentActivity,
  };

  return json(response);
}
