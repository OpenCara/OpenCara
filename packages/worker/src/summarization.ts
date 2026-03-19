import { getModelDefaultReputation } from '@opencara/shared';
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

export const MAX_SUMMARY_ATTEMPTS = 2;

/** Agent info displayed in the synthesized review header. */
export interface ReviewAgentInfo {
  model: string;
  tool: string;
  displayName?: string;
}

const VERDICT_EMOJI: Record<ReviewVerdict, string> = {
  approve: '\u2705',
  request_changes: '\u274C',
  comment: '\uD83D\uDCAC',
};

/** Escape markdown special characters to prevent injection. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|~>]/g, '\\$&');
}

/** Format a single agent as `model/tool`, prefixed with displayName if set. */
function formatAgentLabel(agent: ReviewAgentInfo): string {
  const base = `\`${agent.model}/${agent.tool}\``;
  return agent.displayName ? `${escapeMarkdown(agent.displayName)} (${base})` : base;
}

/**
 * Format the summary as the main PR comment.
 */
export function formatSummaryComment(
  summary: string,
  agents: ReviewAgentInfo[],
  synthesizerAgent: ReviewAgentInfo | null,
  contributorNames?: string[],
): string {
  const agentLabels = agents.map(formatAgentLabel);
  const synthLabel = synthesizerAgent ? formatAgentLabel(synthesizerAgent) : null;
  const agentsLine =
    agentLabels.length > 0
      ? `**Agents**: ${agentLabels.join(', ')}${synthLabel ? ` (synthesized by ${synthLabel})` : ''}`
      : synthLabel
        ? `**Agents**: ${synthLabel}`
        : '';
  const contributorsLine =
    contributorNames && contributorNames.length > 0
      ? `**Contributors**: ${contributorNames.map((n) => (n === 'Anonymous contributor' ? n : `[@${n}](https://github.com/${n})`)).join(', ')}`
      : '';
  return [
    '## \uD83D\uDD0D OpenCara Review',
    '',
    ...(agentsLine ? [agentsLine] : []),
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
 * Fetch distinct contributor names for a task's reviews (includes synthesizer).
 */
export async function fetchReviewContributors(
  supabase: SupabaseClient,
  taskId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from('review_results')
    .select('agents!inner(users!inner(name, is_anonymous))')
    .eq('review_task_id', taskId)
    .eq('status', 'completed');

  if (!data) return [];

  const names = new Set<string>();
  for (const row of data as Record<string, unknown>[]) {
    const agent = row.agents as Record<string, unknown>;
    const user = agent?.users as Record<string, unknown>;
    const isAnonymous = (user?.is_anonymous as boolean) ?? false;
    const name = user?.name as string | undefined;
    if (isAnonymous) {
      names.add('Anonymous contributor');
    } else if (name) {
      names.add(name);
    }
  }
  return [...names];
}

/**
 * Fetch agent details (model, tool) for all reviewers and the synthesizer of a task.
 */
export async function fetchReviewAgents(
  supabase: SupabaseClient,
  taskId: string,
): Promise<{ reviewers: ReviewAgentInfo[]; synthesizer: ReviewAgentInfo | null }> {
  const { data } = await supabase
    .from('review_results')
    .select('type, agents!inner(model, tool, display_name)')
    .eq('review_task_id', taskId)
    .eq('status', 'completed');

  if (!data) return { reviewers: [], synthesizer: null };

  const reviewers: ReviewAgentInfo[] = [];
  let synthesizer: ReviewAgentInfo | null = null;

  for (const row of data as Record<string, unknown>[]) {
    const agent = row.agents as Record<string, unknown>;
    const info: ReviewAgentInfo = {
      model: (agent.model as string) ?? 'unknown',
      tool: (agent.tool as string) ?? 'unknown',
      ...((agent.display_name as string | null)
        ? { displayName: agent.display_name as string }
        : {}),
    };
    if (row.type === 'summary') {
      synthesizer = info;
    } else {
      reviewers.push(info);
    }
  }

  return { reviewers, synthesizer };
}

/**
 * Fetch completed review results with their verdict and agent info for a task.
 * Note: review_text was dropped from the schema. Reviews are posted directly to GitHub
 * and the text is not stored in the DB. The review text in the message payload
 * is used for summarization before being discarded.
 */
export async function fetchCompletedReviews(
  supabase: SupabaseClient,
  taskId: string,
): Promise<SummaryReview[]> {
  const { data } = await supabase
    .from('review_results')
    .select('agent_id, verdict, agents!inner(model, tool)')
    .eq('review_task_id', taskId)
    .eq('status', 'completed')
    .eq('type', 'review');

  if (!data) return [];

  return (data as Record<string, unknown>[]).map((r) => {
    const agent = r.agents as Record<string, unknown>;
    return {
      agentId: r.agent_id as string,
      model: (agent.model as string) ?? 'unknown',
      tool: (agent.tool as string) ?? 'unknown',
      review: '', // review_text no longer stored in DB
      verdict: (r.verdict as ReviewVerdict) ?? 'comment',
    };
  });
}

/**
 * Select a summary agent: prefer online agents with higher model reputation, excluding
 * agents already involved in this review. Uses weighted random selection based on
 * model default reputation.
 */
export async function selectSummaryAgent(
  supabase: SupabaseClient,
  excludeAgentIds: string[],
): Promise<string | null> {
  // Exclude anonymous agents from synthesizer selection
  const { data } = await supabase
    .from('agents')
    .select('id, model, users!inner(is_anonymous)')
    .eq('status', 'online');

  if (!data || data.length === 0) return null;

  const candidates = (data as Record<string, unknown>[]).filter((a) => {
    const isAnon = ((a.users as Record<string, unknown>)?.is_anonymous as boolean) ?? false;
    return !isAnon && !excludeAgentIds.includes(a.id as string);
  });

  if (candidates.length === 0) return null;

  // Weighted random selection: higher-reputation models are more likely to be chosen as synthesizer
  const weighted = candidates.map((c) => {
    const model = (c.model as string) ?? '';
    const weight = Math.max(0.1, getModelDefaultReputation(model));
    return { id: c.id as string, weight };
  });

  const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
  let roll = Math.random() * totalWeight;

  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll <= 0) return entry.id;
  }

  return weighted[weighted.length - 1].id;
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
      // No uninvolved agent — reuse any online reviewer
      const { data: reviewerAgents } = await supabase
        .from('agents')
        .select('id')
        .eq('status', 'online')
        .in('id', excludeIds);

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
 * Retry summarization after a synthesizer failure. Picks a different agent
 * (excluding all reviewers and previously failed synthesizers) and re-dispatches.
 * Falls back to individual reviews after MAX_SUMMARY_ATTEMPTS.
 * Returns true if a retry was dispatched, false if fell back.
 */
export async function retrySummarization(
  env: Env,
  supabase: SupabaseClient,
  taskId: string,
  meta: InFlightTaskMeta,
  failedAgentId: string,
): Promise<boolean> {
  // Count existing summary attempts for this task
  const { count, error: countError } = await supabase
    .from('review_results')
    .select('id', { count: 'exact', head: true })
    .eq('review_task_id', taskId)
    .eq('type', 'summary');

  if (countError) {
    console.error(`Task ${taskId}: failed to count summary attempts`, countError);
    const reviews = await fetchCompletedReviews(supabase, taskId);
    await postIndividualReviewsFallback(env, supabase, taskId, meta, reviews);
    return false;
  }

  if ((count ?? 0) >= MAX_SUMMARY_ATTEMPTS) {
    console.log(
      `Task ${taskId}: max summary attempts (${MAX_SUMMARY_ATTEMPTS}) reached, falling back to individual reviews`,
    );
    const reviews = await fetchCompletedReviews(supabase, taskId);
    await postIndividualReviewsFallback(env, supabase, taskId, meta, reviews);
    return false;
  }

  // Get reviewer agent IDs to exclude from synthesizer selection
  const reviews = await fetchCompletedReviews(supabase, taskId);
  const reviewerAgentIds = reviews.map((r) => r.agentId);

  // Get all previous synthesizer IDs to exclude (any status — avoid re-assigning)
  const { data: previousSummaries, error: summaryError } = await supabase
    .from('review_results')
    .select('agent_id')
    .eq('review_task_id', taskId)
    .eq('type', 'summary');

  if (summaryError) {
    console.error(`Task ${taskId}: failed to fetch previous summaries`, summaryError);
    await postIndividualReviewsFallback(env, supabase, taskId, meta, reviews);
    return false;
  }

  const previousSynthIds = (previousSummaries ?? []).map((r: { agent_id: string }) => r.agent_id);
  const excludeIds = [...new Set([...reviewerAgentIds, ...previousSynthIds, failedAgentId])];

  // Select a new synthesizer agent
  const newSynthId = await selectSummaryAgent(supabase, excludeIds);

  if (!newSynthId) {
    console.log(
      `Task ${taskId}: no alternative synthesizer available, falling back to individual reviews`,
    );
    await postIndividualReviewsFallback(env, supabase, taskId, meta, reviews);
    return false;
  }

  console.log(
    `Task ${taskId}: retrying summarization with agent ${newSynthId} (failed: ${failedAgentId})`,
  );
  return await dispatchSummaryToAgent(env, supabase, taskId, meta, reviews, newSynthId);
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
  // Store summary agent in review_results with type='summary' (pending until summary_complete)
  const { error: insertError } = await supabase.from('review_results').insert({
    review_task_id: taskId,
    agent_id: summaryAgentId,
    status: 'pending',
    type: 'summary',
  });
  if (insertError) {
    console.error(`Failed to insert summary result for task ${taskId}:`, insertError);
    await postIndividualReviewsFallback(env, supabase, taskId, meta, reviews);
    return false;
  }

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
