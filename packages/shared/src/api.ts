import type { ClaimRole, ReviewVerdict } from './types.js';

// ── Poll ───────────────────────────────────────────────────────

/** POST /api/tasks/poll — request */
export interface PollRequest {
  agent_id: string;
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
}

/** Review text returned to summary claimers */
export interface ClaimReview {
  agent_id: string;
  review_text: string;
  verdict: ReviewVerdict;
}

/** POST /api/tasks/{taskId}/claim — response */
export type ClaimResponse =
  | { claimed: true; reviews?: ClaimReview[] }
  | { claimed: false; reason: string };

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
  defaultReputation: number;
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
      defaultReputation: 0.8,
    },
    {
      name: 'claude-opus-4-6[1m]',
      displayName: 'Claude Opus 4.6 (1M context)',
      tools: ['claude'],
      defaultReputation: 0.8,
    },
    {
      name: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet 4.6',
      tools: ['claude'],
      defaultReputation: 0.7,
    },
    {
      name: 'claude-sonnet-4-6[1m]',
      displayName: 'Claude Sonnet 4.6 (1M context)',
      tools: ['claude'],
      defaultReputation: 0.7,
    },
    {
      name: 'gpt-5-codex',
      displayName: 'GPT-5 Codex',
      tools: ['codex'],
      defaultReputation: 0.7,
    },
    {
      name: 'gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      tools: ['gemini'],
      defaultReputation: 0.7,
    },
    {
      name: 'qwen3.5-plus',
      displayName: 'Qwen 3.5 Plus',
      tools: ['qwen'],
      defaultReputation: 0.6,
    },
    { name: 'glm-5', displayName: 'GLM-5', tools: ['qwen'], defaultReputation: 0.5 },
    { name: 'kimi-k2.5', displayName: 'Kimi K2.5', tools: ['qwen'], defaultReputation: 0.5 },
    {
      name: 'minimax-m2.5',
      displayName: 'Minimax M2.5',
      tools: ['qwen'],
      defaultReputation: 0.5,
    },
  ],
};

/** Default reputation for models not in the registry. */
export const DEFAULT_REPUTATION_FALLBACK = 0.5;

/** Look up the default reputation for a model name. Returns DEFAULT_REPUTATION_FALLBACK for unknown models. */
export function getModelDefaultReputation(modelName: string): number {
  const entry = DEFAULT_REGISTRY.models.find((m) => m.name === modelName);
  return entry?.defaultReputation ?? DEFAULT_REPUTATION_FALLBACK;
}

// ── Common ─────────────────────────────────────────────────────

/** Standard error response */
export interface ErrorResponse {
  error: string;
}
