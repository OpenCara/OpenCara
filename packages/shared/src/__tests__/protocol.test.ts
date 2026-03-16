import { describe, it, expect } from 'vitest';
import { getVersion } from '../protocol.js';
import type {
  PlatformMessage,
  AgentMessage,
  ConnectedMessage,
  ReviewRequestMessage,
  HeartbeatPingMessage,
  PlatformErrorMessage,
  ReviewCompleteMessage,
  ReviewRejectedMessage,
  ReviewErrorMessage,
  HeartbeatPongMessage,
  SummaryCompleteMessage,
  SummaryRequestMessage,
} from '../protocol.js';

describe('protocol', () => {
  it('getVersion returns 0.0.1', () => {
    expect(getVersion()).toBe('0.0.1');
  });

  it('constructs a valid ConnectedMessage', () => {
    const msg: ConnectedMessage = {
      id: 'test-id',
      timestamp: Date.now(),
      type: 'connected',
      version: 1,
      agentId: 'agent-1',
    };
    expect(msg.type).toBe('connected');
    expect(msg.version).toBe(1);
  });

  it('constructs a valid ReviewRequestMessage with full payload', () => {
    const msg: ReviewRequestMessage = {
      id: 'test-id',
      timestamp: Date.now(),
      type: 'review_request',
      taskId: 'task-1',
      pr: {
        url: 'https://github.com/org/repo/pull/1',
        number: 1,
        diffUrl: 'https://github.com/org/repo/pull/1.diff',
        base: 'main',
        head: 'feature',
      },
      project: {
        owner: 'org',
        repo: 'repo',
        prompt: 'Review this code for bugs',
      },
      timeout: 600,
    };
    expect(msg.type).toBe('review_request');
    expect(msg.pr.number).toBe(1);
    expect(msg.project.owner).toBe('org');
    expect(msg.timeout).toBe(600);
  });

  it('constructs a valid ReviewCompleteMessage with verdict and tokensUsed', () => {
    const msg: ReviewCompleteMessage = {
      id: 'test-id',
      timestamp: Date.now(),
      type: 'review_complete',
      taskId: 'task-1',
      review: 'LGTM - no issues found',
      verdict: 'approve',
      tokensUsed: 1500,
    };
    expect(msg.verdict).toBe('approve');
    expect(msg.tokensUsed).toBe(1500);
  });

  it('constructs valid PlatformErrorMessage', () => {
    const msg: PlatformErrorMessage = {
      id: 'test-id',
      timestamp: Date.now(),
      type: 'error',
      code: 4001,
      message: 'Authentication failed',
    };
    expect(msg.type).toBe('error');
    expect(msg.code).toBe(4001);
  });

  it('all platform messages have id and timestamp (envelope)', () => {
    const messages: PlatformMessage[] = [
      { id: '1', timestamp: 1, type: 'connected', version: 1, agentId: 'a' },
      {
        id: '2', timestamp: 2, type: 'review_request', taskId: 't',
        pr: { url: '', number: 1, diffUrl: '', base: '', head: '' },
        project: { owner: '', repo: '', prompt: '' }, timeout: 60,
      },
      { id: '3', timestamp: 3, type: 'summary_request', taskId: 't', reviewIds: [] },
      { id: '4', timestamp: 4, type: 'heartbeat_ping' },
      { id: '5', timestamp: 5, type: 'error', code: 0, message: '' },
    ];
    for (const msg of messages) {
      expect(msg.id).toBeDefined();
      expect(msg.timestamp).toBeDefined();
    }
  });

  it('all agent messages have id and timestamp (envelope)', () => {
    const messages: AgentMessage[] = [
      { id: '1', timestamp: 1, type: 'review_complete', taskId: 't', review: '', verdict: 'approve', tokensUsed: 0 },
      { id: '2', timestamp: 2, type: 'summary_complete', taskId: 't', summary: '' },
      { id: '3', timestamp: 3, type: 'review_rejected', taskId: 't', reason: '' },
      { id: '4', timestamp: 4, type: 'review_error', taskId: 't', error: '' },
      { id: '5', timestamp: 5, type: 'heartbeat_pong' },
    ];
    for (const msg of messages) {
      expect(msg.id).toBeDefined();
      expect(msg.timestamp).toBeDefined();
    }
  });

  it('SummaryRequestMessage has reviewIds', () => {
    const msg: SummaryRequestMessage = {
      id: 'test',
      timestamp: Date.now(),
      type: 'summary_request',
      taskId: 'task-1',
      reviewIds: ['r1', 'r2'],
    };
    expect(msg.reviewIds).toHaveLength(2);
  });

  it('HeartbeatPingMessage uses envelope timestamp', () => {
    const now = Date.now();
    const msg: HeartbeatPingMessage = {
      id: 'test',
      timestamp: now,
      type: 'heartbeat_ping',
    };
    expect(msg.timestamp).toBe(now);
  });

  it('HeartbeatPongMessage uses envelope timestamp', () => {
    const msg: HeartbeatPongMessage = {
      id: 'test',
      timestamp: Date.now(),
      type: 'heartbeat_pong',
    };
    expect(msg.type).toBe('heartbeat_pong');
  });

  it('ReviewRejectedMessage has reason', () => {
    const msg: ReviewRejectedMessage = {
      id: 'test',
      timestamp: Date.now(),
      type: 'review_rejected',
      taskId: 'task-1',
      reason: 'Outside my expertise',
    };
    expect(msg.reason).toBe('Outside my expertise');
  });

  it('ReviewErrorMessage has error', () => {
    const msg: ReviewErrorMessage = {
      id: 'test',
      timestamp: Date.now(),
      type: 'review_error',
      taskId: 'task-1',
      error: 'API key expired',
    };
    expect(msg.error).toBe('API key expired');
  });

  it('SummaryCompleteMessage has summary', () => {
    const msg: SummaryCompleteMessage = {
      id: 'test',
      timestamp: Date.now(),
      type: 'summary_complete',
      taskId: 'task-1',
      summary: 'Overall the code looks good',
    };
    expect(msg.summary).toBe('Overall the code looks good');
  });

  it('ReviewVerdict covers all valid values', () => {
    const verdicts: ReviewCompleteMessage['verdict'][] = [
      'approve',
      'request_changes',
      'comment',
    ];
    expect(verdicts).toHaveLength(3);
  });
});
