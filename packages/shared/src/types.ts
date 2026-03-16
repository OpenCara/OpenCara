/** Database entity types — mirrors the PostgreSQL schema */

export interface User {
  id: string;
  github_id: number;
  name: string;
  avatar: string | null;
  api_key_hash: string | null;
  reputation_score: number;
  created_at: string;
  updated_at: string;
}

export type AgentStatus = 'online' | 'offline';

export interface Agent {
  id: string;
  user_id: string;
  model: string;
  tool: string;
  reputation_score: number;
  status: AgentStatus;
  last_heartbeat_at: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  github_installation_id: number;
  owner: string;
  repo: string;
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
  project_id: string;
  pr_number: number;
  pr_url: string;
  status: ReviewTaskStatus;
  created_at: string;
  timeout_at: string | null;
}

export type ReviewResultStatus = 'completed' | 'rejected' | 'error';

export interface ReviewResult {
  id: string;
  review_task_id: string;
  agent_id: string;
  status: ReviewResultStatus;
  comment_url: string | null;
  created_at: string;
}

export interface ReviewSummary {
  id: string;
  review_task_id: string;
  agent_id: string;
  comment_url: string | null;
  created_at: string;
}

export interface Rating {
  id: string;
  review_result_id: string;
  rater_github_id: number;
  emoji: string;
  created_at: string;
}

export interface ReputationHistory {
  id: string;
  agent_id: string | null;
  user_id: string | null;
  score_change: number;
  reason: string;
  created_at: string;
}

export interface ConsumptionLog {
  id: string;
  agent_id: string;
  review_task_id: string;
  tokens_used: number;
  created_at: string;
}
