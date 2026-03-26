import type { ReviewTask, TaskClaim, VerifiedIdentity } from '@opencara/shared';
import type { TaskFilter } from '../types.js';
import type { DataStore } from './interface.js';
import { DEFAULT_TTL_DAYS } from './constants.js';

/** Terminal task statuses eligible for cleanup. */
const TERMINAL_STATUSES = ['completed', 'timeout', 'failed'];

/**
 * D1 database binding interface — subset of Cloudflare D1 API used by this store.
 * Using a minimal interface allows easy mocking in tests.
 */
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1Result>;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta?: {
    changes?: number;
    last_row_id?: number;
    changed_db?: boolean;
    size_after?: number;
    rows_read?: number;
    rows_written?: number;
    duration?: number;
  };
}

// ── Row ↔ Object conversion ──────────────────────────────────────

interface TaskRow {
  id: string;
  owner: string;
  repo: string;
  pr_number: number;
  pr_url: string;
  diff_url: string;
  base_ref: string;
  head_ref: string;
  review_count: number;
  prompt: string;
  timeout_at: number;
  status: string;
  queue: string;
  github_installation_id: number;
  private: number; // SQLite stores booleans as 0/1
  config: string; // JSON string
  created_at: number;
  review_claims: number;
  completed_reviews: number;
  reviews_completed_at: number | null;
  summary_agent_id: string | null;
  summary_retry_count: number;
  // New unified fields
  task_type: string;
  feature: string;
  group_id: string;
  issue_number: number | null;
  issue_url: string | null;
  issue_title: string | null;
  issue_body: string | null;
  issue_author: string | null;
  dedup_target: string | null;
  index_issue_number: number | null;
}

interface ClaimRow {
  id: string;
  task_id: string;
  agent_id: string;
  role: string;
  status: string;
  model: string | null;
  tool: string | null;
  thinking: string | null;
  review_text: string | null;
  verdict: string | null;
  tokens_used: number | null;
  github_user_id: number | null;
  github_username: string | null;
  created_at: number;
}

/** Convert a D1 row to a ReviewTask object. */
export function rowToTask(row: TaskRow): ReviewTask {
  const task: ReviewTask = {
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    pr_number: row.pr_number,
    pr_url: row.pr_url,
    diff_url: row.diff_url,
    base_ref: row.base_ref,
    head_ref: row.head_ref,
    review_count: row.review_count,
    prompt: row.prompt,
    timeout_at: row.timeout_at,
    status: row.status as ReviewTask['status'],
    queue: (row.queue ?? 'review') as ReviewTask['queue'],
    task_type: (row.task_type ?? 'review') as ReviewTask['task_type'],
    feature: (row.feature ?? 'review') as ReviewTask['feature'],
    group_id: row.group_id ?? row.id,
    github_installation_id: row.github_installation_id,
    private: Boolean(row.private),
    config: JSON.parse(row.config),
    created_at: row.created_at,
    review_claims: row.review_claims,
    completed_reviews: row.completed_reviews,
  };

  if (row.reviews_completed_at !== null) {
    task.reviews_completed_at = row.reviews_completed_at;
  }
  if (row.summary_agent_id !== null) {
    task.summary_agent_id = row.summary_agent_id;
  }
  task.summary_retry_count = row.summary_retry_count;

  // Optional issue fields
  if (row.issue_number !== null) task.issue_number = row.issue_number;
  if (row.issue_url !== null) task.issue_url = row.issue_url;
  if (row.issue_title !== null) task.issue_title = row.issue_title;
  if (row.issue_body !== null) task.issue_body = row.issue_body;
  if (row.issue_author !== null) task.issue_author = row.issue_author;

  // Optional dedup fields
  if (row.dedup_target !== null) task.dedup_target = row.dedup_target as ReviewTask['dedup_target'];
  if (row.index_issue_number !== null) task.index_issue_number = row.index_issue_number;

  return task;
}

/** Convert a D1 row to a TaskClaim object. */
export function rowToClaim(row: ClaimRow): TaskClaim {
  const claim: TaskClaim = {
    id: row.id,
    task_id: row.task_id,
    agent_id: row.agent_id,
    role: row.role as TaskClaim['role'],
    status: row.status as TaskClaim['status'],
    created_at: row.created_at,
  };

  if (row.model !== null) claim.model = row.model;
  if (row.tool !== null) claim.tool = row.tool;
  if (row.thinking !== null) claim.thinking = row.thinking;
  if (row.review_text !== null) claim.review_text = row.review_text;
  if (row.verdict !== null) claim.verdict = row.verdict as TaskClaim['verdict'];
  if (row.tokens_used !== null) claim.tokens_used = row.tokens_used;
  if (row.github_user_id !== null) claim.github_user_id = row.github_user_id;
  if (row.github_username !== null) claim.github_username = row.github_username;

  return claim;
}

// ── D1DataStore ──────────────────────────────────────────────────

/**
 * Cloudflare D1 (SQLite) backed DataStore.
 *
 * Provides atomic operations via SQL constraints:
 * - Claims: UNIQUE(task_id, agent_id) constraint prevents duplicate claims
 * - Locks: INSERT OR IGNORE + PRIMARY KEY provides atomic acquire-or-fail
 * - Heartbeats: ON CONFLICT DO UPDATE for upsert
 */
export class D1DataStore implements DataStore {
  private readonly ttlMs: number;

  constructor(
    private readonly db: D1Database,
    ttlDays: number = DEFAULT_TTL_DAYS,
  ) {
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  }

  // ── Tasks ──────────────────────────────────────────────────────

  async createTask(task: ReviewTask): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tasks (id, owner, repo, pr_number, pr_url, diff_url, base_ref, head_ref,
        review_count, prompt, timeout_at, status, queue, github_installation_id, private, config,
        created_at, review_claims, completed_reviews, reviews_completed_at, summary_agent_id,
        summary_retry_count, task_type, feature, group_id,
        issue_number, issue_url, issue_title, issue_body, issue_author,
        dedup_target, index_issue_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        task.id,
        task.owner,
        task.repo,
        task.pr_number,
        task.pr_url,
        task.diff_url,
        task.base_ref,
        task.head_ref,
        task.review_count,
        task.prompt,
        task.timeout_at,
        task.status,
        task.queue,
        task.github_installation_id,
        task.private ? 1 : 0,
        JSON.stringify(task.config),
        task.created_at,
        task.review_claims ?? 0,
        task.completed_reviews ?? 0,
        task.reviews_completed_at ?? null,
        task.summary_agent_id ?? null,
        task.summary_retry_count ?? 0,
        task.task_type,
        task.feature,
        task.group_id,
        task.issue_number ?? null,
        task.issue_url ?? null,
        task.issue_title ?? null,
        task.issue_body ?? null,
        task.issue_author ?? null,
        task.dedup_target ?? null,
        task.index_issue_number ?? null,
      )
      .run();
  }

  async createTaskIfNotExists(task: ReviewTask): Promise<boolean> {
    try {
      const result = await this.db
        .prepare(
          `INSERT INTO tasks (id, owner, repo, pr_number, pr_url, diff_url, base_ref, head_ref,
          review_count, prompt, timeout_at, status, queue, github_installation_id, private, config,
          created_at, review_claims, completed_reviews, reviews_completed_at, summary_agent_id,
          summary_retry_count, task_type, feature, group_id,
          issue_number, issue_url, issue_title, issue_body, issue_author,
          dedup_target, index_issue_number)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM tasks WHERE owner = ? AND repo = ? AND pr_number = ? AND status IN (?, ?)
        )`,
        )
        .bind(
          task.id,
          task.owner,
          task.repo,
          task.pr_number,
          task.pr_url,
          task.diff_url,
          task.base_ref,
          task.head_ref,
          task.review_count,
          task.prompt,
          task.timeout_at,
          task.status,
          task.queue,
          task.github_installation_id,
          task.private ? 1 : 0,
          JSON.stringify(task.config),
          task.created_at,
          task.review_claims ?? 0,
          task.completed_reviews ?? 0,
          task.reviews_completed_at ?? null,
          task.summary_agent_id ?? null,
          task.summary_retry_count ?? 0,
          task.task_type,
          task.feature,
          task.group_id,
          task.issue_number ?? null,
          task.issue_url ?? null,
          task.issue_title ?? null,
          task.issue_body ?? null,
          task.issue_author ?? null,
          task.dedup_target ?? null,
          task.index_issue_number ?? null,
          // WHERE NOT EXISTS params
          task.owner,
          task.repo,
          task.pr_number,
          'pending',
          'reviewing',
        )
        .run();
      return (result.meta?.changes ?? 0) > 0;
    } catch (err) {
      // The partial unique index is a safety net — if it fires (extremely rare race),
      // treat it as a duplicate rather than propagating a 500 error.
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
        return false;
      }
      throw err;
    }
  }

  async getTask(id: string): Promise<ReviewTask | null> {
    const row = await this.db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<TaskRow>();
    return row ? rowToTask(row) : null;
  }

  async listTasks(filter?: TaskFilter): Promise<ReviewTask[]> {
    let sql = 'SELECT * FROM tasks';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.status && filter.status.length > 0) {
      conditions.push(`status IN (${filter.status.map(() => '?').join(',')})`);
      params.push(...filter.status);
    }

    if (filter?.timeout_before) {
      conditions.push('timeout_at <= ?');
      params.push(filter.timeout_before);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const result = await this.db
      .prepare(sql)
      .bind(...params)
      .all<TaskRow>();

    return (result.results ?? []).map(rowToTask);
  }

  async updateTask(id: string, updates: Partial<ReviewTask>): Promise<boolean> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    // Build SET clause dynamically from the updates object
    const columnMap: Record<string, (v: unknown) => unknown> = {
      owner: (v) => v,
      repo: (v) => v,
      pr_number: (v) => v,
      pr_url: (v) => v,
      diff_url: (v) => v,
      base_ref: (v) => v,
      head_ref: (v) => v,
      review_count: (v) => v,
      prompt: (v) => v,
      timeout_at: (v) => v,
      status: (v) => v,
      queue: (v) => v,
      github_installation_id: (v) => v,
      private: (v) => (v ? 1 : 0),
      config: (v) => JSON.stringify(v),
      created_at: (v) => v,
      review_claims: (v) => v,
      completed_reviews: (v) => v,
      reviews_completed_at: (v) => v ?? null,
      summary_agent_id: (v) => v ?? null,
      summary_retry_count: (v) => v ?? 0,
    };

    for (const [field, transform] of Object.entries(columnMap)) {
      if (field in updates) {
        setClauses.push(`${field} = ?`);
        params.push(transform((updates as Record<string, unknown>)[field]));
      }
    }

    if (setClauses.length === 0) return false;

    params.push(id);
    const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`;
    const result = await this.db
      .prepare(sql)
      .bind(...params)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async deleteTask(id: string): Promise<void> {
    // Claims are deleted via ON DELETE CASCADE.
    await this.db.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
  }

  // ── Claims ─────────────────────────────────────────────────────

  async createClaim(claim: TaskClaim): Promise<boolean> {
    // Check for existing active claim with same (task_id, agent_id, role).
    // Terminal claims (rejected, error) can be overwritten.
    const existing = await this.db
      .prepare('SELECT id, status FROM claims WHERE task_id = ? AND agent_id = ? AND role = ?')
      .bind(claim.task_id, claim.agent_id, claim.role)
      .first<{ id: string; status: string }>();

    if (existing) {
      if (existing.status === 'pending' || existing.status === 'completed') {
        return false; // Active claim already exists
      }
      // Terminal claim — delete it so re-claim can proceed
      await this.db.prepare('DELETE FROM claims WHERE id = ?').bind(existing.id).run();
    }

    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO claims (id, task_id, agent_id, role, status, model, tool, thinking,
        review_text, verdict, tokens_used, github_user_id, github_username, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        claim.id,
        claim.task_id,
        claim.agent_id,
        claim.role,
        claim.status,
        claim.model ?? null,
        claim.tool ?? null,
        claim.thinking ?? null,
        claim.review_text ?? null,
        claim.verdict ?? null,
        claim.tokens_used ?? null,
        claim.github_user_id ?? null,
        claim.github_username ?? null,
        claim.created_at,
      )
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async getClaim(claimId: string): Promise<TaskClaim | null> {
    const row = await this.db
      .prepare('SELECT * FROM claims WHERE id = ?')
      .bind(claimId)
      .first<ClaimRow>();
    return row ? rowToClaim(row) : null;
  }

  async getClaimsBatch(claimIds: string[]): Promise<Map<string, TaskClaim>> {
    const map = new Map<string, TaskClaim>();
    if (claimIds.length === 0) return map;

    // SQLite/D1 limits bound parameters to 999. In practice, poll returns
    // at most a few hundred candidates (active tasks × 1 role per task),
    // so this is unlikely to be hit. Guard with chunking just in case.
    const CHUNK_SIZE = 900;
    for (let i = 0; i < claimIds.length; i += CHUNK_SIZE) {
      const chunk = claimIds.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const result = await this.db
        .prepare(`SELECT * FROM claims WHERE id IN (${placeholders})`)
        .bind(...chunk)
        .all<ClaimRow>();

      for (const row of result.results ?? []) {
        map.set(row.id, rowToClaim(row));
      }
    }
    return map;
  }

  async getClaims(taskId: string): Promise<TaskClaim[]> {
    const result = await this.db
      .prepare('SELECT * FROM claims WHERE task_id = ?')
      .bind(taskId)
      .all<ClaimRow>();
    return (result.results ?? []).map(rowToClaim);
  }

  async updateClaim(claimId: string, updates: Partial<TaskClaim>): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    const fields: Array<keyof TaskClaim> = [
      'status',
      'model',
      'tool',
      'thinking',
      'review_text',
      'verdict',
      'tokens_used',
      'github_user_id',
    ];

    for (const field of fields) {
      if (field in updates) {
        setClauses.push(`${field} = ?`);
        params.push(updates[field] ?? null);
      }
    }

    if (setClauses.length === 0) return;

    params.push(claimId);
    await this.db
      .prepare(`UPDATE claims SET ${setClauses.join(', ')} WHERE id = ?`)
      .bind(...params)
      .run();
  }

  // ── Completed reviews (atomic increment) ────────────────────

  async incrementCompletedReviews(
    taskId: string,
  ): Promise<{ newCount: number; queue: string } | null> {
    const row = await this.db
      .prepare(
        `UPDATE tasks SET completed_reviews = completed_reviews + 1 WHERE id = ? RETURNING completed_reviews, queue`,
      )
      .bind(taskId)
      .first<{ completed_reviews: number; queue: string }>();
    if (!row) return null;
    return { newCount: row.completed_reviews, queue: row.queue };
  }

  // ── Summary retry count (atomic increment) ─────────────────

  async incrementSummaryRetryCount(taskId: string): Promise<number | null> {
    const row = await this.db
      .prepare(
        `UPDATE tasks SET summary_retry_count = summary_retry_count + 1 WHERE id = ? RETURNING summary_retry_count`,
      )
      .bind(taskId)
      .first<{ summary_retry_count: number }>();
    return row ? row.summary_retry_count : null;
  }

  // ── Review slot (atomic conditional increment) ──────────────

  async claimReviewSlot(taskId: string, maxSlots: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE tasks SET review_claims = review_claims + 1 WHERE id = ? AND review_claims < ?`,
      )
      .bind(taskId, maxSlots)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async releaseReviewSlot(taskId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE tasks SET review_claims = review_claims - 1 WHERE id = ? AND review_claims > ?`,
      )
      .bind(taskId, 0)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  // ── Summary claim (atomic CAS) ──────────────────────────────

  async claimSummarySlot(taskId: string, agentId: string): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE tasks SET queue = ?, summary_agent_id = ? WHERE id = ? AND queue = ?`)
      .bind('finished', agentId, taskId, 'summary')
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async releaseSummarySlot(taskId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE tasks SET queue = ?, summary_agent_id = ? WHERE id = ? AND queue = ?`)
      .bind('summary', null, taskId, 'finished')
      .run();
  }

  // ── Agent heartbeats ──────────────────────────────────────────

  async setAgentLastSeen(agentId: string, timestamp: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO agent_heartbeats (agent_id, last_seen) VALUES (?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET last_seen = excluded.last_seen`,
      )
      .bind(agentId, timestamp)
      .run();
  }

  async getAgentLastSeen(agentId: string): Promise<number | null> {
    const row = await this.db
      .prepare('SELECT last_seen FROM agent_heartbeats WHERE agent_id = ?')
      .bind(agentId)
      .first<{ last_seen: number }>();
    return row?.last_seen ?? null;
  }

  async listAgentHeartbeats(
    sinceMs: number,
  ): Promise<Array<{ agent_id: string; last_seen: number }>> {
    const result = await this.db
      .prepare('SELECT agent_id, last_seen FROM agent_heartbeats WHERE last_seen >= ?')
      .bind(sinceMs)
      .all<{ agent_id: string; last_seen: number }>();
    return result.results ?? [];
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

    const placeholders = agentIds.map(() => '?').join(',');
    const result = await this.db
      .prepare(
        `SELECT agent_id,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
        FROM claims WHERE agent_id IN (${placeholders})
        GROUP BY agent_id`,
      )
      .bind(...agentIds)
      .all<{
        agent_id: string;
        total: number;
        completed: number;
        rejected: number;
        error: number;
        pending: number;
      }>();

    for (const row of result.results ?? []) {
      map.set(row.agent_id, {
        total: Number(row.total),
        completed: Number(row.completed),
        rejected: Number(row.rejected),
        error: Number(row.error),
        pending: Number(row.pending),
      });
    }
    return map;
  }

  // ── Meta ──────────────────────────────────────────────────────

  async getTimeoutLastCheck(): Promise<number> {
    const row = await this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .bind('timeout_last_check')
      .first<{ value: string }>();
    return row ? parseInt(row.value, 10) : 0;
  }

  async setTimeoutLastCheck(timestamp: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .bind('timeout_last_check', String(timestamp))
      .run();
  }

  // ── Heartbeat-based reclaim ─────────────────────────────────

  async reclaimAbandonedClaims(staleThresholdMs: number): Promise<number> {
    const cutoff = Date.now() - staleThresholdMs;

    // Find pending claims where the agent's heartbeat is stale, OR where the agent
    // has no heartbeat and the claim itself is older than the threshold.
    const staleResult = await this.db
      .prepare(
        `SELECT c.id, c.task_id, c.role, c.agent_id
         FROM claims c
         LEFT JOIN agent_heartbeats h ON c.agent_id = h.agent_id
         WHERE c.status = 'pending'
           AND (
             (h.last_seen IS NOT NULL AND h.last_seen < ?)
             OR (h.last_seen IS NULL AND c.created_at < ?)
           )`,
      )
      .bind(cutoff, cutoff)
      .all<{ id: string; task_id: string; role: string; agent_id: string }>();

    const staleClaims = staleResult.results ?? [];
    if (staleClaims.length === 0) return 0;

    // Process each claim individually to guard against TOCTOU races.
    // Between the SELECT above and these UPDATEs, a claim could transition
    // from 'pending' to 'completed' if the agent wakes up and submits.
    let freed = 0;
    for (const claim of staleClaims) {
      // Guard: only update if claim is still pending (prevents overwriting completed/rejected)
      const result = await this.db
        .prepare(`UPDATE claims SET status = 'error' WHERE id = ? AND status = 'pending'`)
        .bind(claim.id)
        .run();
      const changed = result.meta?.changes ?? 0;
      if (changed === 0) continue; // Claim was already resolved — skip slot release
      freed++;
      // Release the slot only if we actually freed the claim
      if (claim.role === 'review') {
        await this.db
          .prepare(
            `UPDATE tasks SET review_claims = review_claims - 1 WHERE id = ? AND review_claims > 0`,
          )
          .bind(claim.task_id)
          .run();
      } else if (claim.role === 'summary') {
        // Release summary slot immediately so the task becomes re-claimable
        // without waiting for the separate reclaimAbandonedSummarySlots pass.
        await this.db
          .prepare(
            `UPDATE tasks SET queue = 'summary', summary_agent_id = NULL WHERE id = ? AND queue = 'finished' AND summary_agent_id = ?`,
          )
          .bind(claim.task_id, claim.agent_id)
          .run();
      }
    }

    return freed;
  }

  async reclaimAbandonedSummarySlots(staleThresholdMs: number): Promise<number> {
    const cutoff = Date.now() - staleThresholdMs;

    // Find tasks in 'finished' queue where summary agent is stale.
    // If agent has no heartbeat, use reviews_completed_at as fallback
    // (when the task entered summary phase), falling back to created_at.
    const staleResult = await this.db
      .prepare(
        `SELECT t.id
         FROM tasks t
         LEFT JOIN agent_heartbeats h ON t.summary_agent_id = h.agent_id
         WHERE t.queue = 'finished'
           AND t.summary_agent_id IS NOT NULL
           AND (
             (h.last_seen IS NOT NULL AND h.last_seen < ?)
             OR (h.last_seen IS NULL AND COALESCE(t.reviews_completed_at, t.created_at) < ?)
           )`,
      )
      .bind(cutoff, cutoff)
      .all<{ id: string }>();

    const staleTasks = staleResult.results ?? [];
    if (staleTasks.length === 0) return 0;

    // Process individually with guards to prevent TOCTOU races.
    // Between the SELECT and UPDATE, a stale agent could wake up and submit.
    let freed = 0;
    for (const task of staleTasks) {
      const result = await this.db
        .prepare(
          `UPDATE tasks SET queue = 'summary', summary_agent_id = NULL WHERE id = ? AND queue = 'finished'`,
        )
        .bind(task.id)
        .run();
      if ((result.meta?.changes ?? 0) > 0) freed++;
    }

    return freed;
  }

  // ── Agent rejections (abuse tracking) ─────────────────────────

  async recordAgentRejection(agentId: string, reason: string, timestamp: number): Promise<void> {
    await this.db
      .prepare(`INSERT INTO agent_rejections (agent_id, reason, created_at) VALUES (?, ?, ?)`)
      .bind(agentId, reason, timestamp)
      .run();
  }

  async countAgentRejections(agentId: string, sinceMs: number): Promise<number> {
    const row = await this.db
      .prepare(
        'SELECT COUNT(*) as cnt FROM agent_rejections WHERE agent_id = ? AND created_at >= ?',
      )
      .bind(agentId, sinceMs)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  // ── OAuth token cache ────────────────────────────────────────

  async getOAuthCache(tokenHash: string): Promise<VerifiedIdentity | null> {
    const row = await this.db
      .prepare(
        'SELECT github_user_id, github_username, verified_at FROM oauth_token_cache WHERE token_hash = ? AND expires_at > ?',
      )
      .bind(tokenHash, Date.now())
      .first<{ github_user_id: number; github_username: string; verified_at: number }>();
    if (!row) return null;
    return {
      github_user_id: row.github_user_id,
      github_username: row.github_username,
      verified_at: row.verified_at,
    };
  }

  async setOAuthCache(tokenHash: string, identity: VerifiedIdentity, ttlMs: number): Promise<void> {
    const expiresAt = Date.now() + ttlMs;
    await this.db
      .prepare(
        `INSERT INTO oauth_token_cache (token_hash, github_user_id, github_username, verified_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(token_hash) DO UPDATE SET
          github_user_id = excluded.github_user_id,
          github_username = excluded.github_username,
          verified_at = excluded.verified_at,
          expires_at = excluded.expires_at`,
      )
      .bind(
        tokenHash,
        identity.github_user_id,
        identity.github_username,
        identity.verified_at,
        expiresAt,
      )
      .run();
  }

  async cleanupExpiredOAuthCache(): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM oauth_token_cache WHERE expires_at <= ?')
      .bind(Date.now())
      .run();
    return result.meta?.changes ?? 0;
  }

  // ── Cleanup ───────────────────────────────────────────────────

  async cleanupTerminalTasks(): Promise<number> {
    const cutoff = Date.now() - this.ttlMs;
    const statusPlaceholders = TERMINAL_STATUSES.map(() => '?').join(',');

    // Delete tasks (claims cascade via ON DELETE CASCADE)
    const result = await this.db
      .prepare(`DELETE FROM tasks WHERE status IN (${statusPlaceholders}) AND created_at <= ?`)
      .bind(...TERMINAL_STATUSES, cutoff)
      .run();

    return result.meta?.changes ?? 0;
  }
}
