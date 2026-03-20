import type { ReviewTask, TaskClaim } from '@opencara/shared';
import type { TaskFilter } from '../types.js';
import type { TaskStore } from './interface.js';

const TASK_PREFIX = 'task:';
const CLAIM_PREFIX = 'claim:';
const AGENT_PREFIX = 'agent:';
const TASK_INDEX_KEY = 'task_index';

/**
 * Cloudflare Workers KV-backed TaskStore.
 *
 * Key layout:
 *   task:{id}              → ReviewTask JSON
 *   claim:{taskId}:{agentId} → TaskClaim JSON
 *   agent:{agentId}        → last-seen timestamp (string)
 *   task_index             → JSON array of task IDs (for listing)
 */
export class KVTaskStore implements TaskStore {
  constructor(private readonly kv: KVNamespace) {}

  // ── Tasks ──────────────────────────────────────────────────────

  async createTask(task: ReviewTask): Promise<void> {
    await this.kv.put(`${TASK_PREFIX}${task.id}`, JSON.stringify(task));
    // Add to index
    const index = await this.getTaskIndex();
    index.push(task.id);
    await this.kv.put(TASK_INDEX_KEY, JSON.stringify(index));
  }

  async getTask(id: string): Promise<ReviewTask | null> {
    const raw = await this.kv.get(`${TASK_PREFIX}${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as ReviewTask;
  }

  async listTasks(filter?: TaskFilter): Promise<ReviewTask[]> {
    const index = await this.getTaskIndex();
    const tasks: ReviewTask[] = [];

    for (const id of index) {
      const task = await this.getTask(id);
      if (!task) continue;

      if (filter?.status && filter.status.length > 0 && !filter.status.includes(task.status)) {
        continue;
      }
      if (filter?.timeout_before && task.timeout_at > filter.timeout_before) {
        continue;
      }

      tasks.push(task);
    }

    return tasks;
  }

  async updateTask(id: string, updates: Partial<ReviewTask>): Promise<boolean> {
    const task = await this.getTask(id);
    if (!task) return false;
    const updated = { ...task, ...updates };
    await this.kv.put(`${TASK_PREFIX}${id}`, JSON.stringify(updated));

    // Remove from index when reaching terminal state to prevent unbounded growth
    const terminalStates = ['completed', 'timeout', 'failed'];
    if (updates.status && terminalStates.includes(updates.status)) {
      const index = await this.getTaskIndex();
      const filtered = index.filter((tid) => tid !== id);
      await this.kv.put(TASK_INDEX_KEY, JSON.stringify(filtered));
    }

    return true;
  }

  async deleteTask(id: string): Promise<void> {
    await this.kv.delete(`${TASK_PREFIX}${id}`);
    // Remove from index
    const index = await this.getTaskIndex();
    const filtered = index.filter((tid) => tid !== id);
    await this.kv.put(TASK_INDEX_KEY, JSON.stringify(filtered));

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

  async getClaims(taskId: string): Promise<TaskClaim[]> {
    const claimList = await this.kv.list({ prefix: `${CLAIM_PREFIX}${taskId}:` });
    const claims: TaskClaim[] = [];

    for (const key of claimList.keys) {
      const raw = await this.kv.get(key.name);
      if (raw) {
        claims.push(JSON.parse(raw) as TaskClaim);
      }
    }

    return claims;
  }

  async updateClaim(claimId: string, updates: Partial<TaskClaim>): Promise<void> {
    // claimId format: {taskId}:{agentId}
    const key = `${CLAIM_PREFIX}${claimId}`;
    const raw = await this.kv.get(key);
    if (!raw) return;
    const claim = JSON.parse(raw) as TaskClaim;
    const updated = { ...claim, ...updates };
    await this.kv.put(key, JSON.stringify(updated));
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

  // ── Helpers ────────────────────────────────────────────────────

  private async getTaskIndex(): Promise<string[]> {
    const raw = await this.kv.get(TASK_INDEX_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as string[];
  }
}
