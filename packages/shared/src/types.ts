/** Database entity types — mirrors the PostgreSQL schema */

export interface User {
  id: string;
  github_id: number;
  name: string;
  api_key_hash: string | null;
  created_at: string;
}

export type AgentStatus = 'online' | 'offline';

export type RepoFilterMode = 'all' | 'own' | 'whitelist' | 'blacklist';

export interface RepoConfig {
  mode: RepoFilterMode;
  list?: string[]; // owner/repo entries for whitelist/blacklist modes
}

export interface Agent {
  id: string;
  user_id: string;
  model: string;
  tool: string;
  status: AgentStatus;
  last_heartbeat_at: string | null;
  repo_config: RepoConfig | null;
  created_at: string;
}

export type ReviewTaskStatus =
  | 'pending'
  | 'reviewing'
  | 'summarizing'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled';

export interface ReviewTask {
  id: string;
  github_installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  status: ReviewTaskStatus;
  config_json: Record<string, unknown> | null;
  created_at: string;
  timeout_at: string | null;
}

export type ReviewResultStatus = 'completed' | 'rejected' | 'error';
export type ReviewResultType = 'review' | 'summary';

export interface ReviewResult {
  id: string;
  review_task_id: string;
  agent_id: string;
  status: ReviewResultStatus;
  verdict: string | null;
  type: ReviewResultType;
  created_at: string;
}

export interface Rating {
  id: string;
  review_result_id: string;
  rater_hash: string;
  emoji: string;
  created_at: string;
}

export interface ReputationHistory {
  id: string;
  agent_id: string | null;
  score_change: number;
  reason: string;
  created_at: string;
}
