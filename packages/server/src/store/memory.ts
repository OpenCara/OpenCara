import type { ReviewTask, TaskClaim, VerifiedIdentity } from '@opencara/shared';
import type { TaskFilter } from '../types.js';
import type { DataStore, PostedReview, ReputationEvent } from './interface.js';
import { DEFAULT_TTL_DAYS } from './constants.js';
import { MissingBaseRefError, violatesBaseRefInvariant } from '../errors.js';

const TERMINAL_STATUSES = ['completed', 'timeout', 'failed'];

/**
 * In-memory DataStore for dev/testing. No mocks needed in tests.
 */
export class MemoryDataStore implements DataStore {
  private tasks = new Map<string, ReviewTask>();
  private claims = new Map<string, TaskClaim>();
  private agentLastSeen = new Map<string, number>();
  private agentRejections: Array<{
    agent_id: string;
    reason: string;
    created_at: number;
    github_user_id?: number;
  }> = [];
  private oauthCache = new Map<string, { identity: VerifiedIdentity; expires_at: number }>();
  private postedReviews: PostedReview[] = [];
  private postedReviewNextId = 1;
  private reputationEvents: ReputationEvent[] = [];
  private reputationEventNextId = 1;
  private reliabilityEvents: Array<{
    agent_id: string;
    outcome: 'success' | 'error';
    created_at: string;
  }> = [];
  private readonly ttlMs: number;

  constructor(ttlDays: number = DEFAULT_TTL_DAYS) {
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  }

  // Tasks

  /**
   * Throw if the base_ref invariant is violated. Memory throws (CI safety)
   * while D1 logs-and-proceeds (see #776). Both behaviors share the
   * `violatesBaseRefInvariant` predicate.
   */
  private assertBaseRef(task: ReviewTask): void {
    if (violatesBaseRefInvariant(task)) {
      throw new MissingBaseRefError({
        id: task.id,
        owner: task.owner,
        repo: task.repo,
        pr_number: task.pr_number,
        feature: task.feature,
      });
    }
  }

  async createTask(task: ReviewTask): Promise<void> {
    this.assertBaseRef(task);
    this.tasks.set(task.id, { ...task });
  }

  async createTaskBatch(tasks: ReviewTask[]): Promise<void> {
    for (const task of tasks) this.assertBaseRef(task);
    for (const task of tasks) {
      this.tasks.set(task.id, { ...task });
    }
  }

  async createTaskIfNotExists(task: ReviewTask): Promise<boolean> {
    this.assertBaseRef(task);
    // Check-and-insert in a single synchronous block (atomic in single-threaded JS).
    // For issue tasks (pr_number=0 + issue_number set), dedup by issue_number
    // instead of pr_number so different issues don't collide.
    const isIssueTask = task.pr_number === 0 && task.issue_number !== undefined;

    for (const existing of this.tasks.values()) {
      if (
        existing.owner !== task.owner ||
        existing.repo !== task.repo ||
        existing.feature !== task.feature ||
        (existing.status !== 'pending' && existing.status !== 'reviewing')
      ) {
        continue;
      }

      if (isIssueTask) {
        if (existing.issue_number === task.issue_number) return false;
      } else {
        if (existing.pr_number === task.pr_number) return false;
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

  async deletePendingTasksByPr(owner: string, repo: string, prNumber: number): Promise<number> {
    let count = 0;
    for (const [id, task] of this.tasks) {
      if (
        task.owner === owner &&
        task.repo === repo &&
        task.pr_number === prNumber &&
        task.status === 'pending'
      ) {
        this.tasks.delete(id);
        for (const [claimId, claim] of this.claims) {
          if (claim.task_id === id) this.claims.delete(claimId);
        }
        count++;
      }
    }
    return count;
  }

  async deletePendingTasksByIssue(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<number> {
    let count = 0;
    for (const [id, task] of this.tasks) {
      if (
        task.owner === owner &&
        task.repo === repo &&
        task.issue_number === issueNumber &&
        task.pr_number === 0 &&
        task.status === 'pending'
      ) {
        this.tasks.delete(id);
        for (const [claimId, claim] of this.claims) {
          if (claim.task_id === id) this.claims.delete(claimId);
        }
        count++;
      }
    }
    return count;
  }

  async deleteActiveTasksByIssueAndFeature(
    owner: string,
    repo: string,
    issueNumber: number,
    feature: string,
  ): Promise<number> {
    let count = 0;
    for (const [id, task] of this.tasks) {
      if (
        task.owner === owner &&
        task.repo === repo &&
        task.issue_number === issueNumber &&
        task.pr_number === 0 &&
        task.feature === feature &&
        (task.status === 'pending' || task.status === 'reviewing')
      ) {
        this.tasks.delete(id);
        // Also delete associated claims (mirrors ON DELETE CASCADE)
        for (const [claimId, claim] of this.claims) {
          if (claim.task_id === id) this.claims.delete(claimId);
        }
        count++;
      }
    }
    return count;
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

  async getClaimsBatch(claimIds: string[]): Promise<Map<string, TaskClaim>> {
    const map = new Map<string, TaskClaim>();
    for (const id of claimIds) {
      const claim = this.claims.get(id);
      if (claim) {
        map.set(id, { ...claim });
      }
    }
    return map;
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

  async updateClaimHeartbeat(claimId: string, timestamp: number): Promise<boolean> {
    const claim = this.claims.get(claimId);
    if (!claim || claim.status !== 'pending') return false;
    claim.last_heartbeat_at = timestamp;
    return true;
  }

  // ── Generic task claiming (new separate task model) ─────────

  async claimTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'pending') return false;
    task.status = 'reviewing';
    return true;
  }

  async releaseTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task && task.status === 'reviewing') {
      task.status = 'pending';
    }
  }

  // ── Group queries ──────────────────────────────────────────

  async getTasksByGroup(groupId: string): Promise<ReviewTask[]> {
    return [...this.tasks.values()].filter((t) => t.group_id === groupId).map((t) => ({ ...t }));
  }

  async countCompletedInGroup(groupId: string): Promise<number> {
    return [...this.tasks.values()].filter(
      (t) => t.group_id === groupId && t.status === 'completed',
    ).length;
  }

  async countWorkerTasksInGroup(groupId: string): Promise<number> {
    return [...this.tasks.values()].filter(
      (t) => t.group_id === groupId && t.status === 'reviewing',
    ).length;
  }

  async deleteTasksByGroup(groupId: string): Promise<void> {
    for (const [id, task] of this.tasks) {
      if (task.group_id === groupId) {
        this.tasks.delete(id);
        // Also delete associated claims (mirrors ON DELETE CASCADE)
        for (const [claimId, claim] of this.claims) {
          if (claim.task_id === id) {
            this.claims.delete(claimId);
          }
        }
      }
    }
  }

  async completeWorkerAndMaybeCreateSummary(
    workerTaskId: string,
    summaryTask: ReviewTask,
  ): Promise<boolean> {
    // Validate the summary BEFORE mutating worker state — otherwise a throw
    // here leaves the worker marked completed with no summary created, which
    // would permanently stick the group. Fail fast, no side effects.
    // (Bot review on #781 flagged this ordering in the pre-flip hard-reject
    // design; the fix is still correct under Memory's throw behavior.)
    this.assertBaseRef(summaryTask);

    // In single-threaded JS, this is inherently atomic.
    // Step 1: Mark worker as completed
    const worker = this.tasks.get(workerTaskId);
    if (worker) {
      worker.status = 'completed';
    }

    // Step 2: Check if all worker tasks in the group are completed
    const groupId = summaryTask.group_id;
    const groupTasks = [...this.tasks.values()].filter((t) => t.group_id === groupId);
    const workerTypes = new Set(['review', 'issue_review']);
    const reviewTasks = groupTasks.filter((t) => workerTypes.has(t.task_type));
    const completedReviews = reviewTasks.filter((t) => t.status === 'completed');

    if (completedReviews.length < reviewTasks.length) return false;

    // Step 3: Check no active summary task already exists
    const activeSummary = groupTasks.find(
      (t) => t.task_type === 'summary' && (t.status === 'pending' || t.status === 'reviewing'),
    );
    if (activeSummary) return false;

    // Step 4: Create the summary task (no need to re-assert — checked above).
    this.tasks.set(summaryTask.id, { ...summaryTask });
    return true;
  }

  // ── Deprecated: Completed reviews — atomic increment ───────

  /** @deprecated Use claimTask instead. */
  async incrementCompletedReviews(
    taskId: string,
  ): Promise<{ newCount: number; queue: string } | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.completed_reviews = (task.completed_reviews ?? 0) + 1;
    return { newCount: task.completed_reviews, queue: task.queue };
  }

  // Deprecated: Summary retry count — atomic increment

  /** @deprecated */
  async incrementSummaryRetryCount(taskId: string): Promise<number | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.summary_retry_count = (task.summary_retry_count ?? 0) + 1;
    return task.summary_retry_count;
  }

  // Deprecated: Review slot — atomic check-and-increment

  /** @deprecated Use claimTask instead. */
  async claimReviewSlot(taskId: string, maxSlots: number): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    const current = task.review_claims ?? 0;
    if (current >= maxSlots) return false;
    task.review_claims = current + 1;
    return true;
  }

  /** @deprecated Use releaseTask instead. */
  async releaseReviewSlot(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || (task.review_claims ?? 0) <= 0) return false;
    task.review_claims = (task.review_claims ?? 0) - 1;
    return true;
  }

  // Deprecated: Summary claim — atomic compare-and-swap (replaces locks)

  /** @deprecated Use claimTask instead. */
  async claimSummarySlot(taskId: string, agentId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.queue !== 'summary') return false;
    task.queue = 'finished';
    task.summary_agent_id = agentId;
    return true;
  }

  /** @deprecated Use releaseTask instead. */
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

  async getAgentClaimStatsBatch(
    agentIds: string[],
  ): Promise<
    Map<
      string,
      { total: number; completed: number; rejected: number; error: number; pending: number }
    >
  > {
    const map = new Map<
      string,
      { total: number; completed: number; rejected: number; error: number; pending: number }
    >();
    if (agentIds.length === 0) return map;

    const idSet = new Set(agentIds);
    for (const claim of this.claims.values()) {
      if (!idSet.has(claim.agent_id)) continue;
      let stats = map.get(claim.agent_id);
      if (!stats) {
        stats = { total: 0, completed: 0, rejected: 0, error: 0, pending: 0 };
        map.set(claim.agent_id, stats);
      }
      stats.total++;
      if (claim.status === 'completed') stats.completed++;
      else if (claim.status === 'rejected') stats.rejected++;
      else if (claim.status === 'error') stats.error++;
      else if (claim.status === 'pending') stats.pending++;
    }
    return map;
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
      // Reclaim precedence (per #783):
      //  1. Per-claim last_heartbeat_at — authoritative when present.
      //  2. Agent-level last_seen — fallback for old CLIs that don't send
      //     /heartbeat (claim-hb is undefined).
      //  3. claim.created_at — last resort when agent has never checked in.
      if (claim.last_heartbeat_at !== undefined) {
        if (claim.last_heartbeat_at >= cutoff) continue; // Active per-claim
      } else {
        const lastSeen = this.agentLastSeen.get(claim.agent_id);
        if (lastSeen !== undefined) {
          if (lastSeen >= cutoff) continue; // Agent is active
        } else {
          // No heartbeat — only reclaim if the claim itself is old
          if (claim.created_at >= cutoff) continue;
        }
      }
      claim.status = 'error';
      const task = this.tasks.get(claim.task_id);
      if (task) {
        // New model: release the task (reviewing → pending) so another agent can claim it
        if (task.status === 'reviewing') {
          task.status = 'pending';
        }
        // Old model (backward compat): decrement slot counters
        if (claim.role === 'review') {
          if ((task.review_claims ?? 0) > 0) {
            task.review_claims = (task.review_claims ?? 0) - 1;
          }
        } else if (claim.role === 'summary') {
          if (task.queue === 'finished' && task.summary_agent_id === claim.agent_id) {
            task.queue = 'summary';
            task.summary_agent_id = undefined;
          }
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

  // Agent rejections (abuse tracking)

  async recordAgentRejection(
    agentId: string,
    reason: string,
    timestamp: number,
    githubUserId?: number,
  ): Promise<void> {
    this.agentRejections.push({
      agent_id: agentId,
      reason,
      created_at: timestamp,
      github_user_id: githubUserId,
    });
  }

  async countAgentRejections(agentId: string, sinceMs: number): Promise<number> {
    return this.agentRejections.filter((r) => r.agent_id === agentId && r.created_at >= sinceMs)
      .length;
  }

  async countAccountRejections(githubUserId: number, sinceMs: number): Promise<number> {
    return this.agentRejections.filter(
      (r) => r.github_user_id === githubUserId && r.created_at >= sinceMs,
    ).length;
  }

  // Posted reviews (reputation reaction tracking)

  async recordPostedReview(review: {
    owner: string;
    repo: string;
    pr_number: number;
    group_id: string;
    github_comment_id: number;
    feature: string;
    posted_at: string;
  }): Promise<number> {
    const id = this.postedReviewNextId++;
    this.postedReviews.push({
      id,
      owner: review.owner,
      repo: review.repo,
      pr_number: review.pr_number,
      group_id: review.group_id,
      github_comment_id: review.github_comment_id,
      feature: review.feature,
      posted_at: review.posted_at,
      reactions_checked_at: null,
    });
    return id;
  }

  async getPostedReviewsByPr(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PostedReview[]> {
    return this.postedReviews.filter(
      (r) => r.owner === owner && r.repo === repo && r.pr_number === prNumber,
    );
  }

  async markReactionsChecked(postedReviewId: number, timestamp: string): Promise<void> {
    const review = this.postedReviews.find((r) => r.id === postedReviewId);
    if (review) {
      review.reactions_checked_at = timestamp;
    }
  }

  // Reputation events (append-only)

  async recordReputationEvent(event: {
    posted_review_id: number;
    agent_id: string;
    operator_github_user_id: number;
    github_user_id: number;
    delta: number;
    created_at: string;
  }): Promise<void> {
    // Idempotent: skip if (posted_review_id, agent_id, github_user_id) already exists
    const exists = this.reputationEvents.some(
      (e) =>
        e.posted_review_id === event.posted_review_id &&
        e.agent_id === event.agent_id &&
        e.github_user_id === event.github_user_id,
    );
    if (exists) return;
    this.reputationEvents.push({
      id: this.reputationEventNextId++,
      ...event,
    });
  }

  async getAgentReputationEvents(agentId: string, sinceMs: number): Promise<ReputationEvent[]> {
    const sinceIso = new Date(sinceMs).toISOString();
    return this.reputationEvents.filter((e) => e.agent_id === agentId && e.created_at >= sinceIso);
  }

  async getAccountReputationEvents(
    operatorGithubUserId: number,
    sinceMs: number,
  ): Promise<ReputationEvent[]> {
    const sinceIso = new Date(sinceMs).toISOString();
    return this.reputationEvents.filter(
      (e) => e.operator_github_user_id === operatorGithubUserId && e.created_at >= sinceIso,
    );
  }

  // Agent cooldown

  async getAgentLastCompletedClaimAt(agentId: string): Promise<number | null> {
    let latest: number | null = null;
    for (const claim of this.claims.values()) {
      if (claim.agent_id === agentId && claim.status === 'completed') {
        if (latest === null || claim.created_at > latest) {
          latest = claim.created_at;
        }
      }
    }
    return latest;
  }

  // Agent reliability (recent success/error outcomes)

  async recordAgentReliabilityEvent(
    agentId: string,
    outcome: 'success' | 'error',
    createdAt: string,
  ): Promise<void> {
    this.reliabilityEvents.push({ agent_id: agentId, outcome, created_at: createdAt });
  }

  async getAgentReliabilityEventsBatch(
    agentIds: readonly string[],
    sinceMs: number,
  ): Promise<Map<string, Array<{ outcome: 'success' | 'error'; created_at: string }>>> {
    const result = new Map<string, Array<{ outcome: 'success' | 'error'; created_at: string }>>();
    if (agentIds.length === 0) return result;
    const allowed = new Set(agentIds);
    const sinceIso = new Date(sinceMs).toISOString();
    for (const e of this.reliabilityEvents) {
      if (!allowed.has(e.agent_id) || e.created_at < sinceIso) continue;
      let list = result.get(e.agent_id);
      if (!list) {
        list = [];
        result.set(e.agent_id, list);
      }
      list.push({ outcome: e.outcome, created_at: e.created_at });
    }
    return result;
  }

  // OAuth token cache

  async getOAuthCache(tokenHash: string): Promise<VerifiedIdentity | null> {
    const entry = this.oauthCache.get(tokenHash);
    if (!entry || entry.expires_at <= Date.now()) return null;
    return { ...entry.identity };
  }

  async setOAuthCache(tokenHash: string, identity: VerifiedIdentity, ttlMs: number): Promise<void> {
    this.oauthCache.set(tokenHash, {
      identity: { ...identity },
      expires_at: Date.now() + ttlMs,
    });
  }

  async cleanupExpiredOAuthCache(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.oauthCache) {
      if (entry.expires_at <= now) {
        this.oauthCache.delete(key);
        removed++;
      }
    }
    return removed;
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

  async cleanupStaleReliabilityEvents(olderThanMs: number): Promise<number> {
    const cutoffIso = new Date(olderThanMs).toISOString();
    const before = this.reliabilityEvents.length;
    this.reliabilityEvents = this.reliabilityEvents.filter((e) => e.created_at >= cutoffIso);
    return before - this.reliabilityEvents.length;
  }

  async cleanupStaleReputationEvents(olderThanMs: number): Promise<number> {
    const cutoffIso = new Date(olderThanMs).toISOString();
    const before = this.reputationEvents.length;
    this.reputationEvents = this.reputationEvents.filter((e) => e.created_at >= cutoffIso);
    return before - this.reputationEvents.length;
  }

  /** Clear all data. Test-only — not on the DataStore interface. */
  reset(): void {
    this.tasks.clear();
    this.claims.clear();
    this.agentLastSeen.clear();
    this.agentRejections = [];
    this.oauthCache.clear();
    this.postedReviews = [];
    this.postedReviewNextId = 1;
    this.reputationEvents = [];
    this.reputationEventNextId = 1;
    this.reliabilityEvents = [];
    this.timeoutLastCheck = 0;
  }
}
