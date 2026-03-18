import type { RepoConfig, ReviewConfig } from '@opencara/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Env } from './env.js';

export interface EligibleAgent {
  id: string;
  userId: string;
  userName: string;
  model: string;
  tool: string;
  repoConfig: RepoConfig | null;
}

export interface DistributeTaskParams {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
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
  _minReputation: number,
): Promise<EligibleAgent[]> {
  const { data, error } = await supabase
    .from('agents')
    .select('id, user_id, model, tool, repo_config, users!inner(name)')
    .eq('status', 'online')
    .order('created_at', { ascending: true });

  if (error || !data) {
    console.error('Failed to query eligible agents:', error);
    return [];
  }

  return (data as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    userName: ((row.users as Record<string, unknown>)?.name as string) ?? '',
    model: row.model as string,
    tool: row.tool as string,
    repoConfig: (row.repo_config as RepoConfig | null) ?? null,
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

/** Filter agents by their repo preferences against the target repo. */
export function filterByRepoConfig(
  agents: EligibleAgent[],
  targetOwner: string,
  targetRepo: string,
): EligibleAgent[] {
  return agents.filter((agent) => {
    if (!agent.repoConfig) return true; // null = accept all
    const fullRepo = `${targetOwner}/${targetRepo}`;
    switch (agent.repoConfig.mode) {
      case 'all':
        return true;
      case 'own':
        return agent.userName === targetOwner;
      case 'whitelist':
        return (agent.repoConfig.list ?? []).includes(fullRepo);
      case 'blacklist':
        return !(agent.repoConfig.list ?? []).includes(fullRepo);
      default:
        console.warn(
          `Agent ${agent.id} has unknown repoConfig mode: ${String(agent.repoConfig.mode)}`,
        );
        return true;
    }
  });
}

/** Validate that a value is a valid RepoConfig structure. */
export function isValidRepoConfig(value: unknown): value is RepoConfig {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  const validModes = ['all', 'own', 'whitelist', 'blacklist'];
  if (typeof obj.mode !== 'string' || !validModes.includes(obj.mode)) return false;
  if ('list' in obj && obj.list !== undefined) {
    if (!Array.isArray(obj.list)) return false;
    if (!obj.list.every((item: unknown) => typeof item === 'string')) return false;
  }
  return true;
}

export const MAX_AGENTS_PER_TASK = 10;

/**
 * Compute a weight for weighted random selection.
 * With reputation_score removed from agents table, all agents get equal weight.
 * This can be enhanced later with computed reputation from reputation_history.
 */
export function agentWeight(_reputationScore?: number): number {
  return 1;
}

/**
 * Weighted reservoir sampling: select `count` items from `agents`.
 * Currently uses equal weights since reputation_score was removed from agents table.
 * Accepts an optional `rng` function (returns [0,1)) for deterministic testing.
 */
export function weightedRandomSelect(
  agents: EligibleAgent[],
  count: number,
  rng: () => number = Math.random,
): EligibleAgent[] {
  if (agents.length <= count) return [...agents];

  const keyed = agents.map((agent) => ({
    agent,
    key: Math.pow(rng(), 1 / agentWeight()),
  }));

  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, count).map((k) => k.agent);
}

/**
 * Select up to `reviewCount` agents for a review.
 * Priority: preferred models > preferred tools > others.
 * Within each tier, uses weighted random selection.
 * Returns empty only if no agents are available at all.
 *
 * Accepts an optional `rng` function for deterministic testing.
 */
export function selectAgents(
  agents: EligibleAgent[],
  reviewCount: number,
  preferredModels: string[],
  preferredTools: string[],
  rng: () => number = Math.random,
): EligibleAgent[] {
  if (agents.length === 0) return [];

  const count = Math.min(reviewCount, agents.length);

  const hasModelPref = preferredModels.length > 0;
  const hasToolPref = preferredTools.length > 0;

  if (!hasModelPref && !hasToolPref) {
    return weightedRandomSelect(agents, count, rng);
  }

  const modelMatch = hasModelPref ? agents.filter((a) => preferredModels.includes(a.model)) : [];
  const modelMatchIds = new Set(modelMatch.map((a) => a.id));

  const toolMatch = hasToolPref
    ? agents.filter((a) => preferredTools.includes(a.tool) && !modelMatchIds.has(a.id))
    : [];
  const matchedIds = new Set([...modelMatchIds, ...toolMatch.map((a) => a.id)]);

  const others = agents.filter((a) => !matchedIds.has(a.id));

  // Fill from each tier in priority order using weighted random
  const selected: EligibleAgent[] = [];

  for (const tier of [modelMatch, toolMatch, others]) {
    if (selected.length >= count) break;
    const needed = count - selected.length;
    selected.push(...weightedRandomSelect(tier, needed, rng));
  }

  return selected;
}

/** Maximum in-flight tasks before an agent is considered overloaded. */
export const MAX_IN_FLIGHT_THRESHOLD = 2;

/**
 * Query each agent's Durable Object for in-flight task count.
 * Partition agents into low-load (< MAX_IN_FLIGHT_THRESHOLD) and overflow pools.
 * If a DO query fails, the agent is placed in the low-load pool (fail-open).
 */
export async function partitionByLoad(
  env: Env,
  agents: EligibleAgent[],
): Promise<{ lowLoad: EligibleAgent[]; overflow: EligibleAgent[] }> {
  if (agents.length === 0) return { lowLoad: [], overflow: [] };

  const results = await Promise.allSettled(
    agents.map(async (agent) => {
      const doId = env.AGENT_CONNECTION.idFromName(agent.id);
      const stub = env.AGENT_CONNECTION.get(doId);
      const resp = await stub.fetch(new Request('https://internal/status'));
      const status = (await resp.json()) as { inFlightTaskIds?: string[] };
      return { agent, inFlight: status.inFlightTaskIds?.length ?? 0 };
    }),
  );

  const lowLoad: EligibleAgent[] = [];
  const overflow: EligibleAgent[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      if (result.value.inFlight >= MAX_IN_FLIGHT_THRESHOLD) {
        overflow.push(result.value.agent);
      } else {
        lowLoad.push(result.value.agent);
      }
    } else {
      // Fail-open: if we can't query status, assume low load
      lowLoad.push(agents[i]);
    }
  }

  return { lowLoad, overflow };
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
  const { installationId, config, owner, repo, prNumber, diffUrl, baseRef, headRef, diffContent } =
    params;
  const timeoutMs = parseTimeoutMs(config.timeout);
  const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;

  // 1. Create review_task with inlined project fields
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
      github_installation_id: installationId,
      owner,
      repo,
      pr_number: prNumber,
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

  // 2. Set up task timeout BEFORE agent selection (pending tasks also need expiry)
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

  // 3. Find eligible agents and partition by in-flight load
  const allAgents = await findEligibleAgents(supabase, config.agents.minReputation);
  const accessFiltered = filterByAccessList(
    allAgents,
    config.reviewer.whitelist,
    config.reviewer.blacklist,
  );
  const filtered = filterByRepoConfig(accessFiltered, owner, repo);

  // Query each candidate's DO for in-flight task count; partition into low-load / overflow
  const { lowLoad, overflow } = await partitionByLoad(env, filtered);
  // For multi-agent: select reviewCount + 1 so we can reserve one as synthesizer
  const selectionCount =
    config.agents.reviewCount > 1 ? config.agents.reviewCount + 1 : config.agents.reviewCount;

  // Prefer low-load agents; fall back to overflow only if not enough
  let selected = selectAgents(
    lowLoad,
    selectionCount,
    config.agents.preferredModels,
    config.agents.preferredTools,
  );
  if (selected.length < selectionCount && overflow.length > 0) {
    const remaining = selectionCount - selected.length;
    const overflowSelected = selectAgents(
      overflow,
      remaining,
      config.agents.preferredModels,
      config.agents.preferredTools,
    );
    selected = [...selected, ...overflowSelected];
  }

  if (selected.length === 0) {
    console.log(`No eligible agents found for task ${taskId} — stays pending for pickup`);
    // Task stays in "pending" status. The timeout alarm will handle expiry.
    return taskId;
  }

  // 4. For multi-agent reviews: reserve an agent as synthesizer FIRST,
  //    then distribute review_request only to the remaining agents.
  let reviewers = selected;
  let synthesizerAgentId: string | undefined;

  if (config.agents.reviewCount > 1 && selected.length > config.agents.reviewCount) {
    // Only reserve a synthesizer when we have MORE agents than the requested reviewer count.
    // Pick the first agent as synthesizer (all have equal weight now).
    const synthesizer = selected[0];
    synthesizerAgentId = synthesizer.id;
    reviewers = selected.slice(1);

    console.log(
      `Task ${taskId}: reserved agent ${synthesizerAgentId} as synthesizer, ` +
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

  // 5. Update task status to reviewing before distributing (avoid race with timeout alarm)
  await supabase.from('review_tasks').update({ status: 'reviewing' }).eq('id', taskId);

  // 6. Push task to each reviewer's DO (NOT the synthesizer)
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
