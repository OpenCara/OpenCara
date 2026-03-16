import { describe, it, expect, vi } from 'vitest';
import { buildWsUrl, handleMessage } from '../commands/agent.js';

describe('buildWsUrl', () => {
  it('converts https to wss', () => {
    const url = buildWsUrl('https://api.opencrust.dev', 'agent-123', 'cr_key');
    expect(url).toBe(
      'wss://api.opencrust.dev/ws/agent/agent-123?token=cr_key',
    );
  });

  it('converts http to ws', () => {
    const url = buildWsUrl('http://localhost:8787', 'agent-456', 'cr_test');
    expect(url).toBe(
      'ws://localhost:8787/ws/agent/agent-456?token=cr_test',
    );
  });

  it('encodes special characters in apiKey', () => {
    const url = buildWsUrl('https://api.test.com', 'a1', 'cr_k+y=');
    expect(url).toContain('token=cr_k%2By%3D');
  });
});

describe('handleMessage', () => {
  it('responds to heartbeat_ping with heartbeat_pong', () => {
    const send = vi.fn();
    const ws = { send };

    handleMessage(ws, { type: 'heartbeat_ping', timestamp: 1000 });

    expect(send).toHaveBeenCalledOnce();
    const sent = JSON.parse(send.mock.calls[0][0]);
    expect(sent.type).toBe('heartbeat_pong');
    expect(sent.timestamp).toBeTypeOf('number');
  });

  it('calls resetHeartbeat on heartbeat_ping', () => {
    const resetHeartbeat = vi.fn();
    const ws = { send: vi.fn() };

    handleMessage(ws, { type: 'heartbeat_ping', timestamp: 1000 }, resetHeartbeat);
    expect(resetHeartbeat).toHaveBeenCalledOnce();
  });

  it('rejects review_request with not-implemented', () => {
    const send = vi.fn();
    const ws = { send };

    handleMessage(ws, { type: 'review_request', taskId: 'task-1' });

    const sent = JSON.parse(send.mock.calls[0][0]);
    expect(sent.type).toBe('review_rejected');
    expect(sent.taskId).toBe('task-1');
    expect(sent.reason).toContain('not yet implemented');
  });

  it('rejects summary_request with not-implemented', () => {
    const send = vi.fn();
    const ws = { send };

    handleMessage(ws, { type: 'summary_request', taskId: 'task-2' });

    const sent = JSON.parse(send.mock.calls[0][0]);
    expect(sent.type).toBe('review_rejected');
    expect(sent.taskId).toBe('task-2');
  });

  it('handles connected message', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ws = { send: vi.fn() };

    handleMessage(ws, { type: 'connected', version: '1' });

    expect(consoleSpy).toHaveBeenCalledWith('Authenticated. Protocol v1');
    consoleSpy.mockRestore();
  });

  it('handles error message', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ws = { send: vi.fn() };

    handleMessage(ws, { type: 'error', code: 'rate_limited' });

    expect(consoleSpy).toHaveBeenCalledWith('Platform error: rate_limited');
    consoleSpy.mockRestore();
  });

  it('ignores unknown message types', () => {
    const ws = { send: vi.fn() };
    handleMessage(ws, { type: 'unknown_type' });
    expect(ws.send).not.toHaveBeenCalled();
  });
});
