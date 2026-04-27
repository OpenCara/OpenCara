import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ulid } from "ulid";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Sql } from "postgres";
import type { Db } from "../../db/client.js";
import {
  agentRuns,
  flowRuns,
  flowRunSteps,
  flows,
  platformEvents,
} from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import type { FlowEngine } from "../../flows/engine.js";

interface FlowRoutesDeps {
  db: Db;
  pg: Sql;
  flowEngine?: FlowEngine;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export function flowRoutes(deps: FlowRoutesDeps) {
  const r = new Hono<AuthEnv>();
  const auth = requireUser();

  // List flows for a project
  r.get("/projects/:id/flows", auth, async (c) => {
    const projectId = c.req.param("id");
    const rows = await deps.db.query.flows.findMany({
      where: eq(flows.projectId, projectId),
    });
    return c.json({ flows: rows });
  });

  // Single flow detail with recent runs
  r.get("/projects/:id/flows/:slug", auth, async (c) => {
    const projectId = c.req.param("id");
    const slug = c.req.param("slug");
    const flow = await deps.db.query.flows.findFirst({
      where: and(eq(flows.projectId, projectId), eq(flows.slug, slug)),
    });
    if (!flow) return c.json({ error: "not found" }, 404);
    const runs = await deps.db.query.flowRuns.findMany({
      where: eq(flowRuns.flowId, flow.id),
      orderBy: [desc(flowRuns.createdAt)],
      limit: 50,
    });
    return c.json({ flow, runs });
  });

  // Manually trigger a flow run from the UI. Synthesises a platform_event of
  // type "manual" so triggerRunner can recognise it and bypass the PR filter.
  r.post("/projects/:id/flows/:slug/trigger", auth, async (c) => {
    if (!deps.flowEngine) {
      return c.json({ error: "flow engine not configured" }, 503);
    }
    const projectId = c.req.param("id");
    const slug = c.req.param("slug");
    const flow = await deps.db.query.flows.findFirst({
      where: and(eq(flows.projectId, projectId), eq(flows.slug, slug)),
    });
    if (!flow) return c.json({ error: "not found" }, 404);

    const eventId = ulid();
    await deps.db.insert(platformEvents).values({
      id: eventId,
      platform: "github",
      type: "manual",
      payload: {},
      projectId,
      deliveryId: eventId,
    });

    try {
      const { flowRunId } = await deps.flowEngine.triggerFlow(flow.id, {
        id: eventId,
        type: "manual",
        projectId,
        payload: {},
      });
      return c.json({ flowRunId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // Recent flow runs across the project
  r.get("/projects/:id/flow-runs", auth, async (c) => {
    const projectId = c.req.param("id");
    const limit = clampLimit(c.req.query("limit"));
    const rows = await deps.db.query.flowRuns.findMany({
      where: eq(flowRuns.projectId, projectId),
      orderBy: [desc(flowRuns.createdAt)],
      limit,
    });
    return c.json({ runs: rows });
  });

  // Single flow_run + its steps + linked agent_runs
  r.get("/flow-runs/:id", auth, async (c) => {
    const id = c.req.param("id");
    const snapshot = await loadFlowRunSnapshot(deps.db, id);
    if (!snapshot) return c.json({ error: "not found" }, 404);
    return c.json(snapshot);
  });

  // SSE: live snapshot of a flow run + its steps + agent runs.
  // Initial "snapshot" event followed by "step" events on every status change.
  r.get("/flow-runs/:id/events/stream", auth, (c) => {
    const runId = c.req.param("id");
    return streamSSE(c, async (sse) => {
      const writeSnapshot = async (eventName: "snapshot" | "step") => {
        const snap = await loadFlowRunSnapshot(deps.db, runId);
        if (!snap) return null;
        await sse.writeSSE({
          event: eventName,
          data: JSON.stringify(snap),
        });
        return snap;
      };

      const initial = await writeSnapshot("snapshot");
      if (!initial) {
        await sse.writeSSE({ event: "end", data: JSON.stringify({ status: "missing" }) });
        return;
      }
      if (TERMINAL.has(initial.run.status)) {
        await sse.writeSSE({
          event: "end",
          data: JSON.stringify({ status: initial.run.status }),
        });
        return;
      }

      const onNotify = (payload: string) => {
        if (payload !== runId) return;
        writeSnapshot("step").catch((err: unknown) => {
          console.error("[sse] flow snapshot error", err);
        });
      };
      const stepSub = await deps.pg.listen("flow_run_steps", onNotify);
      const runSub = await deps.pg.listen("flow_runs", onNotify);

      const heartbeat = setInterval(() => {
        sse.writeSSE({ event: "ping", data: "" }).catch(() => undefined);
      }, 15_000);

      const terminalCheck = setInterval(async () => {
        const snap = await loadFlowRunSnapshot(deps.db, runId);
        if (snap && TERMINAL.has(snap.run.status)) {
          await sse.writeSSE({ event: "step", data: JSON.stringify(snap) });
          await sse.writeSSE({
            event: "end",
            data: JSON.stringify({ status: snap.run.status }),
          });
          clearInterval(heartbeat);
          clearInterval(terminalCheck);
          await stepSub.unlisten();
          await runSub.unlisten();
          await sse.close();
        }
      }, 2_000);

      sse.onAbort(async () => {
        clearInterval(heartbeat);
        clearInterval(terminalCheck);
        await stepSub.unlisten();
        await runSub.unlisten();
      });
    });
  });

  void agentRuns;
  return r;
}

async function loadFlowRunSnapshot(db: Db, id: string) {
  const run = await db.query.flowRuns.findFirst({ where: eq(flowRuns.id, id) });
  if (!run) return null;
  const steps = await db.query.flowRunSteps.findMany({
    where: eq(flowRunSteps.flowRunId, id),
    orderBy: [flowRunSteps.idx],
  });
  const stepIds = steps.map((s) => s.id);
  const agentRunsList = stepIds.length
    ? await db.query.agentRuns.findMany({
        where: and(
          isNotNull(agentRuns.flowRunStepId),
          inArray(agentRuns.flowRunStepId, stepIds),
        ),
      })
    : [];
  return { run, steps, agentRuns: agentRunsList };
}

function clampLimit(v: string | undefined): number {
  const n = Number.parseInt(v ?? "50", 10);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(n, 1), 200);
}
