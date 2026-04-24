import type { ReviewTask, TaskClaim, VerifiedIdentity } from '@opencara/shared';
import type { TaskFilter } from '../types.js';

export interface PostedReview {
  id: number;
  owner: string;
  repo: string;
  pr_number: number;
  group_id: string;
  github_comment_id: number;
  feature: string;
  posted_at: string;
  reactions_checked_at: string | null;
}

export interface ReputationEvent {
  id: number;
  posted_review_id: number;
  agent_id: string;
  operator_github_user_id: number;
  github_user_id: number;
  delta: number; // +1 or -1
  created_at: string;
}

/**
 * DataStore — abstracted storage for tasks, claims, heartbeats, and meta.
 * Implementations: MemoryDataStore (dev/test), D1DataStore (production).
 */
export interface DataStore {
  // Tasks
  createTask(task: ReviewTask): Promise<void>;
  /** Create multiple tasks in a single batch. Uses D1 batch on production. */
  createTaskBatch(tasks: ReviewTask[]): Promise<void>;
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
  /** Delete all pending tasks for a given PR. Returns number of deleted tasks. */
  deletePendingTasksByPr(owner: string, repo: string, prNumber: number): Promise<number>;
  /** Delete all pending tasks for a given issue. Returns number of deleted tasks. */
  deletePendingTasksByIssue(owner: string, repo: string, issueNumber: number): Promise<number>;
  /** Delete all active (pending/reviewing) tasks for a given issue and feature. Returns number deleted. */
  deleteActiveTasksByIssueAndFeature(
    owner: string,
    repo: string,
    issueNumber: number,
    feature: string,
  ): Promise<number>;

  // Claims — createClaim returns false if (task_id, agent_id) already exists
  createClaim(claim: TaskClaim): Promise<boolean>;
  /**
   * Atomically create a worker claim only if no other non-terminal worker
   * claim (`review` or `issue_review`, `pending`/`completed`) in the given
   * group already uses the claim's model. Strict model diversity (#785).
   *
   * Returns:
   *   - `'ok'` — claim inserted.
   *   - `'model_conflict'` — another agent already holds a non-terminal worker
   *     claim with the same model in this group; nothing was inserted.
   *   - `'agent_conflict'` — an active claim already exists for this
   *     (task_id, agent_id, role); nothing was inserted.
   *
   * Must be implemented so that the model-conflict check and the insert are a
   * single atomic operation (e.g. a SQLite `INSERT ... WHERE NOT EXISTS`
   * statement). This is the sole authority on duplicate-model rejection — the
   * poll-side visibility check is a fast-path hint, not a correctness gate.
   */
  createWorkerClaimIfNoModelConflict(
    claim: TaskClaim,
    groupId: string,
  ): Promise<'ok' | 'model_conflict' | 'agent_conflict'>;
  getClaim(claimId: string): Promise<TaskClaim | null>;
  /** Batch fetch multiple claims by ID. Returns a Map of claimId → TaskClaim for found claims. */
  getClaimsBatch(claimIds: string[]): Promise<Map<string, TaskClaim>>;
  getClaims(taskId: string): Promise<TaskClaim[]>;
  updateClaim(claimId: string, updates: Partial<TaskClaim>): Promise<void>;
  /**
   * Refresh per-claim liveness timestamp. Only succeeds on claims that are
   * still `pending` — returns false if the claim doesn't exist or has
   * already transitioned to a terminal state, so the route can map the
   * result to a 404 for stale/racing callers.
   */
  updateClaimHeartbeat(claimId: string, timestamp: number): Promise<boolean>;

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
  /**
   * Atomically complete a worker task and create a summary task if all workers
   * in the group are done. Uses a single D1 batch transaction to prevent race
   * conditions where concurrent result submissions could both miss or both
   * create the summary task.
   *
   * Returns true if the summary task was created, false otherwise.
   */
  completeWorkerAndMaybeCreateSummary(
    workerTaskId: string,
    summaryTask: ReviewTask,
  ): Promise<boolean>;

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
  recordAgentRejection(
    agentId: string,
    reason: string,
    timestamp: number,
    githubUserId?: number,
  ): Promise<void>;
  /** Count rejections for an agent within a time window. */
  countAgentRejections(agentId: string, sinceMs: number): Promise<number>;
  /** Count rejections across all agents for a given GitHub user within a time window. */
  countAccountRejections(githubUserId: number, sinceMs: number): Promise<number>;

  // Posted reviews (reputation reaction tracking)
  /** Record a posted review comment for later reaction fetching. Returns the inserted row ID. */
  recordPostedReview(review: {
    owner: string;
    repo: string;
    pr_number: number;
    group_id: string;
    github_comment_id: number;
    feature: string;
    posted_at: string;
  }): Promise<number>;
  /** Get all posted reviews for a PR. */
  getPostedReviewsByPr(owner: string, repo: string, prNumber: number): Promise<PostedReview[]>;
  /** Mark a posted review's reactions as checked at the given timestamp. */
  markReactionsChecked(postedReviewId: number, timestamp: string): Promise<void>;

  // Reputation events (append-only reaction-derived scores)
  /** Record a reputation event. Uses INSERT OR IGNORE for idempotency (UNIQUE constraint). */
  recordReputationEvent(event: {
    posted_review_id: number;
    agent_id: string;
    operator_github_user_id: number;
    github_user_id: number;
    delta: number;
    created_at: string;
  }): Promise<void>;
  /** Get reputation events for an agent since a given timestamp. */
  getAgentReputationEvents(agentId: string, sinceMs: number): Promise<ReputationEvent[]>;
  /** Get reputation events for an operator account since a given timestamp. */
  getAccountReputationEvents(
    operatorGithubUserId: number,
    sinceMs: number,
  ): Promise<ReputationEvent[]>;

  // Agent cooldown (last completed claim timestamp)
  /** Get the timestamp of an agent's most recent completed claim. Returns null if none. */
  getAgentLastCompletedClaimAt(agentId: string): Promise<number | null>;

  // Agent reliability (recent success/error outcome events for dispatch weighting)
  /** Append a reliability event when a task completes or errors. */
  recordAgentReliabilityEvent(
    agentId: string,
    outcome: 'success' | 'error',
    createdAt: string,
  ): Promise<void>;
  /** Batch-fetch recent reliability events for multiple agents in one query. */
  getAgentReliabilityEventsBatch(
    agentIds: readonly string[],
    sinceMs: number,
  ): Promise<Map<string, Array<{ outcome: 'success' | 'error'; created_at: string }>>>;

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
  /**
   * Delete `agent_reliability_events` rows whose `created_at` is older than the
   * given cutoff timestamp (ms since epoch). Returns the number of rows deleted.
   * Safe because reliability queries use a fixed rolling window and never read
   * events older than `RELIABILITY_WINDOW_MS`.
   */
  cleanupStaleReliabilityEvents(olderThanMs: number): Promise<number>;
  /**
   * Delete `reputation_events` rows whose `created_at` is older than the given
   * cutoff timestamp (ms since epoch). Returns the number of rows deleted.
   * Intended to be called with a very conservative cutoff (e.g. 180 days) where
   * per-event decay weight is effectively zero.
   */
  cleanupStaleReputationEvents(olderThanMs: number): Promise<number>;
}
