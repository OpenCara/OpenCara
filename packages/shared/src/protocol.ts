/** Base fields present on all WebSocket messages (the "envelope") */
export interface MessageBase {
  id: string;
  timestamp: number;
}

// --- Platform → Agent messages ---

export type PlatformMessage =
  | ConnectedMessage
  | ReviewRequestMessage
  | SummaryRequestMessage
  | HeartbeatPingMessage
  | PlatformErrorMessage;

export interface ConnectedMessage extends MessageBase {
  type: 'connected';
  version: number;
  agentId: string;
}

export interface ReviewRequestPR {
  url: string;
  number: number;
  diffUrl: string;
  base: string;
  head: string;
}

export interface ReviewRequestProject {
  owner: string;
  repo: string;
  prompt: string;
}

export interface ReviewRequestMessage extends MessageBase {
  type: 'review_request';
  taskId: string;
  pr: ReviewRequestPR;
  project: ReviewRequestProject;
  timeout: number;
}

export interface SummaryRequestMessage extends MessageBase {
  type: 'summary_request';
  taskId: string;
  reviewIds: string[];
}

export interface HeartbeatPingMessage extends MessageBase {
  type: 'heartbeat_ping';
}

export interface PlatformErrorMessage extends MessageBase {
  type: 'error';
  code: number;
  message: string;
}

// --- Agent → Platform messages ---

export type AgentMessage =
  | ReviewCompleteMessage
  | SummaryCompleteMessage
  | ReviewRejectedMessage
  | ReviewErrorMessage
  | HeartbeatPongMessage;

export type ReviewVerdict = 'approve' | 'request_changes' | 'comment';

export interface ReviewCompleteMessage extends MessageBase {
  type: 'review_complete';
  taskId: string;
  review: string;
  verdict: ReviewVerdict;
  tokensUsed: number;
}

export interface SummaryCompleteMessage extends MessageBase {
  type: 'summary_complete';
  taskId: string;
  summary: string;
}

export interface ReviewRejectedMessage extends MessageBase {
  type: 'review_rejected';
  taskId: string;
  reason: string;
}

export interface ReviewErrorMessage extends MessageBase {
  type: 'review_error';
  taskId: string;
  error: string;
}

export interface HeartbeatPongMessage extends MessageBase {
  type: 'heartbeat_pong';
}

/** Package version */
export function getVersion(): string {
  return '0.0.1';
}
