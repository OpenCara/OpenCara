import type { ReviewTask, TaskClaim, TaskStatus } from '@opencara/shared';
import type { TaskFilter } from '../types.js';
import type { TaskStore } from './interface.js';

const TASK_PREFIX = 'task:';
const CLAIM_PREFIX = 'claim:';
const AGENT_PREFIX = 'agent:';

/** TTL for terminal KV entries: 7 days in seconds */
const TERMINAL_TTL = 7 * 24 * 60 * 60;

const TERMINAL_TASK_STATES = ['completed', 'timeout', 'failed'];
const TERMINAL_CLAIM_STATUSES = ['completed', 'rejected', 'error'];

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
    console.warn('KV: corrupted JSON entry, returning fallback');
    return fallback;
  }
}

/**
 * Cloudflare Workers KV-backed TaskStore.
 *
 * Key layout:
 *   task:{id}                 → ReviewTask JSON (with metadata: { status, timeout_at })
 *   claim:{taskId}:{agentId}  → TaskClaim JSON
 *   agent:{agentId}           → last-seen timestamp (string)
 *
 * Task enumeration uses kv.list({ prefix: "task:" }) instead of a shared index,
 * eliminating the race condition where concurrent creates/deletes could lose entries
 * in a shared JSON array.
 */
export class KVTaskStore implements TaskStore {
  constructor(private readonly kv: KVNamespace) {}

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
      options.expirationTtl = TERMINAL_TTL;
    }

    await this.kv.put(`${TASK_PREFIX}${id}`, JSON.stringify(updated), options);
    return true;
  }

  async deleteTask(id: string): Promise<void> {
    await this.kv.delete(`${TASK_PREFIX}${id}`);

    // Delete claims (best effort — list by prefix)
    const claimList = await this.kv.list({ prefix: `${CLAIM_PREFIX}${id}:` });
    for (const key of claimList.keys) {
      await this.kv.delete(key.name);
    }
  }

  // ── Claims ─────────────────────────────────────────────────────

  async createClaim(claim: TaskClaim): Promise<void> {
    await this.kv.put(`${CLAIM_PREFIX}${claim.task_id}:${claim.agent_id}`, JSON.stringify(claim));
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
          console.warn(`KV: skipping corrupted claim entry at ${key.name}`);
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
      console.warn(`KV: corrupted claim entry ${key}, skipping update`);
      return;
    }
    const updated = { ...claim, ...updates };

    const options = TERMINAL_CLAIM_STATUSES.includes(updated.status)
      ? { expirationTtl: TERMINAL_TTL }
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

  // ── Timeout check throttle ────────────────────────────────────

  private static readonly TIMEOUT_CHECK_KEY = 'meta:timeout_last_check';

  async getTimeoutLastCheck(): Promise<number> {
    const raw = await this.kv.get(KVTaskStore.TIMEOUT_CHECK_KEY);
    if (!raw) return 0;
    return parseInt(raw, 10);
  }

  async setTimeoutLastCheck(timestamp: number): Promise<void> {
    await this.kv.put(KVTaskStore.TIMEOUT_CHECK_KEY, String(timestamp));
  }
}
