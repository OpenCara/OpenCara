import type { ReviewTask, TaskClaim } from '@opencara/shared';
import type { TaskFilter } from '../types.js';
import type { DataStore } from './interface.js';
import { DEFAULT_TTL_DAYS } from './constants.js';

const TERMINAL_STATUSES = ['completed', 'timeout', 'failed'];

/**
 * In-memory DataStore for dev/testing. No mocks needed in tests.
 */
export class MemoryDataStore implements DataStore {
  private tasks = new Map<string, ReviewTask>();
  private claims = new Map<string, TaskClaim>();
  private agentLastSeen = new Map<string, number>();
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

  async findActiveTaskForPR(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<ReviewTask | null> {
    for (const task of this.tasks.values()) {
      if (
        task.owner === owner &&
        task.repo === repo &&
        task.pr_number === prNumber &&
        (task.status === 'pending' || task.status === 'reviewing')
      ) {
        return { ...task };
      }
    }
    return null;
  }

  async updateTask(id: string, updates: Partial<ReviewTask>): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task) return false;
    Object.assign(task, updates);
    return true;
  }

  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
    // Also delete associated claims
    for (const [claimId, claim] of this.claims) {
      if (claim.task_id === id) {
        this.claims.delete(claimId);
      }
    }
  }

  // Claims — returns false if (task_id, agent_id, role) already has an active claim

  async createClaim(claim: TaskClaim): Promise<boolean> {
    // Dedup check: if an active claim with the same (task_id, agent_id, role) exists, reject.
    // Terminal claims (rejected, error) are overwritten to allow re-claiming after rejection.
    // Role-aware: a reviewer can also create a separate summary claim.
    for (const [id, existing] of this.claims) {
      if (
        existing.task_id === claim.task_id &&
        existing.agent_id === claim.agent_id &&
        existing.role === claim.role
      ) {
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

  // Summary claim — atomic compare-and-swap (replaces locks)

  async claimSummarySlot(taskId: string, agentId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.queue !== 'summary') return false;
    task.queue = 'finished';
    task.summary_agent_id = agentId;
    return true;
  }

  async releaseSummarySlot(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task && task.queue === 'finished') {
      task.queue = 'summary';
      task.summary_agent_id = undefined;
    }
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
    this.timeoutLastCheck = 0;
  }
}
