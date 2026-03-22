import type { ReviewTask, TaskClaim } from '@opencara/shared';
import type { TaskFilter } from '../types.js';
import type { DataStore } from './interface.js';
import { DEFAULT_TTL_DAYS } from './kv.js';

const TERMINAL_STATUSES = ['completed', 'timeout', 'failed'];

/**
 * In-memory DataStore for dev/testing. No mocks needed in tests.
 */
export class MemoryDataStore implements DataStore {
  private tasks = new Map<string, ReviewTask>();
  private claims = new Map<string, TaskClaim>();
  private agentLastSeen = new Map<string, number>();
  private locks = new Map<string, string>();
  private readonly ttlMs: number;

  constructor(ttlDays: number = DEFAULT_TTL_DAYS) {
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  }

  // Tasks

  async createTask(task: ReviewTask): Promise<void> {
    this.tasks.set(task.id, { ...task });
  }

  async getTask(id: string): Promise<ReviewTask | null> {
    const task = this.tasks.get(id);
    return task ? { ...task } : null;
  }

  async listTasks(filter?: TaskFilter): Promise<ReviewTask[]> {
    let results = [...this.tasks.values()];

    if (filter?.status && filter.status.length > 0) {
      results = results.filter((t) => filter.status!.includes(t.status));
    }

    if (filter?.timeout_before) {
      results = results.filter((t) => t.timeout_at <= filter.timeout_before!);
    }

    return results.map((t) => ({ ...t }));
  }

  async updateTask(id: string, updates: Partial<ReviewTask>): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task) return false;
    Object.assign(task, updates);
    return true;
  }

  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
    // Delete the summary lock for this task (exact key match to avoid substring collisions)
    this.locks.delete(`summary:${id}`);
    // Also delete associated claims
    for (const [claimId, claim] of this.claims) {
      if (claim.task_id === id) {
        this.claims.delete(claimId);
      }
    }
  }

  // Claims — returns false if (task_id, agent_id) already exists

  async createClaim(claim: TaskClaim): Promise<boolean> {
    // Dedup check: if an active claim with the same (task_id, agent_id) exists, reject.
    // Terminal claims (rejected, error) are overwritten to allow re-claiming after rejection.
    for (const [id, existing] of this.claims) {
      if (existing.task_id === claim.task_id && existing.agent_id === claim.agent_id) {
        if (existing.status === 'pending' || existing.status === 'completed') {
          return false;
        }
        // Remove the terminal claim so re-claim can proceed
        this.claims.delete(id);
      }
    }
    this.claims.set(claim.id, { ...claim });
    return true;
  }

  async getClaim(claimId: string): Promise<TaskClaim | null> {
    const claim = this.claims.get(claimId);
    return claim ? { ...claim } : null;
  }

  async getClaims(taskId: string): Promise<TaskClaim[]> {
    return [...this.claims.values()].filter((c) => c.task_id === taskId).map((c) => ({ ...c }));
  }

  async updateClaim(claimId: string, updates: Partial<TaskClaim>): Promise<void> {
    const claim = this.claims.get(claimId);
    if (claim) {
      Object.assign(claim, updates);
    }
  }

  // Locks — atomic acquire-or-fail

  async acquireLock(key: string, holder: string): Promise<boolean> {
    const existing = this.locks.get(key);
    if (existing) {
      return existing === holder; // Idempotent for same holder
    }
    this.locks.set(key, holder);
    return true;
  }

  async checkLock(key: string, holder: string): Promise<boolean> {
    return this.locks.get(key) === holder;
  }

  async isLockHeld(key: string): Promise<boolean> {
    return this.locks.has(key);
  }

  async releaseLock(key: string): Promise<void> {
    this.locks.delete(key);
  }

  // Agent last-seen

  async setAgentLastSeen(agentId: string, timestamp: number): Promise<void> {
    this.agentLastSeen.set(agentId, timestamp);
  }

  async getAgentLastSeen(agentId: string): Promise<number | null> {
    return this.agentLastSeen.get(agentId) ?? null;
  }

  // Timeout check throttle

  private timeoutLastCheck = 0;

  async getTimeoutLastCheck(): Promise<number> {
    return this.timeoutLastCheck;
  }

  async setTimeoutLastCheck(timestamp: number): Promise<void> {
    this.timeoutLastCheck = timestamp;
  }

  // Cleanup

  async cleanupTerminalTasks(): Promise<number> {
    const cutoff = Date.now() - this.ttlMs;
    let deleted = 0;
    for (const [id, task] of this.tasks) {
      if (TERMINAL_STATUSES.includes(task.status) && task.created_at <= cutoff) {
        this.tasks.delete(id);
        this.locks.delete(`summary:${id}`);
        for (const [claimId, claim] of this.claims) {
          if (claim.task_id === id) {
            this.claims.delete(claimId);
          }
        }
        deleted++;
      }
    }
    return deleted;
  }

  /** Clear all data. Test-only — not on the DataStore interface. */
  reset(): void {
    this.tasks.clear();
    this.claims.clear();
    this.agentLastSeen.clear();
    this.locks.clear();
    this.timeoutLastCheck = 0;
  }
}

/** @deprecated Use MemoryDataStore instead. Will be removed after D1 migration. */
export const MemoryTaskStore = MemoryDataStore;
/** @deprecated Use MemoryDataStore instead. */
export type MemoryTaskStore = MemoryDataStore;
