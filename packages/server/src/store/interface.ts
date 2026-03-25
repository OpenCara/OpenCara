import type { ReviewTask, TaskClaim } from '@opencara/shared';
import type { TaskFilter } from '../types.js';

/**
 * DataStore — abstracted storage for tasks, claims, heartbeats, and meta.
 * Implementations: MemoryDataStore (dev/test), D1DataStore (production).
 */
export interface DataStore {
  // Tasks
  createTask(task: ReviewTask): Promise<void>;
  /**
   * Atomically create a task only if no active (pending/reviewing) task exists
   * for the same PR. Returns true if the task was created, false if a duplicate exists.
   * This prevents race conditions from concurrent webhook deliveries.
   */
  createTaskIfNotExists(task: ReviewTask): Promise<boolean>;
  getTask(id: string): Promise<ReviewTask | null>;
  listTasks(filter?: TaskFilter): Promise<ReviewTask[]>;
  updateTask(id: string, updates: Partial<ReviewTask>): Promise<boolean>;
  deleteTask(id: string): Promise<void>;

  // Claims — createClaim returns false if (task_id, agent_id) already exists
  createClaim(claim: TaskClaim): Promise<boolean>;
  getClaim(claimId: string): Promise<TaskClaim | null>;
  getClaims(taskId: string): Promise<TaskClaim[]>;
  updateClaim(claimId: string, updates: Partial<TaskClaim>): Promise<void>;

  // Completed reviews — atomic increment (prevents lost increments under concurrency)
  /** Atomically increment completed_reviews and return the new count plus the current queue state. */
  incrementCompletedReviews(taskId: string): Promise<{ newCount: number; queue: string } | null>;

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
  /** List all agent heartbeats where last_seen >= sinceMs. */
  listAgentHeartbeats(sinceMs: number): Promise<Array<{ agent_id: string; last_seen: number }>>;
  /** Get aggregated claim stats for a single agent. */
  getAgentClaimStats(agentId: string): Promise<{
    total: number;
    completed: number;
    rejected: number;
    error: number;
    pending: number;
  }>;

  // Meta (timeout throttle, etc.)
  getTimeoutLastCheck(): Promise<number>;
  setTimeoutLastCheck(timestamp: number): Promise<void>;

  // Heartbeat-based reclaim
  /** Free pending claims from agents not seen within staleThresholdMs. Returns count of freed claims. */
  reclaimAbandonedClaims(staleThresholdMs: number): Promise<number>;
  /** Release summary slots held by agents not seen within staleThresholdMs. Returns count of freed slots. */
  reclaimAbandonedSummarySlots(staleThresholdMs: number): Promise<number>;

  // Cleanup
  /** Delete terminal tasks (completed/timeout/failed) older than the configured TTL. */
  cleanupTerminalTasks(): Promise<number>;
}
