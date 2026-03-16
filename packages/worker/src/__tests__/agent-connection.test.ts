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

    chain.order = vi.fn().mockReturnValue(chain);

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
      expect(result).toContain('OpenCrust Review');
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

  describe('fetch unknown path', () => {
    it('returns 404', async () => {
      const request = new Request('https://internal/unknown');
      const response = await connection.fetch(request);
      expect(response.status).toBe(404);
    });
  });
});
