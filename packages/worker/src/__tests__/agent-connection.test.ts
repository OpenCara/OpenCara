import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentConnection, formatReviewComment } from '../agent-connection.js';

vi.mock('../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

vi.mock('../github.js', () => ({
  getInstallationToken: vi.fn(),
  postPrComment: vi.fn(),
}));

import { createSupabaseClient } from '../db.js';
import { getInstallationToken, postPrComment } from '../github.js';

const mockedCreateSupabase = vi.mocked(createSupabaseClient);
const mockedGetInstallationToken = vi.mocked(getInstallationToken);
const mockedPostPrComment = vi.mocked(postPrComment);

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

interface SupabaseMockConfig {
  /** Per-table results for .select(...).eq(...).single() */
  singleResults?: Record<string, { data: unknown; error: unknown }>;
  /** Per-table results for .select(...).eq(...) terminal (no .single()) */
  selectResults?: Record<string, { data: unknown; error?: unknown }>;
  /** Per-table results for count queries: .select('id', {count:'exact',head:true}).eq(...) */
  countResults?: Record<string, { count: number }>;
}

/**
 * Create a Supabase mock where each `.from(table)` returns a fresh per-table chain.
 * Supports insert, update, select with eq/gte/single/count patterns.
 */
function createSupabaseMock(config: SupabaseMockConfig = {}) {
  const singleResults = config.singleResults ?? {};
  const selectResults = config.selectResults ?? {};
  const countResults = config.countResults ?? {};

  // Track all calls for assertions
  const calls = {
    from: [] as string[],
    insert: [] as { table: string; data: unknown }[],
    update: [] as { table: string; data: unknown }[],
  };

  function makeChain(table: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: Record<string, any> = {};

    chain.select = vi.fn((_cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.count === 'exact') {
        // Count query pattern: .select('id', { count: 'exact', head: true }).eq(...).eq(...)
        const countChain: Record<string, unknown> = {};
        const countResult = countResults[table] ?? { count: 0 };
        countChain.eq = vi.fn().mockReturnValue(countChain);
        countChain.then = (resolve: (v: unknown) => void) =>
          Promise.resolve(countResult).then(resolve);
        return countChain;
      }
      return chain;
    });

    chain.insert = vi.fn((data: unknown) => {
      calls.insert.push({ table, data });
      return Promise.resolve({ data: null, error: null });
    });

    chain.update = vi.fn((data: unknown) => {
      calls.update.push({ table, data });
      return chain;
    });

    chain.eq = vi.fn((_col?: string, _val?: unknown) => {
      // eq() is chainable AND can be terminal
      // Return something that's both thenable (for terminal) and chainable
      const result = selectResults[table] ?? { data: null, error: null };
      const proxy = {
        ...chain,
        then: (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve),
      };
      return proxy;
    });

    chain.gte = vi.fn(() => {
      const result = selectResults[table] ?? { data: null, error: null };
      return Promise.resolve(result);
    });

    chain.gt = vi.fn((_col?: string, _val?: unknown) => {
      const result = selectResults[table] ?? { data: null, error: null };
      const proxy = {
        ...chain,
        then: (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve),
      };
      return proxy;
    });

    chain.order = vi.fn((_col?: string, _opts?: unknown) => {
      const result = selectResults[table] ?? { data: null, error: null };
      const proxy = {
        ...chain,
        then: (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve),
      };
      return proxy;
    });

    chain.single = vi.fn(() => {
      return Promise.resolve(singleResults[table] ?? { data: null, error: null });
    });

    return chain;
  }

  const mock = {
    from: vi.fn((table: string) => {
      calls.from.push(table);
      return makeChain(table);
    }),
    _calls: calls,
  };

  return mock;
}

const mockDoFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
const mockEnv = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  GITHUB_APP_ID: 'test-app-id',
  GITHUB_APP_PRIVATE_KEY: 'test-key',
  GITHUB_CLIENT_ID: 'test-client',
  GITHUB_CLIENT_SECRET: 'test-secret',
  GITHUB_CLI_CLIENT_ID: 'test-cli-client',
  GITHUB_CLI_CLIENT_SECRET: 'test-cli-secret',
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  AGENT_CONNECTION: {
    idFromName: vi.fn(() => ({ toString: () => 'do-id' })),
    get: vi.fn(() => ({
      fetch: mockDoFetch,
    })),
  },
  TASK_TIMEOUT: {},
};

describe('AgentConnection', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let mockCtx: ReturnType<typeof createMockCtx>;
  let connection: AgentConnection;
  let mockSupa: ReturnType<typeof createSupabaseMock>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockDoFetch.mockResolvedValue(new Response('OK', { status: 200 }));
    storage = createMockStorage();
    mockCtx = createMockCtx(storage);
    mockSupa = createSupabaseMock();
    mockedCreateSupabase.mockReturnValue(
      mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
    );
    connection = new AgentConnection(
      mockCtx as unknown as DurableObjectState,
      mockEnv as unknown as Record<string, unknown>,
    );
  });

  describe('formatReviewComment', () => {
    it('formats approve verdict correctly', () => {
      const result = formatReviewComment('approve', 'gpt-4', 'cursor', 'LGTM');
      expect(result).toContain('\u2705 Approve');
      expect(result).toContain('`gpt-4` / `cursor`');
      expect(result).toContain('LGTM');
      expect(result).toContain('OpenCara Review');
    });

    it('formats request_changes verdict correctly', () => {
      const result = formatReviewComment('request_changes', 'claude', 'vscode', 'Fix bugs');
      expect(result).toContain('\u274C Changes Requested');
      expect(result).toContain('Fix bugs');
    });

    it('formats comment verdict correctly', () => {
      const result = formatReviewComment('comment', 'gemini', 'jetbrains', 'Nice code');
      expect(result).toContain('\uD83D\uDCAC Comment');
      expect(result).toContain('Nice code');
    });

    it('includes rating instructions', () => {
      const result = formatReviewComment('approve', 'model', 'tool', 'review');
      expect(result).toContain('\uD83D\uDC4D');
      expect(result).toContain('\uD83D\uDC4E');
    });
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

    it('handles review_complete with GitHub posting and task transition', async () => {
      mockSupa = createSupabaseMock({
        singleResults: {
          review_tasks: {
            data: {
              pr_number: 42,
              pr_url: 'https://github.com/org/repo/pull/42',
              project_id: 'proj-1',
              projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
            },
            error: null,
          },
          agents: {
            data: { model: 'gpt-4', tool: 'cursor' },
            error: null,
          },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );
      mockedGetInstallationToken.mockResolvedValue('test-token');
      mockedPostPrComment.mockResolvedValue('https://github.com/org/repo/pull/42#issuecomment-1');

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

      // Review result inserted with review_text and verdict
      expect(mockSupa._calls.insert).toContainEqual({
        table: 'review_results',
        data: expect.objectContaining({
          review_task_id: 'task-1',
          status: 'completed',
          review_text: 'LGTM',
          verdict: 'approve',
        }),
      });

      // Consumption log inserted
      expect(mockSupa._calls.insert).toContainEqual({
        table: 'consumption_logs',
        data: expect.objectContaining({ tokens_used: 100 }),
      });

      // GitHub comment posted
      expect(mockedGetInstallationToken).toHaveBeenCalledWith(99, expect.anything());
      expect(mockedPostPrComment).toHaveBeenCalledWith(
        'org',
        'repo',
        42,
        expect.stringContaining('\u2705 Approve'),
        'test-token',
      );

      // Comment URL stored
      expect(mockSupa._calls.update).toContainEqual({
        table: 'review_results',
        data: { comment_url: 'https://github.com/org/repo/pull/42#issuecomment-1' },
      });

      // Task transitioned to completed
      expect(mockSupa._calls.update).toContainEqual({
        table: 'review_tasks',
        data: { status: 'completed' },
      });
    });

    it('handles review_complete without consumption log when tokensUsed is 0', async () => {
      mockSupa = createSupabaseMock({
        singleResults: {
          review_tasks: {
            data: {
              pr_number: 42,
              pr_url: 'url',
              project_id: 'proj-1',
              projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
            },
            error: null,
          },
          agents: { data: { model: 'gpt-4', tool: 'cursor' }, error: null },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );
      mockedGetInstallationToken.mockResolvedValue('test-token');
      mockedPostPrComment.mockResolvedValue('https://github.com/comment');

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

      const insertTables = mockSupa._calls.insert.map((c) => c.table);
      expect(insertTables).toContain('review_results');
      expect(insertTables).not.toContain('consumption_logs');
    });

    it('handles review_complete when task lookup fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
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

      expect(mockSupa._calls.insert.map((c) => c.table)).toContain('review_results');
      expect(mockedPostPrComment).not.toHaveBeenCalled();
    });

    it('handles review_complete when GitHub posting fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mockSupa = createSupabaseMock({
        singleResults: {
          review_tasks: {
            data: {
              pr_number: 42,
              pr_url: 'url',
              project_id: 'proj-1',
              projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
            },
            error: null,
          },
          agents: { data: { model: 'gpt-4', tool: 'cursor' }, error: null },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );
      mockedGetInstallationToken.mockRejectedValue(new Error('Token error'));

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

      // Should not throw, just log error
      expect(mockSupa._calls.insert.map((c) => c.table)).toContain('review_results');
    });

    it('handles review_complete with agent lookup returning null', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mockSupa = createSupabaseMock({
        singleResults: {
          review_tasks: {
            data: {
              pr_number: 42,
              pr_url: 'url',
              project_id: 'proj-1',
              projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
            },
            error: null,
          },
          // agents returns null (default)
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );
      mockedGetInstallationToken.mockResolvedValue('test-token');
      mockedPostPrComment.mockResolvedValue('https://github.com/comment');

      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({
          id: '1',
          timestamp: Date.now(),
          type: 'review_complete',
          taskId: 'task-1',
          review: 'LGTM',
          verdict: 'request_changes',
          tokensUsed: 0,
        }),
      );

      // Should use 'unknown' for model/tool
      expect(mockedPostPrComment).toHaveBeenCalledWith(
        'org',
        'repo',
        42,
        expect.stringContaining('`unknown` / `unknown`'),
        'test-token',
      );
    });

    it('handles review_rejected and redistributes to another agent', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockSupa = createSupabaseMock({
        countResults: {
          review_results: { count: 1 },
        },
        selectResults: {
          review_results: { data: [{ agent_id: 'agent-1' }] },
          agents: { data: [{ id: 'agent-2' }] },
        },
        singleResults: {
          review_tasks: {
            data: {
              pr_number: 10,
              pr_url: 'https://github.com/org/repo/pull/10',
              timeout_at: new Date(Date.now() + 300_000).toISOString(),
              projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
            },
            error: null,
          },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );

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
      expect(mockSupa._calls.insert.map((c) => c.table)).toContain('review_results');
      // Redistributed to another agent via DO
      expect(mockEnv.AGENT_CONNECTION.idFromName).toHaveBeenCalledWith('agent-2');
    });

    it('handles review_error and redistributes to another agent', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockSupa = createSupabaseMock({
        countResults: {
          review_results: { count: 1 },
        },
        selectResults: {
          review_results: { data: [{ agent_id: 'agent-1' }] },
          agents: { data: [{ id: 'agent-3' }] },
        },
        singleResults: {
          review_tasks: {
            data: {
              pr_number: 5,
              pr_url: 'https://github.com/org/repo/pull/5',
              timeout_at: new Date(Date.now() + 600_000).toISOString(),
              projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
            },
            error: null,
          },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );

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
      expect(mockEnv.AGENT_CONNECTION.idFromName).toHaveBeenCalledWith('agent-3');
    });

    it('fails task after max attempts on rejection', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockSupa = createSupabaseMock({
        countResults: {
          review_results: { count: 3 },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({
          id: '1',
          timestamp: Date.now(),
          type: 'review_rejected',
          taskId: 'task-1',
          reason: 'Cannot review',
        }),
      );

      expect(mockSupa._calls.update).toContainEqual({
        table: 'review_tasks',
        data: { status: 'failed' },
      });
    });

    it('fails task when no eligible agents are available for redistribution', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockSupa = createSupabaseMock({
        countResults: {
          review_results: { count: 1 },
        },
        selectResults: {
          review_results: { data: [{ agent_id: 'agent-1' }] },
          agents: { data: [] }, // No candidates
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({
          id: '1',
          timestamp: Date.now(),
          type: 'review_rejected',
          taskId: 'task-1',
          reason: 'Cannot review',
        }),
      );

      expect(mockSupa._calls.update).toContainEqual({
        table: 'review_tasks',
        data: { status: 'failed' },
      });
    });

    it('handles redistribution when task lookup fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockSupa = createSupabaseMock({
        countResults: {
          review_results: { count: 1 },
        },
        selectResults: {
          review_results: { data: [{ agent_id: 'agent-1' }] },
          agents: { data: [{ id: 'agent-2' }] },
        },
        // No singleResults for review_tasks -- lookup returns null
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({
          id: '1',
          timestamp: Date.now(),
          type: 'review_rejected',
          taskId: 'task-1',
          reason: 'Cannot review',
        }),
      );

      // Should not throw, logs error
      expect(mockEnv.AGENT_CONNECTION.idFromName).not.toHaveBeenCalled();
    });

    it('handles redistribution when DO push fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockDoFetch.mockRejectedValue(new Error('DO fetch failed'));
      mockSupa = createSupabaseMock({
        countResults: {
          review_results: { count: 1 },
        },
        selectResults: {
          review_results: { data: [{ agent_id: 'agent-1' }] },
          agents: { data: [{ id: 'agent-2' }] },
        },
        singleResults: {
          review_tasks: {
            data: {
              pr_number: 10,
              pr_url: 'url',
              timeout_at: new Date(Date.now() + 300_000).toISOString(),
              projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
            },
            error: null,
          },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({
          id: '1',
          timestamp: Date.now(),
          type: 'review_error',
          taskId: 'task-1',
          error: 'Failed',
        }),
      );

      // Should not throw
      expect(mockEnv.AGENT_CONNECTION.idFromName).toHaveBeenCalledWith('agent-2');
    });

    it('handles summary_complete with GitHub posting', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockSupa = createSupabaseMock({
        singleResults: {
          review_tasks: {
            data: {
              pr_number: 42,
              pr_url: 'https://github.com/org/repo/pull/42',
              project_id: 'proj-1',
              projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
            },
            error: null,
          },
        },
        selectResults: {
          review_results: {
            data: [
              {
                agent_id: 'agent-2',
                review_text: 'LGTM',
                verdict: 'approve',
                agents: { model: 'gpt-4', tool: 'cursor' },
              },
            ],
          },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );
      mockedGetInstallationToken.mockResolvedValue('test-token');
      mockedPostPrComment.mockResolvedValue('https://github.com/comment');

      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({
          id: '1',
          timestamp: Date.now(),
          type: 'summary_complete',
          taskId: 'task-1',
          summary: 'Great code overall',
          tokensUsed: 200,
        }),
      );

      // Summary comment posted
      expect(mockedPostPrComment).toHaveBeenCalled();
      // Task transitioned to completed
      expect(mockSupa._calls.update).toContainEqual({
        table: 'review_tasks',
        data: { status: 'completed' },
      });
    });

    it('handles summary_complete when task not found', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({
          id: '1',
          timestamp: Date.now(),
          type: 'summary_complete',
          taskId: 'task-1',
          summary: 'Great code',
          tokensUsed: 0,
        }),
      );
      expect(mockedPostPrComment).not.toHaveBeenCalled();
    });

    it('handles summary_complete with GitHub posting failure — falls back to individual reviews', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockSupa = createSupabaseMock({
        singleResults: {
          review_tasks: {
            data: {
              pr_number: 42,
              pr_url: 'url',
              project_id: 'proj-1',
              projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
            },
            error: null,
          },
        },
        selectResults: {
          review_results: {
            data: [
              {
                agent_id: 'agent-2',
                review_text: 'LGTM',
                verdict: 'approve',
                agents: { model: 'gpt-4', tool: 'cursor' },
              },
            ],
          },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );
      mockedGetInstallationToken.mockRejectedValue(new Error('Token error'));

      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({
          id: '1',
          timestamp: Date.now(),
          type: 'summary_complete',
          taskId: 'task-1',
          summary: 'Great code',
          tokensUsed: 0,
        }),
      );

      // Should not throw, fallback attempted
      expect(mockedGetInstallationToken).toHaveBeenCalled();
    });

    it('handles review_error insert failure gracefully', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockSupa = createSupabaseMock({
        countResults: {
          review_results: { count: 1 },
        },
        selectResults: {
          review_results: { data: [{ agent_id: 'agent-1' }] },
          agents: { data: [{ id: 'agent-2' }] },
        },
        singleResults: {
          review_tasks: {
            data: {
              pr_number: 10,
              pr_url: 'url',
              timeout_at: new Date(Date.now() + 300_000).toISOString(),
              projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
            },
            error: null,
          },
        },
      });
      // Make insert return an error
      const origInsert = mockSupa.from('review_results').insert;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (origInsert as any).mockResolvedValueOnce({ data: null, error: { message: 'insert error' } });

      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({
          id: '1',
          timestamp: Date.now(),
          type: 'review_error',
          taskId: 'task-1',
          error: 'Failed',
        }),
      );

      // Should not throw
      expect(storage.store.get('inFlightTaskIds')).toEqual(['task-2']);
    });

    it('handles multi-agent review_complete: waits for more reviews when below minCount', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      // Store taskMeta to enable multi-agent mode
      storage.store.set('taskMeta:task-1', {
        minCount: 3,
        installationId: 99,
        owner: 'org',
        repo: 'repo',
        prNumber: 42,
        prompt: 'Review',
      });

      mockSupa = createSupabaseMock({
        countResults: {
          review_results: { count: 1 }, // only 1 of 3 completed
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );

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

      // Should NOT post to GitHub (multi-agent mode, waiting for more)
      expect(mockedGetInstallationToken).not.toHaveBeenCalled();
      expect(mockedPostPrComment).not.toHaveBeenCalled();
      // Should NOT transition to completed
      const completedUpdates = mockSupa._calls.update.filter(
        (u) =>
          u.table === 'review_tasks' && (u.data as Record<string, string>).status === 'completed',
      );
      expect(completedUpdates).toHaveLength(0);
    });

    it('ignores invalid JSON', async () => {
      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(mockWs as unknown as WebSocket, 'not-json');

      expect(mockSupa.from).not.toHaveBeenCalled();
    });

    it('ignores non-string messages', async () => {
      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(mockWs as unknown as WebSocket, new ArrayBuffer(8));

      expect(mockSupa.from).not.toHaveBeenCalled();
    });

    it('ignores unknown message types', async () => {
      const mockWs = createMockWebSocket();
      await connection.webSocketMessage(
        mockWs as unknown as WebSocket,
        JSON.stringify({ id: '1', timestamp: Date.now(), type: 'unknown_type' }),
      );

      expect(mockSupa.from).not.toHaveBeenCalled();
    });
  });

  describe('webSocketError', () => {
    it('closes the WebSocket with error code', async () => {
      const mockWs = createMockWebSocket();
      await connection.webSocketError(
        mockWs as unknown as WebSocket,
        new Error('connection reset'),
      );

      expect(mockWs.close).toHaveBeenCalledWith(4004, 'websocket_error');
    });
  });

  describe('webSocketClose', () => {
    it('sets status to offline and marks in-flight tasks as error', async () => {
      storage.store.set('agentId', 'agent-1');
      storage.store.set('inFlightTaskIds', ['task-1']);

      const mockWs = createMockWebSocket();
      await connection.webSocketClose(mockWs as unknown as WebSocket, 1000, 'Normal closure', true);

      expect(storage.store.get('status')).toBe('offline');
      expect(storage.store.get('inFlightTaskIds')).toEqual([]);
      expect(storage.deleteAlarm).toHaveBeenCalled();

      // Supabase: update agent status + insert error result
      expect(mockSupa._calls.from).toContain('agents');
      expect(mockSupa._calls.from).toContain('review_results');
    });

    it('handles close when no agentId is stored', async () => {
      const mockWs = createMockWebSocket();
      await connection.webSocketClose(mockWs as unknown as WebSocket, 1000, 'Normal closure', true);

      expect(storage.store.get('status')).toBe('offline');
      expect(mockSupa.from).not.toHaveBeenCalled();
      expect(storage.deleteAlarm).toHaveBeenCalled();
    });

    it('skips cleanup when close code is 4002 (replaced)', async () => {
      storage.store.set('agentId', 'agent-1');
      storage.store.set('status', 'online');
      storage.store.set('connectedAt', new Date().toISOString());
      storage.store.set('inFlightTaskIds', ['task-1']);

      const mockWs = createMockWebSocket();
      await connection.webSocketClose(mockWs as unknown as WebSocket, 4002, 'replaced', false);

      // Status and connectedAt should NOT be modified
      expect(storage.store.get('status')).toBe('online');
      expect(storage.store.get('connectedAt')).toBeDefined();
      // In-flight tasks should NOT be marked as error
      expect(storage.store.get('inFlightTaskIds')).toEqual(['task-1']);
      // Supabase should NOT have been called
      expect(mockSupa.from).not.toHaveBeenCalled();
      // Alarm should NOT be deleted
      expect(storage.deleteAlarm).not.toHaveBeenCalled();
    });
  });

  describe('alarm', () => {
    it('sends heartbeat ping when WebSocket is connected', async () => {
      const mockWs = createMockWebSocket();
      mockCtx._websockets.push(mockWs);
      storage.store.set('lastHeartbeatAt', new Date().toISOString());

      await connection.alarm();

      expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('"type":"heartbeat_ping"'));
      expect(storage.setAlarm).toHaveBeenCalled();
    });

    it('closes connection on heartbeat timeout', async () => {
      const mockWs = createMockWebSocket();
      mockCtx._websockets.push(mockWs);
      storage.store.set('lastHeartbeatAt', new Date(Date.now() - 120_000).toISOString());

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
    it('sends review_request with diffContent and tracks in-flight task', async () => {
      const mockWs = createMockWebSocket();
      mockCtx._websockets.push(mockWs);
      storage.store.set('inFlightTaskIds', []);

      const request = new Request('https://internal/push-task', {
        method: 'POST',
        body: JSON.stringify({
          taskId: 'task-99',
          pr: {
            url: 'https://gh.com/pr/1',
            number: 1,
            diffUrl: 'https://gh.com/pr/1.diff',
            base: 'main',
            head: 'feature',
          },
          project: { owner: 'org', repo: 'repo', prompt: 'Review this' },
          timeout: 600,
          diffContent: 'diff --git a/file.ts b/file.ts\n',
        }),
      });

      const response = await connection.fetch(request);

      expect(response.status).toBe(200);
      const sentMessage = JSON.parse(mockWs.send.mock.calls[0][0]);
      expect(sentMessage.type).toBe('review_request');
      expect(sentMessage.diffContent).toBe('diff --git a/file.ts b/file.ts\n');
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

    it('stores taskMeta when minCount is provided', async () => {
      const mockWs = createMockWebSocket();
      mockCtx._websockets.push(mockWs);
      storage.store.set('inFlightTaskIds', []);

      const request = new Request('https://internal/push-task', {
        method: 'POST',
        body: JSON.stringify({
          taskId: 'task-99',
          pr: { url: 'url', number: 1, diffUrl: 'diff', base: 'main', head: 'feature' },
          project: { owner: 'org', repo: 'repo', prompt: 'Review' },
          timeout: 600,
          diffContent: 'diff content',
          minCount: 3,
          installationId: 99,
        }),
      });

      await connection.fetch(request);

      const meta = storage.store.get('taskMeta:task-99');
      expect(meta).toEqual({
        minCount: 3,
        installationId: 99,
        owner: 'org',
        repo: 'repo',
        prNumber: 1,
        prompt: 'Review',
      });
    });
  });

  describe('fetch /push-summary', () => {
    it('sends summary_request to WebSocket and tracks in-flight', async () => {
      const mockWs = createMockWebSocket();
      mockCtx._websockets.push(mockWs);
      storage.store.set('inFlightTaskIds', []);

      const summaryMsg = {
        id: 'msg-1',
        timestamp: Date.now(),
        type: 'summary_request',
        taskId: 'task-1',
        pr: { url: 'url', number: 1 },
        project: { owner: 'org', repo: 'repo', prompt: 'Review' },
        reviews: [
          { agentId: 'a1', model: 'gpt-4', tool: 'cursor', review: 'LGTM', verdict: 'approve' },
        ],
        timeout: 300,
      };

      const request = new Request('https://internal/push-summary', {
        method: 'POST',
        body: JSON.stringify(summaryMsg),
      });

      const response = await connection.fetch(request);

      expect(response.status).toBe(200);
      const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
      expect(sent.type).toBe('summary_request');
      expect(sent.taskId).toBe('task-1');
      expect(storage.store.get('inFlightTaskIds')).toEqual(['task-1']);
    });

    it('returns 503 when no WebSocket is connected', async () => {
      const request = new Request('https://internal/push-summary', {
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

  describe('pending task pickup on connect', () => {
    it('picks up pending tasks when called after agent connects', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const futureTimeout = new Date(Date.now() + 300_000).toISOString();

      // Simulate a connected WebSocket
      const mockWs = createMockWebSocket();
      mockCtx._websockets.push(mockWs);
      storage.store.set('agentId', 'agent-1');
      storage.store.set('inFlightTaskIds', []);

      mockSupa = createSupabaseMock({
        selectResults: {
          review_tasks: {
            data: [
              {
                id: 'pending-task-1',
                pr_number: 10,
                pr_url: 'https://github.com/org/repo/pull/10',
                timeout_at: futureTimeout,
                diff_content: 'diff --git a/file.ts\n+hello',
                config_json: {
                  prompt: 'Review',
                  minCount: 1,
                  timeout: '10m',
                  diffUrl: 'https://github.com/org/repo/pull/10.diff',
                  baseRef: 'main',
                  headRef: 'feature',
                  installationId: 99,
                },
                project_id: 'proj-1',
                projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
              },
            ],
          },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const supabase = createSupabaseClient(mockEnv as unknown as Record<string, unknown>);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (connection as any).pickUpPendingTasks('agent-1', supabase);

      // Verify the pending task was picked up: status updated to reviewing
      expect(mockSupa._calls.update).toContainEqual({
        table: 'review_tasks',
        data: { status: 'reviewing' },
      });

      // Verify a review_request was sent on the WebSocket
      const sentMessages = mockWs.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
      const reviewRequest = sentMessages.find((m: { type: string }) => m.type === 'review_request');
      expect(reviewRequest).toBeDefined();
      expect(reviewRequest.taskId).toBe('pending-task-1');
      expect(reviewRequest.diffContent).toBe('diff --git a/file.ts\n+hello');

      // Verify in-flight tracking
      expect(storage.store.get('inFlightTaskIds')).toContain('pending-task-1');

      // Verify taskMeta stored
      expect(storage.store.get('taskMeta:pending-task-1')).toEqual({
        minCount: 1,
        installationId: 99,
        owner: 'org',
        repo: 'repo',
        prNumber: 10,
        prompt: 'Review',
      });
    });

    it('skips pending tasks with too little time remaining', async () => {
      // Task expires in 20 seconds (below 30s threshold)
      const nearTimeout = new Date(Date.now() + 20_000).toISOString();

      const mockWs = createMockWebSocket();
      mockCtx._websockets.push(mockWs);
      storage.store.set('agentId', 'agent-1');
      storage.store.set('inFlightTaskIds', []);

      mockSupa = createSupabaseMock({
        selectResults: {
          review_tasks: {
            data: [
              {
                id: 'expiring-task',
                pr_number: 5,
                pr_url: 'https://github.com/org/repo/pull/5',
                timeout_at: nearTimeout,
                diff_content: 'diff',
                config_json: {},
                project_id: 'proj-1',
                projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
              },
            ],
          },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const supabase = createSupabaseClient(mockEnv as unknown as Record<string, unknown>);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (connection as any).pickUpPendingTasks('agent-1', supabase);

      // Should NOT have updated task status to reviewing
      const reviewingUpdates = mockSupa._calls.update.filter(
        (u) =>
          u.table === 'review_tasks' && (u.data as Record<string, string>).status === 'reviewing',
      );
      expect(reviewingUpdates).toHaveLength(0);

      // Should NOT have sent a review request
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('does nothing when no pending tasks exist', async () => {
      const mockWs = createMockWebSocket();
      mockCtx._websockets.push(mockWs);
      storage.store.set('agentId', 'agent-1');
      storage.store.set('inFlightTaskIds', []);

      mockSupa = createSupabaseMock({
        selectResults: {
          review_tasks: { data: [] },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const supabase = createSupabaseClient(mockEnv as unknown as Record<string, unknown>);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (connection as any).pickUpPendingTasks('agent-1', supabase);

      // No task status updates
      const taskUpdates = mockSupa._calls.update.filter((u) => u.table === 'review_tasks');
      expect(taskUpdates).toHaveLength(0);
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('does nothing when pending tasks query returns null', async () => {
      const mockWs = createMockWebSocket();
      mockCtx._websockets.push(mockWs);
      storage.store.set('agentId', 'agent-1');
      storage.store.set('inFlightTaskIds', []);

      mockSupa = createSupabaseMock({
        selectResults: {
          review_tasks: { data: null },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const supabase = createSupabaseClient(mockEnv as unknown as Record<string, unknown>);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (connection as any).pickUpPendingTasks('agent-1', supabase);

      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('handles CAS failure gracefully (another agent got it first)', async () => {
      const futureTimeout = new Date(Date.now() + 300_000).toISOString();

      const mockWs = createMockWebSocket();
      mockCtx._websockets.push(mockWs);
      storage.store.set('agentId', 'agent-1');
      storage.store.set('inFlightTaskIds', []);

      // Create a mock where the update returns an error (CAS failure)
      mockSupa = createSupabaseMock({
        selectResults: {
          review_tasks: {
            data: [
              {
                id: 'contested-task',
                pr_number: 10,
                pr_url: 'url',
                timeout_at: futureTimeout,
                diff_content: 'diff',
                config_json: {},
                project_id: 'proj-1',
                projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
              },
            ],
            error: { message: 'CAS conflict' },
          },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const supabase = createSupabaseClient(mockEnv as unknown as Record<string, unknown>);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (connection as any).pickUpPendingTasks('agent-1', supabase);

      // Should not send a review request on the WebSocket
      const sentMessages = mockWs.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
      const reviewRequests = sentMessages.filter(
        (m: { type: string }) => m.type === 'review_request',
      );
      expect(reviewRequests).toHaveLength(0);
    });

    it('uses default values when config_json fields are missing', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const futureTimeout = new Date(Date.now() + 300_000).toISOString();

      const mockWs = createMockWebSocket();
      mockCtx._websockets.push(mockWs);
      storage.store.set('agentId', 'agent-1');
      storage.store.set('inFlightTaskIds', []);

      mockSupa = createSupabaseMock({
        selectResults: {
          review_tasks: {
            data: [
              {
                id: 'task-no-config',
                pr_number: 5,
                pr_url: 'https://github.com/org/repo/pull/5',
                timeout_at: futureTimeout,
                diff_content: null,
                config_json: null,
                project_id: 'proj-1',
                projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
              },
            ],
          },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const supabase = createSupabaseClient(mockEnv as unknown as Record<string, unknown>);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (connection as any).pickUpPendingTasks('agent-1', supabase);

      // Should still pick up the task with defaults
      const sentMessages = mockWs.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
      const reviewRequest = sentMessages.find((m: { type: string }) => m.type === 'review_request');
      expect(reviewRequest).toBeDefined();
      expect(reviewRequest.diffContent).toBe('');
      expect(reviewRequest.pr.base).toBe('main');
      expect(reviewRequest.pr.head).toBe('unknown');
      expect(reviewRequest.project.prompt).toBe('');
    });

    it('stops picking up tasks when WebSocket is not connected', async () => {
      const futureTimeout = new Date(Date.now() + 300_000).toISOString();

      // No WebSocket connected
      storage.store.set('agentId', 'agent-1');
      storage.store.set('inFlightTaskIds', []);

      mockSupa = createSupabaseMock({
        selectResults: {
          review_tasks: {
            data: [
              {
                id: 'task-1',
                pr_number: 10,
                pr_url: 'url',
                timeout_at: futureTimeout,
                diff_content: 'diff',
                config_json: {},
                project_id: 'proj-1',
                projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
              },
            ],
          },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const supabase = createSupabaseClient(mockEnv as unknown as Record<string, unknown>);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (connection as any).pickUpPendingTasks('agent-1', supabase);

      // WebSocket check happens BEFORE CAS update, so no task status changes at all
      const reviewingUpdates = mockSupa._calls.update.filter(
        (u) =>
          u.table === 'review_tasks' && (u.data as Record<string, string>).status === 'reviewing',
      );
      expect(reviewingUpdates).toHaveLength(0);
      expect(storage.store.get('inFlightTaskIds')).toEqual([]);
    });

    it('rolls back task to pending when WebSocket send fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const futureTimeout = new Date(Date.now() + 300_000).toISOString();

      const mockWs = createMockWebSocket();
      mockWs.send.mockImplementation(() => {
        throw new Error('WebSocket closed');
      });
      mockCtx._websockets.push(mockWs);
      storage.store.set('agentId', 'agent-1');
      storage.store.set('inFlightTaskIds', []);

      mockSupa = createSupabaseMock({
        selectResults: {
          review_tasks: {
            data: [
              {
                id: 'send-fail-task',
                pr_number: 10,
                pr_url: 'url',
                timeout_at: futureTimeout,
                diff_content: 'diff',
                config_json: {},
                project_id: 'proj-1',
                projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
              },
            ],
          },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const supabase = createSupabaseClient(mockEnv as unknown as Record<string, unknown>);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (connection as any).pickUpPendingTasks('agent-1', supabase);

      // Should have rolled back: first update to reviewing, then rollback to pending
      expect(mockSupa._calls.update).toContainEqual({
        table: 'review_tasks',
        data: { status: 'reviewing' },
      });
      expect(mockSupa._calls.update).toContainEqual({
        table: 'review_tasks',
        data: { status: 'pending' },
      });
      // Task should NOT be in inFlight
      expect(storage.store.get('inFlightTaskIds')).toEqual([]);
    });
  });

  describe('handleWebSocket preserves inFlightTaskIds on reconnect', () => {
    it('clears inFlightTaskIds on fresh connection (no existing WebSocket)', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // No existing WebSockets — fresh connection
      storage.store.set('inFlightTaskIds', ['task-old']);

      const request = new Request('https://internal/websocket?agentId=agent-1', {
        headers: { Upgrade: 'websocket' },
      });

      // Reaches Response(101) — RangeError in Node, success in Workers
      await expect(connection.fetch(request)).rejects.toThrow('init["status"]');

      // Fresh connection: inFlightTaskIds should be cleared
      expect(storage.store.get('inFlightTaskIds')).toEqual([]);
    });

    it('preserves inFlightTaskIds on reconnect (existing WebSocket replaced)', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // Simulate existing WebSocket with connectedAt old enough to pass debounce
      const existingWs = createMockWebSocket();
      mockCtx._websockets.push(existingWs);
      storage.store.set('inFlightTaskIds', ['task-in-progress']);
      storage.store.set('connectedAt', new Date(Date.now() - 10_000).toISOString());

      const request = new Request('https://internal/websocket?agentId=agent-1', {
        headers: { Upgrade: 'websocket' },
      });

      // Reaches Response(101) — RangeError in Node, success in Workers
      await expect(connection.fetch(request)).rejects.toThrow('init["status"]');

      // Reconnect: inFlightTaskIds should be preserved
      expect(storage.store.get('inFlightTaskIds')).toEqual(['task-in-progress']);

      // Existing WebSocket should have been closed with 4002
      expect(existingWs.close).toHaveBeenCalledWith(4002, 'replaced');
    });
  });

  describe('handleWebSocket debounce', () => {
    it('returns 409 when reconnecting within debounce window', async () => {
      // Simulate existing WebSocket with recent connectedAt
      const existingWs = createMockWebSocket();
      mockCtx._websockets.push(existingWs);
      storage.store.set('connectedAt', new Date(Date.now() - 1_000).toISOString());

      const request = new Request('https://internal/websocket?agentId=agent-1', {
        headers: { Upgrade: 'websocket' },
      });

      const response = await connection.fetch(request);
      expect(response.status).toBe(409);
      expect(await response.text()).toBe('Already connected');

      // Existing WebSocket should NOT have been closed
      expect(existingWs.close).not.toHaveBeenCalled();
    });

    it('allows reconnection after debounce window expires', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // Simulate existing WebSocket with old connectedAt (beyond 5s debounce)
      const existingWs = createMockWebSocket();
      mockCtx._websockets.push(existingWs);
      storage.store.set('connectedAt', new Date(Date.now() - 6_000).toISOString());

      const request = new Request('https://internal/websocket?agentId=agent-1', {
        headers: { Upgrade: 'websocket' },
      });

      // Should proceed past debounce — reaches Response(101) which throws in Node
      await expect(connection.fetch(request)).rejects.toThrow('init["status"]');

      // Existing WebSocket should have been closed with 4002
      expect(existingWs.close).toHaveBeenCalledWith(4002, 'replaced');
    });

    it('allows connection when no connectedAt is stored', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // Existing WebSocket but no connectedAt — first-ever connection scenario
      const existingWs = createMockWebSocket();
      mockCtx._websockets.push(existingWs);

      const request = new Request('https://internal/websocket?agentId=agent-1', {
        headers: { Upgrade: 'websocket' },
      });

      // Should proceed — reaches Response(101) which throws in Node
      await expect(connection.fetch(request)).rejects.toThrow('init["status"]');
      expect(existingWs.close).toHaveBeenCalledWith(4002, 'replaced');
    });

    it('allows connection when connectedAt exists but no WebSocket', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // connectedAt is recent but no WebSocket exists (e.g., WS already closed)
      storage.store.set('connectedAt', new Date(Date.now() - 1_000).toISOString());

      const request = new Request('https://internal/websocket?agentId=agent-1', {
        headers: { Upgrade: 'websocket' },
      });

      // Should proceed — reaches Response(101) which throws in Node
      await expect(connection.fetch(request)).rejects.toThrow('init["status"]');
    });
  });

  describe('handleWebSocket pickUpPendingTasks on reconnect', () => {
    it('skips pickUpPendingTasks when reconnecting with in-flight tasks', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      // Simulate existing WebSocket with connectedAt old enough to pass debounce
      const existingWs = createMockWebSocket();
      mockCtx._websockets.push(existingWs);
      storage.store.set('connectedAt', new Date(Date.now() - 10_000).toISOString());
      // Set in-flight tasks so pickup is skipped
      storage.store.set('inFlightTaskIds', ['task-in-flight-1']);

      // Set up mock with pending tasks to verify they are NOT picked up
      const pendingTaskMock = createSupabaseMock({
        selectResults: {
          review_tasks: {
            data: [
              {
                id: 'pending-task-1',
                pr_number: 10,
                pr_url: 'https://github.com/org/repo/pull/10',
                timeout_at: new Date(Date.now() + 300_000).toISOString(),
                diff_content: 'diff',
                config_json: { prompt: 'Review', minCount: 1 },
                project_id: 'proj-1',
                projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
              },
            ],
          },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        pendingTaskMock as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const request = new Request('https://internal/websocket?agentId=agent-1', {
        headers: { Upgrade: 'websocket' },
      });

      // Reaches Response(101) — RangeError in Node
      await expect(connection.fetch(request)).rejects.toThrow('init["status"]');

      // review_tasks should NOT have been queried (pickUpPendingTasks was skipped)
      const reviewTasksFromCalls = pendingTaskMock._calls.from.filter((t) => t === 'review_tasks');
      expect(reviewTasksFromCalls).toHaveLength(0);
    });

    it('picks up pending tasks on reconnect when no in-flight tasks', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      // Simulate existing WebSocket with connectedAt old enough to pass debounce
      const existingWs = createMockWebSocket();
      mockCtx._websockets.push(existingWs);
      storage.store.set('connectedAt', new Date(Date.now() - 10_000).toISOString());
      // No in-flight tasks — reconnect should pick up pending tasks
      storage.store.set('inFlightTaskIds', []);

      const reconnectMock = createSupabaseMock({
        selectResults: {
          review_tasks: { data: [] },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        reconnectMock as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const request = new Request('https://internal/websocket?agentId=agent-1', {
        headers: { Upgrade: 'websocket' },
      });

      await expect(connection.fetch(request)).rejects.toThrow('init["status"]');

      // review_tasks SHOULD have been queried (pickUpPendingTasks ran)
      const reviewTasksFromCalls = reconnectMock._calls.from.filter((t) => t === 'review_tasks');
      expect(reviewTasksFromCalls.length).toBeGreaterThan(0);
    });

    it('calls pickUpPendingTasks on fresh connection (no existing WebSocket)', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // No existing WebSockets — fresh connection
      const freshMock = createSupabaseMock({
        selectResults: {
          review_tasks: { data: [] },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        freshMock as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const request = new Request('https://internal/websocket?agentId=agent-1', {
        headers: { Upgrade: 'websocket' },
      });

      // Reaches Response(101) — RangeError in Node
      await expect(connection.fetch(request)).rejects.toThrow('init["status"]');

      // review_tasks should have been queried (pickUpPendingTasks was called)
      const reviewTasksFromCalls = freshMock._calls.from.filter((t) => t === 'review_tasks');
      expect(reviewTasksFromCalls.length).toBeGreaterThan(0);
    });
  });

  describe('handleWebSocket resilience', () => {
    // Note: In Node.js test environment, `new Response(null, { status: 101 })` throws
    // RangeError because Node's Response only accepts 200-599 status codes.
    // The Cloudflare Workers runtime supports 101 natively. We verify resilience by
    // confirming the code reaches the Response(101) line (throws RangeError) rather
    // than failing earlier with the Supabase/pickUpPendingTasks error.

    it('WebSocket setup completes when pickUpPendingTasks throws', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // Make pickUpPendingTasks throw by having the review_tasks select throw
      const throwingMock = createSupabaseMock();
      let selectCallCount = 0;
      const originalFrom = throwingMock.from;
      throwingMock.from = vi.fn((table: string) => {
        const chain = originalFrom(table);
        if (table === 'review_tasks') {
          chain.select = vi.fn(() => {
            selectCallCount++;
            throw new Error('column diff_content does not exist');
          });
        }
        return chain;
      }) as typeof throwingMock.from;

      mockedCreateSupabase.mockReturnValue(
        throwingMock as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const request = new Request('https://internal/websocket?agentId=agent-1', {
        headers: { Upgrade: 'websocket' },
      });

      // Reaches Response(101) — throws RangeError in Node but would succeed in Workers
      await expect(connection.fetch(request)).rejects.toThrow('init["status"]');

      // Heartbeat alarm was set (before pickUpPendingTasks)
      expect(storage.setAlarm).toHaveBeenCalled();

      // Agent stored as online in DO storage
      expect(storage.store.get('status')).toBe('online');
      expect(storage.store.get('agentId')).toBe('agent-1');

      // pickUpPendingTasks was attempted and caught
      expect(selectCallCount).toBeGreaterThan(0);
    });

    it('WebSocket setup completes when createSupabaseClient throws', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // Make createSupabaseClient throw
      mockedCreateSupabase.mockImplementation(() => {
        throw new Error('Supabase connection refused');
      });

      const request = new Request('https://internal/websocket?agentId=agent-1', {
        headers: { Upgrade: 'websocket' },
      });

      // Reaches Response(101) — RangeError in Node, success in Workers
      await expect(connection.fetch(request)).rejects.toThrow('init["status"]');

      // Heartbeat alarm was set
      expect(storage.setAlarm).toHaveBeenCalled();

      // Agent stored as online in DO storage
      expect(storage.store.get('status')).toBe('online');
      expect(storage.store.get('agentId')).toBe('agent-1');
    });

    it('WebSocket setup completes when Supabase status update rejects', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // Create a mock where the agents update rejects
      const rejectingMock = createSupabaseMock();
      const originalFrom = rejectingMock.from;
      rejectingMock.from = vi.fn((table: string) => {
        const chain = originalFrom(table);
        if (table === 'agents') {
          chain.update = vi.fn(() => {
            const eqChain = {
              eq: vi.fn(() => Promise.reject(new Error('network timeout'))),
            };
            return eqChain;
          });
        }
        return chain;
      }) as typeof rejectingMock.from;

      mockedCreateSupabase.mockReturnValue(
        rejectingMock as unknown as ReturnType<typeof createSupabaseClient>,
      );

      const request = new Request('https://internal/websocket?agentId=agent-1', {
        headers: { Upgrade: 'websocket' },
      });

      // Reaches Response(101) — RangeError in Node, success in Workers
      await expect(connection.fetch(request)).rejects.toThrow('init["status"]');

      // Heartbeat alarm was set
      expect(storage.setAlarm).toHaveBeenCalled();

      // Agent stored as online in DO storage
      expect(storage.store.get('status')).toBe('online');
    });
  });

  describe('redistribution uses stored diff_content and config_json', () => {
    beforeEach(() => {
      storage.store.set('agentId', 'agent-1');
      storage.store.set('inFlightTaskIds', ['task-1']);
    });

    it('redistributes with stored diff_content and config_json from task', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      mockSupa = createSupabaseMock({
        countResults: {
          review_results: { count: 1 },
        },
        selectResults: {
          review_results: { data: [{ agent_id: 'agent-1' }] },
          agents: { data: [{ id: 'agent-2' }] },
        },
        singleResults: {
          review_tasks: {
            data: {
              pr_number: 10,
              pr_url: 'https://github.com/org/repo/pull/10',
              timeout_at: new Date(Date.now() + 300_000).toISOString(),
              diff_content: 'stored diff content',
              config_json: {
                prompt: 'Review carefully',
                diffUrl: 'https://github.com/org/repo/pull/10.diff',
                baseRef: 'main',
                headRef: 'feature-branch',
              },
              projects: { owner: 'org', repo: 'repo', github_installation_id: 99 },
            },
            error: null,
          },
        },
      });
      mockedCreateSupabase.mockReturnValue(
        mockSupa as unknown as ReturnType<typeof createSupabaseClient>,
      );

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

      // Verify the DO push used stored data
      expect(mockDoFetch).toHaveBeenCalled();
      const pushBody = JSON.parse(
        (mockDoFetch.mock.calls[0][0] as Request).clone().text
          ? await (mockDoFetch.mock.calls[0][0] as Request).text()
          : '{}',
      );
      expect(pushBody.diffContent).toBe('stored diff content');
      expect(pushBody.project.prompt).toBe('Review carefully');
      expect(pushBody.pr.diffUrl).toBe('https://github.com/org/repo/pull/10.diff');
      expect(pushBody.pr.base).toBe('main');
      expect(pushBody.pr.head).toBe('feature-branch');
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
