import type { ReviewTask, TaskClaim } from '@opencara/shared';
import type { TaskFilter } from '../types.js';

/**
 * DataStore — abstracted storage for tasks, claims, heartbeats, and meta.
 * Implementations: MemoryDataStore (dev/test), D1DataStore (production).
 */
export interface DataStore {
  // Tasks
  createTask(task: ReviewTask): Promise<void>;
  getTask(id: string): Promise<ReviewTask | null>;
  listTasks(filter?: TaskFilter): Promise<ReviewTask[]>;
  /** Find an active (pending/reviewing) task for a specific PR. Returns null if none exists. */
  findActiveTaskForPR(owner: string, repo: string, prNumber: number): Promise<ReviewTask | null>;
  updateTask(id: string, updates: Partial<ReviewTask>): Promise<boolean>;
  deleteTask(id: string): Promise<void>;

  // Claims — createClaim returns false if (task_id, agent_id) already exists
  createClaim(claim: TaskClaim): Promise<boolean>;
  getClaim(claimId: string): Promise<TaskClaim | null>;
  getClaims(taskId: string): Promise<TaskClaim[]>;
  updateClaim(claimId: string, updates: Partial<TaskClaim>): Promise<void>;

  // Review slot — atomic increment-if-below (prevents oversubscription)
  /** Atomically increment review_claims if review_claims < maxSlots (exclusive). Returns true if a slot was reserved. */
  claimReviewSlot(taskId: string, maxSlots: number): Promise<boolean>;
  /** Atomically decrement review_claims (floor at 0). Used to release a slot on claim failure. */
  releaseReviewSlot(taskId: string): Promise<boolean>;

  // Summary claim — atomic compare-and-swap (replaces locks)
  /** Atomically claim summary: sets queue='finished' + summary_agent_id only if queue='summary'. Returns true if claimed. */
  claimSummarySlot(taskId: string, agentId: string): Promise<boolean>;
  /** Release summary slot: sets queue='summary' + clears summary_agent_id. Used by reject/error/failure paths. */
  releaseSummarySlot(taskId: string): Promise<void>;

  // Agent heartbeats
  setAgentLastSeen(agentId: string, timestamp: number): Promise<void>;
  getAgentLastSeen(agentId: string): Promise<number | null>;

  // Meta (timeout throttle, etc.)
  getTimeoutLastCheck(): Promise<number>;
  setTimeoutLastCheck(timestamp: number): Promise<void>;

  // Cleanup
  /** Delete terminal tasks (completed/timeout/failed) older than the configured TTL. */
  cleanupTerminalTasks(): Promise<number>;
}
