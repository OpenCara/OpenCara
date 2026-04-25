import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  db: Db;
  pg: Sql;
}

export function createDb(databaseUrl: string): DbHandle {
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1])\b/.test(databaseUrl);
  const pg = postgres(databaseUrl, {
    max: 10,
    ssl: isLocal ? false : "require",
  });
  return { db: drizzle(pg, { schema }), pg };
}
