/** API key prefix for OpenCrust API keys */
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
  status: 'online' | 'offline';
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
    tokensUsed: number;
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

/** Consumption stats for a time period */
export interface ConsumptionPeriodStats {
  tokens: number;
  reviews: number;
}

/** GET /api/consumption/:agentId — response */
export interface ConsumptionStatsResponse {
  agentId: string;
  totalTokens: number;
  totalReviews: number;
  period: {
    last24h: ConsumptionPeriodStats;
    last7d: ConsumptionPeriodStats;
    last30d: ConsumptionPeriodStats;
  };
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
      name: 'claude-code',
      displayName: 'Claude Code',
      binary: 'claude',
      commandTemplate: 'claude -p --output-format text',
      tokenParser: 'claude',
    },
    {
      name: 'codex',
      displayName: 'Codex',
      binary: 'codex',
      commandTemplate: 'codex exec',
      tokenParser: 'codex',
    },
    {
      name: 'gemini',
      displayName: 'Gemini',
      binary: 'gemini',
      commandTemplate: 'gemini -p',
      tokenParser: 'gemini',
    },
    {
      name: 'qwen',
      displayName: 'Qwen',
      binary: 'qwen',
      commandTemplate: 'qwen -y -m ${MODEL}',
      tokenParser: 'qwen',
    },
  ],
  models: [
    { name: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', tools: ['claude-code'] },
    { name: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', tools: ['claude-code'] },
    { name: 'gpt-5-codex', displayName: 'GPT-5 Codex', tools: ['codex'] },
    { name: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', tools: ['gemini'] },
    { name: 'qwen3.5-plus', displayName: 'Qwen 3.5 Plus', tools: ['qwen'] },
    { name: 'glm-5', displayName: 'GLM-5', tools: ['qwen'] },
    { name: 'kimi-k2.5', displayName: 'Kimi K2.5', tools: ['qwen'] },
    { name: 'minimax-m2.5', displayName: 'Minimax M2.5', tools: ['qwen'] },
  ],
};
