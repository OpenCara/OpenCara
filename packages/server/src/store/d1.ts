import type { ReviewTask, TaskClaim, VerifiedIdentity } from '@opencara/shared';
import type { TaskFilter } from '../types.js';
import type { DataStore, PostedReview, ReputationEvent } from './interface.js';
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
  diff_size: number | null;
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
  if (row.index_issue_number !== null) task.index_issue_number = row.index_issue_number;

  // Optional diff size
  if (row.diff_size !== null) task.diff_size = row.diff_size;

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

  private static readonly INSERT_TASK_SQL = `INSERT INTO tasks (id, owner, repo, pr_number, pr_url, diff_url, base_ref, head_ref,
        review_count, prompt, timeout_at, status, queue, github_installation_id, private, config,
        created_at, review_claims, completed_reviews, reviews_completed_at, summary_agent_id,
        summary_retry_count, task_type, feature, group_id,
        issue_number, issue_url, issue_title, issue_body, issue_author,
        dedup_target, index_issue_number, diff_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  private bindTaskParams(task: ReviewTask): unknown[] {
    return [
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
      null, // dedup_target column (deprecated — role now encodes target)
      task.index_issue_number ?? null,
      task.diff_size ?? null,
    ];
  }

  async createTask(task: ReviewTask): Promise<void> {
    await this.db
      .prepare(D1DataStore.INSERT_TASK_SQL)
      .bind(...this.bindTaskParams(task))
      .run();
  }

  async createTaskBatch(tasks: ReviewTask[]): Promise<void> {
    if (tasks.length === 0) return;
    if (tasks.length === 1) {
      await this.createTask(tasks[0]);
      return;
    }
    const statements = tasks.map((task) =>
      this.db.prepare(D1DataStore.INSERT_TASK_SQL).bind(...this.bindTaskParams(task)),
    );
    await this.db.batch(statements);
  }

  async createTaskIfNotExists(task: ReviewTask): Promise<boolean> {
    // Use separate SELECT + INSERT instead of INSERT...SELECT...WHERE NOT EXISTS.
    // D1's meta.changes can return 0 for INSERT...SELECT even when a row is
    // inserted, causing the caller to incorrectly think a duplicate exists.
    //
    // For issue tasks (pr_number=0 + issue_number set), scope dedup by
    // issue_number so different issues don't collide.
    let existing: Record<string, unknown> | null;
    if (task.pr_number === 0 && task.issue_number !== undefined) {
      existing = await this.db
        .prepare(
          `SELECT 1 AS found FROM tasks WHERE owner = ? AND repo = ? AND issue_number = ? AND feature = ? AND status IN (?, ?)`,
        )
        .bind(task.owner, task.repo, task.issue_number, task.feature, 'pending', 'reviewing')
        .first();
    } else {
      existing = await this.db
        .prepare(
          `SELECT 1 AS found FROM tasks WHERE owner = ? AND repo = ? AND pr_number = ? AND feature = ? AND status IN (?, ?)`,
        )
        .bind(task.owner, task.repo, task.pr_number, task.feature, 'pending', 'reviewing')
        .first();
    }
    if (existing) return false;

    try {
      await this.createTask(task);
      return true;
    } catch (err) {
      // Safety net for rare race: concurrent webhook inserts between SELECT and INSERT.
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
      task_type: (v) => v,
      feature: (v) => v,
      group_id: (v) => v,
      issue_number: (v) => v ?? null,
      issue_url: (v) => v ?? null,
      issue_title: (v) => v ?? null,
      issue_body: (v) => v ?? null,
      issue_author: (v) => v ?? null,
      index_issue_number: (v) => v ?? null,
      diff_size: (v) => v ?? null,
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

  async deletePendingTasksByPr(owner: string, repo: string, prNumber: number): Promise<number> {
    // Claims are deleted via ON DELETE CASCADE.
    const result = await this.db
      .prepare(`DELETE FROM tasks WHERE owner = ? AND repo = ? AND pr_number = ? AND status = ?`)
      .bind(owner, repo, prNumber, 'pending')
      .run();
    return result.meta?.changes ?? 0;
  }

  async deletePendingTasksByIssue(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<number> {
    // Claims are deleted via ON DELETE CASCADE.
    // Only delete issue-scoped tasks (pr_number = 0 means issue-only).
    const result = await this.db
      .prepare(
        `DELETE FROM tasks WHERE owner = ? AND repo = ? AND issue_number = ? AND pr_number = ? AND status = ?`,
      )
      .bind(owner, repo, issueNumber, 0, 'pending')
      .run();
    return result.meta?.changes ?? 0;
  }

  async deleteActiveTasksByIssueAndFeature(
    owner: string,
    repo: string,
    issueNumber: number,
    feature: string,
  ): Promise<number> {
    // Claims are deleted via ON DELETE CASCADE.
    // Only delete issue-scoped tasks (pr_number = 0 means issue-only).
    const result = await this.db
      .prepare(
        `DELETE FROM tasks WHERE owner = ? AND repo = ? AND issue_number = ? AND pr_number = ? AND feature = ? AND status IN (?, ?)`,
      )
      .bind(owner, repo, issueNumber, 0, feature, 'pending', 'reviewing')
      .run();
    return result.meta?.changes ?? 0;
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

  // ── Generic task claiming (new separate task model) ─────────

  async claimTask(taskId: string): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE tasks SET status = ? WHERE id = ? AND status = ?`)
      .bind('reviewing', taskId, 'pending')
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async releaseTask(taskId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE tasks SET status = ? WHERE id = ? AND status = ?`)
      .bind('pending', taskId, 'reviewing')
      .run();
  }

  // ── Group queries ──────────────────────────────────────────

  async getTasksByGroup(groupId: string): Promise<ReviewTask[]> {
    const result = await this.db
      .prepare('SELECT * FROM tasks WHERE group_id = ?')
      .bind(groupId)
      .all<TaskRow>();
    return (result.results ?? []).map(rowToTask);
  }

  async countCompletedInGroup(groupId: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE group_id = ? AND status = ?`)
      .bind(groupId, 'completed')
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  async countWorkerTasksInGroup(groupId: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE group_id = ? AND status = ?`)
      .bind(groupId, 'reviewing')
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  async deleteTasksByGroup(groupId: string): Promise<void> {
    // Claims are deleted via ON DELETE CASCADE (see 0001_initial.sql).
    await this.db.prepare('DELETE FROM tasks WHERE group_id = ?').bind(groupId).run();
  }

  async completeWorkerAndMaybeCreateSummary(
    workerTaskId: string,
    summaryTask: ReviewTask,
  ): Promise<boolean> {
    // Step 1: Mark the worker as completed first.
    // Done as a separate statement (not batched with the count check) so the
    // count check below sees the updated status. D1 batch statements share a
    // transaction but the INSERT...SELECT subqueries do NOT see same-batch
    // UPDATE changes, causing the condition to evaluate with stale counts and
    // the summary to never be created.
    await this.db
      .prepare(`UPDATE tasks SET status = ? WHERE id = ?`)
      .bind('completed', workerTaskId)
      .run();

    // Step 2: Check whether all worker tasks in the group are now completed
    // and no active summary task already exists.
    const completedRow = await this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM tasks WHERE group_id = ? AND task_type IN (?, ?) AND status = ?`,
      )
      .bind(summaryTask.group_id, 'review', 'issue_review', 'completed')
      .first<{ cnt: number }>();

    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM tasks WHERE group_id = ? AND task_type IN (?, ?)`)
      .bind(summaryTask.group_id, 'review', 'issue_review')
      .first<{ cnt: number }>();

    const completed = completedRow?.cnt ?? 0;
    const total = totalRow?.cnt ?? 0;
    if (total === 0 || completed < total) return false;

    const activeSummary = await this.db
      .prepare(`SELECT 1 FROM tasks WHERE group_id = ? AND task_type = ? AND status IN (?, ?)`)
      .bind(summaryTask.group_id, 'summary', 'pending', 'reviewing')
      .first();

    if (activeSummary) return false;

    // Step 3: Insert the summary task. Use UNIQUE constraint as a safety net
    // for the rare race where two concurrent workers both pass the checks above
    // and both try to insert.
    try {
      await this.createTask(summaryTask);
      return true;
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
        return false;
      }
      throw err;
    }
  }

  // ── Deprecated: Completed reviews (atomic increment) ───────

  /** @deprecated Use claimTask instead. */
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

  // ── Deprecated: Summary retry count (atomic increment) ─────

  /** @deprecated */
  async incrementSummaryRetryCount(taskId: string): Promise<number | null> {
    const row = await this.db
      .prepare(
        `UPDATE tasks SET summary_retry_count = summary_retry_count + 1 WHERE id = ? RETURNING summary_retry_count`,
      )
      .bind(taskId)
      .first<{ summary_retry_count: number }>();
    return row ? row.summary_retry_count : null;
  }

  // ── Deprecated: Review slot (atomic conditional increment) ──

  /** @deprecated Use claimTask instead. */
  async claimReviewSlot(taskId: string, maxSlots: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE tasks SET review_claims = review_claims + 1 WHERE id = ? AND review_claims < ?`,
      )
      .bind(taskId, maxSlots)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /** @deprecated Use releaseTask instead. */
  async releaseReviewSlot(taskId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE tasks SET review_claims = review_claims - 1 WHERE id = ? AND review_claims > ?`,
      )
      .bind(taskId, 0)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  // ── Deprecated: Summary claim (atomic CAS) ─────────────────

  /** @deprecated Use claimTask instead. */
  async claimSummarySlot(taskId: string, agentId: string): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE tasks SET queue = ?, summary_agent_id = ? WHERE id = ? AND queue = ?`)
      .bind('finished', agentId, taskId, 'summary')
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /** @deprecated Use releaseTask instead. */
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

  async recordAgentRejection(
    agentId: string,
    reason: string,
    timestamp: number,
    githubUserId?: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO agent_rejections (agent_id, reason, created_at, github_user_id) VALUES (?, ?, ?, ?)`,
      )
      .bind(agentId, reason, timestamp, githubUserId ?? null)
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

  async countAccountRejections(githubUserId: number, sinceMs: number): Promise<number> {
    const row = await this.db
      .prepare(
        'SELECT COUNT(*) as cnt FROM agent_rejections WHERE github_user_id = ? AND created_at >= ?',
      )
      .bind(githubUserId, sinceMs)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  // ── Posted reviews (reputation reaction tracking) ──────────────

  async recordPostedReview(review: {
    owner: string;
    repo: string;
    pr_number: number;
    group_id: string;
    github_comment_id: number;
    feature: string;
    posted_at: string;
  }): Promise<number> {
    const result = await this.db
      .prepare(
        `INSERT INTO posted_reviews (owner, repo, pr_number, group_id, github_comment_id, feature, posted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        review.owner,
        review.repo,
        review.pr_number,
        review.group_id,
        review.github_comment_id,
        review.feature,
        review.posted_at,
      )
      .run();
    return result.meta?.last_row_id ?? 0;
  }

  async getPostedReviewsByPr(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PostedReview[]> {
    const result = await this.db
      .prepare('SELECT * FROM posted_reviews WHERE owner = ? AND repo = ? AND pr_number = ?')
      .bind(owner, repo, prNumber)
      .all<PostedReview>();
    return result.results ?? [];
  }

  async markReactionsChecked(postedReviewId: number, timestamp: string): Promise<void> {
    await this.db
      .prepare('UPDATE posted_reviews SET reactions_checked_at = ? WHERE id = ?')
      .bind(timestamp, postedReviewId)
      .run();
  }

  // ── Reputation events (append-only) ────────────────────────────

  async recordReputationEvent(event: {
    posted_review_id: number;
    agent_id: string;
    operator_github_user_id: number;
    github_user_id: number;
    delta: number;
    created_at: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO reputation_events
        (posted_review_id, agent_id, operator_github_user_id, github_user_id, delta, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.posted_review_id,
        event.agent_id,
        event.operator_github_user_id,
        event.github_user_id,
        event.delta,
        event.created_at,
      )
      .run();
  }

  async getAgentReputationEvents(agentId: string, sinceMs: number): Promise<ReputationEvent[]> {
    const sinceIso = new Date(sinceMs).toISOString();
    const result = await this.db
      .prepare(
        'SELECT * FROM reputation_events WHERE agent_id = ? AND created_at >= ? ORDER BY created_at DESC',
      )
      .bind(agentId, sinceIso)
      .all<ReputationEvent>();
    return result.results ?? [];
  }

  async getAccountReputationEvents(
    operatorGithubUserId: number,
    sinceMs: number,
  ): Promise<ReputationEvent[]> {
    const sinceIso = new Date(sinceMs).toISOString();
    const result = await this.db
      .prepare(
        'SELECT * FROM reputation_events WHERE operator_github_user_id = ? AND created_at >= ? ORDER BY created_at DESC',
      )
      .bind(operatorGithubUserId, sinceIso)
      .all<ReputationEvent>();
    return result.results ?? [];
  }

  // ── Agent cooldown ───────────────────────────────────────────

  async getAgentLastCompletedClaimAt(agentId: string): Promise<number | null> {
    const row = await this.db
      .prepare('SELECT MAX(created_at) as latest FROM claims WHERE agent_id = ? AND status = ?')
      .bind(agentId, 'completed')
      .first<{ latest: number | null }>();
    return row?.latest ?? null;
  }

  // ── Agent reliability (recent success/error outcomes) ────────

  async recordAgentReliabilityEvent(
    agentId: string,
    outcome: 'success' | 'error',
    createdAt: string,
  ): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO agent_reliability_events (agent_id, outcome, created_at) VALUES (?, ?, ?)',
      )
      .bind(agentId, outcome, createdAt)
      .run();
  }

  async getAgentReliabilityEventsBatch(
    agentIds: readonly string[],
    sinceMs: number,
  ): Promise<Map<string, Array<{ outcome: 'success' | 'error'; created_at: string }>>> {
    const result = new Map<string, Array<{ outcome: 'success' | 'error'; created_at: string }>>();
    if (agentIds.length === 0) return result;
    const sinceIso = new Date(sinceMs).toISOString();
    const placeholders = agentIds.map(() => '?').join(',');
    const rows = await this.db
      .prepare(
        `SELECT agent_id, outcome, created_at FROM agent_reliability_events
         WHERE agent_id IN (${placeholders}) AND created_at >= ?`,
      )
      .bind(...agentIds, sinceIso)
      .all<{ agent_id: string; outcome: 'success' | 'error'; created_at: string }>();
    for (const row of rows.results ?? []) {
      let list = result.get(row.agent_id);
      if (!list) {
        list = [];
        result.set(row.agent_id, list);
      }
      list.push({ outcome: row.outcome, created_at: row.created_at });
    }
    return result;
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
