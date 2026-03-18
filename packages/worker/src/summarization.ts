import type { SummaryReview, ReviewVerdict } from '@opencara/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from './env.js';
import { getInstallationToken, fetchPrDiff, postPrReview, verdictToReviewEvent } from './github.js';

export interface InFlightTaskMeta {
  reviewCount: number;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  prompt: string;
  /** Pre-selected synthesizer agent ID (multi-agent mode). */
  synthesizerAgentId?: string;
}

const VERDICT_EMOJI: Record<ReviewVerdict, string> = {
  approve: '\u2705',
  request_changes: '\u274C',
  comment: '\uD83D\uDCAC',
};

/**
 * Format the summary as the main PR comment.
 */
export function formatSummaryComment(
  summary: string,
  reviewCount: number,
  contributorNames?: string[],
): string {
  const contributorsLine =
    contributorNames && contributorNames.length > 0
      ? `**Contributors**: ${contributorNames.map((n) => `[@${n}](https://github.com/${n})`).join(', ')}`
      : '';
  return [
    '## \uD83D\uDD0D OpenCara Review',
    '',
    `**Synthesized from ${reviewCount + 1} agent${reviewCount !== 0 ? 's' : ''}**`,
    ...(contributorsLine ? [contributorsLine] : []),
    '',
    '---',
    '',
    summary,
    '',
    '---',
    '<sub>Reviewed by <a href="https://github.com/apps/opencara">OpenCara</a> | React with \uD83D\uDC4D or \uD83D\uDC4E to rate this review</sub>',
  ].join('\n');
}

/**
 * Format an individual review as a follow-up comment.
 */
export function formatIndividualReviewComment(
  model: string,
  tool: string,
  verdict: ReviewVerdict,
  review: string,
): string {
  const emoji = VERDICT_EMOJI[verdict];
  return [
    `### Agent: \`${model}\` / \`${tool}\``,
    `**Verdict**: ${emoji} ${verdict}`,
    '',
    review,
  ].join('\n');
}

/**
 * Fetch distinct contributor names for a task's reviews.
 */
export async function fetchReviewContributors(
  supabase: SupabaseClient,
  taskId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from('review_results')
    .select('agents!inner(users!inner(name))')
    .eq('review_task_id', taskId)
    .eq('status', 'completed');

  if (!data) return [];

  const names = new Set<string>();
  for (const row of data as Record<string, unknown>[]) {
    const agent = row.agents as Record<string, unknown>;
    const user = agent?.users as Record<string, unknown>;
    const name = user?.name as string | undefined;
    if (name) names.add(name);
  }
  return [...names];
}

/**
 * Fetch completed review results with their text, verdict, and agent info for a task.
 */
export async function fetchCompletedReviews(
  supabase: SupabaseClient,
  taskId: string,
): Promise<SummaryReview[]> {
  const { data } = await supabase
    .from('review_results')
    .select('agent_id, review_text, verdict, agents!inner(model, tool)')
    .eq('review_task_id', taskId)
    .eq('status', 'completed');

  if (!data) return [];

  return (data as Record<string, unknown>[])
    .filter((r) => r.review_text)
    .map((r) => {
      const agent = r.agents as Record<string, unknown>;
      return {
        agentId: r.agent_id as string,
        model: (agent.model as string) ?? 'unknown',
        tool: (agent.tool as string) ?? 'unknown',
        review: r.review_text as string,
        verdict: (r.verdict as ReviewVerdict) ?? 'comment',
      };
    });
}

/**
 * Select a summary agent: highest-reputation online agent not involved in this review.
 */
export async function selectSummaryAgent(
  supabase: SupabaseClient,
  excludeAgentIds: string[],
): Promise<string | null> {
  const { data } = await supabase
    .from('agents')
    .select('id')
    .eq('status', 'online')
    .gte('reputation_score', 0)
    .order('reputation_score', { ascending: false });

  if (!data) return null;

  const candidate = (data as { id: string }[]).find((a) => !excludeAgentIds.includes(a.id));
  return candidate?.id ?? null;
}

/**
 * Push a summary request to a summary agent's DO.
 */
export async function pushSummaryToAgent(
  env: Env,
  summaryAgentId: string,
  taskId: string,
  pr: { url: string; number: number },
  project: { owner: string; repo: string; prompt: string },
  reviews: SummaryReview[],
  timeoutSeconds: number,
  diffContent: string,
): Promise<void> {
  const doId = env.AGENT_CONNECTION.idFromName(summaryAgentId);
  const stub = env.AGENT_CONNECTION.get(doId);

  const message = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    type: 'summary_request' as const,
    taskId,
    pr,
    project,
    reviews,
    timeout: timeoutSeconds,
    diffContent,
  };

  await stub.fetch(
    new Request('https://internal/push-summary', {
      method: 'POST',
      body: JSON.stringify(message),
    }),
  );
}

/**
 * Trigger summarization for a task. Called from both handleReviewComplete and TaskTimeout.alarm().
 * Returns true if summary was dispatched, false if fell back to individual reviews.
 */
export async function triggerSummarization(
  env: Env,
  supabase: SupabaseClient,
  taskId: string,
  meta: InFlightTaskMeta,
): Promise<boolean> {
  // Fetch completed reviews
  const reviews = await fetchCompletedReviews(supabase, taskId);

  if (reviews.length === 0) {
    console.error(`No completed reviews found for task ${taskId} during summarization`);
    return false;
  }

  // Use the pre-selected synthesizer if available (new flow: reserved at distribution time)
  let summaryAgentId = meta.synthesizerAgentId ?? null;

  if (summaryAgentId) {
    // Verify the pre-selected synthesizer is still online
    const { data: synthAgent } = await supabase
      .from('agents')
      .select('id')
      .eq('id', summaryAgentId)
      .eq('status', 'online')
      .single();

    if (!synthAgent) {
      console.log(
        `Pre-selected synthesizer ${summaryAgentId} for task ${taskId} is offline, finding replacement`,
      );
      summaryAgentId = null;
    }
  }

  // Fallback: find any online agent (prefer uninvolved, then fall back to a reviewer)
  if (!summaryAgentId) {
    const excludeIds = reviews.map((r) => r.agentId);
    summaryAgentId = await selectSummaryAgent(supabase, excludeIds);

    if (!summaryAgentId) {
      // No uninvolved agent — reuse the highest-rep reviewer
      const { data: reviewerAgents } = await supabase
        .from('agents')
        .select('id')
        .eq('status', 'online')
        .in('id', excludeIds)
        .order('reputation_score', { ascending: false });

      summaryAgentId = (reviewerAgents?.[0]?.id as string) ?? null;
    }
  }

  if (!summaryAgentId) {
    // Last resort: all agents offline — post individual reviews
    console.log(
      `No summary agent available for task ${taskId}, falling back to individual reviews`,
    );
    await postIndividualReviewsFallback(env, supabase, taskId, meta, reviews);
    return false;
  }

  console.log(`Task ${taskId}: dispatching summary to synthesizer ${summaryAgentId}`);
  return await dispatchSummaryToAgent(env, supabase, taskId, meta, reviews, summaryAgentId);
}

/**
 * Dispatch summary to a specific agent. Shared by both the normal path
 * (uninvolved agent) and the fallback path (reusing a reviewer).
 */
async function dispatchSummaryToAgent(
  env: Env,
  supabase: SupabaseClient,
  taskId: string,
  meta: InFlightTaskMeta,
  reviews: SummaryReview[],
  summaryAgentId: string,
): Promise<boolean> {
  // Store summary agent in review_summaries
  await supabase.from('review_summaries').insert({
    review_task_id: taskId,
    agent_id: summaryAgentId,
  });

  // Calculate remaining timeout
  const { data: taskData } = await supabase
    .from('review_tasks')
    .select('timeout_at')
    .eq('id', taskId)
    .single();

  const timeoutAt = taskData?.timeout_at
    ? new Date(taskData.timeout_at as string).getTime()
    : Date.now() + 300_000;
  const remainingSeconds = Math.max(60, Math.floor((timeoutAt - Date.now()) / 1000));

  // Fetch diff from GitHub for synthesizer
  let diffContent = '';
  try {
    const token = await getInstallationToken(meta.installationId, env);
    diffContent = await fetchPrDiff(meta.owner, meta.repo, meta.prNumber, token);
  } catch {
    // Diff fetch failed — synthesizer will work without diff
  }

  try {
    await pushSummaryToAgent(
      env,
      summaryAgentId,
      taskId,
      {
        url: `https://github.com/${meta.owner}/${meta.repo}/pull/${meta.prNumber}`,
        number: meta.prNumber,
      },
      { owner: meta.owner, repo: meta.repo, prompt: meta.prompt },
      reviews,
      remainingSeconds,
      diffContent,
    );
    console.log(`Summary for task ${taskId} dispatched to agent ${summaryAgentId}`);
    return true;
  } catch (err) {
    console.error(`Failed to dispatch summary for task ${taskId}:`, err);
    // Fallback: post individual reviews
    await postIndividualReviewsFallback(env, supabase, taskId, meta, reviews);
    return false;
  }
}

/**
 * Fallback: post each individual review as a standalone PR review.
 */
export async function postIndividualReviewsFallback(
  env: Env,
  supabase: SupabaseClient,
  taskId: string,
  meta: InFlightTaskMeta,
  reviews: SummaryReview[],
): Promise<void> {
  try {
    const token = await getInstallationToken(meta.installationId, env);

    for (const review of reviews) {
      const body = formatIndividualReviewComment(
        review.model,
        review.tool,
        review.verdict,
        review.review,
      );
      await postPrReview(
        meta.owner,
        meta.repo,
        meta.prNumber,
        body,
        verdictToReviewEvent(review.verdict),
        token,
      );
    }

    // Transition task to completed
    await supabase.from('review_tasks').update({ status: 'completed' }).eq('id', taskId);

    console.log(`Posted ${reviews.length} individual reviews for task ${taskId} (fallback)`);
  } catch (err) {
    console.error(`Failed to post individual reviews for task ${taskId}:`, err);
  }
}
