import type { ReviewTask, TaskClaim, VerifiedIdentity } from '@opencara/shared';
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
   * for the same PR and feature. Returns true if the task was created, false if
   * a duplicate exists. This prevents race conditions from concurrent webhook
   * deliveries while allowing multiple task groups for different features on
   * the same PR.
   */
  createTaskIfNotExists(task: ReviewTask): Promise<boolean>;
  getTask(id: string): Promise<ReviewTask | null>;
  listTasks(filter?: TaskFilter): Promise<ReviewTask[]>;
  updateTask(id: string, updates: Partial<ReviewTask>): Promise<boolean>;
  deleteTask(id: string): Promise<void>;

  // Claims — createClaim returns false if (task_id, agent_id) already exists
  createClaim(claim: TaskClaim): Promise<boolean>;
  getClaim(claimId: string): Promise<TaskClaim | null>;
  /** Batch fetch multiple claims by ID. Returns a Map of claimId → TaskClaim for found claims. */
  getClaimsBatch(claimIds: string[]): Promise<Map<string, TaskClaim>>;
  getClaims(taskId: string): Promise<TaskClaim[]>;
  updateClaim(claimId: string, updates: Partial<TaskClaim>): Promise<void>;

  // ── Generic task claiming (new separate task model) ────────
  /** Atomically transition a task from pending → reviewing. Returns true if claimed. */
  claimTask(taskId: string): Promise<boolean>;
  /** Release a claimed task: reviewing → pending. */
  releaseTask(taskId: string): Promise<void>;

  // ── Group queries (tasks linked by group_id) ──────────────
  /** Get all tasks belonging to a group. */
  getTasksByGroup(groupId: string): Promise<ReviewTask[]>;
  /** Count completed tasks in a group. */
  countCompletedInGroup(groupId: string): Promise<number>;
  /** Count tasks currently being worked on (status=reviewing) in a group. */
  countWorkerTasksInGroup(groupId: string): Promise<number>;
  /** Delete all tasks in a group (cascade deletes claims). */
  deleteTasksByGroup(groupId: string): Promise<void>;

  // ── Deprecated slot-counting methods (will be removed) ────
  /** @deprecated Use claimTask instead. Atomically increment completed_reviews. */
  incrementCompletedReviews(taskId: string): Promise<{ newCount: number; queue: string } | null>;
  /** @deprecated Atomically increment summary_retry_count. */
  incrementSummaryRetryCount(taskId: string): Promise<number | null>;
  /** @deprecated Use claimTask instead. Atomically increment review_claims if < maxSlots. */
  claimReviewSlot(taskId: string, maxSlots: number): Promise<boolean>;
  /** @deprecated Use releaseTask instead. Atomically decrement review_claims. */
  releaseReviewSlot(taskId: string): Promise<boolean>;
  /** @deprecated Use claimTask instead. Atomically claim summary slot. */
  claimSummarySlot(taskId: string, agentId: string): Promise<boolean>;
  /** @deprecated Use releaseTask instead. Release summary slot. */
  releaseSummarySlot(taskId: string): Promise<void>;

  // Agent heartbeats
  setAgentLastSeen(agentId: string, timestamp: number): Promise<void>;
  getAgentLastSeen(agentId: string): Promise<number | null>;
  /** List all agent heartbeats where last_seen >= sinceMs. */
  listAgentHeartbeats(sinceMs: number): Promise<Array<{ agent_id: string; last_seen: number }>>;
  /** Get aggregated claim stats for multiple agents in a single query. */
  getAgentClaimStatsBatch(
    agentIds: string[],
  ): Promise<
    Map<
      string,
      { total: number; completed: number; rejected: number; error: number; pending: number }
    >
  >;

  // Meta (timeout throttle, etc.)
  getTimeoutLastCheck(): Promise<number>;
  setTimeoutLastCheck(timestamp: number): Promise<void>;

  // Heartbeat-based reclaim
  /** Free pending claims from agents not seen within staleThresholdMs. Returns count of freed claims. */
  reclaimAbandonedClaims(staleThresholdMs: number): Promise<number>;
  /** Release summary slots held by agents not seen within staleThresholdMs. Returns count of freed slots. */
  reclaimAbandonedSummarySlots(staleThresholdMs: number): Promise<number>;

  // Agent rejections (abuse tracking)
  /** Record a review_text validation rejection for an agent. */
  recordAgentRejection(agentId: string, reason: string, timestamp: number): Promise<void>;
  /** Count rejections for an agent within a time window. */
  countAgentRejections(agentId: string, sinceMs: number): Promise<number>;

  // OAuth token cache
  /** Look up a cached verified identity by token hash. Returns null if not found or expired. */
  getOAuthCache(tokenHash: string): Promise<VerifiedIdentity | null>;
  /** Cache a verified identity with a TTL. */
  setOAuthCache(tokenHash: string, identity: VerifiedIdentity, ttlMs: number): Promise<void>;
  /** Delete expired OAuth cache entries. Returns the number of entries removed. */
  cleanupExpiredOAuthCache(): Promise<number>;

  // Cleanup
  /** Delete terminal tasks (completed/timeout/failed) older than the configured TTL. */
  cleanupTerminalTasks(): Promise<number>;
}
