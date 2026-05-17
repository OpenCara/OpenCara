// PM agent REST endpoints (kanban-scoped wave dispatch + cancellation).
// The session lookup that used to live here moved into chatSessionsRoutes
// when sessions were generalized to (userId, scopeKind, scopeId).
//
// Routes (all under /api):
//   GET  /projects/:id/pm/waves            — recent waves with items
//   POST /projects/:id/pm/waves/:wid/cancel — cancel a wave

import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { flowRuns, pmWaveItems, pmWaves } from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import { loadOwnedProject } from "../../auth/ownership.js";
import type { FlowEngine } from "../../flows/engine.js";

interface PmRoutesDeps {
  db: Db;
  flowEngine?: FlowEngine;
}

const WAVE_LIMIT = 20;

export function pmRoutes(deps: PmRoutesDeps) {
  const r = new Hono<AuthEnv>();
  const auth = requireUser();

  // GET /projects/:id/pm/waves — recent waves with their items.
  r.get("/projects/:id/pm/waves", auth, async (c) => {
    const projectId = c.req.param("id");
    const user = c.get("user")!;
    const owned = await loadOwnedProject(deps.db, projectId, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);

    const waves = await deps.db.query.pmWaves.findMany({
      where: eq(pmWaves.projectId, projectId),
      orderBy: [desc(pmWaves.startedAt)],
      limit: WAVE_LIMIT,
    });

    const wavesWithItems = await Promise.all(
      waves.map(async (wave) => {
        const items = await deps.db.query.pmWaveItems.findMany({
          where: eq(pmWaveItems.waveId, wave.id),
        });
        return { ...wave, items };
      }),
    );

    return c.json({ waves: wavesWithItems });
  });

  // POST /projects/:id/pm/waves/:wid/cancel
  r.post("/projects/:id/pm/waves/:wid/cancel", auth, async (c) => {
    const projectId = c.req.param("id");
    const waveId = c.req.param("wid");
    const user = c.get("user")!;
    const owned = await loadOwnedProject(deps.db, projectId, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);

    const wave = await deps.db.query.pmWaves.findFirst({
      where: and(eq(pmWaves.id, waveId), eq(pmWaves.projectId, projectId)),
    });
    if (!wave) return c.json({ error: "not found" }, 404);
    if (wave.status !== "running") {
      return c.json({ error: "wave is not running" }, 400);
    }

    // Cancel pending/running items' flow runs.
    const items = await deps.db.query.pmWaveItems.findMany({
      where: and(
        eq(pmWaveItems.waveId, waveId),
      ),
    });

    for (const item of items) {
      if (!item.flowRunId) continue;
      // Skip items that already settled — overwriting a succeeded/failed
      // flow run's status with "cancelled" corrupts historical run records.
      if (item.status !== "pending" && item.status !== "running") continue;
      try {
        // Best-effort: mark the flow run cancelled via a direct DB write.
        // The status predicate here mirrors the item-status guard above so
        // a run that finished between the item fetch and this write is safe.
        await deps.db
          .update(flowRuns)
          .set({ status: "cancelled", cancelReason: "pm-wave-cancel", finishedAt: new Date() })
          .where(
            and(
              eq(flowRuns.id, item.flowRunId),
              eq(flowRuns.projectId, projectId),
              inArray(flowRuns.status, ["pending", "running"]),
            ),
          );
      } catch (err) {
        console.warn("[pm] cancel flow run failed", { flowRunId: item.flowRunId, err });
      }
    }

    // Only touch items that haven't already settled. Without the status
    // filter, a wave where some items finished before the cancel arrived
    // loses its succeeded/failed history — every row gets overwritten as
    // "cancelled" and post-cancellation forensics become impossible.
    await deps.db
      .update(pmWaveItems)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(pmWaveItems.waveId, waveId),
          inArray(pmWaveItems.status, ["pending", "running"]),
        ),
      );

    await deps.db
      .update(pmWaves)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(pmWaves.id, waveId));

    return c.json({ ok: true });
  });

  return r;
}
