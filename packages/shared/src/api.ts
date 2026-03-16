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
  reputationScore: number;
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

/** Standard error response */
export interface ErrorResponse {
  error: string;
}
