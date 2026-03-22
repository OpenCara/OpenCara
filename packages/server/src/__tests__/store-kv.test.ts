import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KVTaskStore, safeParseJson } from '../store/kv.js';
import type { ReviewTask, TaskClaim } from '@opencara/shared';
import { DEFAULT_REVIEW_CONFIG } from '@opencara/shared';

// ── Mock KVNamespace ───────────────────────────────────────────────

type PutOptions = { expirationTtl?: number; metadata?: unknown };

interface StoredEntry {
  value: string;
  metadata?: unknown;
}

class MockKV {
  private data = new Map<string, StoredEntry>();
  /** Track put calls with their options for TTL assertions */
  putCalls: Array<{ key: string; value: string; options?: PutOptions }> = [];

  async get(key: string): Promise<string | null> {
    const entry = this.data.get(key);
    return entry?.value ?? null;
  }

  async put(key: string, value: string, options?: PutOptions): Promise<void> {
    this.putCalls.push({ key, value, options });
    this.data.set(key, { value, metadata: options?.metadata });
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list(opts: {
    prefix: string;
  }): Promise<{ keys: Array<{ name: string; metadata?: unknown }> }> {
    const keys: Array<{ name: string; metadata?: unknown }> = [];
    for (const [k, entry] of this.data.entries()) {
      if (k.startsWith(opts.prefix)) {
        keys.push({ name: k, metadata: entry.metadata });
      }
    }
    return { keys };
  }

  /** Inject raw string at a key (for corruption tests) */
  _setRaw(key: string, value: string): void {
    this.data.set(key, { value });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function makeTask(overrides: Partial<ReviewTask> = {}): ReviewTask {
  return {
    id: 'task-1',
    owner: 'test-org',
    repo: 'test-repo',
    pr_number: 1,
    pr_url: 'https://github.com/test-org/test-repo/pull/1',
    diff_url: 'https://github.com/test-org/test-repo/pull/1.diff',
    base_ref: 'main',
    head_ref: 'feature',
    review_count: 1,
    prompt: 'Review this PR',
    timeout_at: Date.now() + 600_000,
    status: 'pending',
    github_installation_id: 123,
    config: DEFAULT_REVIEW_CONFIG,
    created_at: Date.now(),
    ...overrides,
  };
}

function makeClaim(overrides: Partial<TaskClaim> = {}): TaskClaim {
  return {
    id: 'task-1:agent-1',
    task_id: 'task-1',
    agent_id: 'agent-1',
    role: 'review',
    status: 'pending',
    created_at: Date.now(),
    ...overrides,
  };
}

const SEVEN_DAYS = 7 * 24 * 60 * 60;

// ── Tests ───────────────────────────────────────────────────────────

describe('safeParseJson', () => {
  it('parses valid JSON', () => {
    expect(safeParseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null on malformed JSON', () => {
    expect(safeParseJson<unknown>('not json')).toBeNull();
  });

  it('returns custom fallback on malformed JSON', () => {
    expect(safeParseJson<string[]>('bad', [])).toEqual([]);
  });

  it('logs a warning on malformed JSON', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    safeParseJson('bad');
    expect(warnSpy).toHaveBeenCalledWith('KV: corrupted JSON entry, returning fallback');
    warnSpy.mockRestore();
  });
});

describe('KVTaskStore', () => {
  let kv: MockKV;
  let store: KVTaskStore;

  beforeEach(() => {
    kv = new MockKV();
    store = new KVTaskStore(kv as unknown as KVNamespace);
  });

  // ── getTask: corrupted JSON ──────────────────────────────────

  describe('getTask — corrupted JSON', () => {
    it('returns null when KV contains invalid JSON', async () => {
      kv._setRaw('task:bad', '{corrupt');
      const result = await store.getTask('bad');
      expect(result).toBeNull();
    });

    it('returns parsed task for valid JSON', async () => {
      const task = makeTask();
      await store.createTask(task);
      const result = await store.getTask('task-1');
      expect(result).toEqual(task);
    });
  });

  // ── createTask: metadata ──────────────────────────────────────

  describe('createTask — metadata', () => {
    it('stores task status and timeout_at in KV metadata', async () => {
      const task = makeTask();
      await store.createTask(task);

      const putCall = kv.putCalls.find((c) => c.key === 'task:task-1');
      expect(putCall).toBeDefined();
      expect(putCall!.options?.metadata).toEqual({
        status: 'pending',
        timeout_at: task.timeout_at,
      });
    });
  });

  // ── listTasks: uses kv.list() instead of index ────────────────

  describe('listTasks — uses kv.list() prefix scan', () => {
    it('lists all tasks via prefix scan', async () => {
      await store.createTask(makeTask({ id: 'a' }));
      await store.createTask(makeTask({ id: 'b' }));

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.id).sort()).toEqual(['a', 'b']);
    });

    it('filters by status using metadata', async () => {
      await store.createTask(makeTask({ id: 'a', status: 'pending' }));
      await store.createTask(makeTask({ id: 'b', status: 'reviewing' }));
      await store.createTask(makeTask({ id: 'c', status: 'completed' }));

      const pending = await store.listTasks({ status: ['pending'] });
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('a');

      const active = await store.listTasks({ status: ['pending', 'reviewing'] });
      expect(active).toHaveLength(2);
    });

    it('filters by timeout_before using metadata', async () => {
      const now = Date.now();
      await store.createTask(makeTask({ id: 'expired', timeout_at: now - 1000 }));
      await store.createTask(makeTask({ id: 'active', timeout_at: now + 60_000 }));

      const expired = await store.listTasks({ timeout_before: now });
      expect(expired).toHaveLength(1);
      expect(expired[0].id).toBe('expired');
    });

    it('handles entries without metadata (backwards compatibility)', async () => {
      // Simulate a task stored without metadata (pre-migration)
      kv._setRaw('task:legacy', JSON.stringify(makeTask({ id: 'legacy', status: 'pending' })));

      const tasks = await store.listTasks({ status: ['pending'] });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('legacy');
    });

    it('skips corrupted task entries', async () => {
      await store.createTask(makeTask({ id: 'good' }));
      kv._setRaw('task:bad', '{corrupt');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('good');
      warnSpy.mockRestore();
    });

    it('no race condition: concurrent creates are independent KV keys', async () => {
      // With the index-based approach, concurrent creates could lose entries.
      // With prefix scan, each task is an independent key — no shared state.
      await Promise.all([
        store.createTask(makeTask({ id: 'concurrent-1' })),
        store.createTask(makeTask({ id: 'concurrent-2' })),
        store.createTask(makeTask({ id: 'concurrent-3' })),
      ]);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(3);
    });
  });

  // ── getClaim: corrupted JSON ─────────────────────────────────

  describe('getClaim — corrupted JSON', () => {
    it('returns null when KV contains invalid JSON', async () => {
      kv._setRaw('claim:task-1:agent-1', 'not-json');
      const result = await store.getClaim('task-1:agent-1');
      expect(result).toBeNull();
    });
  });

  // ── getClaims: corrupted entries ─────────────────────────────

  describe('getClaims — corrupted entries', () => {
    it('skips corrupted entries and returns valid ones', async () => {
      // One valid, one corrupted
      await store.createClaim(makeClaim({ task_id: 'task-1', agent_id: 'a1' }));
      kv._setRaw('claim:task-1:bad', '{broken');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const claims = await store.getClaims('task-1');
      expect(claims).toHaveLength(1);
      expect(claims[0].agent_id).toBe('a1');
      expect(warnSpy).toHaveBeenCalledWith(
        'KV: skipping corrupted claim entry at claim:task-1:bad',
      );
      warnSpy.mockRestore();
    });

    it('returns empty array when all entries are corrupted', async () => {
      kv._setRaw('claim:task-1:a1', 'bad1');
      kv._setRaw('claim:task-1:a2', 'bad2');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const claims = await store.getClaims('task-1');
      expect(claims).toEqual([]);
      warnSpy.mockRestore();
    });
  });

  // ── updateClaim: corrupted JSON ──────────────────────────────

  describe('updateClaim — corrupted JSON', () => {
    it('returns early and logs warning when claim data is corrupted', async () => {
      kv._setRaw('claim:task-1:agent-1', '{corrupt');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await store.updateClaim('task-1:agent-1', { status: 'completed' });

      // Should not have written anything new (only the initial raw injection exists)
      const putCallsForKey = kv.putCalls.filter((c) => c.key === 'claim:task-1:agent-1');
      expect(putCallsForKey).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        'KV: corrupted claim entry claim:task-1:agent-1, skipping update',
      );
      warnSpy.mockRestore();
    });
  });

  // ── updateTask: TTL on terminal states ───────────────────────

  describe('updateTask — TTL on terminal states', () => {
    it('sets expirationTtl when status transitions to completed', async () => {
      await store.createTask(makeTask());
      kv.putCalls = [];

      await store.updateTask('task-1', { status: 'completed' });

      const taskPut = kv.putCalls.find((c) => c.key === 'task:task-1');
      expect(taskPut).toBeDefined();
      expect(taskPut!.options?.expirationTtl).toBe(SEVEN_DAYS);
    });

    it('sets expirationTtl when status transitions to timeout', async () => {
      await store.createTask(makeTask());
      kv.putCalls = [];

      await store.updateTask('task-1', { status: 'timeout' });

      const taskPut = kv.putCalls.find((c) => c.key === 'task:task-1');
      expect(taskPut!.options?.expirationTtl).toBe(SEVEN_DAYS);
    });

    it('sets expirationTtl when status transitions to failed', async () => {
      await store.createTask(makeTask());
      kv.putCalls = [];

      await store.updateTask('task-1', { status: 'failed' });

      const taskPut = kv.putCalls.find((c) => c.key === 'task:task-1');
      expect(taskPut!.options?.expirationTtl).toBe(SEVEN_DAYS);
    });

    it('does NOT set expirationTtl for non-terminal status', async () => {
      await store.createTask(makeTask());
      kv.putCalls = [];

      await store.updateTask('task-1', { status: 'reviewing' });

      const taskPut = kv.putCalls.find((c) => c.key === 'task:task-1');
      expect(taskPut).toBeDefined();
      expect(taskPut!.options?.expirationTtl).toBeUndefined();
    });

    it('does NOT set expirationTtl when updating non-status fields', async () => {
      await store.createTask(makeTask());
      kv.putCalls = [];

      await store.updateTask('task-1', { prompt: 'Updated prompt' });

      const taskPut = kv.putCalls.find((c) => c.key === 'task:task-1');
      expect(taskPut).toBeDefined();
      expect(taskPut!.options?.expirationTtl).toBeUndefined();
    });

    it('updates metadata on every task update', async () => {
      await store.createTask(makeTask());
      kv.putCalls = [];

      await store.updateTask('task-1', { status: 'reviewing' });

      const taskPut = kv.putCalls.find((c) => c.key === 'task:task-1');
      expect(taskPut!.options?.metadata).toEqual(expect.objectContaining({ status: 'reviewing' }));
    });
  });

  // ── updateClaim: TTL on terminal statuses ────────────────────

  describe('updateClaim — TTL on terminal statuses', () => {
    it('sets expirationTtl when claim status transitions to completed', async () => {
      await store.createClaim(makeClaim());
      kv.putCalls = [];

      await store.updateClaim('task-1:agent-1', { status: 'completed', review_text: 'LGTM' });

      const claimPut = kv.putCalls.find((c) => c.key === 'claim:task-1:agent-1');
      expect(claimPut).toBeDefined();
      expect(claimPut!.options).toEqual({ expirationTtl: SEVEN_DAYS });
    });

    it('sets expirationTtl when claim status transitions to rejected', async () => {
      await store.createClaim(makeClaim());
      kv.putCalls = [];

      await store.updateClaim('task-1:agent-1', { status: 'rejected' });

      const claimPut = kv.putCalls.find((c) => c.key === 'claim:task-1:agent-1');
      expect(claimPut!.options).toEqual({ expirationTtl: SEVEN_DAYS });
    });

    it('sets expirationTtl when claim status transitions to error', async () => {
      await store.createClaim(makeClaim());
      kv.putCalls = [];

      await store.updateClaim('task-1:agent-1', { status: 'error' });

      const claimPut = kv.putCalls.find((c) => c.key === 'claim:task-1:agent-1');
      expect(claimPut!.options).toEqual({ expirationTtl: SEVEN_DAYS });
    });

    it('does NOT set expirationTtl for non-terminal claim status', async () => {
      await store.createClaim(makeClaim());
      kv.putCalls = [];

      await store.updateClaim('task-1:agent-1', { status: 'active' });

      const claimPut = kv.putCalls.find((c) => c.key === 'claim:task-1:agent-1');
      expect(claimPut).toBeDefined();
      expect(claimPut!.options).toBeUndefined();
    });
  });

  // ── deleteTask: cleanup ────────────────────────────────────────

  describe('deleteTask', () => {
    it('removes task and associated claims', async () => {
      await store.createTask(makeTask());
      await store.createClaim(makeClaim({ task_id: 'task-1', agent_id: 'a1' }));

      await store.deleteTask('task-1');

      expect(await store.getTask('task-1')).toBeNull();
      const claims = await store.getClaims('task-1');
      expect(claims).toEqual([]);
    });

    it('task no longer appears in listTasks after deletion', async () => {
      await store.createTask(makeTask({ id: 'a' }));
      await store.createTask(makeTask({ id: 'b' }));

      await store.deleteTask('a');

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('b');
    });
  });
});
