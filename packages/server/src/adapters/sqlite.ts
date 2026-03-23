/**
 * SQLite adapter that implements the D1Database interface from store/d1.ts.
 *
 * Wraps better-sqlite3 (synchronous) calls in Promises to match the
 * async D1 API. This allows D1DataStore to run against a local SQLite
 * file on VPS / self-hosted deployments without any code changes.
 */
import Database from 'better-sqlite3';
import type { D1Database, D1PreparedStatement, D1Result } from '../store/d1.js';

/**
 * Wraps a better-sqlite3 Database instance to expose the D1Database interface.
 */
export class SqliteD1Adapter implements D1Database {
  private readonly db: Database.Database;

  constructor(pathOrDb: string | Database.Database) {
    if (typeof pathOrDb === 'string') {
      this.db = new Database(pathOrDb);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
    } else {
      this.db = pathOrDb;
    }
  }

  prepare(sql: string): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.db, sql, []);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    // Run all statements inside a transaction for atomicity (matching D1 batch semantics).
    const runBatch = this.db.transaction(() => {
      for (const stmt of statements) {
        results.push((stmt as SqliteD1PreparedStatement).runSync() as D1Result<T>);
      }
    });
    runBatch();
    return results;
  }

  /** Get the underlying better-sqlite3 Database (for sync migration runner). */
  getRawDb(): Database.Database {
    return this.db;
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close();
  }
}

/**
 * Wraps a better-sqlite3 prepared statement to expose D1PreparedStatement.
 *
 * Immutable: bind() returns a new instance (matching D1 semantics).
 */
class SqliteD1PreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly db: Database.Database,
    private readonly sql: string,
    private readonly params: unknown[],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    // Immutable — return a new instance with the bound values.
    return new SqliteD1PreparedStatement(this.db, this.sql, values);
  }

  async run(): Promise<D1Result> {
    return this.runSync();
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (column) return (row[column] as T) ?? null;
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.params) as T[];
    return { results: rows, success: true };
  }

  /**
   * Synchronous run — used internally by batch() to execute inside a transaction.
   * @internal
   */
  runSync(): D1Result {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.params);
    return {
      success: true,
      meta: {
        changes: info.changes,
        last_row_id: Number(info.lastInsertRowid),
        changed_db: info.changes > 0,
      },
    };
  }
}
