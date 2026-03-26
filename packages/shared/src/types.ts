/** ReviewVerdict — the agent's conclusion on a PR */
export type ReviewVerdict = 'approve' | 'request_changes' | 'comment';

/** Task queue — determines what kind of claims the task accepts */
export type TaskQueue = 'review' | 'summary' | 'finished' | 'completed';

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
  queue: TaskQueue; // which queue this task is in
  github_installation_id: number;
  private: boolean; // true if the source repo is private
  config: import('./review-config.js').ReviewConfig; // parsed .review.yml
  created_at: number;
  // Counters — updated atomically on task to avoid KV list() consistency issues
  review_claims?: number; // number of review slot claims
  completed_reviews?: number; // number of completed review submissions
  reviews_completed_at?: number; // unix ms when all reviews completed (for grace period)
  summary_agent_id?: string; // agent that claimed summary (queue=finished)
  summary_retry_count?: number; // number of failed summary quality evaluations
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
  thinking?: string; // agent's thinking/reasoning level (self-reported)
  review_text?: string; // filled on completion
  verdict?: ReviewVerdict; // filled on completion (review only)
  tokens_used?: number;
  github_user_id?: number; // verified GitHub user ID from OAuth (optional for backward compat)
  github_username?: string; // verified GitHub username from OAuth (optional for backward compat)
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
