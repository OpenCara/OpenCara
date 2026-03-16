import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'node:events';

// Track all created mock WebSocket instances
const mockWsInstances: EventEmitter[] = [];

function createMockWs() {
  const emitter = new EventEmitter();
  (emitter as Record<string, unknown>).send = vi.fn();
  (emitter as Record<string, unknown>).close = vi.fn();
  (emitter as Record<string, unknown>).terminate = vi.fn();
  mockWsInstances.push(emitter);
  return emitter;
}

vi.mock('ws', () => ({
  default: vi.fn(() => createMockWs()),
}));

vi.mock('../reconnect.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});

import { startAgent } from '../commands/agent.js';

describe('startAgent reconnect guards', () => {
  beforeEach(() => {
    mockWsInstances.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  it('does not reconnect when a stale WebSocket closes (ws !== currentWs)', async () => {
    startAgent('agent-1', 'http://localhost:8787', 'test-key');

    // First connection created (WS-A)
    expect(mockWsInstances).toHaveLength(1);
    const wsA = mockWsInstances[0];
    wsA.emit('open');

    // WS-A closes normally — triggers reconnect, creates WS-B
    wsA.emit('close', 1006, Buffer.from('abnormal'));

    await vi.waitFor(() => {
      expect(mockWsInstances).toHaveLength(2);
    });

    const wsB = mockWsInstances[1];
    wsB.emit('open');

    // Stale WS-A fires another close event — should NOT trigger reconnect
    wsA.emit('close', 4002, Buffer.from('replaced'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should still only have 2 instances — no third reconnect
    expect(mockWsInstances).toHaveLength(2);
  });

  it('does not reconnect when close code is 4002 (replaced)', async () => {
    startAgent('agent-1', 'http://localhost:8787', 'test-key');

    expect(mockWsInstances).toHaveLength(1);
    const ws = mockWsInstances[0];
    ws.emit('open');

    // Close with 4002 "replaced" — should NOT reconnect
    ws.emit('close', 4002, Buffer.from('replaced'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(console.log).toHaveBeenCalledWith('Connection replaced by server — not reconnecting.');
    expect(mockWsInstances).toHaveLength(1);
  });

  it('reconnects normally on non-4002 close codes', async () => {
    startAgent('agent-1', 'http://localhost:8787', 'test-key');

    expect(mockWsInstances).toHaveLength(1);
    const ws = mockWsInstances[0];
    ws.emit('open');

    // Normal close — should reconnect
    ws.emit('close', 1006, Buffer.from('abnormal'));

    await vi.waitFor(() => {
      expect(mockWsInstances).toHaveLength(2);
    });

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Reconnecting'));
  });
});
