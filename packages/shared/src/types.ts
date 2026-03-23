/** ReviewVerdict — the agent's conclusion on a PR */
export type ReviewVerdict = 'approve' | 'request_changes' | 'comment';

/** Task status lifecycle */
export type TaskStatus = 'pending' | 'reviewing' | 'completed' | 'timeout' | 'failed';

/** Claim status lifecycle */
export type ClaimStatus = 'pending' | 'completed' | 'rejected' | 'error';

/** Claim role — review or summary (synthesizer) */
export type ClaimRole = 'review' | 'summary';

/** Repo filter mode for agent preferences */
export type RepoFilterMode = 'all' | 'own' | 'whitelist' | 'blacklist';

/** Agent repo filter config */
export interface RepoConfig {
  mode: RepoFilterMode;
  list?: string[]; // owner/repo entries for whitelist/blacklist modes
}

/** A review task in the store */
export interface ReviewTask {
  id: string;
  owner: string;
  repo: string;
  pr_number: number;
  pr_url: string;
  diff_url: string;
  base_ref: string;
  head_ref: string;
  review_count: number; // total agents (reviewers + synthesizer)
  prompt: string;
  timeout_at: number; // unix ms
  status: TaskStatus;
  github_installation_id: number;
  private: boolean; // true if the source repo is private
  config: import('./review-config.js').ReviewConfig; // parsed .review.yml
  created_at: number;
  // Claim counters — updated atomically on task to avoid KV list() consistency issues
  claimed_agents?: string[]; // agent IDs that have claimed this task
  review_claims?: number; // number of review claims
  completed_reviews?: number; // number of completed review claims
  reviews_completed_at?: number; // unix ms when all reviews were completed (for grace period)
}

/** A claim on a task (review_result equivalent) */
export interface TaskClaim {
  id: string;
  task_id: string;
  agent_id: string;
  role: ClaimRole;
  status: ClaimStatus;
  model?: string; // agent's model name (self-reported)
  tool?: string; // agent's tool name (self-reported)
  review_text?: string; // filled on completion
  verdict?: ReviewVerdict; // filled on completion (review only)
  tokens_used?: number;
  created_at: number;
}

/**
 * Check if an agent's repo config allows reviewing a given repo.
 */
export function isRepoAllowed(
  repoConfig: RepoConfig | null | undefined,
  targetOwner: string,
  targetRepo: string,
  agentOwner?: string,
): boolean {
  if (!repoConfig) return true; // null = accept all
  const fullRepo = `${targetOwner}/${targetRepo}`;
  switch (repoConfig.mode) {
    case 'all':
      return true;
    case 'own':
      return agentOwner === targetOwner;
    case 'whitelist':
      return (repoConfig.list ?? []).includes(fullRepo);
    case 'blacklist':
      return !(repoConfig.list ?? []).includes(fullRepo);
    default:
      return true;
  }
}

// Re-export ReviewConfig types from review-config.ts
export type { ReviewConfig, TriggerConfig, EntityEntry } from './review-config.js';
