import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { and, asc, eq, gt } from "drizzle-orm";
import type { Sql } from "postgres";
import type { Db } from "../../db/client.js";
import { agentRunLogs, agentRuns } from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";

interface RunRoutesDeps {
  db: Db;
  pg: Sql;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export function runRoutes(deps: RunRoutesDeps) {
  const r = new Hono<AuthEnv>();
  const auth = requireUser();

  // One-shot snapshot of logs.
  r.get("/runs/:id/logs", auth, async (c) => {
    const runId = c.req.param("id");
    const since = Number.parseInt(c.req.query("since") ?? "-1", 10);
    const rows = await deps.db
      .select()
      .from(agentRunLogs)
      .where(
        Number.isFinite(since) && since >= 0
          ? and(eq(agentRunLogs.agentRunId, runId), gt(agentRunLogs.seq, since))
          : eq(agentRunLogs.agentRunId, runId),
      )
      .orderBy(asc(agentRunLogs.seq));
    return c.json({ logs: rows });
  });

  // SSE stream: replays existing logs then tails via pg LISTEN/NOTIFY.
  r.get("/runs/:id/logs/stream", auth, (c) => {
    const runId = c.req.param("id");
    return streamSSE(c, async (sse) => {
      let lastSeq = -1;

      const flush = async () => {
        const rows = await deps.db
          .select()
          .from(agentRunLogs)
          .where(and(eq(agentRunLogs.agentRunId, runId), gt(agentRunLogs.seq, lastSeq)))
          .orderBy(asc(agentRunLogs.seq));
        for (const row of rows) {
          await sse.writeSSE({
            event: "log",
            data: JSON.stringify({
              seq: row.seq,
              stream: row.stream,
              chunk: row.chunk,
              ts: row.ts,
            }),
          });
          lastSeq = row.seq;
        }
      };

      await flush();

      // Status-only projection: `spec` can carry a hundreds-of-kB ACP
      // payload and we only need the status to decide whether to close.
      const run = await deps.db.query.agentRuns.findFirst({
        where: eq(agentRuns.id, runId),
        columns: { id: true, status: true },
      });
      if (run && TERMINAL.has(run.status)) {
        await sse.writeSSE({ event: "end", data: JSON.stringify({ status: run.status }) });
        return;
      }

      const subscription = await deps.pg.listen("agent_run_logs", (payload) => {
        if (payload !== runId) return;
        flush().catch((err: unknown) => {
          console.error("[sse] flush error", err);
        });
      });

      // Heartbeat every 15s so proxies don't close idle connections.
      const heartbeat = setInterval(() => {
        sse.writeSSE({ event: "ping", data: "" }).catch(() => undefined);
      }, 15_000);

      // Poll terminal state every 2s; close stream when run finishes.
      // Status-only projection — see the initial check above.
      const terminalCheck = setInterval(async () => {
        const r2 = await deps.db.query.agentRuns.findFirst({
          where: eq(agentRuns.id, runId),
          columns: { id: true, status: true },
        });
        if (r2 && TERMINAL.has(r2.status)) {
          await flush();
          await sse.writeSSE({ event: "end", data: JSON.stringify({ status: r2.status }) });
          clearInterval(heartbeat);
          clearInterval(terminalCheck);
          await subscription.unlisten();
          await sse.close();
        }
      }, 2_000);

      sse.onAbort(async () => {
        clearInterval(heartbeat);
        clearInterval(terminalCheck);
        await subscription.unlisten();
      });
    });
  });

  return r;
}
