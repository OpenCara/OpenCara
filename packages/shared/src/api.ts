import type { RepoConfig } from './types.js';

/** API key prefix for OpenCara API keys */
export const API_KEY_PREFIX = 'cr_';

/** POST /auth/device — response */
export interface DeviceFlowResponse {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  deviceCode: string;
}

/** POST /auth/device/token — request */
export interface DeviceTokenRequest {
  deviceCode: string;
}

/** POST /auth/device/token — response variants */
export type DeviceTokenResponse =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'complete'; apiKey: string };

/** POST /auth/revoke — response */
export interface RevokeResponse {
  apiKey: string;
}

/** Agent representation in API responses (camelCase) */
export interface AgentResponse {
  id: string;
  model: string;
  tool: string;
  // reputationScore removed — trust tier shown via stats instead
  isAnonymous: boolean;
  status: 'online' | 'offline';
  repoConfig: RepoConfig | null;
  createdAt: string;
}

/** GET /api/agents — response */
export interface ListAgentsResponse {
  agents: AgentResponse[];
}

/** POST /api/agents — request */
export interface CreateAgentRequest {
  model: string;
  tool: string;
  repoConfig?: RepoConfig;
}

/** POST /api/agents — response */
export type CreateAgentResponse = AgentResponse;

/** Trust tier — quality-based, not competitive ranking */
export type TrustTier = 'newcomer' | 'trusted' | 'expert';

/** Trust tier info for display */
export interface TrustTierInfo {
  tier: TrustTier;
  label: string; // "Newcomer", "Trusted", "Expert"
  reviewCount: number;
  positiveRate: number; // 0-1
  nextTier: TrustTier | null;
  progressToNext: number; // 0-1
}

/** GET /api/stats/:agentId — response */
export interface AgentStatsResponse {
  agent: {
    id: string;
    model: string;
    tool: string;
    status: 'online' | 'offline';
    trustTier: TrustTierInfo; // replaces reputationScore
  };
  stats: {
    totalReviews: number;
    totalSummaries: number;
    totalRatings: number;
    thumbsUp: number;
    thumbsDown: number;
  };
}

/** GET /api/projects/stats — public response (no auth) */
export interface ProjectStatsResponse {
  totalReviews: number;
  totalContributors: number;
  activeContributorsThisWeek: number;
  averagePositiveRate: number;
  recentActivity: ProjectActivityEntry[];
}

/** A single entry in the project activity feed */
export interface ProjectActivityEntry {
  type: 'review_completed';
  repo: string; // "owner/repo"
  prNumber: number;
  agentModel: string;
  completedAt: string;
}

/** POST /api/tasks/:taskId/collect-ratings — response */
export interface CollectRatingsResponse {
  collected: number;
  ratings: Array<{
    agentId: string;
    thumbsUp: number;
    thumbsDown: number;
    newScore: number;
  }>;
}

/** Standard error response */
export interface ErrorResponse {
  error: string;
}

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

/** Default registry data — single source of truth for worker + CLI fallback */
export const DEFAULT_REGISTRY: RegistryResponse = {
  tools: [
    {
      name: 'claude',
      displayName: 'Claude',
      binary: 'claude',
      commandTemplate: 'claude --model ${MODEL} -p ${PROMPT} --output-format text',
      tokenParser: 'claude',
    },
    {
      name: 'codex',
      displayName: 'Codex',
      binary: 'codex',
      commandTemplate: 'codex --model ${MODEL} -p ${PROMPT}',
      tokenParser: 'codex',
    },
    {
      name: 'gemini',
      displayName: 'Gemini',
      binary: 'gemini',
      commandTemplate: 'gemini --model ${MODEL} -p ${PROMPT}',
      tokenParser: 'gemini',
    },
    {
      name: 'qwen',
      displayName: 'Qwen',
      binary: 'qwen',
      commandTemplate: 'qwen --model ${MODEL} -p ${PROMPT} -y',
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

/** POST /auth/anonymous — request */
export interface AnonymousRegisterRequest {
  model: string;
  tool: string;
  repoConfig?: RepoConfig;
}

/** POST /auth/anonymous — response */
export interface AnonymousRegisterResponse {
  agentId: string;
  apiKey: string; // full cr_ key, store locally
}

/** POST /auth/link — request (link anonymous agent to authenticated user) */
export interface LinkAccountRequest {
  anonymousApiKey: string; // cr_ key of the anonymous user
}

/** POST /auth/link — response */
export interface LinkAccountResponse {
  linked: boolean;
  agentIds: string[]; // agents transferred to authenticated user
}
