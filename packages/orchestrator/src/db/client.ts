import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(databaseUrl: string): Db {
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1])\b/.test(databaseUrl);
  const client = postgres(databaseUrl, {
    max: 10,
    ssl: isLocal ? false : "require",
  });
  return drizzle(client, { schema });
}
