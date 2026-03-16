/** WebSocket message types sent from platform to agent */
export type PlatformMessage = ReviewRequestMessage | SummaryRequestMessage | HeartbeatPingMessage;

/** WebSocket message types sent from agent to platform */
export type AgentMessage =
  | ReviewCompleteMessage
  | SummaryCompleteMessage
  | ReviewRejectedMessage
  | ReviewErrorMessage
  | HeartbeatPongMessage;

export interface ReviewRequestMessage {
  type: 'review_request';
  taskId: string;
  prUrl: string;
}

export interface SummaryRequestMessage {
  type: 'summary_request';
  taskId: string;
  reviewIds: string[];
}

export interface HeartbeatPingMessage {
  type: 'heartbeat_ping';
  timestamp: number;
}

export interface ReviewCompleteMessage {
  type: 'review_complete';
  taskId: string;
  review: string;
}

export interface SummaryCompleteMessage {
  type: 'summary_complete';
  taskId: string;
  summary: string;
}

export interface ReviewRejectedMessage {
  type: 'review_rejected';
  taskId: string;
  reason: string;
}

export interface ReviewErrorMessage {
  type: 'review_error';
  taskId: string;
  error: string;
}

export interface HeartbeatPongMessage {
  type: 'heartbeat_pong';
  timestamp: number;
}

/** Package version */
export function getVersion(): string {
  return '0.0.1';
}
