import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(databaseUrl: string): Db {
  const client = postgres(databaseUrl, { max: 10 });
  return drizzle(client, { schema });
}
