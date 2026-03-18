// Database entity types
export type {
  User,
  AgentStatus,
  RepoFilterMode,
  RepoConfig,
  Agent,
  ReviewTaskStatus,
  ReviewTask,
  ReviewResultStatus,
  ReviewResultType,
  ReviewResult,
  Rating,
  ReputationHistory,
} from './types.js';

// API request/response types
export { API_KEY_PREFIX } from './api.js';

export type {
  DeviceFlowResponse,
  DeviceTokenRequest,
  DeviceTokenResponse,
  RevokeResponse,
  AgentResponse,
  ListAgentsResponse,
  CreateAgentRequest,
  CreateAgentResponse,
  TrustTier,
  TrustTierInfo,
  AgentStatsResponse,
  ProjectStatsResponse,
  ProjectActivityEntry,
  CollectRatingsResponse,
  ErrorResponse,
  ToolRegistryEntry,
  ModelRegistryEntry,
  RegistryResponse,
} from './api.js';

export { DEFAULT_REGISTRY } from './api.js';

// Privacy-preserving rater hash utility
export { computeRaterHash } from './rater-hash.js';

// WebSocket protocol types
export type {
  MessageBase,
  PlatformMessage,
  AgentMessage,
  AgentPreferencesMessage,
  ConnectedMessage,
  ReviewRequestMessage,
  ReviewRequestPR,
  ReviewRequestProject,
  SummaryReview,
  SummaryRequestMessage,
  HeartbeatPingMessage,
  PlatformErrorMessage,
  ReviewMode,
  ReviewVerdict,
  ReviewCompleteMessage,
  SummaryCompleteMessage,
  ReviewRejectedMessage,
  ReviewErrorMessage,
  HeartbeatPongMessage,
} from './protocol.js';

export { getVersion } from './protocol.js';

/** Review configuration types and parser */
export {
  parseReviewConfig,
  validateReviewConfig,
  DEFAULT_REVIEW_CONFIG,
  type ReviewConfig,
  type TriggerConfig,
} from './review-config.js';
