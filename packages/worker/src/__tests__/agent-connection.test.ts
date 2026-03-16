import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentConnection } from '../agent-connection.js';

vi.mock('../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

import { createSupabaseClient } from '../db.js';

const mockedCreateSupabase = vi.mocked(createSupabaseClient);

function createMockStorage() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    setAlarm: vi.fn(async () => {}),
    getAlarm: vi.fn(async () => null),
    deleteAlarm: vi.fn(async () => {}),
  };
}

function createMockWebSocket() {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

function createMockCtx(storage: ReturnType<typeof createMockStorage>) {
  const websockets: unknown[] = [];
  return {
    storage,
    acceptWebSocket: vi.fn((ws: unknown) => {
      websockets.push(ws);
    }),
    getWebSockets: vi.fn(() => websockets),
    id: { toString: () => 'test-do-id' },
    _websockets: websockets,
  };
}

function createChainableSupabase() {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockResolvedValue({ data: null, error: null });
  chain.update = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockResolvedValue({ data: null, error: null });
  chain.gte = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
  return chain;
}

const mockEnv = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  AGENT_CONNECTION: {},
  TASK_TIMEOUT: {},
};

describe('AgentConnection', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let mockCtx: ReturnType<typeof createMockCtx>;
  let connection: AgentConnection;
  let mockSupabase: ReturnType<typeof createChainableSupabase>;

  beforeEach(() => {
    vi.restoreAllMocks();
    storage = createMockStorage();
    mockCtx = createMockCtx(storage);
    mockSupabase = createChainableSupabase();
    mockedCreateSupabase.mockReturnValue(mockSupabase as unknown as ReturnType<typeof createSupabaseClient>);
    connection = new AgentConnection(mockCtx as any, mockEnv as any);
  });

  describe('webSocketMessage', () => {
    beforeEach(() => {
      storage.store.set('agentId', 'agent-1');
      storage.store.set('inFlightTaskIds', ['task-1', 'task-2']);
    });

    it('handles heartbeat_pong by updating lastHeartbeatAt', async () => {
      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({ id: '1', timestamp: Date.now(), type: 'heartbeat_pong' }),
      );

      expect(storage.put).toHaveBeenCalledWith('lastHeartbeatAt', expect.any(String));
    });

    it('handles review_complete by removing task and inserting result', async () => {
      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({
          id: '1',
          timestamp: Date.now(),
          type: 'review_complete',
          taskId: 'task-1',
          review: 'LGTM',
          verdict: 'approve',
          tokensUsed: 100,
        }),
      );

      // Task removed from in-flight
      expect(storage.store.get('inFlightTaskIds')).toEqual(['task-2']);

      // Supabase insert called for review_results and consumption_logs
      expect(mockSupabase.from).toHaveBeenCalledWith('review_results');
      expect(mockSupabase.from).toHaveBeenCalledWith('consumption_logs');
    });

    it('handles review_complete without consumption log when tokensUsed is 0', async () => {
      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({
          id: '1',
          timestamp: Date.now(),
          type: 'review_complete',
          taskId: 'task-1',
          review: 'LGTM',
          verdict: 'approve',
          tokensUsed: 0,
        }),
      );

      // Only review_results, not consumption_logs
      const fromCalls = mockSupabase.from.mock.calls.map((c: unknown[]) => c[0]);
      expect(fromCalls).toContain('review_results');
      expect(fromCalls).not.toContain('consumption_logs');
    });

    it('handles review_rejected by removing task and inserting result', async () => {
      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({
          id: '1',
          timestamp: Date.now(),
          type: 'review_rejected',
          taskId: 'task-1',
          reason: 'Not relevant',
        }),
      );

      expect(storage.store.get('inFlightTaskIds')).toEqual(['task-2']);
      expect(mockSupabase.from).toHaveBeenCalledWith('review_results');
    });

    it('handles review_error by removing task and inserting result', async () => {
      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({
          id: '1',
          timestamp: Date.now(),
          type: 'review_error',
          taskId: 'task-2',
          error: 'Something went wrong',
        }),
      );

      expect(storage.store.get('inFlightTaskIds')).toEqual(['task-1']);
      expect(mockSupabase.from).toHaveBeenCalledWith('review_results');
    });

    it('ignores invalid JSON', async () => {
      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        'not-json',
      );

      expect(mockSupabase.from).not.toHaveBeenCalled();
    });

    it('ignores non-string messages', async () => {
      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        new ArrayBuffer(8),
      );

      expect(mockSupabase.from).not.toHaveBeenCalled();
    });

    it('ignores unknown message types', async () => {
      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({ id: '1', timestamp: Date.now(), type: 'unknown_type' }),
      );

      expect(mockSupabase.from).not.toHaveBeenCalled();
    });
  });

  describe('webSocketClose', () => {
    it('sets status to offline and marks in-flight tasks as error', async () => {
      storage.store.set('agentId', 'agent-1');
      storage.store.set('inFlightTaskIds', ['task-1']);

      const mockWs = createMockWebSocket();
      await connection.webSocketClose(
        mockWs as unknown as WebSocket,
        1000,
        'Normal closure',
        true,
      );

      expect(storage.store.get('status')).toBe('offline');
      expect(storage.store.get('inFlightTaskIds')).toEqual([]);
      expect(storage.deleteAlarm).toHaveBeenCalled();

      // Supabase: update agent status + insert error result
      expect(mockSupabase.from).toHaveBeenCalledWith('agents');
      expect(mockSupabase.from).toHaveBeenCalledWith('review_results');
    });

    it('handles close when no agentId is stored', async () => {
      const mockWs = createMockWebSocket();
      await connection.webSocketClose(
        mockWs as unknown as WebSocket,
        1000,
        'Normal closure',
        true,
      );

      expect(storage.store.get('status')).toBe('offline');
      expect(mockSupabase.from).not.toHaveBeenCalled();
      expect(storage.deleteAlarm).toHaveBeenCalled();
    });
  });

  describe('alarm', () => {
    it('sends heartbeat ping when WebSocket is connected', async () => {
      const mockWs = createMockWebSocket();
      mockCtx._websockets.push(mockWs);
      storage.store.set('lastHeartbeatAt', new Date().toISOString());

      await connection.alarm();

      expect(mockWs.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"heartbeat_ping"'),
      );
      expect(storage.setAlarm).toHaveBeenCalled();
    });

    it('closes connection on heartbeat timeout', async () => {
      const mockWs = createMockWebSocket();
      mockCtx._websockets.push(mockWs);
      // Last pong was 2 minutes ago (> 90s timeout)
      storage.store.set(
        'lastHeartbeatAt',
        new Date(Date.now() - 120_000).toISOString(),
      );

      await connection.alarm();

      expect(mockWs.close).toHaveBeenCalledWith(4003, 'heartbeat_timeout');
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('does nothing when no WebSocket is connected', async () => {
      await connection.alarm();
      expect(storage.setAlarm).not.toHaveBeenCalled();
    });
  });

  describe('fetch /push-task', () => {
    it('sends review_request and tracks in-flight task', async () => {
      const mockWs = createMockWebSocket();
      mockCtx._websockets.push(mockWs);
      storage.store.set('inFlightTaskIds', []);

      const request = new Request('https://internal/push-task', {
        method: 'POST',
        body: JSON.stringify({
          taskId: 'task-99',
          pr: { url: 'https://gh.com/pr/1', number: 1, diffUrl: 'https://gh.com/pr/1.diff', base: 'main', head: 'feature' },
          project: { owner: 'org', repo: 'repo', prompt: 'Review this' },
          timeout: 600,
        }),
      });

      const response = await connection.fetch(request);

      expect(response.status).toBe(200);
      expect(mockWs.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"review_request"'),
      );
      expect(storage.store.get('inFlightTaskIds')).toEqual(['task-99']);
    });

    it('returns 503 when no WebSocket is connected', async () => {
      const request = new Request('https://internal/push-task', {
        method: 'POST',
        body: JSON.stringify({ taskId: 'task-1' }),
      });

      const response = await connection.fetch(request);
      expect(response.status).toBe(503);
    });
  });

  describe('fetch /status', () => {
    it('returns current DO state', async () => {
      storage.store.set('status', 'online');
      storage.store.set('connectedAt', '2024-01-01T00:00:00Z');
      storage.store.set('lastHeartbeatAt', '2024-01-01T00:01:00Z');
      storage.store.set('inFlightTaskIds', ['task-1']);

      const request = new Request('https://internal/status');
      const response = await connection.fetch(request);
      const data = await response.json();

      expect(data).toEqual({
        status: 'online',
        connectedAt: '2024-01-01T00:00:00Z',
        lastHeartbeatAt: '2024-01-01T00:01:00Z',
        inFlightTaskIds: ['task-1'],
      });
    });

    it('returns defaults when empty', async () => {
      const request = new Request('https://internal/status');
      const response = await connection.fetch(request);
      const data = await response.json();

      expect(data).toEqual({
        status: 'offline',
        connectedAt: undefined,
        lastHeartbeatAt: undefined,
        inFlightTaskIds: [],
      });
    });
  });

  describe('fetch unknown path', () => {
    it('returns 404', async () => {
      const request = new Request('https://internal/unknown');
      const response = await connection.fetch(request);
      expect(response.status).toBe(404);
    });
  });
});
