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
import {
  validateCron,
  nextCronOccurrences,
  isValidTimeZone,
} from "@opencara/shared";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import { loadOwnedProject } from "../../auth/ownership.js";
import { resetProjectFlowToTemplate } from "../../flows/builtin.js";
import { cancelFlowRunAgents } from "../../flows/cancelAgents.js";
import type { FlowEngine } from "../../flows/engine.js";
import type { AgentDispatcher } from "../../dispatch/dispatcher.js";
import {
  FLOW_RUNS_CHANNEL,
  parseFlowRunsNotify,
  serializeFlowRunsNotify,
} from "../../flows/notify.js";

interface FlowRoutesDeps {
  db: Db;
  pg: Sql;
  flowEngine?: FlowEngine;
  dispatcher?: AgentDispatcher;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export function flowRoutes(deps: FlowRoutesDeps) {
  const r = new Hono<AuthEnv>();
  const auth = requireUser();

  // List flows for a project
  r.get("/projects/:id/flows", auth, async (c) => {
    const projectId = c.req.param("id");
    const user = c.get("user")!;
    const owned = await loadOwnedProject(deps.db, projectId, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);
    const rows = await deps.db.query.flows.findMany({
      where: eq(flows.projectId, projectId),
    });
    return c.json({ flows: rows });
  });

  // Single flow detail with recent runs
  r.get("/projects/:id/flows/:slug", auth, async (c) => {
    const projectId = c.req.param("id");
    const slug = c.req.param("slug");
    const user = c.get("user")!;
    const owned = await loadOwnedProject(deps.db, projectId, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);
    const flow = await deps.db.query.flows.findFirst({
      where: and(eq(flows.projectId, projectId), eq(flows.slug, slug)),
    });
    if (!flow) return c.json({ error: "not found" }, 404);
    // Hide trigger-skip rows by default; ?includeSkipped=true shows them.
    // Webhook fan-out to (project flow × event) makes these the bulk of
    // the rows otherwise.
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
    const user = c.get("user")!;
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled (boolean) required" }, 400);
    }
    const owned = await loadOwnedProject(deps.db, projectId, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);
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

  // Reset a project flow back to its global template (discards per-project
  // graph edits, clears customizedAt so it tracks the template again).
  r.post("/projects/:id/flows/:slug/reset", auth, async (c) => {
    const projectId = c.req.param("id");
    const slug = c.req.param("slug");
    const user = c.get("user")!;
    const owned = await loadOwnedProject(deps.db, projectId, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);
    const result = await resetProjectFlowToTemplate(deps.db, projectId, slug);
    if (!result.ok) return c.json({ error: result.error }, 400);
    const flow = await deps.db.query.flows.findFirst({
      where: and(eq(flows.projectId, projectId), eq(flows.slug, slug)),
    });
    return c.json({ flow });
  });

  // Sets customizedAt so the seeder doesn't clobber the edit on next start.
  r.patch(
    "/projects/:projectId/flows/:flowId/nodes/:nodeId/config",
    auth,
    async (c) => {
      const projectId = c.req.param("projectId");
      const flowId = c.req.param("flowId");
      const nodeId = c.req.param("nodeId");
      const user = c.get("user")!;
      const body = await c.req.json().catch(() => ({}));
      if (!body.config || typeof body.config !== "object") {
        return c.json({ error: "config (object) required" }, 400);
      }

      const owned = await loadOwnedProject(deps.db, projectId, user.id);
      if (!owned) return c.json({ error: "flow not found in project" }, 404);
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
    const user = c.get("user")!;
    const owned = await loadOwnedProject(deps.db, projectId, user.id);
    if (!owned) return c.json({ error: "flow not found in project" }, 404);
    const flow = await deps.db.query.flows.findFirst({
      where: and(eq(flows.id, flowId), eq(flows.projectId, projectId)),
    });
    if (!flow) return c.json({ error: "flow not found in project" }, 404);

    const graph = parseGraph(flow.graphJson);
    if (!graph) return c.json({ error: "flow graph invalid" }, 400);

    // Anchor on the synthesizer: reviewers are the agents feeding it. This is
    // robust to graphs with more than one PR trigger (e.g. development-lifecycle's
    // independent single-review component, whose reviewer feeds its own post,
    // not the synthesizer).
    const synth = graph.nodes.find(
      (n) => n.kind === "agent" && (n.id === "synthesizer" || /synth/i.test(n.id)),
    );
    if (!synth) {
      return c.json({ error: "flow shape not supported (need a synthesizer node)" }, 400);
    }
    const reviewerNodes = graph.nodes.filter(
      (n) =>
        n.kind === "agent" &&
        graph.edges.some((e) => e.source === n.id && e.target === synth.id),
    );
    const template = reviewerNodes[0];
    if (!template) {
      return c.json(
        { error: "no reviewer node to clone — add the first one in code" },
        400,
      );
    }
    // Wire the new reviewer to the SAME PR trigger that feeds the existing
    // reviewers (not any/the first PR trigger in the graph).
    const triggerEdge = graph.edges.find((e) => e.target === template.id);
    const trigger = triggerEdge
      ? graph.nodes.find(
          (n) => n.id === triggerEdge.source && n.kind === "github.pull_request",
        )
      : undefined;
    if (!trigger) {
      return c.json(
        { error: "flow shape not supported (no PR trigger feeding the reviewers)" },
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
      const user = c.get("user")!;
      const owned = await loadOwnedProject(deps.db, projectId, user.id);
      if (!owned) return c.json({ error: "flow not found in project" }, 404);
      const flow = await deps.db.query.flows.findFirst({
        where: and(eq(flows.id, flowId), eq(flows.projectId, projectId)),
      });
      if (!flow) return c.json({ error: "flow not found in project" }, 404);
      const graph = parseGraph(flow.graphJson);
      if (!graph) return c.json({ error: "flow graph invalid" }, 400);

      // Synth-anchored (see the POST handler): reviewers are the agents feeding
      // the synthesizer, so a second PR trigger / single-review node is ignored.
      const synth = graph.nodes.find(
        (n) => n.kind === "agent" && (n.id === "synthesizer" || /synth/i.test(n.id)),
      );
      if (!synth) return c.json({ error: "flow shape not supported" }, 400);

      const reviewerIds = new Set(
        graph.nodes
          .filter(
            (n) =>
              n.kind === "agent" &&
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
  // Accepts optional `{ issueNumber: number }` — when present, the engine
  // seeds an issueContext so label-based agent routing fires for manual runs
  // (used by the kanban Start button).
  r.post("/projects/:id/flows/:slug/trigger", auth, async (c) => {
    if (!deps.flowEngine) {
      return c.json({ error: "flow engine not configured" }, 503);
    }
    const projectId = c.req.param("id");
    const slug = c.req.param("slug");
    const user = c.get("user")!;
    const owned = await loadOwnedProject(deps.db, projectId, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);
    const flow = await deps.db.query.flows.findFirst({
      where: and(eq(flows.projectId, projectId), eq(flows.slug, slug)),
    });
    if (!flow) return c.json({ error: "not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const issueNumber =
      typeof body.issueNumber === "number" && Number.isFinite(body.issueNumber) && body.issueNumber > 0
        ? body.issueNumber
        : undefined;

    const payload: Record<string, unknown> = {};
    if (issueNumber !== undefined) payload.issueNumber = issueNumber;

    const eventId = ulid();
    await deps.db.insert(platformEvents).values({
      id: eventId,
      platform: "github",
      type: "manual",
      payload,
      projectId,
      deliveryId: eventId,
    });

    try {
      const { flowRunId } = await deps.flowEngine.triggerFlow(flow.id, {
        id: eventId,
        type: "manual",
        projectId,
        payload,
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
    const user = c.get("user")!;
    const owned = await loadOwnedProject(deps.db, projectId, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);
    const limit = clampLimit(c.req.query("limit"));
    // Hide trigger-skip rows by default; ?includeSkipped=true shows them.
    const includeSkipped = c.req.query("includeSkipped") === "true";
    const where = includeSkipped
      ? eq(flowRuns.projectId, projectId)
      : and(
          eq(flowRuns.projectId, projectId),
          sql`(${flowRuns.cancelReason} IS NULL OR ${flowRuns.cancelReason} <> 'trigger_skip')`,
        );
    // LEFT JOIN the originating platform event so the UI can show a trigger
    // type indicator (#128): "schedule" for cron runs, "pull_request" /
    // "projects_v2_item" / "manual" / … for the rest. triggerType is null
    // only for legacy rows whose event was pruned.
    const rows = await deps.db
      .select({
        id: flowRuns.id,
        flowId: flowRuns.flowId,
        projectId: flowRuns.projectId,
        triggerEventId: flowRuns.triggerEventId,
        triggerType: platformEvents.type,
        status: flowRuns.status,
        startedAt: flowRuns.startedAt,
        finishedAt: flowRuns.finishedAt,
        createdAt: flowRuns.createdAt,
        error: flowRuns.error,
        cancelReason: flowRuns.cancelReason,
      })
      .from(flowRuns)
      .leftJoin(platformEvents, eq(flowRuns.triggerEventId, platformEvents.id))
      .where(where)
      .orderBy(desc(flowRuns.createdAt))
      .limit(limit);
    return c.json({ runs: rows });
  });

  // ── Scheduled tasks (cron) ────────────────────────────────────────────────
  // A scheduled task is modelled as a dedicated flow whose entry-point is a
  // `schedule.cron` trigger (graph: schedule → agent). These endpoints give the
  // project-settings UI a flat CRUD surface over those flows without exposing
  // the underlying graph plumbing. The orchestrator's scheduler loop fires them
  // (see flows/scheduler.ts); editing cron/enabled here just rewrites the
  // trigger node's config + flows.enabled.

  // List the project's scheduled tasks with their next fire times.
  r.get("/projects/:id/schedules", auth, async (c) => {
    const projectId = c.req.param("id");
    const user = c.get("user")!;
    const owned = await loadOwnedProject(deps.db, projectId, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);
    const rows = await deps.db.query.flows.findMany({
      where: eq(flows.projectId, projectId),
    });
    const schedules = rows
      .map((f) => buildScheduleSummary(f))
      .filter((s): s is ScheduleSummary => s !== null);
    return c.json({ schedules });
  });

  // Create a scheduled task: a new flow with a schedule.cron → agent graph.
  r.post("/projects/:id/schedules", auth, async (c) => {
    const projectId = c.req.param("id");
    const user = c.get("user")!;
    const owned = await loadOwnedProject(deps.db, projectId, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Scheduled task";
    const cron = typeof body.cron === "string" ? body.cron.trim() : "";
    const timezone = typeof body.timezone === "string" && body.timezone ? body.timezone : "UTC";

    const cronCheck = validateCron(cron);
    if (!cronCheck.valid) {
      return c.json({ error: `invalid cron: ${cronCheck.error}` }, 400);
    }
    if (!isValidTimeZone(timezone)) {
      return c.json({ error: `invalid timezone: ${timezone}` }, 400);
    }

    const flowId = ulid();
    const slug = `schedule-${flowId.slice(-10).toLowerCase()}`;
    const graph = {
      description: `Scheduled task: ${name}`,
      nodes: [
        {
          id: "schedule",
          kind: "schedule.cron",
          position: { x: 0, y: 0 },
          config: { name, cron, timezone, enabled: true },
        },
        {
          id: "agent",
          kind: "agent",
          position: { x: 0, y: 200 },
          config: {
            label: "Scheduled agent",
            contextInjection: {
              env: [
                "OPENCARA_REPO",
                "OPENCARA_SCHEDULE_NAME",
                "OPENCARA_SCHEDULE_CRON",
                "OPENCARA_SCHEDULE_TIMEZONE",
                "OPENCARA_SCHEDULE_RUN_AT",
              ],
              stdinJson: true,
            },
          },
        },
      ],
      edges: [{ id: "e_schedule_agent", source: "schedule", target: "agent" }],
    };

    // Validate the assembled graph before persisting (same guard as node config
    // edits) so a future schema change can't let a broken schedule flow land.
    const validation = FlowDefinitionSchema.safeParse({
      slug,
      name,
      description: graph.description,
      nodes: graph.nodes,
      edges: graph.edges,
    });
    if (!validation.success) {
      const issue = validation.error.issues[0];
      return c.json(
        { error: `invalid schedule: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}` },
        400,
      );
    }

    const now = new Date();
    await deps.db.insert(flows).values({
      id: flowId,
      projectId,
      slug,
      name,
      graphJson: graph,
      enabled: true,
      customizedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const created = await deps.db.query.flows.findFirst({ where: eq(flows.id, flowId) });
    return c.json({ schedule: created ? buildScheduleSummary(created) : null }, 201);
  });

  // Edit a scheduled task: name / cron / timezone / enabled.
  r.patch("/projects/:id/schedules/:flowId", auth, async (c) => {
    const projectId = c.req.param("id");
    const flowId = c.req.param("flowId");
    const user = c.get("user")!;
    const owned = await loadOwnedProject(deps.db, projectId, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);
    const flow = await deps.db.query.flows.findFirst({
      where: and(eq(flows.id, flowId), eq(flows.projectId, projectId)),
    });
    if (!flow) return c.json({ error: "not found" }, 404);
    const graph = parseGraph(flow.graphJson);
    const scheduleNode = graph?.nodes.find((n) => n.kind === "schedule.cron");
    if (!graph || !scheduleNode) {
      return c.json({ error: "flow is not a scheduled task" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const cfg = (scheduleNode.config ?? {}) as Record<string, unknown>;

    if (typeof body.cron === "string") {
      const cronCheck = validateCron(body.cron.trim());
      if (!cronCheck.valid) {
        return c.json({ error: `invalid cron: ${cronCheck.error}` }, 400);
      }
      cfg.cron = body.cron.trim();
    }
    if (typeof body.timezone === "string") {
      if (!isValidTimeZone(body.timezone)) {
        return c.json({ error: `invalid timezone: ${body.timezone}` }, 400);
      }
      cfg.timezone = body.timezone;
    }
    let newName: string | undefined;
    if (typeof body.name === "string" && body.name.trim()) {
      newName = body.name.trim();
      cfg.name = newName;
    }
    let enabled: boolean | undefined;
    if (typeof body.enabled === "boolean") {
      enabled = body.enabled;
      cfg.enabled = body.enabled;
    }
    scheduleNode.config = cfg as typeof scheduleNode.config;

    const now = new Date();
    await deps.db
      .update(flows)
      .set({
        graphJson: graph,
        name: newName ?? flow.name,
        enabled: enabled ?? flow.enabled,
        customizedAt: now,
        updatedAt: now,
      })
      .where(eq(flows.id, flow.id));
    const updated = await deps.db.query.flows.findFirst({ where: eq(flows.id, flow.id) });
    return c.json({ schedule: updated ? buildScheduleSummary(updated) : null });
  });

  // Delete a scheduled task (cascades to flow_schedule_state + flow_runs).
  r.delete("/projects/:id/schedules/:flowId", auth, async (c) => {
    const projectId = c.req.param("id");
    const flowId = c.req.param("flowId");
    const user = c.get("user")!;
    const owned = await loadOwnedProject(deps.db, projectId, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);
    const flow = await deps.db.query.flows.findFirst({
      where: and(eq(flows.id, flowId), eq(flows.projectId, projectId)),
    });
    if (!flow) return c.json({ error: "not found" }, 404);
    const graph = parseGraph(flow.graphJson);
    if (!graph?.nodes.some((n) => n.kind === "schedule.cron")) {
      return c.json({ error: "flow is not a scheduled task" }, 400);
    }
    await deps.db.delete(flows).where(eq(flows.id, flow.id));
    return c.json({ ok: true });
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
    const user = c.get("user")!;
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
    // Foreign-project flow runs return the same 404 as "no row" so the
    // existence of the id can't be probed cross-account.
    const owned = await loadOwnedProject(deps.db, original.projectId, user.id);
    if (!owned) return c.json({ error: "flow run not found" }, 404);
    try {
      const { flowRunId } = await deps.flowEngine.rerunFlow(id, { fromStepId });
      return c.json({ flowRunId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  // Cancel a running flow run. Mirrors the per-wave cancel in /pm: flip the
  // row to `cancelled` only if still non-terminal (guarded UPDATE), cancel
  // the in-flight agent_runs and signal their device (best-effort — the DB
  // write is the load-bearing state either way), then ping the flow_runs
  // LISTEN channel so any SSE stream and the kanban board see the new
  // status without waiting for the next poll tick. The engine's own
  // terminal write is status-guarded, so the finished agent can't flip
  // this run back to succeeded/failed.
  r.post("/flow-runs/:id/cancel", auth, async (c) => {
    const id = c.req.param("id");
    const user = c.get("user")!;
    const run = await deps.db.query.flowRuns.findFirst({
      where: eq(flowRuns.id, id),
      columns: { id: true, projectId: true, status: true },
    });
    if (!run) return c.json({ error: "not found" }, 404);
    const owned = await loadOwnedProject(deps.db, run.projectId, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);
    if (run.status !== "pending" && run.status !== "running") {
      return c.json({ error: "already terminal" }, 409);
    }
    // The status predicate races against the engine's own terminal write
    // (the run could finish between the SELECT above and this UPDATE).
    // `.returning()` lets us tell honestly whether we actually cancelled,
    // so a no-op UPDATE returns 409 instead of pretending we stopped a
    // run that just finished.
    const updated = await deps.db
      .update(flowRuns)
      .set({
        status: "cancelled",
        cancelReason: "user_stopped",
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(flowRuns.id, id),
          inArray(flowRuns.status, ["pending", "running"]),
        ),
      )
      .returning({ id: flowRuns.id });
    if (updated.length === 0) {
      return c.json({ error: "already terminal" }, 409);
    }
    // Flip the in-flight agent_runs rows and signal the device to actually
    // kill the process. Without the WS frame, "cancelled" here was purely
    // cosmetic — the agent kept executing on the device (and could still
    // push commits / open PRs) until it finished naturally.
    let signalled = 0;
    if (deps.dispatcher) {
      ({ signalled } = await cancelFlowRunAgents(
        deps.db,
        deps.dispatcher,
        id,
        "user_stopped",
      ));
    }
    // Wake SSE listeners (both /flow-runs/:id/events/stream and the kanban
    // board, which LISTENs on `flow_runs` to refresh implement statuses).
    void deps.pg.notify(
      FLOW_RUNS_CHANNEL,
      serializeFlowRunsNotify({ flowRunId: id, projectId: run.projectId }),
    );
    return c.json({ ok: true, signalled });
  });

  r.get("/flow-runs/:id", auth, async (c) => {
    const id = c.req.param("id");
    const user = c.get("user")!;
    const run = await deps.db.query.flowRuns.findFirst({
      where: eq(flowRuns.id, id),
      columns: { id: true, projectId: true },
    });
    if (!run) return c.json({ error: "not found" }, 404);
    const owned = await loadOwnedProject(deps.db, run.projectId, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);
    const snapshot = await loadFlowRunSnapshot(deps.db, id);
    if (!snapshot) return c.json({ error: "not found" }, 404);
    return c.json(snapshot);
  });

  // SSE: live snapshot of a flow run + its steps + agent runs.
  // Initial "snapshot" event followed by "step" events on every status change.
  r.get("/flow-runs/:id/events/stream", auth, async (c) => {
    const runId = c.req.param("id");
    const user = c.get("user")!;
    // Verify ownership BEFORE opening the SSE stream so a foreign id
    // returns a normal 404 instead of an indefinitely-open empty stream.
    const run = await deps.db.query.flowRuns.findFirst({
      where: eq(flowRuns.id, runId),
      columns: { id: true, projectId: true },
    });
    if (!run) return c.json({ error: "not found" }, 404);
    const owned = await loadOwnedProject(deps.db, run.projectId, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);
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

      // flow_run_steps carries a bare flowRunId; flow_runs carries a JSON
      // { flowRunId, projectId } payload (see flows/notify.ts). Accept either:
      // resolve the run id from whichever shape arrived and match on it.
      const onNotify = (raw: string) => {
        const flowRunId = parseFlowRunsNotify(raw)?.flowRunId ?? raw;
        if (flowRunId !== runId) return;
        writeSnapshot("step").catch((err: unknown) => {
          console.error("[sse] flow snapshot error", err);
        });
      };
      const stepSub = await deps.pg.listen("flow_run_steps", onNotify);
      const runSub = await deps.pg.listen(FLOW_RUNS_CHANNEL, onNotify);

      const heartbeat = setInterval(() => {
        sse.writeSSE({ event: "ping", data: "" }).catch(() => undefined);
      }, 15_000);

      // The on-NOTIFY handler above ships snapshot updates; this poll is
      // only a fallback to detect terminal status and close the stream
      // if a NOTIFY is missed, so we must NOT refetch the snapshot here —
      // doing so re-ships every agent_run.spec (incl. multi-hundred-kB ACP
      // payloads) every 2s for the life of the stream.
      const terminalCheck = setInterval(async () => {
        // Guard the whole body: a rejection from an async setInterval is
        // unhandled and Node promotes it to a fatal uncaughtException, which
        // would take opencara.com down (see runs.ts for the full rationale —
        // the Supabase pooler's EMAXCONNSESSION under pool pressure was the
        // real trigger on 2026-06-07). Log and retry on the next tick instead.
        try {
          const r2 = await deps.db.query.flowRuns.findFirst({
            where: eq(flowRuns.id, runId),
            columns: { status: true },
          });
          if (r2 && TERMINAL.has(r2.status)) {
            const snap = await loadFlowRunSnapshot(deps.db, runId);
            if (snap) {
              await sse.writeSSE({ event: "step", data: JSON.stringify(snap) });
              await sse.writeSSE({
                event: "end",
                data: JSON.stringify({ status: snap.run.status }),
              });
            }
            clearInterval(heartbeat);
            clearInterval(terminalCheck);
            await stepSub.unlisten();
            await runSub.unlisten();
            await sse.close();
          }
        } catch (err) {
          console.error("[sse] flow terminal check error", err);
        }
      }, 2_000);

      sse.onAbort(async () => {
        clearInterval(heartbeat);
        clearInterval(terminalCheck);
        await stepSub.unlisten().catch(() => undefined);
        await runSub.unlisten().catch(() => undefined);
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
  // Project only the fields the snapshot consumer needs. Excluding `spec`
  // is load-bearing: the ACP payload it carries can be hundreds of kB per
  // row, and this function is called on every snapshot refetch.
  const agentRunsList = stepIds.length
    ? await db.query.agentRuns.findMany({
        where: and(
          isNotNull(agentRuns.flowRunStepId),
          inArray(agentRuns.flowRunStepId, stepIds),
        ),
        columns: {
          id: true,
          status: true,
          hostId: true,
          flowRunStepId: true,
          createdAt: true,
          startedAt: true,
          finishedAt: true,
          exitCode: true,
        },
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

interface ScheduleSummary {
  flowId: string;
  slug: string;
  /** Flow name (kept in sync with the schedule node's `name`). */
  name: string;
  nodeId: string;
  cron: string;
  timezone: string;
  /** Whether the schedule is active (flow enabled AND node not paused). */
  enabled: boolean;
  /** Next up-to-3 fire times (ISO 8601), or [] for an invalid cron. */
  nextFireTimes: string[];
  /** Validation message when the cron can't be parsed; null otherwise. */
  cronError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Derive a ScheduleSummary from a flow row, or null when the flow has no
 * schedule.cron trigger (i.e. it's an ordinary flow). The "enabled" flag folds
 * the flow-level switch and the node-level pause together so the UI shows one
 * coherent state.
 */
function buildScheduleSummary(flow: {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  graphJson: unknown;
  createdAt: Date;
  updatedAt: Date;
}): ScheduleSummary | null {
  const graph = parseGraph(flow.graphJson);
  const node = graph?.nodes.find((n) => n.kind === "schedule.cron");
  if (!graph || !node) return null;
  const cfg = (node.config ?? {}) as {
    name?: string;
    cron?: string;
    timezone?: string;
    enabled?: boolean;
  };
  const cron = cfg.cron ?? "";
  const timezone = cfg.timezone ?? "UTC";
  const cronCheck = validateCron(cron);
  let nextFireTimes: string[] = [];
  if (cronCheck.valid) {
    nextFireTimes = nextCronOccurrences(cron, new Date(), 3, timezone).map((d) =>
      d.toISOString(),
    );
  }
  return {
    flowId: flow.id,
    slug: flow.slug,
    name: cfg.name ?? flow.name,
    nodeId: node.id,
    cron,
    timezone,
    enabled: flow.enabled && cfg.enabled !== false,
    nextFireTimes,
    cronError: cronCheck.valid ? null : cronCheck.error ?? "invalid cron",
    createdAt: flow.createdAt.toISOString(),
    updatedAt: flow.updatedAt.toISOString(),
  };
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
