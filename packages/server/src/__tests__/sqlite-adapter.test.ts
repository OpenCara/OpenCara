import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteD1Adapter } from '../adapters/sqlite.js';
import { D1DataStore } from '../store/d1.js';
import type { ReviewTask, TaskClaim } from '@opencara/shared';
import { DEFAULT_REVIEW_CONFIG } from '@opencara/shared';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Helpers ─────────────────────────────────────────────────────────

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../migrations');
const MIGRATION_SQL = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8'))
  .join('\n');

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
    review_count: 3,
    prompt: 'Review this PR',
    timeout_at: Date.now() + 600_000,
    status: 'pending',
    queue: 'review',
    github_installation_id: 123,
    private: false,
    config: DEFAULT_REVIEW_CONFIG,
    created_at: Date.now(),
    task_type: 'review',
    feature: 'review',
    group_id: 'group-1',
    ...overrides,
  };
}

function makeClaim(overrides: Partial<TaskClaim> = {}): TaskClaim {
  return {
    id: 'task-1:agent-1:review',
    task_id: 'task-1',
    agent_id: 'agent-1',
    role: 'review',
    status: 'pending',
    created_at: Date.now(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('SqliteD1Adapter', () => {
  let rawDb: Database.Database;
  let adapter: SqliteD1Adapter;

  beforeEach(() => {
    rawDb = new Database(':memory:');
    adapter = new SqliteD1Adapter(rawDb);
    // Apply migrations
    rawDb.exec(MIGRATION_SQL);
  });

  afterEach(() => {
    adapter.close();
  });

  describe('adapter layer', () => {
    it('prepare + bind + run inserts a row', async () => {
      const result = await adapter
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .bind('test_key', 'test_value')
        .run();

      expect(result.success).toBe(true);
      expect(result.meta?.changes).toBe(1);
    });

    it('prepare + bind + first reads a row', async () => {
      rawDb.exec("INSERT INTO meta (key, value) VALUES ('k1', 'v1')");

      const row = await adapter.prepare('SELECT * FROM meta WHERE key = ?').bind('k1').first<{
        key: string;
        value: string;
      }>();

      expect(row).toEqual({ key: 'k1', value: 'v1' });
    });

    it('first returns null when no row matches', async () => {
      const row = await adapter.prepare('SELECT * FROM meta WHERE key = ?').bind('missing').first();
      expect(row).toBeNull();
    });

    it('first with column returns scalar value', async () => {
      rawDb.exec("INSERT INTO meta (key, value) VALUES ('k1', 'v1')");

      const val = await adapter
        .prepare('SELECT value FROM meta WHERE key = ?')
        .bind('k1')
        .first<string>('value');

      expect(val).toBe('v1');
    });

    it('prepare + bind + all returns rows', async () => {
      rawDb.exec("INSERT INTO meta (key, value) VALUES ('a', '1'), ('b', '2')");

      const result = await adapter.prepare('SELECT * FROM meta ORDER BY key').bind().all<{
        key: string;
        value: string;
      }>();

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results?.[0].key).toBe('a');
      expect(result.results?.[1].key).toBe('b');
    });

    it('bind is immutable — returns new instance', async () => {
      const base = adapter.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
      const bound1 = base.bind('a', '1');
      const bound2 = base.bind('b', '2');

      // Both should succeed independently
      await bound1.run();
      await bound2.run();

      const result = await adapter.prepare('SELECT COUNT(*) as cnt FROM meta').bind().first<{
        cnt: number;
      }>();
      expect(result?.cnt).toBe(2);
    });

    it('batch executes multiple statements atomically', async () => {
      const results = await adapter.batch([
        adapter.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').bind('x', '1'),
        adapter.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').bind('y', '2'),
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);

      const all = await adapter.prepare('SELECT * FROM meta').bind().all();
      expect(all.results).toHaveLength(2);
    });

    it('PRAGMA foreign_keys is ON when constructed from path', () => {
      // Construct from path (using :memory: as path for testing)
      const pathAdapter = new SqliteD1Adapter(':memory:');
      const pathDb = (pathAdapter as unknown as { db: Database.Database }).db;
      const fk = pathDb.pragma('foreign_keys', { simple: true });
      expect(fk).toBe(1);
      pathAdapter.close();
    });

    it('PRAGMA journal_mode is WAL when constructed from path', () => {
      // Use a temp file for WAL test (WAL requires file-based database)
      const tmpPath = '/tmp/test-sqlite-wal-' + Date.now() + '.db';
      try {
        const pathAdapter = new SqliteD1Adapter(tmpPath);
        const pathDb = (pathAdapter as unknown as { db: Database.Database }).db;
        const mode = pathDb.pragma('journal_mode', { simple: true });
        expect(mode).toBe('wal');
        pathAdapter.close();
      } finally {
        try {
          fs.unlinkSync(tmpPath);
          fs.unlinkSync(tmpPath + '-wal');
          fs.unlinkSync(tmpPath + '-shm');
        } catch {
          // Ignore cleanup errors
        }
      }
    });
  });

  describe('D1DataStore integration via SQLite adapter', () => {
    let store: D1DataStore;

    beforeEach(() => {
      store = new D1DataStore(adapter);
    });

    it('creates and retrieves a task', async () => {
      const task = makeTask();
      await store.createTask(task);
      const retrieved = await store.getTask(task.id);
      expect(retrieved).toMatchObject({
        id: task.id,
        owner: task.owner,
        repo: task.repo,
        status: 'pending',
      });
    });

    it('lists tasks with status filter', async () => {
      await store.createTask(makeTask({ id: 'a', pr_number: 1, status: 'pending' }));
      await store.createTask(makeTask({ id: 'b', pr_number: 2, status: 'reviewing' }));
      await store.createTask(makeTask({ id: 'c', pr_number: 3, status: 'completed' }));

      const pending = await store.listTasks({ status: ['pending'] });
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('a');

      const active = await store.listTasks({ status: ['pending', 'reviewing'] });
      expect(active).toHaveLength(2);
    });

    it('updates a task', async () => {
      await store.createTask(makeTask());
      const updated = await store.updateTask('task-1', { status: 'reviewing' });
      expect(updated).toBe(true);

      const task = await store.getTask('task-1');
      expect(task?.status).toBe('reviewing');
    });

    it('deletes a task and cascades claims', async () => {
      await store.createTask(makeTask());
      await store.createClaim(makeClaim());
      await store.deleteTask('task-1');

      expect(await store.getTask('task-1')).toBeNull();
      expect(await store.getClaim('task-1:agent-1')).toBeNull();
    });

    it('creates a claim and prevents duplicate', async () => {
      await store.createTask(makeTask());
      const first = await store.createClaim(makeClaim());
      expect(first).toBe(true);

      // Duplicate should fail (same agent_id + task_id + role)
      const dup = await store.createClaim(makeClaim({ id: 'task-1:agent-1:review-dup' }));
      expect(dup).toBe(false);
    });

    it('allows re-claim after rejected claim', async () => {
      await store.createTask(makeTask());
      await store.createClaim(makeClaim());
      await store.updateClaim('task-1:agent-1:review', { status: 'rejected' });

      // Re-claim should succeed
      const reclaim = await store.createClaim(
        makeClaim({ id: 'task-1:agent-1:review-v2', status: 'pending' }),
      );
      expect(reclaim).toBe(true);
    });

    it('claims and releases summary slots', async () => {
      await store.createTask(makeTask({ queue: 'summary' }));

      const claimed = await store.claimSummarySlot('task-1', 'agent-a');
      expect(claimed).toBe(true);

      const task = await store.getTask('task-1');
      expect(task?.queue).toBe('finished');
      expect(task?.summary_agent_id).toBe('agent-a');

      // Second claim should fail
      const duplicate = await store.claimSummarySlot('task-1', 'agent-b');
      expect(duplicate).toBe(false);

      // Release and re-claim
      await store.releaseSummarySlot('task-1');
      const released = await store.getTask('task-1');
      expect(released?.queue).toBe('summary');

      const reclaimed = await store.claimSummarySlot('task-1', 'agent-b');
      expect(reclaimed).toBe(true);
    });

    it('handles agent heartbeats', async () => {
      const now = Date.now();
      await store.setAgentLastSeen('agent-1', now);
      expect(await store.getAgentLastSeen('agent-1')).toBe(now);
      expect(await store.getAgentLastSeen('unknown')).toBeNull();
    });

    it('handles timeout meta', async () => {
      expect(await store.getTimeoutLastCheck()).toBe(0);
      await store.setTimeoutLastCheck(12345);
      expect(await store.getTimeoutLastCheck()).toBe(12345);
    });

    it('cleans up terminal tasks older than TTL', async () => {
      const old = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
      await store.createTask(makeTask({ id: 'old-task', status: 'completed', created_at: old }));
      await store.createTask(makeTask({ id: 'fresh-task', status: 'completed' }));

      const deleted = await store.cleanupTerminalTasks();
      expect(deleted).toBe(1);
      expect(await store.getTask('old-task')).toBeNull();
      expect(await store.getTask('fresh-task')).not.toBeNull();
    });

    it('preserves boolean and JSON fields round-trip', async () => {
      const task = makeTask({ private: true, queue: 'summary', summary_agent_id: 'agent-1' });
      await store.createTask(task);
      const retrieved = await store.getTask(task.id);
      expect(retrieved?.private).toBe(true);
      expect(retrieved?.queue).toBe('summary');
      expect(retrieved?.summary_agent_id).toBe('agent-1');
    });

    // ── createTaskIfNotExists (atomic dedup) ──────────────────

    it('createTaskIfNotExists creates task when no active task exists', async () => {
      const task = makeTask({ id: 'new-1', owner: 'org', repo: 'repo', pr_number: 10 });
      const created = await store.createTaskIfNotExists(task);
      expect(created).toBe(true);
      expect(await store.getTask('new-1')).not.toBeNull();
    });

    it('createTaskIfNotExists returns false when pending task exists for same PR', async () => {
      await store.createTask(
        makeTask({ id: 'existing', owner: 'org', repo: 'repo', pr_number: 10 }),
      );
      const task = makeTask({ id: 'dup', owner: 'org', repo: 'repo', pr_number: 10 });
      const created = await store.createTaskIfNotExists(task);
      expect(created).toBe(false);
      expect(await store.getTask('dup')).toBeNull();
    });

    it('createTaskIfNotExists returns false when reviewing task exists for same PR', async () => {
      await store.createTask(
        makeTask({
          id: 'existing',
          owner: 'org',
          repo: 'repo',
          pr_number: 10,
          status: 'reviewing',
        }),
      );
      const task = makeTask({ id: 'dup', owner: 'org', repo: 'repo', pr_number: 10 });
      const created = await store.createTaskIfNotExists(task);
      expect(created).toBe(false);
      expect(await store.getTask('dup')).toBeNull();
    });

    it('createTaskIfNotExists succeeds when existing task is completed', async () => {
      await store.createTask(
        makeTask({
          id: 'old',
          owner: 'org',
          repo: 'repo',
          pr_number: 10,
          status: 'completed',
        }),
      );
      const task = makeTask({ id: 'new-1', owner: 'org', repo: 'repo', pr_number: 10 });
      const created = await store.createTaskIfNotExists(task);
      expect(created).toBe(true);
      expect(await store.getTask('new-1')).not.toBeNull();
    });

    it('createTaskIfNotExists succeeds when existing task is for different PR', async () => {
      await store.createTask(makeTask({ id: 'other', owner: 'org', repo: 'repo', pr_number: 5 }));
      const task = makeTask({ id: 'new-1', owner: 'org', repo: 'repo', pr_number: 10 });
      const created = await store.createTaskIfNotExists(task);
      expect(created).toBe(true);
    });

    it('createTaskIfNotExists succeeds when existing task is for different repo', async () => {
      await store.createTask(
        makeTask({ id: 'other', owner: 'org', repo: 'other-repo', pr_number: 10 }),
      );
      const task = makeTask({ id: 'new-1', owner: 'org', repo: 'repo', pr_number: 10 });
      const created = await store.createTaskIfNotExists(task);
      expect(created).toBe(true);
    });

    it('createTaskIfNotExists succeeds when existing task has timeout status', async () => {
      await store.createTask(
        makeTask({
          id: 'old',
          owner: 'org',
          repo: 'repo',
          pr_number: 10,
          status: 'timeout',
        }),
      );
      const task = makeTask({ id: 'new-1', owner: 'org', repo: 'repo', pr_number: 10 });
      const created = await store.createTaskIfNotExists(task);
      expect(created).toBe(true);
    });

    it('createTaskIfNotExists succeeds when existing task has failed status', async () => {
      await store.createTask(
        makeTask({
          id: 'old',
          owner: 'org',
          repo: 'repo',
          pr_number: 10,
          status: 'failed',
        }),
      );
      const task = makeTask({ id: 'new-1', owner: 'org', repo: 'repo', pr_number: 10 });
      const created = await store.createTaskIfNotExists(task);
      expect(created).toBe(true);
    });

    it('partial unique index prevents duplicate active tasks at DB level', async () => {
      await store.createTask(
        makeTask({ id: 'first', owner: 'org', repo: 'repo', pr_number: 10, status: 'pending' }),
      );

      await expect(
        store.createTask(
          makeTask({
            id: 'second',
            owner: 'org',
            repo: 'repo',
            pr_number: 10,
            status: 'pending',
          }),
        ),
      ).rejects.toThrow(/UNIQUE constraint failed/);
    });

    it('createTaskIfNotExists returns false on constraint violation', async () => {
      // Directly insert a pending task
      await store.createTask(
        makeTask({ id: 'first', owner: 'org', repo: 'repo', pr_number: 10, status: 'pending' }),
      );

      // createTaskIfNotExists should return false (caught by WHERE NOT EXISTS)
      const task = makeTask({ id: 'dup', owner: 'org', repo: 'repo', pr_number: 10 });
      const created = await store.createTaskIfNotExists(task);
      expect(created).toBe(false);
    });
  });

  describe('agent rejections (D1)', () => {
    let store: D1DataStore;

    beforeEach(() => {
      store = new D1DataStore(adapter);
    });

    it('recordAgentRejection inserts a row and countAgentRejections reads it', async () => {
      const now = Date.now();
      await store.recordAgentRejection('agent-1', 'too_short', now);
      await store.recordAgentRejection('agent-1', 'too_long', now);
      await store.recordAgentRejection('agent-2', 'too_short', now);

      expect(await store.countAgentRejections('agent-1', now - 1000)).toBe(2);
      expect(await store.countAgentRejections('agent-2', now - 1000)).toBe(1);
      expect(await store.countAgentRejections('agent-3', now - 1000)).toBe(0);
    });

    it('countAgentRejections respects time window', async () => {
      const old = Date.now() - 100_000;
      const recent = Date.now();

      await store.recordAgentRejection('agent-1', 'too_short', old);
      await store.recordAgentRejection('agent-1', 'too_short', recent);

      expect(await store.countAgentRejections('agent-1', recent - 1000)).toBe(1);
      expect(await store.countAgentRejections('agent-1', old - 1000)).toBe(2);
    });
  });

  // ── OAuth token cache (D1) ─────────────────────────────────────

  describe('OAuth token cache (D1)', () => {
    let store: D1DataStore;

    beforeEach(() => {
      store = new D1DataStore(adapter);
    });

    it('returns null for missing cache entry', async () => {
      const result = await store.getOAuthCache('nonexistent-hash');
      expect(result).toBeNull();
    });

    it('stores and retrieves a cached identity', async () => {
      const identity = { github_user_id: 42, github_username: 'octocat', verified_at: Date.now() };
      await store.setOAuthCache('hash-abc', identity, 60_000);
      const cached = await store.getOAuthCache('hash-abc');
      expect(cached).toEqual(identity);
    });

    it('returns null for expired entries', async () => {
      const identity = { github_user_id: 42, github_username: 'octocat', verified_at: Date.now() };
      // Use a TTL of -1 to immediately expire
      await store.setOAuthCache('hash-expired', identity, -1);
      const cached = await store.getOAuthCache('hash-expired');
      expect(cached).toBeNull();
    });

    it('upserts on conflict (same token_hash)', async () => {
      const id1 = { github_user_id: 1, github_username: 'user1', verified_at: 100 };
      const id2 = { github_user_id: 2, github_username: 'user2', verified_at: 200 };
      await store.setOAuthCache('hash-upsert', id1, 60_000);
      await store.setOAuthCache('hash-upsert', id2, 60_000);
      const cached = await store.getOAuthCache('hash-upsert');
      expect(cached?.github_user_id).toBe(2);
      expect(cached?.github_username).toBe('user2');
    });

    it('cleanupExpiredOAuthCache removes expired entries and keeps valid ones', async () => {
      const identity = { github_user_id: 42, github_username: 'octocat', verified_at: Date.now() };
      await store.setOAuthCache('hash-expired', identity, -1);
      await store.setOAuthCache('hash-valid', identity, 60_000);
      const removed = await store.cleanupExpiredOAuthCache();
      expect(removed).toBe(1);
      expect(await store.getOAuthCache('hash-expired')).toBeNull();
      expect(await store.getOAuthCache('hash-valid')).not.toBeNull();
    });

    it('cleanupExpiredOAuthCache returns 0 when no expired entries', async () => {
      const identity = { github_user_id: 42, github_username: 'octocat', verified_at: Date.now() };
      await store.setOAuthCache('hash-valid', identity, 60_000);
      const removed = await store.cleanupExpiredOAuthCache();
      expect(removed).toBe(0);
    });
  });
});
