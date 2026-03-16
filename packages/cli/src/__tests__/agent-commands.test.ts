import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.hoisted(() => vi.fn());
const mockPost = vi.hoisted(() => vi.fn());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockWsInstances = vi.hoisted(() => [] as any[]);

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({ apiKey: 'cr_testkey', platformUrl: 'https://test.api.dev' })),
  requireApiKey: vi.fn((config: { apiKey: string }) => config.apiKey),
}));

vi.mock('../http.js', () => ({
  ApiClient: vi.fn(() => ({ get: mockGet, post: mockPost })),
}));

vi.mock('../reconnect.js', () => ({
  calculateDelay: vi.fn(() => 100),
  sleep: vi.fn().mockResolvedValue(undefined),
  DEFAULT_RECONNECT_OPTIONS: {
    initialDelay: 1000,
    maxDelay: 30000,
    multiplier: 2,
    jitter: true,
  },
}));

vi.mock('ws', () => {
  class MockWebSocket {
    private _handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    send = vi.fn();
    close = vi.fn();
    terminate = vi.fn();

    constructor() {
      mockWsInstances.push(this);
    }

    on(event: string, fn: (...args: unknown[]) => void) {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event)!.push(fn);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      for (const fn of this._handlers.get(event) ?? []) fn(...args);
    }
  }

  return { default: MockWebSocket };
});

import { agentCommand } from '../commands/agent.js';

describe('agent commands', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWsInstances.length = 0;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Prevent signal handlers from accumulating
    vi.spyOn(process, 'once').mockReturnValue(process);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('agent create', () => {
    it('creates agent successfully', async () => {
      mockPost.mockResolvedValueOnce({
        id: 'agent-new',
        model: 'gpt-4',
        tool: 'claude-code',
      });

      await agentCommand.parseAsync(
        ['create', '--model', 'gpt-4', '--tool', 'claude-code'],
        { from: 'user' },
      );

      expect(logSpy).toHaveBeenCalledWith('Agent created:');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('agent-new'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('gpt-4'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('claude-code'));
    });

    it('handles create failure with Error', async () => {
      mockPost.mockRejectedValueOnce(new Error('Server error'));

      await expect(
        agentCommand.parseAsync(
          ['create', '--model', 'gpt-4', '--tool', 'claude-code'],
          { from: 'user' },
        ),
      ).rejects.toThrow('process.exit');

      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to create agent:',
        'Server error',
      );
    });

    it('handles create failure with non-Error', async () => {
      mockPost.mockRejectedValueOnce('raw error');

      await expect(
        agentCommand.parseAsync(
          ['create', '--model', 'gpt-4', '--tool', 'claude-code'],
          { from: 'user' },
        ),
      ).rejects.toThrow('process.exit');

      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to create agent:',
        'raw error',
      );
    });
  });

  describe('agent list', () => {
    it('displays agents in table format', async () => {
      mockGet.mockResolvedValueOnce({
        agents: [
          {
            id: 'agent-1',
            model: 'gpt-4',
            tool: 'claude-code',
            status: 'online',
            reputationScore: 4.5,
            createdAt: '2024-01-01',
          },
        ],
      });

      await agentCommand.parseAsync(['list'], { from: 'user' });

      // Header row
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ID'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Model'));
      // Agent row
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('agent-1'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('gpt-4'));
    });

    it('shows message when no agents', async () => {
      mockGet.mockResolvedValueOnce({ agents: [] });

      await agentCommand.parseAsync(['list'], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('No agents registered'),
      );
    });

    it('handles list failure with Error', async () => {
      mockGet.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        agentCommand.parseAsync(['list'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to list agents:',
        'Network error',
      );
    });

    it('handles list failure with non-Error', async () => {
      mockGet.mockRejectedValueOnce('raw error');

      await expect(
        agentCommand.parseAsync(['list'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to list agents:',
        'raw error',
      );
    });
  });

  describe('agent start', () => {
    it('starts agent with explicit ID', async () => {
      await agentCommand.parseAsync(['start', 'agent-123'], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith('Starting agent agent-123...');
      expect(mockWsInstances).toHaveLength(1);
    });

    it('auto-selects single agent when no ID', async () => {
      mockGet.mockResolvedValueOnce({
        agents: [{ id: 'agent-solo', model: 'gpt-4', tool: 'cc' }],
      });

      await agentCommand.parseAsync(['start'], { from: 'user' });

      expect(logSpy).toHaveBeenCalledWith('Using agent agent-solo');
      expect(logSpy).toHaveBeenCalledWith('Starting agent agent-solo...');
    });

    it('exits when no agents and no ID', async () => {
      mockGet.mockResolvedValueOnce({ agents: [] });

      await expect(
        agentCommand.parseAsync(['start'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('No agents registered'),
      );
    });

    it('exits when multiple agents and no ID', async () => {
      mockGet.mockResolvedValueOnce({
        agents: [
          { id: 'a1', model: 'm1', tool: 't1' },
          { id: 'a2', model: 'm2', tool: 't2' },
        ],
      });

      await expect(
        agentCommand.parseAsync(['start'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Multiple agents found'),
      );
    });

    it('prints agent details when multiple agents', async () => {
      mockGet.mockResolvedValueOnce({
        agents: [
          { id: 'a1', model: 'm1', tool: 't1' },
          { id: 'a2', model: 'm2', tool: 't2' },
        ],
      });

      await expect(
        agentCommand.parseAsync(['start'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('a1'));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('a2'));
    });

    it('exits when list fails during auto-select', async () => {
      mockGet.mockRejectedValueOnce(new Error('API error'));

      await expect(
        agentCommand.parseAsync(['start'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to list agents:',
        'API error',
      );
    });

    it('handles WebSocket open event', async () => {
      await agentCommand.parseAsync(['start', 'a1'], { from: 'user' });

      const ws = mockWsInstances[0];
      ws.emit('open');

      expect(logSpy).toHaveBeenCalledWith('Connected to platform.');
    });

    it('handles WebSocket message with handleMessage', async () => {
      await agentCommand.parseAsync(['start', 'a1'], { from: 'user' });

      const ws = mockWsInstances[0];
      ws.emit('open');
      ws.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'connected', version: '1' })),
      );

      expect(logSpy).toHaveBeenCalledWith('Authenticated. Protocol v1');
    });

    it('ignores invalid JSON messages', async () => {
      await agentCommand.parseAsync(['start', 'a1'], { from: 'user' });

      const ws = mockWsInstances[0];
      ws.emit('message', Buffer.from('not json'));
      // Should not throw or log errors
    });

    it('handles WebSocket error event', async () => {
      await agentCommand.parseAsync(['start', 'a1'], { from: 'user' });

      const ws = mockWsInstances[0];
      ws.emit('error', new Error('Connection refused'));

      expect(errorSpy).toHaveBeenCalledWith(
        'WebSocket error: Connection refused',
      );
    });

    it('reconnects on unintentional close', async () => {
      await agentCommand.parseAsync(['start', 'a1'], { from: 'user' });

      const ws = mockWsInstances[0];
      ws.emit('close', 1006, Buffer.from('Abnormal'));

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Disconnected'),
      );

      // Wait for async reconnect
      await new Promise((r) => setTimeout(r, 0));

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Reconnecting'),
      );
      // A new WebSocket should be created after reconnect
      expect(mockWsInstances.length).toBeGreaterThanOrEqual(2);
    });

    it('clears heartbeat timer on close after open', async () => {
      await agentCommand.parseAsync(['start', 'a1'], { from: 'user' });

      const ws = mockWsInstances[0];
      ws.emit('open'); // Sets heartbeat timer via resetHeartbeatTimer
      ws.emit('close', 1000, Buffer.from('Normal')); // Clears heartbeat timer

      expect(logSpy).toHaveBeenCalledWith('Connected to platform.');
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Disconnected'),
      );
    });

    it('terminates connection on heartbeat timeout', async () => {
      vi.useFakeTimers();

      await agentCommand.parseAsync(['start', 'a1'], { from: 'user' });

      const ws = mockWsInstances[0];
      ws.emit('open'); // Sets heartbeat timer (90s)

      vi.advanceTimersByTime(90_000); // Trigger heartbeat timeout

      expect(logSpy).toHaveBeenCalledWith(
        'No heartbeat received in 90s. Reconnecting...',
      );
      expect(ws.terminate).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('shuts down gracefully on SIGINT', async () => {
      const onceSpy = vi.mocked(process.once);

      await agentCommand.parseAsync(['start', 'a1'], { from: 'user' });

      const ws = mockWsInstances[0];

      // Find the SIGINT handler registered via process.once
      const sigintCall = onceSpy.mock.calls.find(
        ([event]) => event === 'SIGINT',
      );
      expect(sigintCall).toBeDefined();

      const shutdown = sigintCall![1] as () => void;

      // Calling shutdown triggers process.exit(0) which throws
      expect(() => shutdown()).toThrow('process.exit');

      expect(ws.close).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('Disconnected.');
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });
});
