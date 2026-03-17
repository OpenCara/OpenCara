import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not reconnect when a stale WebSocket closes (ws !== currentWs)', async () => {
    startAgent('agent-1', 'http://localhost:8787', 'test-key');

    // First connection created (WS-A)
    expect(mockWsInstances).toHaveLength(1);
    const wsA = mockWsInstances[0];
    wsA.emit('open');

    // WS-A closes normally — triggers reconnect, creates WS-B
    wsA.emit('close', 1006, Buffer.from('abnormal'));

    // Flush the microtask queue so the async reconnect() runs
    await vi.advanceTimersByTimeAsync(0);

    expect(mockWsInstances).toHaveLength(2);

    const wsB = mockWsInstances[1];
    wsB.emit('open');

    // Stale WS-A fires another close event — should NOT trigger reconnect
    wsA.emit('close', 4002, Buffer.from('replaced'));
    await vi.advanceTimersByTimeAsync(0);

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
    await vi.advanceTimersByTimeAsync(0);

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

    await vi.advanceTimersByTimeAsync(0);
    expect(mockWsInstances).toHaveLength(2);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Reconnecting'));
  });

  it('does not reset attempt counter immediately on open', async () => {
    startAgent('agent-1', 'http://localhost:8787', 'test-key');

    const ws1 = mockWsInstances[0];
    ws1.emit('open');

    // Disconnect quickly (before 30s stability threshold)
    ws1.emit('close', 1006, Buffer.from('quick disconnect'));

    await vi.advanceTimersByTimeAsync(0);
    expect(mockWsInstances).toHaveLength(2);

    // The reconnect message should show attempt 1 (not reset to 0)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('attempt 1'));
  });

  it('resets attempt counter after connection is stable for 30s', async () => {
    startAgent('agent-1', 'http://localhost:8787', 'test-key');

    const ws1 = mockWsInstances[0];
    ws1.emit('open');

    // Advance time past the stability threshold (30s)
    vi.advanceTimersByTime(31_000);

    // Now disconnect
    ws1.emit('close', 1006, Buffer.from('late disconnect'));

    await vi.advanceTimersByTimeAsync(0);
    expect(mockWsInstances).toHaveLength(2);

    // After stability threshold passed, attempt should have been reset to 0
    // So the next reconnect should show attempt 1 (0 + 1)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('attempt 1'));
  });

  it('logs connection lifetime on disconnect', async () => {
    startAgent('agent-1', 'http://localhost:8787', 'test-key');

    const ws = mockWsInstances[0];
    ws.emit('open');

    // Advance time by 5 seconds
    vi.advanceTimersByTime(5000);

    ws.emit('close', 1006, Buffer.from('test'));

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('alive for'));
  });

  it('logs verbose diagnostics when verbose option is enabled', async () => {
    startAgent('agent-1', 'http://localhost:8787', 'test-key', undefined, undefined, {
      verbose: true,
    });

    const ws = mockWsInstances[0];
    ws.emit('open');

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('[verbose] Connection opened'),
    );

    // Advance past stability threshold
    vi.advanceTimersByTime(31_000);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('[verbose] Connection stable'),
    );
  });

  it('does not log verbose diagnostics when verbose option is not set', () => {
    startAgent('agent-1', 'http://localhost:8787', 'test-key');

    const ws = mockWsInstances[0];
    ws.emit('open');

    const verboseCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('[verbose]'),
    );
    expect(verboseCalls).toHaveLength(0);
  });

  it('uses custom stability threshold when provided', async () => {
    startAgent('agent-1', 'http://localhost:8787', 'test-key', undefined, undefined, {
      verbose: true,
      stabilityThresholdMs: 60_000,
    });

    const ws = mockWsInstances[0];
    ws.emit('open');

    // At 31s (past default 30s but before custom 60s), should NOT have reset
    vi.advanceTimersByTime(31_000);
    const stableCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('Connection stable'),
    );
    expect(stableCalls).toHaveLength(0);

    // At 61s (past custom 60s), should have reset
    vi.advanceTimersByTime(30_000);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('[verbose] Connection stable for 60s'),
    );
  });

  it('uses default threshold when stabilityThresholdMs is not provided', async () => {
    startAgent('agent-1', 'http://localhost:8787', 'test-key', undefined, undefined, {
      verbose: true,
    });

    const ws = mockWsInstances[0];
    ws.emit('open');

    // Advance past default 30s threshold
    vi.advanceTimersByTime(31_000);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('[verbose] Connection stable for 30s'),
    );
  });
});
