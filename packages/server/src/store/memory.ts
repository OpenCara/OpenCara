import type { ReviewTask, TaskClaim } from '@opencara/shared';
import type { TaskFilter } from '../types.js';
import type { TaskStore } from './interface.js';

/**
 * In-memory TaskStore for dev/testing. No mocks needed in tests.
 */
export class MemoryTaskStore implements TaskStore {
  private tasks = new Map<string, ReviewTask>();
  private claims = new Map<string, TaskClaim>();
  private agentLastSeen = new Map<string, number>();

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
    // Also delete associated claims
    for (const [claimId, claim] of this.claims) {
      if (claim.task_id === id) {
        this.claims.delete(claimId);
      }
    }
  }

  // Claims

  async createClaim(claim: TaskClaim): Promise<void> {
    this.claims.set(claim.id, { ...claim });
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

  // Agent last-seen

  async setAgentLastSeen(agentId: string, timestamp: number): Promise<void> {
    this.agentLastSeen.set(agentId, timestamp);
  }

  async getAgentLastSeen(agentId: string): Promise<number | null> {
    return this.agentLastSeen.get(agentId) ?? null;
  }

  /** Clear all data. Test-only — not on the TaskStore interface. */
  reset(): void {
    this.tasks.clear();
    this.claims.clear();
    this.agentLastSeen.clear();
  }
}
