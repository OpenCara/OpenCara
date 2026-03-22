import type { ReviewTask, TaskClaim, TaskStatus } from '@opencara/shared';
import type { TaskFilter } from '../types.js';
import type { DataStore } from './interface.js';
import { createLogger } from '../logger.js';

const TASK_PREFIX = 'task:';
const CLAIM_PREFIX = 'claim:';
const AGENT_PREFIX = 'agent:';
const LOCK_PREFIX = 'lock:';

/** Default TTL for terminal KV entries: 7 days */
export const DEFAULT_TTL_DAYS = 7;

const TERMINAL_TASK_STATES = ['completed', 'timeout', 'failed'];
const TERMINAL_CLAIM_STATUSES = ['completed', 'rejected', 'error'];

/** Module-level logger for KV store operations (avoids per-call instantiation). */
const kvLogger = createLogger();

/** Metadata stored on task KV entries for fast filtering via list(). */
interface TaskMetadata {
  status: TaskStatus;
  timeout_at: number;
}

/** Safely parse JSON, returning fallback on malformed input. */
export function safeParseJson<T>(raw: string, fallback: T | null = null): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    kvLogger.warn('KV: corrupted JSON entry, returning fallback');
    return fallback;
  }
}

/**
 * Cloudflare Workers KV-backed DataStore.
 *
 * Key layout:
 *   task:{id}                 → ReviewTask JSON (with metadata: { status, timeout_at })
 *   claim:{taskId}:{agentId}  → TaskClaim JSON
 *   agent:{agentId}           → last-seen timestamp (string)
 *   lock:{key}                → holder string (lock value)
 *
 * Task enumeration uses kv.list({ prefix: "task:" }) instead of a shared index,
 * eliminating the race condition where concurrent creates/deletes could lose entries
 * in a shared JSON array.
 */
export class KVDataStore implements DataStore {
  private readonly terminalTtl: number;

  constructor(
    private readonly kv: KVNamespace,
    ttlDays: number = DEFAULT_TTL_DAYS,
  ) {
    this.terminalTtl = ttlDays * 24 * 60 * 60;
  }

  // ── Tasks ──────────────────────────────────────────────────────

  async createTask(task: ReviewTask): Promise<void> {
    const metadata: TaskMetadata = {
      status: task.status,
      timeout_at: task.timeout_at,
    };
    await this.kv.put(`${TASK_PREFIX}${task.id}`, JSON.stringify(task), { metadata });
  }

  async getTask(id: string): Promise<ReviewTask | null> {
    const raw = await this.kv.get(`${TASK_PREFIX}${id}`);
    if (!raw) return null;
    return safeParseJson<ReviewTask>(raw);
  }

  async listTasks(filter?: TaskFilter): Promise<ReviewTask[]> {
    // Use kv.list() to enumerate all task keys, using metadata for fast filtering
    const listResult = await this.kv.list({ prefix: TASK_PREFIX });
    const tasks: ReviewTask[] = [];

    for (const key of listResult.keys) {
      const meta = key.metadata as TaskMetadata | undefined;

      // Fast-path filtering using metadata (avoids full JSON fetch)
      if (meta) {
        if (filter?.status && filter.status.length > 0 && !filter.status.includes(meta.status)) {
          continue;
        }
        if (filter?.timeout_before && meta.timeout_at > filter.timeout_before) {
          continue;
        }
      }

      // Fetch full task JSON
      const raw = await this.kv.get(key.name);
      if (!raw) continue;
      const task = safeParseJson<ReviewTask>(raw);
      if (!task) continue;

      // Double-check filter for tasks without metadata (backwards compatibility)
      if (!meta) {
        if (filter?.status && filter.status.length > 0 && !filter.status.includes(task.status)) {
          continue;
        }
        if (filter?.timeout_before && task.timeout_at > filter.timeout_before) {
          continue;
        }
      }

      tasks.push(task);
    }

    return tasks;
  }

  async updateTask(id: string, updates: Partial<ReviewTask>): Promise<boolean> {
    const task = await this.getTask(id);
    if (!task) return false;
    const updated = { ...task, ...updates };

    const metadata: TaskMetadata = {
      status: updated.status,
      timeout_at: updated.timeout_at,
    };

    const options: { expirationTtl?: number; metadata: TaskMetadata } = { metadata };
    if (TERMINAL_TASK_STATES.includes(updated.status)) {
      options.expirationTtl = this.terminalTtl;
    }

    await this.kv.put(`${TASK_PREFIX}${id}`, JSON.stringify(updated), options);
    return true;
  }

  async deleteTask(id: string): Promise<void> {
    await this.kv.delete(`${TASK_PREFIX}${id}`);

    // Delete associated lock (summary lock for this task)
    await this.kv.delete(`${LOCK_PREFIX}summary:${id}`);

    // Delete claims (best effort — list by prefix)
    const claimList = await this.kv.list({ prefix: `${CLAIM_PREFIX}${id}:` });
    for (const key of claimList.keys) {
      await this.kv.delete(key.name);
    }
  }

  // ── Claims ─────────────────────────────────────────────────────

  async createClaim(claim: TaskClaim): Promise<boolean> {
    const key = `${CLAIM_PREFIX}${claim.task_id}:${claim.agent_id}`;
    // Check if an active claim already exists for this (task_id, agent_id).
    // Terminal claims (rejected, error) are overwritten to allow re-claiming.
    // Note: this GET→PUT is not atomic — concurrent retries from the same agent
    // could both pass the check. This is acceptable since idempotent writes of
    // the same claim data are harmless, and distinct agents are differentiated
    // by the lock mechanism at claim time.
    const existing = await this.kv.get(key);
    if (existing) {
      const parsed = safeParseJson<TaskClaim>(existing);
      if (parsed && (parsed.status === 'pending' || parsed.status === 'completed')) {
        return false;
      }
      // Terminal claim — allow overwrite
    }
    await this.kv.put(key, JSON.stringify(claim));
    return true;
  }

  async getClaim(claimId: string): Promise<TaskClaim | null> {
    const raw = await this.kv.get(`${CLAIM_PREFIX}${claimId}`);
    if (!raw) return null;
    return safeParseJson<TaskClaim>(raw);
  }

  async getClaims(taskId: string): Promise<TaskClaim[]> {
    const claimList = await this.kv.list({ prefix: `${CLAIM_PREFIX}${taskId}:` });
    const claims: TaskClaim[] = [];

    for (const key of claimList.keys) {
      const raw = await this.kv.get(key.name);
      if (raw) {
        const claim = safeParseJson<TaskClaim>(raw);
        if (claim) {
          claims.push(claim);
        } else {
          kvLogger.warn('KV: skipping corrupted claim entry', { key: key.name });
        }
      }
    }

    return claims;
  }

  async updateClaim(claimId: string, updates: Partial<TaskClaim>): Promise<void> {
    // claimId format: {taskId}:{agentId}
    const key = `${CLAIM_PREFIX}${claimId}`;
    const raw = await this.kv.get(key);
    if (!raw) return;
    const claim = safeParseJson<TaskClaim>(raw);
    if (!claim) {
      kvLogger.warn('KV: corrupted claim entry, skipping update', { key });
      return;
    }
    const updated = { ...claim, ...updates };

    const options = TERMINAL_CLAIM_STATUSES.includes(updated.status)
      ? { expirationTtl: this.terminalTtl }
      : undefined;
    await this.kv.put(key, JSON.stringify(updated), options);
  }

  // ── Agent last-seen ────────────────────────────────────────────

  async setAgentLastSeen(agentId: string, timestamp: number): Promise<void> {
    await this.kv.put(`${AGENT_PREFIX}${agentId}`, String(timestamp));
  }

  async getAgentLastSeen(agentId: string): Promise<number | null> {
    const raw = await this.kv.get(`${AGENT_PREFIX}${agentId}`);
    if (!raw) return null;
    return parseInt(raw, 10);
  }

  // ── Locks ─────────────────────────────────────────────────

  async acquireLock(lockKey: string, holder: string): Promise<boolean> {
    const key = `${LOCK_PREFIX}${lockKey}`;
    const existing = await this.kv.get(key);
    if (existing) {
      // Lock already held — only succeed if same holder (idempotent)
      return existing === holder;
    }
    // No lock exists — write it. Under KV eventual consistency, two agents
    // may both see no lock and both write. The second write wins in KV,
    // but the claim endpoint's task-level guards provide the primary defense.
    // This lock is defense-in-depth checked at result submission time.
    await this.kv.put(key, holder, { expirationTtl: this.terminalTtl });
    return true;
  }

  async checkLock(lockKey: string, holder: string): Promise<boolean> {
    const key = `${LOCK_PREFIX}${lockKey}`;
    const current = await this.kv.get(key);
    return current === holder;
  }

  async isLockHeld(lockKey: string): Promise<boolean> {
    const key = `${LOCK_PREFIX}${lockKey}`;
    const current = await this.kv.get(key);
    return current !== null;
  }

  async releaseLock(lockKey: string): Promise<void> {
    await this.kv.delete(`${LOCK_PREFIX}${lockKey}`);
  }

  // ── Timeout check throttle ────────────────────────────────────

  private static readonly TIMEOUT_CHECK_KEY = 'meta:timeout_last_check';

  async getTimeoutLastCheck(): Promise<number> {
    const raw = await this.kv.get(KVDataStore.TIMEOUT_CHECK_KEY);
    if (!raw) return 0;
    const parsed = parseInt(raw, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  async setTimeoutLastCheck(timestamp: number): Promise<void> {
    await this.kv.put(KVDataStore.TIMEOUT_CHECK_KEY, String(timestamp));
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  /**
   * KV auto-expires terminal entries via expirationTtl, so this is a
   * defense-in-depth pass that explicitly deletes any terminal tasks
   * whose created_at is older than the TTL. Returns the count deleted.
   */
  async cleanupTerminalTasks(): Promise<number> {
    const ttlMs = this.terminalTtl * 1000;
    const cutoff = Date.now() - ttlMs;

    const terminalTasks = await this.listTasks({
      status: ['completed', 'timeout', 'failed'],
    });

    let deleted = 0;
    for (const task of terminalTasks) {
      if (task.created_at <= cutoff) {
        await this.deleteTask(task.id);
        deleted++;
      }
    }
    return deleted;
  }
}
