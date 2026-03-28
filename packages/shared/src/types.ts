/** ReviewVerdict — the agent's conclusion on a PR */
export type ReviewVerdict = 'approve' | 'request_changes' | 'comment';

/** Unified task role — determines what kind of work a task represents */
export type TaskRole =
  | 'review'
  | 'summary'
  | 'pr_dedup'
  | 'issue_dedup'
  | 'pr_triage'
  | 'issue_triage';

/** Check if a role is a dedup variant */
export function isDedupRole(role: TaskRole): boolean {
  return role === 'pr_dedup' || role === 'issue_dedup';
}

/** Check if a role is a triage variant */
export function isTriageRole(role: TaskRole): boolean {
  return role === 'pr_triage' || role === 'issue_triage';
}

/** Feature pipeline — which feature spawned this task group */
export type Feature = 'review' | 'dedup_pr' | 'dedup_issue' | 'triage';

/**
 * @deprecated Use TaskRole instead. Kept for backward compatibility during migration.
 */
export type ClaimRole = 'review' | 'summary';

/**
 * Task queue — determines what kind of claims the task accepts.
 * @deprecated Use task_type (TaskRole) instead. Kept for backward compatibility during migration.
 */
export type TaskQueue = 'review' | 'summary' | 'finished' | 'completed';

/** Task status lifecycle */
export type TaskStatus = 'pending' | 'reviewing' | 'completed' | 'timeout' | 'failed';

/** Claim status lifecycle */
export type ClaimStatus = 'pending' | 'completed' | 'rejected' | 'error';

/** Repo filter mode for agent preferences */
export type RepoFilterMode = 'public' | 'private' | 'whitelist' | 'blacklist';

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
  prompt: string;
  timeout_at: number; // unix ms
  status: TaskStatus;
  github_installation_id: number;
  private: boolean; // true if the source repo is private
  config: import('./review-config.js').ReviewConfig; // parsed .opencara.toml review section
  created_at: number;

  // ── New unified fields ──────────────────────────────────────
  task_type: TaskRole; // replaces queue — determines what kind of work this task is
  feature: Feature; // which feature pipeline spawned this task
  group_id: string; // links tasks in the same pipeline run

  // ── Issue fields (for dedup/triage on issues) ──────────────
  issue_number?: number;
  issue_url?: string;
  issue_title?: string;
  issue_body?: string;
  issue_author?: string;

  // ── Dedup fields ───────────────────────────────────────────
  index_issue_number?: number;

  // ── Deprecated fields (kept for migration) ─────────────────
  /** @deprecated Use task_type instead */
  queue: TaskQueue;
  /** @deprecated Use group task count instead */
  review_count: number;
  /** @deprecated Tracked per-task now (1 task = 1 claim) */
  review_claims?: number;
  /** @deprecated Tracked per-task now (1 task = 1 claim) */
  completed_reviews?: number;
  /** @deprecated Tracked per-task now */
  reviews_completed_at?: number;
  /** @deprecated Tracked per-task now */
  summary_agent_id?: string;
  /** @deprecated Tracked per-task now */
  summary_retry_count?: number;
}

/** A claim on a task (review_result equivalent) */
export interface TaskClaim {
  id: string;
  task_id: string;
  agent_id: string;
  role: TaskRole;
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

// ── Dedup Report Types ──────────────────────────────────────────

/** A single duplicate match found by the dedup agent */
export interface DedupMatch {
  number: number;
  similarity: 'exact' | 'high' | 'partial';
  description: string;
}

/** Report produced by a dedup agent */
export interface DedupReport {
  duplicates: DedupMatch[];
  index_entry: string;
}

// ── Triage Report Types ─────────────────────────────────────────

/** Issue category determined by triage */
export type TriageCategory = 'bug' | 'feature' | 'improvement' | 'question' | 'docs' | 'chore';

/** Triage priority level */
export type TriagePriority = 'critical' | 'high' | 'medium' | 'low';

/** Triage size estimate */
export type TriageSize = 'XS' | 'S' | 'M' | 'L' | 'XL';

/** Report produced by a triage agent */
export interface TriageReport {
  category: TriageCategory;
  module?: string;
  priority: TriagePriority;
  size: TriageSize;
  labels: string[];
  summary?: string;
  body?: string;
  comment: string;
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
    case 'public':
      return true;
    case 'private':
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
