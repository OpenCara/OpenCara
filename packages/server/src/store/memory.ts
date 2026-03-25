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

  async createTaskIfNotExists(task: ReviewTask): Promise<boolean> {
    // Check-and-insert in a single synchronous block (atomic in single-threaded JS)
    for (const existing of this.tasks.values()) {
      if (
        existing.owner === task.owner &&
        existing.repo === task.repo &&
        existing.pr_number === task.pr_number &&
        (existing.status === 'pending' || existing.status === 'reviewing')
      ) {
        return false;
      }
    }
    this.tasks.set(task.id, { ...task });
    return true;
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

  // Completed reviews — atomic increment

  async incrementCompletedReviews(
    taskId: string,
  ): Promise<{ newCount: number; queue: string } | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.completed_reviews = (task.completed_reviews ?? 0) + 1;
    return { newCount: task.completed_reviews, queue: task.queue };
  }

  // Review slot — atomic check-and-increment

  async claimReviewSlot(taskId: string, maxSlots: number): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    const current = task.review_claims ?? 0;
    if (current >= maxSlots) return false;
    task.review_claims = current + 1;
    return true;
  }

  async releaseReviewSlot(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || (task.review_claims ?? 0) <= 0) return false;
    task.review_claims = (task.review_claims ?? 0) - 1;
    return true;
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

  async listAgentHeartbeats(
    sinceMs: number,
  ): Promise<Array<{ agent_id: string; last_seen: number }>> {
    const results: Array<{ agent_id: string; last_seen: number }> = [];
    for (const [agent_id, last_seen] of this.agentLastSeen) {
      if (last_seen >= sinceMs) {
        results.push({ agent_id, last_seen });
      }
    }
    return results;
  }

  async getAgentClaimStats(agentId: string): Promise<{
    total: number;
    completed: number;
    rejected: number;
    error: number;
    pending: number;
  }> {
    const stats = { total: 0, completed: 0, rejected: 0, error: 0, pending: 0 };
    for (const claim of this.claims.values()) {
      if (claim.agent_id !== agentId) continue;
      stats.total++;
      if (claim.status === 'completed') stats.completed++;
      else if (claim.status === 'rejected') stats.rejected++;
      else if (claim.status === 'error') stats.error++;
      else if (claim.status === 'pending') stats.pending++;
    }
    return stats;
  }

  // Timeout check throttle

  private timeoutLastCheck = 0;

  async getTimeoutLastCheck(): Promise<number> {
    return this.timeoutLastCheck;
  }

  async setTimeoutLastCheck(timestamp: number): Promise<void> {
    this.timeoutLastCheck = timestamp;
  }

  // Heartbeat-based reclaim

  async reclaimAbandonedClaims(staleThresholdMs: number): Promise<number> {
    const now = Date.now();
    const cutoff = now - staleThresholdMs;
    let freed = 0;

    for (const claim of this.claims.values()) {
      if (claim.status !== 'pending') continue;
      const lastSeen = this.agentLastSeen.get(claim.agent_id);
      // Reclaim if agent has a stale heartbeat, OR if no heartbeat exists
      // and the claim itself is older than the threshold.
      if (lastSeen !== undefined) {
        if (lastSeen >= cutoff) continue; // Agent is active
      } else {
        // No heartbeat — only reclaim if the claim itself is old
        if (claim.created_at >= cutoff) continue;
      }
      claim.status = 'error';
      if (claim.role === 'review') {
        const task = this.tasks.get(claim.task_id);
        if (task && (task.review_claims ?? 0) > 0) {
          task.review_claims = (task.review_claims ?? 0) - 1;
        }
      }
      freed++;
    }
    return freed;
  }

  async reclaimAbandonedSummarySlots(staleThresholdMs: number): Promise<number> {
    const now = Date.now();
    const cutoff = now - staleThresholdMs;
    let freed = 0;

    for (const task of this.tasks.values()) {
      if (task.queue !== 'finished' || !task.summary_agent_id) continue;
      const lastSeen = this.agentLastSeen.get(task.summary_agent_id);
      // Reclaim if agent has a stale heartbeat, OR if no heartbeat exists
      // and the task has been in summary phase longer than the threshold.
      if (lastSeen !== undefined) {
        if (lastSeen >= cutoff) continue;
      } else {
        // No heartbeat — use reviews_completed_at (when task entered summary phase)
        // as fallback, falling back to created_at for single-review tasks.
        const fallbackTime = task.reviews_completed_at ?? task.created_at;
        if (fallbackTime >= cutoff) continue;
      }
      task.queue = 'summary';
      task.summary_agent_id = undefined;
      freed++;
    }
    return freed;
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
