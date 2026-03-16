import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskTimeout } from '../task-timeout.js';

vi.mock('../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

vi.mock('../summarization.js', () => ({
  triggerSummarization: vi.fn().mockResolvedValue(true),
}));

import { createSupabaseClient } from '../db.js';
import { triggerSummarization } from '../summarization.js';

const mockedCreateSupabase = vi.mocked(createSupabaseClient);
const mockedTriggerSummarization = vi.mocked(triggerSummarization);

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
    deleteAlarm: vi.fn(async () => {}),
  };
}

/**
 * Create a Supabase mock where all builder methods return the chain,
 * and the chain is thenable (for `await chain.eq(...).eq(...)` patterns).
 */
function createChainableSupabase() {
  let chainResult: unknown = { data: null, error: null, count: null };

  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.gte = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data: null, error: null });

  // Make chain thenable — resolves to chainResult when awaited without .single()
  chain.then = (resolve: (value: unknown) => void, reject?: (reason: unknown) => void) =>
    Promise.resolve(chainResult).then(resolve, reject);

  // Helper to set what `await chain` resolves to
  chain._setChainResult = (result: unknown) => {
    chainResult = result;
  };

  return chain;
}

const mockEnv = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  AGENT_CONNECTION: {},
  TASK_TIMEOUT: {},
};

describe('TaskTimeout', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let timeout: TaskTimeout;
  let mockSupabase: ReturnType<typeof createChainableSupabase>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockedTriggerSummarization.mockResolvedValue(true);
    storage = createMockStorage();
    mockSupabase = createChainableSupabase();
    mockedCreateSupabase.mockReturnValue(
      mockSupabase as unknown as ReturnType<typeof createSupabaseClient>,
    );

    const mockCtx = {
      storage,
      id: { toString: () => 'test-do-id' },
    };
    timeout = new TaskTimeout(
      mockCtx as unknown as DurableObjectState,
      mockEnv as unknown as Record<string, unknown>,
    );
  });

  describe('fetch /set-timeout', () => {
    it('stores taskId and minCount, sets alarm', async () => {
      const request = new Request('https://internal/set-timeout', {
        method: 'POST',
        body: JSON.stringify({ taskId: 'task-1', timeoutMs: 60000, minCount: 2 }),
      });

      const response = await timeout.fetch(request);

      expect(response.status).toBe(200);
      expect(storage.store.get('taskId')).toBe('task-1');
      expect(storage.store.get('minCount')).toBe(2);
      expect(storage.setAlarm).toHaveBeenCalled();
    });

    it('stores taskMeta when installationId is provided', async () => {
      const request = new Request('https://internal/set-timeout', {
        method: 'POST',
        body: JSON.stringify({
          taskId: 'task-1',
          timeoutMs: 60000,
          minCount: 2,
          installationId: 99,
          owner: 'org',
          repo: 'repo',
          prNumber: 42,
          prompt: 'Review',
        }),
      });

      const response = await timeout.fetch(request);

      expect(response.status).toBe(200);
      expect(storage.store.get('taskMeta')).toEqual({
        minCount: 2,
        installationId: 99,
        owner: 'org',
        repo: 'repo',
        prNumber: 42,
        prompt: 'Review',
      });
    });
  });

  describe('fetch unknown path', () => {
    it('returns 404', async () => {
      const request = new Request('https://internal/unknown');
      const response = await timeout.fetch(request);
      expect(response.status).toBe(404);
    });
  });

  describe('alarm', () => {
    beforeEach(() => {
      storage.store.set('taskId', 'task-1');
      storage.store.set('minCount', 2);
    });

    it('does nothing when taskId is not set', async () => {
      storage.store.delete('taskId');
      await timeout.alarm();
      expect(mockSupabase.from).not.toHaveBeenCalled();
    });

    it('does nothing when task is not in reviewing status', async () => {
      (mockSupabase.single as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { status: 'completed' },
        error: null,
      });

      await timeout.alarm();

      expect(mockSupabase.from).toHaveBeenCalledWith('review_tasks');
      expect(mockSupabase.update).not.toHaveBeenCalled();
    });

    it('transitions to timeout when no results exist', async () => {
      (mockSupabase.single as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { status: 'reviewing' },
        error: null,
      });
      (mockSupabase._setChainResult as (r: unknown) => void)({
        count: 0,
        data: null,
        error: null,
      });

      await timeout.alarm();

      expect(mockSupabase.update).toHaveBeenCalledWith({ status: 'timeout' });
      expect(mockedTriggerSummarization).not.toHaveBeenCalled();
    });

    it('transitions to summarizing and dispatches summary when enough results exist', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      storage.store.set('taskMeta', {
        minCount: 2,
        installationId: 99,
        owner: 'org',
        repo: 'repo',
        prNumber: 42,
        prompt: 'Review',
      });

      (mockSupabase.single as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { status: 'reviewing' },
        error: null,
      });
      (mockSupabase._setChainResult as (r: unknown) => void)({
        count: 3,
        data: null,
        error: null,
      });

      await timeout.alarm();

      expect(mockSupabase.update).toHaveBeenCalledWith({ status: 'summarizing' });
      expect(mockedTriggerSummarization).toHaveBeenCalledWith(
        mockEnv,
        expect.anything(),
        'task-1',
        expect.objectContaining({ minCount: 2, installationId: 99 }),
      );
    });

    it('transitions to summarizing with partial results and dispatches', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      storage.store.set('taskMeta', {
        minCount: 3,
        installationId: 99,
        owner: 'org',
        repo: 'repo',
        prNumber: 42,
        prompt: 'Review',
      });

      (mockSupabase.single as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { status: 'reviewing' },
        error: null,
      });
      (mockSupabase._setChainResult as (r: unknown) => void)({
        count: 1,
        data: null,
        error: null,
      });

      await timeout.alarm();

      expect(mockSupabase.update).toHaveBeenCalledWith({ status: 'summarizing' });
      expect(mockedTriggerSummarization).toHaveBeenCalled();
    });

    it('does not dispatch summary when no taskMeta stored', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      (mockSupabase.single as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { status: 'reviewing' },
        error: null,
      });
      (mockSupabase._setChainResult as (r: unknown) => void)({
        count: 2,
        data: null,
        error: null,
      });

      await timeout.alarm();

      expect(mockSupabase.update).toHaveBeenCalledWith({ status: 'summarizing' });
      expect(mockedTriggerSummarization).not.toHaveBeenCalled();
    });
  });
});
