import type {
  BatchPollAgent,
  BatchPollRequest,
  BatchPollResponse,
  PollTask,
  RepoConfig,
  TaskRole,
} from '@opencara/shared';
import { isRepoAllowed } from '@opencara/shared';
import type { ApiClient } from './http.js';
import type { LocalAgentConfig } from './config.js';
import { computeRoles } from './commands/agent.js';

// ── Repo Access Check ───────────────────────────────────────────

export interface RepoAccessResult {
  repo: string; // "owner/repo"
  accessible: boolean;
}

/**
 * Check GitHub API access for a single repo.
 * Returns true if the agent's token can access the repo (200), false otherwise (404/403).
 */
export async function checkRepoAccess(
  repo: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Verify access to all repos in a list.
 * Returns arrays of accessible and inaccessible repos.
 */
export async function verifyRepoAccess(
  repos: string[],
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ accessible: string[]; inaccessible: string[] }> {
  const results = await Promise.all(
    repos.map(async (repo) => ({
      repo,
      accessible: await checkRepoAccess(repo, token, fetchFn),
    })),
  );
  const accessible = results.filter((r) => r.accessible).map((r) => r.repo);
  const inaccessible = results.filter((r) => !r.accessible).map((r) => r.repo);
  return { accessible, inaccessible };
}

/**
 * Extract unique repo URLs from all agent configs' repo_filters.
 * Only whitelist repos have explicit repo URLs; other modes don't have a fixed list
 * we can verify upfront.
 */
export function extractRepoUrls(agents: LocalAgentConfig[]): string[] {
  const repos = new Set<string>();
  for (const agent of agents) {
    if (agent.repos?.list) {
      for (const repo of agent.repos.list) repos.add(repo);
    }
    if (agent.synthesize_repos?.list) {
      for (const repo of agent.synthesize_repos.list) repos.add(repo);
    }
  }
  return [...repos];
}

// ── Batch Poll Coordinator ──────────────────────────────────────

export interface AgentDescriptor {
  /** Config-level agent name (label) */
  name: string;
  /** Unique agent_id for claim operations (UUID) */
  agentId: string;
  /** Roles this agent is willing to take */
  roles: TaskRole[];
  model: string;
  tool: string;
  thinking?: string;
  repoConfig?: RepoConfig;
  synthesizeRepos?: RepoConfig;
  agentOwner?: string;
  userOrgs?: ReadonlySet<string>;
}

/**
 * Build a BatchPollRequest from agent descriptors.
 * Each descriptor maps to one BatchPollAgent entry.
 */
export function buildBatchPollRequest(agents: AgentDescriptor[]): BatchPollRequest {
  const batchAgents: BatchPollAgent[] = agents.map((a) => {
    const entry: BatchPollAgent = {
      agent_name: a.name,
      roles: a.roles,
    };
    if (a.model) entry.model = a.model;
    if (a.tool) entry.tool = a.tool;
    if (a.thinking) entry.thinking = a.thinking;

    // Build repo_filters array from repos + synthesize_repos configs
    const filters: RepoConfig[] = [];
    if (a.repoConfig) filters.push(a.repoConfig);
    if (a.synthesizeRepos) filters.push(a.synthesizeRepos);
    if (filters.length > 0) entry.repo_filters = filters;

    return entry;
  });

  return { agents: batchAgents };
}

export interface BatchPollResult {
  /** Tasks keyed by agent name */
  assignments: Map<string, PollTask[]>;
}

/**
 * Execute a single batch poll request.
 * Returns tasks grouped by agent name.
 */
export async function batchPoll(
  client: ApiClient,
  agents: AgentDescriptor[],
): Promise<BatchPollResult> {
  const request = buildBatchPollRequest(agents);
  const response = await client.post<BatchPollResponse>('/api/tasks/poll/batch', request);

  const assignments = new Map<string, PollTask[]>();
  for (const [agentName, pollResponse] of Object.entries(response.assignments)) {
    assignments.set(agentName, pollResponse.tasks);
  }
  return { assignments };
}

/**
 * Filter tasks for a specific agent using its repo config and diff size limit.
 * Mirrors the per-agent filtering in the existing pollLoop.
 */
export function filterTasksForAgent(
  tasks: PollTask[],
  agent: AgentDescriptor,
  maxDiffSizeKb?: number,
  diffFailCounts?: Map<string, number>,
  maxDiffFetchAttempts: number = 3,
): PollTask[] {
  return tasks.filter((t) => {
    // Filter by repo config
    if (
      agent.repoConfig &&
      !isRepoAllowed(agent.repoConfig, t.owner, t.repo, agent.agentOwner, agent.userOrgs)
    ) {
      return false;
    }
    // Skip tasks whose diff_size clearly exceeds maxDiffSizeKb
    if (maxDiffSizeKb && t.diff_size != null && (t.diff_size * 120) / 1024 > maxDiffSizeKb) {
      return false;
    }
    // Skip tasks that have failed diff fetch too many times
    if (diffFailCounts && (diffFailCounts.get(t.task_id) ?? 0) >= maxDiffFetchAttempts) {
      return false;
    }
    return true;
  });
}

/**
 * Build AgentDescriptor from a LocalAgentConfig.
 * Utility for converting config entries into batch-compatible descriptors.
 */
export function agentConfigToDescriptor(
  config: LocalAgentConfig,
  agentId: string,
  index: number,
  agentOwner?: string,
  userOrgs?: ReadonlySet<string>,
): AgentDescriptor {
  return {
    name: config.name ?? `agent[${index}]`,
    agentId,
    roles: computeRoles(config),
    model: config.model,
    tool: config.tool,
    thinking: config.thinking,
    repoConfig: config.repos,
    synthesizeRepos: config.synthesize_repos,
    agentOwner,
    userOrgs,
  };
}

/** Default number of poll cycles between repo access re-checks. */
export const DEFAULT_RECHECK_INTERVAL = 50;
