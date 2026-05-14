import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";

interface ActivityRouteDeps {
  db: Db;
}

interface ActivityRow extends Record<string, unknown> {
  kind: "event" | "run";
  id: string;
  ts: string;
  type: string;
  project_id: string | null;
  payload: unknown;
}

export function activityRoutes(deps: ActivityRouteDeps) {
  const r = new Hono<AuthEnv>();
  r.use("*", requireUser());

  r.get("/", async (c) => {
    const user = c.get("user")!;
    const limit = clampLimit(c.req.query("limit"));
    const before = c.req.query("before");

    const beforeFilter = before
      ? sql`AND ts < to_timestamp(${Number(before) / 1000})`
      : sql``;

    // Restrict both arms of the UNION to projects owned by the caller.
    // Rows with project_id IS NULL (cron/system events) drop out
    // intentionally — there is no per-user trust model for them yet, so
    // surfacing them in everyone's feed would re-introduce the leak.
    const rows = await deps.db.execute<ActivityRow>(sql`
      SELECT * FROM (
        SELECT 'event'::text as kind, id, received_at as ts, type, project_id, payload
        FROM platform_events
        WHERE project_id IN (
          SELECT id FROM projects WHERE added_by_user_id = ${user.id}
        )
        UNION ALL
        SELECT 'run'::text as kind, id, created_at as ts, status::text as type, project_id,
               jsonb_build_object('status', status::text, 'hostId', host_id, 'exitCode', exit_code) as payload
        FROM agent_runs
        WHERE project_id IN (
          SELECT id FROM projects WHERE added_by_user_id = ${user.id}
        )
      ) u
      WHERE TRUE ${beforeFilter}
      ORDER BY ts DESC
      LIMIT ${limit}
    `);
    return c.json({ activity: rows });
  });

  return r;
}

function clampLimit(v: string | undefined): number {
  const n = Number.parseInt(v ?? "50", 10);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(n, 1), 200);
}
