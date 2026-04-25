import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { agentRuns, flowRuns, flowRunSteps, flows } from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";

interface FlowRoutesDeps {
  db: Db;
}

export function flowRoutes(deps: FlowRoutesDeps) {
  const r = new Hono<AuthEnv>();
  r.use("*", requireUser());

  // List flows for a project
  r.get("/projects/:id/flows", async (c) => {
    const projectId = c.req.param("id");
    const rows = await deps.db.query.flows.findMany({
      where: eq(flows.projectId, projectId),
    });
    return c.json({ flows: rows });
  });

  // Single flow detail with recent runs
  r.get("/projects/:id/flows/:slug", async (c) => {
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

  // Recent flow runs across the project
  r.get("/projects/:id/flow-runs", async (c) => {
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
  r.get("/flow-runs/:id", async (c) => {
    const id = c.req.param("id");
    const run = await deps.db.query.flowRuns.findFirst({
      where: eq(flowRuns.id, id),
    });
    if (!run) return c.json({ error: "not found" }, 404);
    const steps = await deps.db.query.flowRunSteps.findMany({
      where: eq(flowRunSteps.flowRunId, id),
      orderBy: [flowRunSteps.idx],
    });

    const stepIds = steps.map((s) => s.id);
    const agentRunsList = stepIds.length
      ? await deps.db.query.agentRuns.findMany({
          where: (a, { inArray, isNotNull, and }) =>
            and(isNotNull(a.flowRunStepId), inArray(a.flowRunStepId, stepIds)),
        })
      : [];

    return c.json({ run, steps, agentRuns: agentRunsList });
  });

  void agentRuns;
  return r;
}

function clampLimit(v: string | undefined): number {
  const n = Number.parseInt(v ?? "50", 10);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(n, 1), 200);
}
