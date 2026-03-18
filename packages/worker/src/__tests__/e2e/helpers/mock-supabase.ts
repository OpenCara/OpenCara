/**
 * In-memory Supabase mock that persists data within a test run.
 *
 * Supports the Supabase query builder chain used throughout the codebase:
 * .from(table).select(cols).eq(col, val).single() etc.
 */

type Row = Record<string, unknown>;
type TableData = Row[];

/** Foreign key relationships for nested select joins */
const FK_MAP: Record<string, Record<string, { table: string; fk: string }>> = {
  agents: { users: { table: 'users', fk: 'user_id' } },
  review_results: {
    review_tasks: { table: 'review_tasks', fk: 'review_task_id' },
    agents: { table: 'agents', fk: 'agent_id' },
  },
  ratings: { review_results: { table: 'review_results', fk: 'review_result_id' } },
  reputation_history: {
    agents: { table: 'agents', fk: 'agent_id' },
  },
};

interface QueryResult {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
}

class MockQueryBuilder {
  private tableName: string;
  private tables: Map<string, TableData>;
  private filters: Array<(row: Row) => boolean> = [];
  private selectColumns: string | null = null;
  private countOnly = false;
  private countExact = false;
  private orderByCol: string | null = null;
  private orderAsc = true;
  private limitCount: number | null = null;
  private isSingle = false;
  private operation: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private operationData: Row | Row[] | null = null;
  private upsertConflict: string | null = null;
  private returnSelect = false;

  constructor(tableName: string, tables: Map<string, TableData>) {
    this.tableName = tableName;
    this.tables = tables;
    if (!this.tables.has(tableName)) {
      this.tables.set(tableName, []);
    }
  }

  select(columns?: string, opts?: { count?: string; head?: boolean }): this {
    this.selectColumns = columns ?? '*';
    if (opts?.count === 'exact') {
      this.countExact = true;
    }
    if (opts?.head) {
      this.countOnly = true;
    }
    return this;
  }

  insert(data: Row | Row[]): this {
    this.operation = 'insert';
    this.operationData = data;
    return this;
  }

  update(data: Row): this {
    this.operation = 'update';
    this.operationData = data;
    return this;
  }

  upsert(data: Row | Row[], opts?: { onConflict?: string }): this {
    this.operation = 'upsert';
    this.operationData = data;
    this.upsertConflict = opts?.onConflict ?? null;
    return this;
  }

  delete(): this {
    this.operation = 'delete';
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] !== value);
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push((row) => (row[column] as number) >= (value as number));
    return this;
  }

  gt(column: string, value: unknown): this {
    this.filters.push((row) => (row[column] as string) > (value as string));
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    if (operator === 'is') {
      this.filters.push((row) => row[column] !== value && row[column] !== undefined);
    }
    return this;
  }

  order(column: string, opts?: { ascending?: boolean }): this {
    this.orderByCol = column;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  single(): Promise<QueryResult> & { then: Promise<QueryResult>['then'] } {
    this.isSingle = true;
    return this.execute();
  }

  then(
    onFulfilled?: (value: QueryResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ): Promise<unknown> {
    return this.execute().then(onFulfilled, onRejected);
  }

  private execute(): Promise<QueryResult> {
    return Promise.resolve(this.executeSync());
  }

  private executeSync(): QueryResult {
    const table = this.tables.get(this.tableName) ?? [];

    switch (this.operation) {
      case 'insert':
        return this.executeInsert(table);
      case 'update':
        return this.executeUpdate(table);
      case 'upsert':
        return this.executeUpsert(table);
      case 'delete':
        return this.executeDelete(table);
      default:
        return this.executeSelect(table);
    }
  }

  private executeInsert(table: TableData): QueryResult {
    const rows = Array.isArray(this.operationData) ? this.operationData : [this.operationData!];

    const inserted: Row[] = [];
    for (const row of rows) {
      const newRow: Row = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        ...row,
      };
      table.push(newRow);
      inserted.push(newRow);
    }

    if (this.returnSelect) {
      if (this.isSingle) {
        return { data: inserted[0] ?? null, error: null };
      }
      return { data: inserted, error: null };
    }
    if (this.selectColumns) {
      const projected = inserted.map((r) => this.projectRow(r));
      if (this.isSingle) {
        return { data: projected[0] ?? null, error: null };
      }
      return { data: projected, error: null };
    }
    return { data: inserted, error: null };
  }

  private executeUpdate(table: TableData): QueryResult {
    const updated: Row[] = [];
    for (const row of table) {
      if (this.matchesFilters(row)) {
        Object.assign(row, this.operationData);
        updated.push(row);
      }
    }
    if (this.selectColumns) {
      const projected = updated.map((r) => this.projectRow(r));
      if (this.isSingle) {
        return { data: projected[0] ?? null, error: null };
      }
      return { data: projected, error: null };
    }
    return { data: updated, error: null };
  }

  private executeUpsert(table: TableData): QueryResult {
    const rows = Array.isArray(this.operationData) ? this.operationData : [this.operationData!];

    for (const row of rows) {
      if (this.upsertConflict) {
        const conflictCols = this.upsertConflict.split(',').map((c) => c.trim());
        const existingIdx = table.findIndex((existing) =>
          conflictCols.every((col) => existing[col] === row[col]),
        );
        if (existingIdx >= 0) {
          Object.assign(table[existingIdx], row);
        } else {
          table.push({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...row });
        }
      } else {
        table.push({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...row });
      }
    }
    return { data: null, error: null };
  }

  private executeDelete(_table: TableData): QueryResult {
    const tableRef = this.tables.get(this.tableName)!;
    const remaining = tableRef.filter((row) => !this.matchesFilters(row));
    this.tables.set(this.tableName, remaining);
    return { data: null, error: null };
  }

  private executeSelect(table: TableData): QueryResult {
    let results = table.filter((row) => this.matchesFilters(row));

    if (this.orderByCol) {
      const col = this.orderByCol;
      const asc = this.orderAsc;
      results.sort((a, b) => {
        const av = a[col] as string | number;
        const bv = b[col] as string | number;
        if (av < bv) return asc ? -1 : 1;
        if (av > bv) return asc ? 1 : -1;
        return 0;
      });
    }

    if (this.limitCount !== null) {
      results = results.slice(0, this.limitCount);
    }

    if (this.countOnly) {
      return { data: null, error: null, count: results.length };
    }

    if (this.countExact && !this.countOnly) {
      const projected = results.map((r) => this.projectRow(r));
      if (this.isSingle) {
        if (projected.length === 0) {
          return { data: null, error: { message: 'No rows found' }, count: 0 };
        }
        return { data: projected[0], error: null, count: results.length };
      }
      return { data: projected, error: null, count: results.length };
    }

    const projected = results.map((r) => this.projectRow(r));

    if (this.isSingle) {
      if (projected.length === 0) {
        return { data: null, error: { message: 'No rows found' } };
      }
      if (projected.length > 1) {
        return { data: null, error: { message: 'Multiple rows found' } };
      }
      return { data: projected[0], error: null };
    }

    return { data: projected, error: null };
  }

  private matchesFilters(row: Row): boolean {
    return this.filters.every((fn) => fn(row));
  }

  private projectRow(row: Row): Row {
    if (!this.selectColumns || this.selectColumns === '*') {
      return { ...row };
    }

    const result: Row = {};
    const parts = this.parseSelectColumns(this.selectColumns);

    for (const part of parts) {
      if (part.includes('(')) {
        // Nested join: "agents!inner(model, tool)"
        this.resolveJoin(row, part, result);
      } else {
        result[part.trim()] = row[part.trim()];
      }
    }

    return result;
  }

  private parseSelectColumns(cols: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of cols) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  private resolveJoin(row: Row, joinExpr: string, result: Row): void {
    // Parse "tableName!inner(col1, col2)" or "tableName(col1, col2)"
    const match = joinExpr.match(/^(\w+)(?:!inner)?\((.+)\)$/);
    if (!match) return;

    const alias = match[1];
    const innerCols = match[2];
    const fkInfo = FK_MAP[this.tableName]?.[alias];
    if (!fkInfo) {
      // Try reverse FK lookup — we might be in a nested context
      result[alias] = {};
      return;
    }

    const fkValue = row[fkInfo.fk];
    const targetTable = this.tables.get(fkInfo.table) ?? [];
    const targetRow = targetTable.find((r) => r.id === fkValue);

    if (!targetRow) {
      result[alias] = null;
      return;
    }

    // Recursively project the joined row
    const subBuilder = new MockQueryBuilder(fkInfo.table, this.tables);
    subBuilder.selectColumns = innerCols;
    const projected = subBuilder.projectRow(targetRow);
    result[alias] = projected;
  }
}

export interface MockSupabase {
  client: {
    from(table: string): MockQueryBuilder;
  };
  tables: Map<string, TableData>;
  getTable(name: string): TableData;
  reset(): void;
}

export function createMockSupabase(seed?: Record<string, Row[]>): MockSupabase {
  const tables = new Map<string, TableData>();

  // Initialize all known tables
  const tableNames = [
    'users',
    'agents',
    'review_tasks',
    'review_results',
    'ratings',
    'reputation_history',
  ];
  for (const name of tableNames) {
    tables.set(name, []);
  }

  // Apply seed data
  if (seed) {
    for (const [table, rows] of Object.entries(seed)) {
      tables.set(table, [...rows]);
    }
  }

  const client = {
    from(table: string): MockQueryBuilder {
      return new MockQueryBuilder(table, tables);
    },
  };

  return {
    client: client as MockSupabase['client'],
    tables,
    getTable(name: string): TableData {
      return tables.get(name) ?? [];
    },
    reset() {
      for (const name of tables.keys()) {
        tables.set(name, []);
      }
    },
  };
}
