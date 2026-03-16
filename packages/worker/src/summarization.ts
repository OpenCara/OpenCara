import type { SummaryReview, ReviewVerdict } from '@opencrust/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from './env.js';
import { getInstallationToken, postPrComment } from './github.js';

export interface InFlightTaskMeta {
  minCount: number;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  prompt: string;
}

const VERDICT_EMOJI: Record<ReviewVerdict, string> = {
  approve: '\u2705',
  request_changes: '\u274C',
  comment: '\uD83D\uDCAC',
};

/**
 * Format the summary as the main PR comment.
 */
export function formatSummaryComment(summary: string, reviewCount: number): string {
  return [
    '## \uD83D\uDD0D OpenCrust Review Summary',
    '',
    `**Reviews**: ${reviewCount} agent${reviewCount !== 1 ? 's' : ''} reviewed this PR`,
    '',
    '---',
    '',
    summary,
    '',
    '---',
    '<sub>Summarized by <a href="https://github.com/apps/opencrust">OpenCrust</a> | React with \uD83D\uDC4D or \uD83D\uDC4E to rate</sub>',
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

  // Select summary agent (not involved in the review)
  const excludeIds = reviews.map((r) => r.agentId);
  const summaryAgentId = await selectSummaryAgent(supabase, excludeIds);

  if (!summaryAgentId) {
    // Fallback: post individual reviews
    console.log(
      `No summary agent available for task ${taskId}, falling back to individual reviews`,
    );
    await postIndividualReviewsFallback(env, supabase, taskId, meta, reviews);
    return false;
  }

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
 * Fallback: post each individual review as a standalone PR comment.
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
      await postPrComment(meta.owner, meta.repo, meta.prNumber, body, token);
    }

    // Transition task to completed
    await supabase.from('review_tasks').update({ status: 'completed' }).eq('id', taskId);

    console.log(`Posted ${reviews.length} individual reviews for task ${taskId} (fallback)`);
  } catch (err) {
    console.error(`Failed to post individual reviews for task ${taskId}:`, err);
  }
}
