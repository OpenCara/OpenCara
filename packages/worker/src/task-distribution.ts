import type { ReviewConfig } from '@opencara/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from './env.js';

export interface EligibleAgent {
  id: string;
  userId: string;
  userName: string;
  model: string;
  tool: string;
  reputationScore: number;
}

export interface DistributeTaskParams {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  diffUrl: string;
  baseRef: string;
  headRef: string;
  config: ReviewConfig;
  diffContent: string;
}

/** Parse timeout string (e.g., "10m") to milliseconds. */
export function parseTimeoutMs(timeout: string): number {
  const match = timeout.match(/^(\d+)m$/);
  if (!match) return 10 * 60 * 1000;
  return parseInt(match[1], 10) * 60 * 1000;
}

/** Query eligible online agents from Supabase. */
export async function findEligibleAgents(
  supabase: SupabaseClient,
  minReputation: number,
): Promise<EligibleAgent[]> {
  const { data, error } = await supabase
    .from('agents')
    .select('id, user_id, model, tool, reputation_score, users!inner(name)')
    .eq('status', 'online')
    .gte('reputation_score', minReputation)
    .order('created_at', { ascending: true });

  if (error || !data) {
    console.error('Failed to query eligible agents:', error);
    return [];
  }

  return (data as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    userName: (row.users as Record<string, unknown>).name as string,
    model: row.model as string,
    tool: row.tool as string,
    reputationScore: row.reputation_score as number,
  }));
}

/** Filter agents by whitelist/blacklist from review config. */
export function filterByAccessList(
  agents: EligibleAgent[],
  whitelist: Array<{ user?: string; agent?: string }>,
  blacklist: Array<{ user?: string; agent?: string }>,
): EligibleAgent[] {
  let filtered = agents;

  if (whitelist.length > 0) {
    filtered = filtered.filter((agent) =>
      whitelist.some(
        (entry) =>
          (entry.user && entry.user === agent.userName) ||
          (entry.agent && entry.agent === agent.id),
      ),
    );
  }

  if (blacklist.length > 0) {
    filtered = filtered.filter(
      (agent) =>
        !blacklist.some(
          (entry) =>
            (entry.user && entry.user === agent.userName) ||
            (entry.agent && entry.agent === agent.id),
        ),
    );
  }

  return filtered;
}

export const MAX_AGENTS_PER_TASK = 10;

/**
 * Select up to `reviewCount` agents for a review.
 * Priority: preferred models > preferred tools > others, sorted by reputation within each group.
 * Returns empty only if no agents are available at all.
 */
export function selectAgents(
  agents: EligibleAgent[],
  reviewCount: number,
  preferredModels: string[],
  preferredTools: string[],
): EligibleAgent[] {
  if (agents.length === 0) return [];

  const count = Math.min(reviewCount, agents.length);
  const byReputation = (a: EligibleAgent, b: EligibleAgent) =>
    b.reputationScore - a.reputationScore;

  const hasModelPref = preferredModels.length > 0;
  const hasToolPref = preferredTools.length > 0;

  if (!hasModelPref && !hasToolPref) {
    return [...agents].sort(byReputation).slice(0, count);
  }

  const modelMatch = hasModelPref
    ? agents.filter((a) => preferredModels.includes(a.model)).sort(byReputation)
    : [];
  const modelMatchIds = new Set(modelMatch.map((a) => a.id));

  const toolMatch = hasToolPref
    ? agents
        .filter((a) => preferredTools.includes(a.tool) && !modelMatchIds.has(a.id))
        .sort(byReputation)
    : [];
  const matchedIds = new Set([...modelMatchIds, ...toolMatch.map((a) => a.id)]);

  const others = agents.filter((a) => !matchedIds.has(a.id)).sort(byReputation);

  return [...modelMatch, ...toolMatch, ...others].slice(0, count);
}

/**
 * Find or create a project record for the given repository.
 */
async function findOrCreateProject(
  supabase: SupabaseClient,
  installationId: number,
  owner: string,
  repo: string,
): Promise<string | null> {
  const { data: existing } = await supabase
    .from('projects')
    .select('id')
    .eq('owner', owner)
    .eq('repo', repo)
    .single();

  if (existing) return existing.id as string;

  const { data: created, error } = await supabase
    .from('projects')
    .insert({ github_installation_id: installationId, owner, repo })
    .select('id')
    .single();

  if (error || !created) {
    console.error('Failed to create project:', error);
    return null;
  }

  return created.id as string;
}

/**
 * Distribute a review task to eligible agents.
 * Creates the task, finds agents, pushes to DOs, sets timeout.
 * Returns the created task ID or null on failure.
 */
export async function distributeTask(
  env: Env,
  supabase: SupabaseClient,
  params: DistributeTaskParams,
): Promise<string | null> {
  const {
    installationId,
    config,
    owner,
    repo,
    prNumber,
    prUrl,
    diffUrl,
    baseRef,
    headRef,
    diffContent,
  } = params;
  const timeoutMs = parseTimeoutMs(config.timeout);

  // 1. Find or create project
  const projectId = await findOrCreateProject(supabase, installationId, owner, repo);
  if (!projectId) return null;

  // 2. Create review_task with config_json for pending pickup (diff fetched on demand)
  const configJson = {
    prompt: config.prompt,
    reviewCount: config.agents.reviewCount,
    timeout: config.timeout,
    diffUrl,
    baseRef,
    headRef,
    installationId,
  };

  const { data: task, error: taskError } = await supabase
    .from('review_tasks')
    .insert({
      project_id: projectId,
      pr_number: prNumber,
      pr_url: prUrl,
      status: 'pending',
      timeout_at: new Date(Date.now() + timeoutMs).toISOString(),
      config_json: configJson,
    })
    .select('id')
    .single();

  if (taskError || !task) {
    console.error('Failed to create review_task:', taskError);
    return null;
  }

  const taskId = task.id as string;

  // 3. Set up task timeout BEFORE agent selection (pending tasks also need expiry)
  try {
    const timeoutDoId = env.TASK_TIMEOUT.idFromName(taskId);
    const timeoutStub = env.TASK_TIMEOUT.get(timeoutDoId);
    await timeoutStub.fetch(
      new Request('https://internal/set-timeout', {
        method: 'POST',
        body: JSON.stringify({
          taskId,
          timeoutMs,
          reviewCount: config.agents.reviewCount,
          installationId,
          owner,
          repo,
          prNumber,
          prompt: config.prompt,
        }),
      }),
    );
  } catch (err) {
    console.error(`Failed to set task timeout for ${taskId}:`, err);
  }

  // 4. Find eligible agents
  const allAgents = await findEligibleAgents(supabase, config.agents.minReputation);
  const filtered = filterByAccessList(
    allAgents,
    config.reviewer.whitelist,
    config.reviewer.blacklist,
  );
  // For multi-agent: select reviewCount + 1 so we can reserve one as synthesizer
  const selectionCount =
    config.agents.reviewCount > 1 ? config.agents.reviewCount + 1 : config.agents.reviewCount;
  const selected = selectAgents(
    filtered,
    selectionCount,
    config.agents.preferredModels,
    config.agents.preferredTools,
  );

  if (selected.length === 0) {
    console.log(`No eligible agents found for task ${taskId} — stays pending for pickup`);
    // Task stays in "pending" status. The timeout alarm will handle expiry.
    return taskId;
  }

  // 5. For multi-agent reviews: reserve the highest-rep agent as synthesizer FIRST,
  //    then distribute review_request only to the remaining agents.
  let reviewers = selected;
  let synthesizerAgentId: string | undefined;

  if (config.agents.reviewCount > 1 && selected.length > config.agents.reviewCount) {
    // Only reserve a synthesizer when we have MORE agents than the requested reviewer count.
    // If selected.length == reviewCount, all agents become reviewers (no synthesizer).
    const sorted = [...selected].sort((a, b) => b.reputationScore - a.reputationScore);
    const synthesizer = sorted[0];
    synthesizerAgentId = synthesizer.id;
    reviewers = sorted.slice(1);

    console.log(
      `Task ${taskId}: reserved agent ${synthesizerAgentId} (rep: ${synthesizer.reputationScore}) as synthesizer, ` +
        `${reviewers.length} reviewer(s)`,
    );

    // Store synthesizer in config_json for later retrieval
    await supabase
      .from('review_tasks')
      .update({
        config_json: { ...configJson, synthesizerAgentId },
      })
      .eq('id', taskId);
  }

  // 6. Update task status to reviewing before distributing (avoid race with timeout alarm)
  await supabase.from('review_tasks').update({ status: 'reviewing' }).eq('id', taskId);

  // 7. Push task to each reviewer's DO (NOT the synthesizer)
  const remainingSeconds = Math.floor(timeoutMs / 1000);
  for (const agent of reviewers) {
    try {
      const doId = env.AGENT_CONNECTION.idFromName(agent.id);
      const stub = env.AGENT_CONNECTION.get(doId);
      await stub.fetch(
        new Request('https://internal/push-task', {
          method: 'POST',
          body: JSON.stringify({
            taskId,
            pr: {
              url: prUrl,
              number: prNumber,
              diffUrl,
              base: baseRef,
              head: headRef,
            },
            project: { owner, repo, prompt: config.prompt },
            timeout: remainingSeconds,
            diffContent,
            // reviewCount is the number of REVIEWERS (excluding synthesizer)
            reviewCount: reviewers.length,
            installationId,
            reviewMode: reviewers.length > 1 ? 'compact' : 'full',
            synthesizerAgentId,
          }),
        }),
      );
    } catch (err) {
      console.error(`Failed to push task to agent ${agent.id}:`, err);
    }
  }

  console.log(
    `Task ${taskId} distributed to ${reviewers.length} reviewer(s)` +
      (synthesizerAgentId ? ` + 1 synthesizer` : ''),
  );
  return taskId;
}
