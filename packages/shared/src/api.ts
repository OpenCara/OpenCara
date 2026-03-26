import type { ClaimRole, RepoConfig, ReviewVerdict } from './types.js';

// ── Poll ───────────────────────────────────────────────────────

/** POST /api/tasks/poll — request */
export interface PollRequest {
  agent_id: string;
  roles?: ClaimRole[]; // roles this agent is willing to take
  review_only?: boolean; // deprecated — use roles instead
  repos?: string[]; // "owner/repo" entries — used to include matching private repo tasks
  synthesize_repos?: RepoConfig; // repos this agent will synthesize for
  model?: string; // agent's model name (for preferred_models matching)
  tool?: string; // agent's tool name (for preferred_tools matching)
  thinking?: string; // agent's thinking/reasoning level (e.g. budget_tokens or named level)
}

/** A task returned in the poll response */
export interface PollTask {
  task_id: string;
  owner: string;
  repo: string;
  pr_number: number;
  diff_url: string;
  timeout_seconds: number;
  prompt: string;
  role: ClaimRole;
}

/** POST /api/tasks/poll — response */
export interface PollResponse {
  tasks: PollTask[];
}

// ── Claim ──────────────────────────────────────────────────────

/** POST /api/tasks/{taskId}/claim — request */
export interface ClaimRequest {
  agent_id: string;
  role: ClaimRole;
  model?: string;
  tool?: string;
  thinking?: string;
}

/** Review text returned to summary claimers */
export interface ClaimReview {
  agent_id: string;
  review_text: string;
  verdict: ReviewVerdict;
  /** Agent's model name (self-reported during claim, may be undefined for old claims) */
  model?: string;
  /** Agent's tool name (self-reported during claim, may be undefined for old claims) */
  tool?: string;
  /** Agent's thinking/reasoning level (self-reported during claim, may be undefined for old claims) */
  thinking?: string;
}

/** POST /api/tasks/{taskId}/claim — success response (errors use ErrorResponse) */
export interface ClaimResponse {
  claimed: true;
  reviews?: ClaimReview[];
}

// ── Result ─────────────────────────────────────────────────────

/** POST /api/tasks/{taskId}/result — request */
export interface ResultRequest {
  agent_id: string;
  type: ClaimRole;
  review_text: string;
  verdict?: ReviewVerdict;
  tokens_used?: number;
}

/** POST /api/tasks/{taskId}/result — response */
export interface ResultResponse {
  success: true;
}

// ── Reject / Error ─────────────────────────────────────────────

/** POST /api/tasks/{taskId}/reject — request */
export interface RejectRequest {
  agent_id: string;
  reason: string;
}

/** POST /api/tasks/{taskId}/error — request */
export interface ErrorRequest {
  agent_id: string;
  error: string;
}

// ── Registry ───────────────────────────────────────────────────

/** Tool entry in the platform registry */
export interface ToolRegistryEntry {
  name: string;
  displayName: string;
  binary: string;
  commandTemplate: string;
  tokenParser: string;
}

/** Model entry in the platform registry */
export interface ModelRegistryEntry {
  name: string;
  displayName: string;
  tools: string[];
}

/** GET /api/registry — response */
export interface RegistryResponse {
  tools: ToolRegistryEntry[];
  models: ModelRegistryEntry[];
}

/** Default registry data — single source of truth for server + CLI fallback */
export const DEFAULT_REGISTRY: RegistryResponse = {
  tools: [
    {
      name: 'claude',
      displayName: 'Claude',
      binary: 'claude',
      commandTemplate: "claude --model ${MODEL} --allowedTools '*' --print",
      tokenParser: 'claude',
    },
    {
      name: 'codex',
      displayName: 'Codex',
      binary: 'codex',
      commandTemplate: 'codex --model ${MODEL} exec',
      tokenParser: 'codex',
    },
    {
      name: 'gemini',
      displayName: 'Gemini',
      binary: 'gemini',
      commandTemplate: 'gemini -m ${MODEL}',
      tokenParser: 'gemini',
    },
    {
      name: 'qwen',
      displayName: 'Qwen',
      binary: 'qwen',
      commandTemplate: 'qwen --model ${MODEL} -y',
      tokenParser: 'qwen',
    },
  ],
  models: [
    {
      name: 'claude-opus-4-6',
      displayName: 'Claude Opus 4.6',
      tools: ['claude'],
    },
    {
      name: 'claude-opus-4-6[1m]',
      displayName: 'Claude Opus 4.6 (1M context)',
      tools: ['claude'],
    },
    {
      name: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet 4.6',
      tools: ['claude'],
    },
    {
      name: 'claude-sonnet-4-6[1m]',
      displayName: 'Claude Sonnet 4.6 (1M context)',
      tools: ['claude'],
    },
    {
      name: 'gpt-5-codex',
      displayName: 'GPT-5 Codex',
      tools: ['codex'],
    },
    {
      name: 'gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      tools: ['gemini'],
    },
    {
      name: 'qwen3.5-plus',
      displayName: 'Qwen 3.5 Plus',
      tools: ['qwen'],
    },
    { name: 'glm-5', displayName: 'GLM-5', tools: ['qwen'] },
    { name: 'kimi-k2.5', displayName: 'Kimi K2.5', tools: ['qwen'] },
    {
      name: 'minimax-m2.5',
      displayName: 'Minimax M2.5',
      tools: ['qwen'],
    },
  ],
};

// ── Agents ────────────────────────────────────────────────────

/** Agent status based on last-seen timestamp */
export type AgentStatus = 'active' | 'idle' | 'offline';

/** Per-agent claim statistics */
export interface AgentClaimStats {
  total: number;
  completed: number;
  rejected: number;
  error: number;
  pending: number;
}

/** Single agent activity entry */
export interface AgentActivity {
  agent_id: string;
  last_seen: number;
  status: AgentStatus;
  claims: AgentClaimStats;
}

/** GET /api/agents — response */
export interface AgentsResponse {
  agents: AgentActivity[];
}

// ── Meta ──────────────────────────────────────────────────────

/** GET /api/meta — response */
export interface MetaResponse {
  server_version: string;
  min_cli_version: string;
  features: string[];
}

// ── Config Validate ──────────────────────────────────────────────

/** POST /api/config/validate — request */
export interface ConfigValidateRequest {
  yaml: string;
}

/** POST /api/config/validate — success response */
export interface ConfigValidateSuccessResponse {
  valid: true;
  config: import('./review-config.js').ReviewConfig;
}

/** POST /api/config/validate — failure response */
export interface ConfigValidateErrorResponse {
  valid: false;
  error: string;
}

/** POST /api/config/validate — response (union) */
export type ConfigValidateResponse = ConfigValidateSuccessResponse | ConfigValidateErrorResponse;

// ── OAuth ────────────────────────────────────────────────────

/** Verified identity extracted from OAuth token by server middleware */
export interface VerifiedIdentity {
  github_user_id: number;
  github_username: string;
  verified_at: number; // unix ms
}

/** POST /api/auth/device — initiate device flow (proxied through server) */
export interface DeviceFlowInitResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/** POST /api/auth/device/token — poll for device flow completion */
export interface DeviceFlowTokenRequest {
  device_code: string;
}

export interface DeviceFlowTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/** POST /api/auth/refresh — refresh an expired token */
export interface RefreshTokenRequest {
  refresh_token: string;
}

export interface RefreshTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

// ── Common ─────────────────────────────────────────────────────

/** Standardized API error codes for programmatic error handling. */
export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'TASK_NOT_FOUND'
  | 'CLAIM_CONFLICT'
  | 'CLAIM_NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'SUMMARY_LOCKED'
  | 'CLI_OUTDATED'
  | 'AGENT_BLOCKED'
  | 'REVIEW_QUALITY_REJECTED'
  | 'AUTH_TOKEN_EXPIRED'
  | 'AUTH_TOKEN_REVOKED'
  | 'AUTH_REQUIRED';

/** Standard error response — structured format with error code. */
export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
  };
}
