import { describe, it, expect, beforeEach } from 'vitest';
import { D1DataStore, rowToTask, rowToClaim } from '../store/d1.js';
import type { D1Database, D1PreparedStatement, D1Result } from '../store/d1.js';
import type { ReviewTask, TaskClaim } from '@opencara/shared';
import { DEFAULT_REVIEW_CONFIG } from '@opencara/shared';

// ── Mock D1 Database ──────────────────────────────────────────────
// A minimal in-memory mock that simulates D1's SQL behavior.
// Stores data in Maps keyed by table name; parses SQL to route operations.

interface TableRow {
  [key: string]: unknown;
}

interface TableSchema {
  primaryKey: string;
  uniqueConstraints: string[][]; // arrays of column names
  foreignKeys: Array<{
    columns: string[];
    refTable: string;
    refColumns: string[];
    onDelete?: string;
  }>;
}

const SCHEMAS: Record<string, TableSchema> = {
  tasks: {
    primaryKey: 'id',
    uniqueConstraints: [],
    foreignKeys: [],
  },
  claims: {
    primaryKey: 'id',
    uniqueConstraints: [['task_id', 'agent_id']],
    foreignKeys: [
      { columns: ['task_id'], refTable: 'tasks', refColumns: ['id'], onDelete: 'CASCADE' },
    ],
  },
  locks: {
    primaryKey: 'key',
    uniqueConstraints: [],
    foreignKeys: [],
  },
  agent_heartbeats: {
    primaryKey: 'agent_id',
    uniqueConstraints: [],
    foreignKeys: [],
  },
  meta: {
    primaryKey: 'key',
    uniqueConstraints: [],
    foreignKeys: [],
  },
};

class MockD1Database implements D1Database {
  private tables = new Map<string, TableRow[]>();

  constructor() {
    for (const table of Object.keys(SCHEMAS)) {
      this.tables.set(table, []);
    }
  }

  prepare(sql: string): D1PreparedStatement {
    return new MockD1Statement(this, sql);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const stmt of statements) {
      results.push((await (stmt as MockD1Statement).run()) as D1Result<T>);
    }
    return results;
  }

  _getTable(name: string): TableRow[] {
    return this.tables.get(name) ?? [];
  }

  _setTable(name: string, rows: TableRow[]): void {
    this.tables.set(name, rows);
  }

  _cascadeDelete(table: string, deletedRows: TableRow[]): void {
    for (const [childTable, schema] of Object.entries(SCHEMAS)) {
      for (const fk of schema.foreignKeys) {
        if (fk.refTable === table && fk.onDelete === 'CASCADE') {
          const childRows = this._getTable(childTable);
          const remaining = childRows.filter((childRow) => {
            return !deletedRows.some((deleted) =>
              fk.columns.every((col, i) => childRow[col] === deleted[fk.refColumns[i]]),
            );
          });
          this._setTable(childTable, remaining);
        }
      }
    }
  }
}

class MockD1Statement implements D1PreparedStatement {
  private boundValues: unknown[] = [];

  constructor(
    private db: MockD1Database,
    private sql: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.boundValues = values;
    return this;
  }

  async run(): Promise<D1Result> {
    return this._execute();
  }

  async first<T = Record<string, unknown>>(_column?: string): Promise<T | null> {
    const result = this._execute();
    if (_column && result.results && result.results.length > 0) {
      return (result.results[0] as Record<string, unknown>)[_column] as T;
    }
    return (result.results?.[0] as T) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this._execute() as D1Result<T>;
  }

  private _execute(): D1Result {
    const sql = this.sql.trim();
    const sqlUpper = sql.toUpperCase();

    if (sqlUpper.startsWith('INSERT')) {
      return this._handleInsert(sql);
    } else if (sqlUpper.startsWith('SELECT')) {
      return this._handleSelect(sql);
    } else if (sqlUpper.startsWith('UPDATE')) {
      return this._handleUpdate(sql);
    } else if (sqlUpper.startsWith('DELETE')) {
      return this._handleDelete(sql);
    }

    return { success: true, results: [], meta: { changes: 0 } };
  }

  private _handleInsert(sql: string): D1Result {
    const tableName = this._extractTableName(sql, 'INSERT');
    const table = this.db._getTable(tableName);
    const schema = SCHEMAS[tableName];
    const isOrIgnore = sql.toUpperCase().includes('OR IGNORE');
    const hasOnConflict = sql.toUpperCase().includes('ON CONFLICT');

    // Extract column names from INSERT INTO table (col1, col2, ...)
    const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
    if (!colMatch) return { success: false, meta: { changes: 0 } };

    const columns = colMatch[1].split(',').map((c) => c.trim());
    const row: TableRow = {};
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]] = this.boundValues[i] ?? null;
    }

    // Check primary key conflict
    const pkValue = row[schema.primaryKey];
    const existingIdx = table.findIndex((r) => r[schema.primaryKey] === pkValue);

    if (existingIdx >= 0) {
      if (hasOnConflict) {
        // ON CONFLICT DO UPDATE — update the existing row with excluded values
        const updateMatch = sql.match(/DO UPDATE SET (.+)$/is);
        if (updateMatch) {
          const existing = table[existingIdx];
          const setClauses = updateMatch[1].split(',').map((s) => s.trim());
          for (const clause of setClauses) {
            const [colPart, valPart] = clause.split('=').map((s) => s.trim());
            if (valPart.startsWith('excluded.')) {
              const srcCol = valPart.replace('excluded.', '');
              existing[colPart] = row[srcCol];
            }
          }
        }
        return { success: true, results: [], meta: { changes: 1 } };
      }
      if (isOrIgnore) {
        return { success: true, results: [], meta: { changes: 0 } };
      }
      // Would throw UNIQUE constraint violation
      return { success: false, results: [], meta: { changes: 0 } };
    }

    // Check UNIQUE constraints
    for (const uniqueCols of schema.uniqueConstraints) {
      const conflict = table.some((r) => uniqueCols.every((col) => r[col] === row[col]));
      if (conflict) {
        if (isOrIgnore) {
          return { success: true, results: [], meta: { changes: 0 } };
        }
        return { success: false, results: [], meta: { changes: 0 } };
      }
    }

    table.push(row);
    return { success: true, results: [], meta: { changes: 1 } };
  }

  private _handleSelect(sql: string): D1Result {
    const tableName = this._extractTableName(sql, 'SELECT');
    const table = this.db._getTable(tableName);

    const whereClause = this._extractWhere(sql);
    const results = whereClause
      ? table.filter((row) => this._matchWhere(row, whereClause))
      : [...table];

    return { success: true, results, meta: { changes: 0 } };
  }

  private _handleUpdate(sql: string): D1Result {
    const tableName = this._extractTableName(sql, 'UPDATE');
    const table = this.db._getTable(tableName);

    // Extract SET and WHERE
    const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/is);
    if (!setMatch) return { success: true, meta: { changes: 0 } };

    const setClauses = this._parseSetClauses(setMatch[1]);
    const whereClause = this._extractWhere(sql);

    let changes = 0;
    for (const row of table) {
      if (whereClause && !this._matchWhere(row, whereClause)) continue;
      for (const { column, paramIndex } of setClauses) {
        row[column] = this.boundValues[paramIndex];
      }
      changes++;
    }

    return { success: true, results: [], meta: { changes } };
  }

  private _handleDelete(sql: string): D1Result {
    const tableName = this._extractTableName(sql, 'DELETE');
    const table = this.db._getTable(tableName);
    const whereClause = this._extractWhere(sql);

    const deleted: TableRow[] = [];
    const remaining: TableRow[] = [];

    for (const row of table) {
      if (whereClause && !this._matchWhere(row, whereClause)) {
        remaining.push(row);
      } else {
        deleted.push(row);
      }
    }

    this.db._setTable(tableName, remaining);

    // Cascade deletes
    if (deleted.length > 0) {
      this.db._cascadeDelete(tableName, deleted);
    }

    return { success: true, results: [], meta: { changes: deleted.length } };
  }

  private _extractTableName(sql: string, type: string): string {
    let match: RegExpMatchArray | null;
    if (type === 'INSERT') {
      match = sql.match(/INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+(\w+)/i);
    } else if (type === 'SELECT') {
      match = sql.match(/FROM\s+(\w+)/i);
    } else if (type === 'UPDATE') {
      match = sql.match(/UPDATE\s+(\w+)/i);
    } else {
      match = sql.match(/FROM\s+(\w+)/i);
    }
    return match?.[1] ?? '';
  }

  private _extractWhere(sql: string): string | null {
    const match = sql.match(/WHERE\s+(.+?)(?:\s*$)/is);
    return match?.[1]?.trim() ?? null;
  }

  private _matchWhere(row: TableRow, whereClause: string): boolean {
    // Handle subqueries: IN (SELECT ...)
    const subqueryMatch = whereClause.match(/(\w+)\s+IN\s+\(\s*SELECT\s+(.+)\)/is);
    if (subqueryMatch) {
      return this._handleSubqueryWhere(row, whereClause, subqueryMatch);
    }

    // Split on AND
    const conditions = whereClause.split(/\s+AND\s+/i);
    let paramIdx = 0;

    // Count params used before WHERE in the original SQL
    const sqlBeforeWhere = this.sql.substring(0, this.sql.toUpperCase().indexOf('WHERE'));
    const paramsBeforeWhere = (sqlBeforeWhere.match(/\?/g) || []).length;
    paramIdx = paramsBeforeWhere;

    for (const cond of conditions) {
      const trimmed = cond.trim();

      // Handle IN (?, ?, ...)
      const inMatch = trimmed.match(/^(\w+)\s+IN\s+\(([^)]+)\)/i);
      if (inMatch) {
        const col = inMatch[1];
        const placeholders = inMatch[2].split(',').map((s) => s.trim());
        const values = placeholders.map(() => this.boundValues[paramIdx++]);
        if (!values.includes(row[col])) return false;
        continue;
      }

      // Handle column = ?
      const eqMatch = trimmed.match(/^(\w+)\s*=\s*\?$/);
      if (eqMatch) {
        const col = eqMatch[1];
        if (row[col] !== this.boundValues[paramIdx++]) return false;
        continue;
      }

      // Handle column <= ?
      const leMatch = trimmed.match(/^(\w+)\s*<=\s*\?$/);
      if (leMatch) {
        const col = leMatch[1];
        if ((row[col] as number) > (this.boundValues[paramIdx++] as number)) return false;
        continue;
      }
    }

    return true;
  }

  private _handleSubqueryWhere(
    row: TableRow,
    _whereClause: string,
    subqueryMatch: RegExpMatchArray,
  ): boolean {
    const col = subqueryMatch[1];
    const subSql = subqueryMatch[2];

    // Parse: 'summary:' || id FROM tasks WHERE status IN (?, ?, ?) AND created_at <= ?
    const concatMatch = subSql.match(/'([^']+)'\s*\|\|\s*(\w+)\s+FROM\s+(\w+)/i);
    if (concatMatch) {
      const prefix = concatMatch[1];
      const srcCol = concatMatch[2];
      const srcTable = concatMatch[3];

      // Extract the inner WHERE
      const innerWhereMatch = subSql.match(/WHERE\s+(.+)$/is);
      if (!innerWhereMatch) return false;

      const srcRows = this.db._getTable(srcTable);
      const innerWhere = innerWhereMatch[1].trim();

      // Parse inner conditions
      const innerConditions = innerWhere.split(/\s+AND\s+/i);
      const paramIdx = 0; // subquery params start at the beginning of bound values

      const matchingSrcRows = srcRows.filter((srcRow) => {
        let innerParamIdx = paramIdx;
        for (const cond of innerConditions) {
          const inMatch = cond.trim().match(/^(\w+)\s+IN\s+\(([^)]+)\)/i);
          if (inMatch) {
            const innerCol = inMatch[1];
            const placeholders = inMatch[2].split(',').map((s) => s.trim());
            const values = placeholders.map(() => this.boundValues[innerParamIdx++]);
            if (!values.includes(srcRow[innerCol])) return false;
            continue;
          }
          const leMatch = cond.trim().match(/^(\w+)\s*<=\s*\?$/);
          if (leMatch) {
            const innerCol = leMatch[1];
            if ((srcRow[innerCol] as number) > (this.boundValues[innerParamIdx++] as number))
              return false;
            continue;
          }
        }
        return true;
      });

      const validKeys = matchingSrcRows.map((r) => `${prefix}${r[srcCol]}`);
      return validKeys.includes(row[col] as string);
    }

    return false;
  }

  private _parseSetClauses(setStr: string): Array<{ column: string; paramIndex: number }> {
    const clauses: Array<{ column: string; paramIndex: number }> = [];
    const parts = setStr.split(',');
    let paramIdx = 0;

    for (const part of parts) {
      const match = part.trim().match(/^(\w+)\s*=\s*\?$/);
      if (match) {
        clauses.push({ column: match[1], paramIndex: paramIdx++ });
      }
    }

    return clauses;
  }
}

// ── Test Helpers ──────────────────────────────────────────────────

function makeTask(overrides: Partial<ReviewTask> = {}): ReviewTask {
  return {
    id: 'task-1',
    owner: 'test-org',
    repo: 'test-repo',
    pr_number: 1,
    pr_url: 'https://github.com/test-org/test-repo/pull/1',
    diff_url: 'https://github.com/test-org/test-repo/pull/1.diff',
    base_ref: 'main',
    head_ref: 'feature',
    review_count: 1,
    prompt: 'Review this PR',
    timeout_at: Date.now() + 600_000,
    status: 'pending',
    github_installation_id: 123,
    private: false,
    config: DEFAULT_REVIEW_CONFIG,
    queue: 'review',
    created_at: Date.now(),
    ...overrides,
  };
}

function makeClaim(overrides: Partial<TaskClaim> = {}): TaskClaim {
  return {
    id: 'task-1:agent-1:review',
    task_id: 'task-1',
    agent_id: 'agent-1',
    role: 'review',
    status: 'pending',
    created_at: Date.now(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('D1DataStore', () => {
  let db: MockD1Database;
  let store: D1DataStore;

  beforeEach(() => {
    db = new MockD1Database();
    store = new D1DataStore(db);
  });

  // ── Tasks ──────────────────────────────────────────────────

  describe('tasks', () => {
    it('creates and retrieves a task', async () => {
      const task = makeTask();
      await store.createTask(task);
      const retrieved = await store.getTask('task-1');
      // D1 stores review_claims/completed_reviews as NOT NULL DEFAULT 0,
      // so they are always present in the returned object
      expect(retrieved).toEqual({ ...task, review_claims: 0, completed_reviews: 0 });
    });

    it('returns null for nonexistent task', async () => {
      expect(await store.getTask('nope')).toBeNull();
    });

    it('serializes config as JSON', async () => {
      const task = makeTask();
      await store.createTask(task);
      const retrieved = await store.getTask('task-1');
      expect(retrieved?.config).toEqual(DEFAULT_REVIEW_CONFIG);
    });

    it('stores boolean as integer and converts back', async () => {
      const task = makeTask({ private: true });
      await store.createTask(task);
      const retrieved = await store.getTask('task-1');
      expect(retrieved?.private).toBe(true);
    });

    it('stores queue field', async () => {
      const task = makeTask({ queue: 'summary' });
      await store.createTask(task);
      const retrieved = await store.getTask('task-1');
      expect(retrieved?.queue).toBe('summary');
    });

    it('stores summary_agent_id', async () => {
      const task = makeTask({ summary_agent_id: 'agent-1' });
      await store.createTask(task);
      const retrieved = await store.getTask('task-1');
      expect(retrieved?.summary_agent_id).toBe('agent-1');
    });

    it('lists tasks with no filter', async () => {
      await store.createTask(makeTask({ id: 'a' }));
      await store.createTask(makeTask({ id: 'b' }));
      const all = await store.listTasks();
      expect(all).toHaveLength(2);
    });

    it('filters by status', async () => {
      await store.createTask(makeTask({ id: 'a', status: 'pending' }));
      await store.createTask(makeTask({ id: 'b', status: 'completed' }));
      await store.createTask(makeTask({ id: 'c', status: 'reviewing' }));

      const pending = await store.listTasks({ status: ['pending'] });
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('a');

      const active = await store.listTasks({ status: ['pending', 'reviewing'] });
      expect(active).toHaveLength(2);
    });

    it('filters by timeout_before', async () => {
      const now = Date.now();
      await store.createTask(makeTask({ id: 'expired', timeout_at: now - 1000 }));
      await store.createTask(makeTask({ id: 'active', timeout_at: now + 60000 }));

      const expired = await store.listTasks({ timeout_before: now });
      expect(expired).toHaveLength(1);
      expect(expired[0].id).toBe('expired');
    });

    it('updates a task', async () => {
      await store.createTask(makeTask());
      const updated = await store.updateTask('task-1', { status: 'reviewing' });
      expect(updated).toBe(true);
      const task = await store.getTask('task-1');
      expect(task?.status).toBe('reviewing');
    });

    it('updateTask returns false for nonexistent', async () => {
      expect(await store.updateTask('nope', { status: 'reviewing' })).toBe(false);
    });

    it('updateTask with empty updates returns false', async () => {
      await store.createTask(makeTask());
      expect(await store.updateTask('task-1', {})).toBe(false);
    });

    it('updates private field correctly', async () => {
      await store.createTask(makeTask({ private: false }));
      await store.updateTask('task-1', { private: true });
      const task = await store.getTask('task-1');
      expect(task?.private).toBe(true);
    });

    it('updates config field correctly', async () => {
      await store.createTask(makeTask());
      const newConfig = { ...DEFAULT_REVIEW_CONFIG, review_count: 5 };
      await store.updateTask('task-1', { config: newConfig });
      const task = await store.getTask('task-1');
      expect(task?.config.review_count).toBe(5);
    });

    it('deletes a task and its claims via cascade', async () => {
      await store.createTask(makeTask());
      await store.createClaim(makeClaim());
      await store.deleteTask('task-1');
      expect(await store.getTask('task-1')).toBeNull();
      expect(await store.getClaims('task-1')).toHaveLength(0);
    });

    it('deleteTask also removes summary lock', async () => {
      await store.createTask(makeTask());
      await store.acquireLock('summary:task-1', 'agent-a');
      await store.deleteTask('task-1');
      expect(await store.checkLock('summary:task-1', 'agent-a')).toBe(false);
    });
  });

  // ── Claims ─────────────────────────────────────────────────

  describe('claims', () => {
    it('creates and retrieves claims', async () => {
      await store.createTask(makeTask());
      const claim = makeClaim();
      const created = await store.createClaim(claim);
      expect(created).toBe(true);
      const claims = await store.getClaims('task-1');
      expect(claims).toHaveLength(1);
      expect(claims[0]).toEqual(claim);
    });

    it('returns empty array when no claims', async () => {
      expect(await store.getClaims('task-1')).toEqual([]);
    });

    it('returns false for duplicate (task_id, agent_id, role)', async () => {
      await store.createTask(makeTask());
      await store.createClaim(makeClaim());
      const result = await store.createClaim(makeClaim({ id: 'task-1:agent-1:review-dup' }));
      expect(result).toBe(false);
      const claims = await store.getClaims('task-1');
      expect(claims).toHaveLength(1);
    });

    it('allows different agents on same task', async () => {
      await store.createTask(makeTask());
      await store.createClaim(makeClaim({ id: 'task-1:agent-1:review', agent_id: 'agent-1' }));
      const result = await store.createClaim(
        makeClaim({ id: 'task-1:agent-2:review', agent_id: 'agent-2' }),
      );
      expect(result).toBe(true);
      const claims = await store.getClaims('task-1');
      expect(claims).toHaveLength(2);
    });

    it('allows re-claim after rejected claim', async () => {
      await store.createTask(makeTask());
      await store.createClaim(makeClaim());
      await store.updateClaim('task-1:agent-1:review', { status: 'rejected' });
      const result = await store.createClaim(makeClaim({ id: 'task-1:agent-1:review-retry' }));
      expect(result).toBe(true);
    });

    it('allows re-claim after error claim', async () => {
      await store.createTask(makeTask());
      await store.createClaim(makeClaim());
      await store.updateClaim('task-1:agent-1:review', { status: 'error' });
      const result = await store.createClaim(makeClaim({ id: 'task-1:agent-1:review-retry' }));
      expect(result).toBe(true);
    });

    it('blocks re-claim when claim is pending', async () => {
      await store.createTask(makeTask());
      await store.createClaim(makeClaim());
      const result = await store.createClaim(makeClaim({ id: 'task-1:agent-1:review-dup' }));
      expect(result).toBe(false);
    });

    it('blocks re-claim when claim is completed', async () => {
      await store.createTask(makeTask());
      await store.createClaim(makeClaim());
      await store.updateClaim('task-1:agent-1:review', { status: 'completed' });
      const result = await store.createClaim(makeClaim({ id: 'task-1:agent-1:review-dup' }));
      expect(result).toBe(false);
    });

    it('getClaim retrieves a specific claim', async () => {
      await store.createTask(makeTask());
      const claim = makeClaim();
      await store.createClaim(claim);
      const retrieved = await store.getClaim('task-1:agent-1:review');
      expect(retrieved).toEqual(claim);
    });

    it('getClaim returns null for nonexistent', async () => {
      expect(await store.getClaim('nope')).toBeNull();
    });

    it('updates a claim', async () => {
      await store.createTask(makeTask());
      await store.createClaim(makeClaim());
      await store.updateClaim('task-1:agent-1:review', {
        status: 'completed',
        review_text: 'LGTM',
        verdict: 'approve',
      });
      const claims = await store.getClaims('task-1');
      expect(claims[0].status).toBe('completed');
      expect(claims[0].review_text).toBe('LGTM');
      expect(claims[0].verdict).toBe('approve');
    });

    it('updates claim with optional fields', async () => {
      await store.createTask(makeTask());
      await store.createClaim(makeClaim({ model: 'gpt-4', tool: 'cursor' }));
      await store.updateClaim('task-1:agent-1:review', { tokens_used: 1500 });
      const claim = await store.getClaim('task-1:agent-1:review');
      expect(claim?.tokens_used).toBe(1500);
    });

    it('filters claims by taskId', async () => {
      await store.createTask(makeTask({ id: 'task-1' }));
      await store.createTask(makeTask({ id: 'task-2' }));
      await store.createClaim(makeClaim({ id: 'task-1:a', task_id: 'task-1', agent_id: 'a' }));
      await store.createClaim(makeClaim({ id: 'task-2:b', task_id: 'task-2', agent_id: 'b' }));
      const claims = await store.getClaims('task-1');
      expect(claims).toHaveLength(1);
      expect(claims[0].agent_id).toBe('a');
    });

    it('preserves optional null fields on claim', async () => {
      await store.createTask(makeTask());
      const claim = makeClaim();
      await store.createClaim(claim);
      const retrieved = await store.getClaim('task-1:agent-1:review');
      expect(retrieved?.model).toBeUndefined();
      expect(retrieved?.tool).toBeUndefined();
      expect(retrieved?.review_text).toBeUndefined();
      expect(retrieved?.verdict).toBeUndefined();
      expect(retrieved?.tokens_used).toBeUndefined();
    });
  });

  // ── Agent last-seen ────────────────────────────────────────

  describe('agent last-seen', () => {
    it('sets and gets last-seen timestamp', async () => {
      const now = Date.now();
      await store.setAgentLastSeen('agent-1', now);
      expect(await store.getAgentLastSeen('agent-1')).toBe(now);
    });

    it('returns null for unknown agent', async () => {
      expect(await store.getAgentLastSeen('nope')).toBeNull();
    });

    it('overwrites previous timestamp via upsert', async () => {
      await store.setAgentLastSeen('agent-1', 1000);
      await store.setAgentLastSeen('agent-1', 2000);
      expect(await store.getAgentLastSeen('agent-1')).toBe(2000);
    });
  });

  // ── Locks ─────────────────────────────────────────────────

  describe('locks', () => {
    it('acquires lock for first holder', async () => {
      const result = await store.acquireLock('summary:task-1', 'agent-a');
      expect(result).toBe(true);
    });

    it('rejects second holder when lock is held', async () => {
      await store.acquireLock('summary:task-1', 'agent-a');
      const result = await store.acquireLock('summary:task-1', 'agent-b');
      expect(result).toBe(false);
    });

    it('is idempotent for same holder', async () => {
      await store.acquireLock('summary:task-1', 'agent-a');
      const result = await store.acquireLock('summary:task-1', 'agent-a');
      expect(result).toBe(true);
    });

    it('checkLock returns true for lock holder', async () => {
      await store.acquireLock('summary:task-1', 'agent-a');
      expect(await store.checkLock('summary:task-1', 'agent-a')).toBe(true);
    });

    it('checkLock returns false for non-holder', async () => {
      await store.acquireLock('summary:task-1', 'agent-a');
      expect(await store.checkLock('summary:task-1', 'agent-b')).toBe(false);
    });

    it('checkLock returns false when no lock exists', async () => {
      expect(await store.checkLock('summary:task-1', 'agent-a')).toBe(false);
    });

    it('isLockHeld returns true when lock exists', async () => {
      await store.acquireLock('summary:task-1', 'agent-a');
      expect(await store.isLockHeld('summary:task-1')).toBe(true);
    });

    it('isLockHeld returns false when no lock exists', async () => {
      expect(await store.isLockHeld('summary:task-1')).toBe(false);
    });

    it('releaseLock allows new acquisition', async () => {
      await store.acquireLock('summary:task-1', 'agent-a');
      await store.releaseLock('summary:task-1');
      const result = await store.acquireLock('summary:task-1', 'agent-b');
      expect(result).toBe(true);
    });

    it('locks are independent per key', async () => {
      await store.acquireLock('summary:task-1', 'agent-a');
      const result = await store.acquireLock('summary:task-2', 'agent-b');
      expect(result).toBe(true);
    });
  });

  // ── Timeout check throttle ────────────────────────────────

  describe('timeout check throttle', () => {
    it('returns 0 when no timestamp set', async () => {
      expect(await store.getTimeoutLastCheck()).toBe(0);
    });

    it('stores and retrieves timestamp', async () => {
      const now = Date.now();
      await store.setTimeoutLastCheck(now);
      expect(await store.getTimeoutLastCheck()).toBe(now);
    });

    it('overwrites previous timestamp', async () => {
      await store.setTimeoutLastCheck(1000);
      await store.setTimeoutLastCheck(2000);
      expect(await store.getTimeoutLastCheck()).toBe(2000);
    });
  });

  // ── cleanupTerminalTasks ─────────────────────────────────────

  describe('cleanupTerminalTasks', () => {
    it('deletes terminal tasks older than default TTL', async () => {
      const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
      await store.createTask(
        makeTask({ id: 'old-completed', status: 'completed', created_at: oldTime }),
      );
      await store.createTask(
        makeTask({ id: 'old-timeout', status: 'timeout', created_at: oldTime }),
      );
      await store.createTask(makeTask({ id: 'old-failed', status: 'failed', created_at: oldTime }));

      const deleted = await store.cleanupTerminalTasks();
      expect(deleted).toBe(3);
      expect(await store.getTask('old-completed')).toBeNull();
      expect(await store.getTask('old-timeout')).toBeNull();
      expect(await store.getTask('old-failed')).toBeNull();
    });

    it('does not delete terminal tasks within TTL', async () => {
      const recentTime = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day ago
      await store.createTask(
        makeTask({ id: 'recent', status: 'completed', created_at: recentTime }),
      );

      const deleted = await store.cleanupTerminalTasks();
      expect(deleted).toBe(0);
      expect(await store.getTask('recent')).not.toBeNull();
    });

    it('does not delete active tasks even if old', async () => {
      const oldTime = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
      await store.createTask(makeTask({ id: 'pending', status: 'pending', created_at: oldTime }));
      await store.createTask(
        makeTask({ id: 'reviewing', status: 'reviewing', created_at: oldTime }),
      );

      const deleted = await store.cleanupTerminalTasks();
      expect(deleted).toBe(0);
    });

    it('respects custom TTL', async () => {
      const customStore = new D1DataStore(db, 1); // 1 day TTL
      const oldTime = Date.now() - 2 * 24 * 60 * 60 * 1000; // 2 days ago

      await customStore.createTask(
        makeTask({ id: 'old', status: 'completed', created_at: oldTime }),
      );

      const deleted = await customStore.cleanupTerminalTasks();
      expect(deleted).toBe(1);
    });

    it('also deletes associated claims via cascade', async () => {
      const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
      await store.createTask(makeTask({ id: 'old', status: 'completed', created_at: oldTime }));
      await store.createClaim(
        makeClaim({ id: 'old:agent-1', task_id: 'old', agent_id: 'agent-1' }),
      );

      await store.cleanupTerminalTasks();
      expect(await store.getClaims('old')).toEqual([]);
    });

    it('also deletes associated summary locks', async () => {
      const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
      await store.createTask(makeTask({ id: 'old', status: 'completed', created_at: oldTime }));
      await store.acquireLock('summary:old', 'agent-1');

      await store.cleanupTerminalTasks();
      expect(await store.checkLock('summary:old', 'agent-1')).toBe(false);
    });

    it('returns 0 when no tasks exist', async () => {
      const deleted = await store.cleanupTerminalTasks();
      expect(deleted).toBe(0);
    });
  });
});

// ── Row conversion helpers ────────────────────────────────────

describe('rowToTask', () => {
  it('converts a flat row to ReviewTask', () => {
    const row = {
      id: 'task-1',
      owner: 'org',
      repo: 'repo',
      pr_number: 1,
      pr_url: 'https://github.com/org/repo/pull/1',
      diff_url: 'https://github.com/org/repo/pull/1.diff',
      base_ref: 'main',
      head_ref: 'feature',
      review_count: 3,
      prompt: 'Review',
      timeout_at: 1000000,
      status: 'pending',
      github_installation_id: 456,
      private: 1,
      config: JSON.stringify(DEFAULT_REVIEW_CONFIG),
      created_at: 999000,
      queue: 'review',
      review_claims: 2,
      completed_reviews: 1,
      reviews_completed_at: null,
      summary_agent_id: null,
    };

    const task = rowToTask(row);
    expect(task.id).toBe('task-1');
    expect(task.private).toBe(true);
    expect(task.config).toEqual(DEFAULT_REVIEW_CONFIG);
    expect(task.queue).toBe('review');
    expect(task.reviews_completed_at).toBeUndefined();
    expect(task.summary_agent_id).toBeUndefined();
  });

  it('handles summary queue with summary_agent_id', () => {
    const row = {
      id: 'task-1',
      owner: 'org',
      repo: 'repo',
      pr_number: 1,
      pr_url: 'url',
      diff_url: 'diff',
      base_ref: 'main',
      head_ref: 'feature',
      review_count: 1,
      prompt: 'Review',
      timeout_at: 1000000,
      status: 'reviewing',
      github_installation_id: 123,
      private: 0,
      config: JSON.stringify(DEFAULT_REVIEW_CONFIG),
      created_at: 999000,
      queue: 'finished',
      review_claims: 0,
      completed_reviews: 0,
      reviews_completed_at: null,
      summary_agent_id: 'agent-1',
    };

    const task = rowToTask(row);
    expect(task.queue).toBe('finished');
    expect(task.summary_agent_id).toBe('agent-1');
    expect(task.private).toBe(false);
  });
});

describe('rowToClaim', () => {
  it('converts a flat row to TaskClaim', () => {
    const row = {
      id: 'task-1:agent-1:review',
      task_id: 'task-1',
      agent_id: 'agent-1',
      role: 'review',
      status: 'completed',
      model: 'claude-3',
      tool: 'cursor',
      review_text: 'LGTM',
      verdict: 'approve',
      tokens_used: 500,
      created_at: 1000000,
    };

    const claim = rowToClaim(row);
    expect(claim.id).toBe('task-1:agent-1:review');
    expect(claim.model).toBe('claude-3');
    expect(claim.verdict).toBe('approve');
    expect(claim.tokens_used).toBe(500);
  });

  it('omits null optional fields', () => {
    const row = {
      id: 'task-1:agent-1:review',
      task_id: 'task-1',
      agent_id: 'agent-1',
      role: 'review',
      status: 'pending',
      model: null,
      tool: null,
      review_text: null,
      verdict: null,
      tokens_used: null,
      created_at: 1000000,
    };

    const claim = rowToClaim(row);
    expect(claim.model).toBeUndefined();
    expect(claim.tool).toBeUndefined();
    expect(claim.review_text).toBeUndefined();
    expect(claim.verdict).toBeUndefined();
    expect(claim.tokens_used).toBeUndefined();
  });
});
