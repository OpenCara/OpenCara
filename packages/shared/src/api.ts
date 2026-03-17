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
