import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ulid } from "ulid";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Sql } from "postgres";
import type { Db } from "../../db/client.js";
import {
  agentRuns,
  flowNodeSettings,
  flowRuns,
  flowRunSteps,
  flows,
  platformEvents,
} from "../../db/schema.js";
import { FlowDefinitionSchema } from "@opencara/flows";
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
    // Hide trigger-skip noise unless caller opts in. Each inbound webhook
    // fans out to (project flow × event), so a single pull_request webhook
    // generates one cancelled-with-trigger-skip row per flow whose trigger
    // doesn't match — that's most of the rows on this page.
    const includeSkipped = c.req.query("includeSkipped") === "true";
    const runs = await deps.db.query.flowRuns.findMany({
      where: includeSkipped
        ? eq(flowRuns.flowId, flow.id)
        : and(
            eq(flowRuns.flowId, flow.id),
            sql`(${flowRuns.cancelReason} IS NULL OR ${flowRuns.cancelReason} <> 'trigger_skip')`,
          ),
      orderBy: [desc(flowRuns.createdAt)],
      limit: 50,
    });
    return c.json({ flow, runs });
  });

  // Toggle a flow's enabled state. Disabled flows are skipped by the webhook
  // dispatcher AND refused by triggerFlow, so this is the kill-switch users
  // reach for when a built-in flow is misbehaving.
  r.patch("/projects/:id/flows/:slug", auth, async (c) => {
    const projectId = c.req.param("id");
    const slug = c.req.param("slug");
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled (boolean) required" }, 400);
    }
    const flow = await deps.db.query.flows.findFirst({
      where: and(eq(flows.projectId, projectId), eq(flows.slug, slug)),
    });
    if (!flow) return c.json({ error: "not found" }, 404);
    await deps.db
      .update(flows)
      .set({ enabled: body.enabled, updatedAt: new Date() })
      .where(eq(flows.id, flow.id));
    const updated = await deps.db.query.flows.findFirst({ where: eq(flows.id, flow.id) });
    return c.json({ flow: updated });
  });

  // Sets customizedAt so the seeder doesn't clobber the edit on next start.
  // No project-ownership gate — `projects` has no userId column today, so
  // flow routes share the same trust boundary (any authenticated user can
  // edit any flow they know the ids of). When a real per-user model lands,
  // every route in this file needs the same gate.
  r.patch(
    "/projects/:projectId/flows/:flowId/nodes/:nodeId/config",
    auth,
    async (c) => {
      const projectId = c.req.param("projectId");
      const flowId = c.req.param("flowId");
      const nodeId = c.req.param("nodeId");
      const body = await c.req.json().catch(() => ({}));
      if (!body.config || typeof body.config !== "object") {
        return c.json({ error: "config (object) required" }, 400);
      }

      const flow = await deps.db.query.flows.findFirst({
        where: and(eq(flows.id, flowId), eq(flows.projectId, projectId)),
      });
      if (!flow) return c.json({ error: "flow not found in project" }, 404);

      const graph = parseGraph(flow.graphJson);
      if (!graph) return c.json({ error: "flow graph invalid" }, 400);

      const target = graph.nodes.find((n) => n.id === nodeId);
      if (!target) return c.json({ error: "node not found" }, 404);

      target.config = body.config as typeof target.config;

      // Validate the candidate graph before persisting — without this, an
      // invalid config (missing required field, wrong shape) writes through
      // and breaks FlowDefinitionSchema.parse on the next load.
      const validation = FlowDefinitionSchema.safeParse({
        slug: flow.slug,
        name: flow.name,
        description:
          (flow.graphJson as { description?: string })?.description ?? "",
        nodes: graph.nodes,
        edges: graph.edges,
      });
      if (!validation.success) {
        const issue = validation.error.issues[0];
        return c.json(
          {
            error: `invalid config: ${issue?.path.join(".") ?? ""} ${issue?.message ?? "validation failed"}`,
          },
          400,
        );
      }

      await deps.db
        .update(flows)
        .set({
          graphJson: graph,
          customizedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(flows.id, flow.id));

      const updated = await deps.db.query.flows.findFirst({
        where: eq(flows.id, flow.id),
      });
      return c.json({ flow: updated });
    },
  );

  // Add a reviewer node to a multi-agent review flow. Clones the first
  // existing reviewer (any node with edges trigger→X→synthesizer) so
  // the new node inherits a sane shape, then wires trigger → new and
  // new → synthesizer. Sets customizedAt to lock the seeder out.
  r.post("/projects/:projectId/flows/:flowId/reviewers", auth, async (c) => {
    const projectId = c.req.param("projectId");
    const flowId = c.req.param("flowId");
    const flow = await deps.db.query.flows.findFirst({
      where: and(eq(flows.id, flowId), eq(flows.projectId, projectId)),
    });
    if (!flow) return c.json({ error: "flow not found in project" }, 404);

    const graph = parseGraph(flow.graphJson);
    if (!graph) return c.json({ error: "flow graph invalid" }, 400);

    const trigger = graph.nodes.find((n) => n.kind === "github.pull_request");
    const synth = graph.nodes.find(
      (n) => n.kind === "agent" && (n.id === "synthesizer" || /synth/i.test(n.id)),
    );
    if (!trigger || !synth) {
      return c.json(
        { error: "flow shape not supported (need a trigger and a synthesizer node)" },
        400,
      );
    }

    const reviewerNodes = graph.nodes.filter(
      (n) =>
        n.kind === "agent" &&
        graph.edges.some((e) => e.source === trigger.id && e.target === n.id) &&
        graph.edges.some((e) => e.source === n.id && e.target === synth.id),
    );
    const template = reviewerNodes[0];
    if (!template) {
      return c.json(
        { error: "no reviewer node to clone — add the first one in code" },
        400,
      );
    }

    const newId = `reviewer_${ulid().slice(-8).toLowerCase()}`;
    const newNode = {
      ...JSON.parse(JSON.stringify(template)),
      id: newId,
      position: {
        x: template.position.x,
        y: Math.max(...reviewerNodes.map((r) => r.position.y)) + 160,
      },
    };
    if (newNode.config && typeof newNode.config === "object") {
      newNode.config.label = `Reviewer ${reviewerNodes.length + 1}`;
    }

    graph.nodes.push(newNode);
    graph.edges.push(
      { id: `e_t_${newId}`, source: trigger.id, target: newId },
      { id: `e_${newId}_s`, source: newId, target: synth.id },
    );

    await deps.db
      .update(flows)
      .set({
        graphJson: graph,
        customizedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(flows.id, flow.id));

    const updated = await deps.db.query.flows.findFirst({ where: eq(flows.id, flow.id) });
    return c.json({ flow: updated, addedNodeId: newId });
  });

  // Remove a reviewer node. Refuses if it's the last reviewer between trigger
  // and synthesizer. Removes incident edges and clears any flow_node_settings
  // for the orphaned node so a future node with the same id starts clean.
  r.delete(
    "/projects/:projectId/flows/:flowId/reviewers/:nodeId",
    auth,
    async (c) => {
      const projectId = c.req.param("projectId");
      const flowId = c.req.param("flowId");
      const nodeId = c.req.param("nodeId");
      const flow = await deps.db.query.flows.findFirst({
        where: and(eq(flows.id, flowId), eq(flows.projectId, projectId)),
      });
      if (!flow) return c.json({ error: "flow not found in project" }, 404);
      const graph = parseGraph(flow.graphJson);
      if (!graph) return c.json({ error: "flow graph invalid" }, 400);

      const trigger = graph.nodes.find((n) => n.kind === "github.pull_request");
      const synth = graph.nodes.find(
        (n) => n.kind === "agent" && (n.id === "synthesizer" || /synth/i.test(n.id)),
      );
      if (!trigger || !synth) return c.json({ error: "flow shape not supported" }, 400);

      const reviewerIds = new Set(
        graph.nodes
          .filter(
            (n) =>
              n.kind === "agent" &&
              graph.edges.some((e) => e.source === trigger.id && e.target === n.id) &&
              graph.edges.some((e) => e.source === n.id && e.target === synth.id),
          )
          .map((n) => n.id),
      );
      if (!reviewerIds.has(nodeId)) {
        return c.json({ error: "node is not a reviewer in this flow" }, 400);
      }
      if (reviewerIds.size <= 1) {
        return c.json(
          { error: "cannot remove the last reviewer — synthesizer would have no input" },
          400,
        );
      }

      graph.nodes = graph.nodes.filter((n) => n.id !== nodeId);
      graph.edges = graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);

      await deps.db
        .update(flows)
        .set({
          graphJson: graph,
          customizedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(flows.id, flow.id));

      // Cleanup any per-node settings (label / agent / prompt link) for the
      // removed node so a re-added node with the same id starts clean.
      await deps.db
        .delete(flowNodeSettings)
        .where(
          and(
            eq(flowNodeSettings.flowId, flow.id),
            eq(flowNodeSettings.nodeId, nodeId),
          ),
        );

      const updated = await deps.db.query.flows.findFirst({ where: eq(flows.id, flow.id) });
      return c.json({ flow: updated });
    },
  );

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
    // See /flows/:slug — trigger-skip rows are noise from the webhook
    // fan-out to (flow × event); hide unless ?includeSkipped=true.
    const includeSkipped = c.req.query("includeSkipped") === "true";
    const rows = await deps.db.query.flowRuns.findMany({
      where: includeSkipped
        ? eq(flowRuns.projectId, projectId)
        : and(
            eq(flowRuns.projectId, projectId),
            sql`(${flowRuns.cancelReason} IS NULL OR ${flowRuns.cancelReason} <> 'trigger_skip')`,
          ),
      orderBy: [desc(flowRuns.createdAt)],
      limit,
    });
    return c.json({ runs: rows });
  });

  // Single flow_run + its steps + linked agent_runs
  // Re-run a flow run. body { fromStepId?: string } chooses behaviour:
  //   - omitted → re-execute every node from the original trigger event
  //   - present → preload outputs from upstream succeeded steps and re-run
  //     starting from the supplied (failed) step. Step must belong to the
  //     run and the user must have access to its project.
  r.post("/flow-runs/:id/rerun", auth, async (c) => {
    if (!deps.flowEngine) {
      return c.json({ error: "flow engine not configured" }, 503);
    }
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const fromStepIdRaw = body.fromStepId;
    const fromStepId =
      typeof fromStepIdRaw === "string" && fromStepIdRaw.trim()
        ? fromStepIdRaw.trim()
        : undefined;
    const original = await deps.db.query.flowRuns.findFirst({
      where: eq(flowRuns.id, id),
    });
    if (!original) return c.json({ error: "flow run not found" }, 404);
    try {
      const { flowRunId } = await deps.flowEngine.rerunFlow(id, { fromStepId });
      return c.json({ flowRunId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

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

interface MutableGraph {
  nodes: Array<{
    id: string;
    kind: string;
    position: { x: number; y: number };
    config?: { label?: string };
    [key: string]: unknown;
  }>;
  edges: Array<{ id: string; source: string; target: string }>;
  description?: string;
}

function parseGraph(raw: unknown): MutableGraph | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as MutableGraph;
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;
  // Defensive deep clone so callers mutate a fresh object — avoids accidentally
  // mutating drizzle's cached row reference.
  return JSON.parse(JSON.stringify(g)) as MutableGraph;
}

function clampLimit(v: string | undefined): number {
  const n = Number.parseInt(v ?? "50", 10);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(n, 1), 200);
}
