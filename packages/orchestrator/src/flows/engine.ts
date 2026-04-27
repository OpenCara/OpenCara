import { ulid } from "ulid";
import { eq, type InferSelectModel } from "drizzle-orm";
import type { Sql } from "postgres";
import { FlowDefinitionSchema, type FlowDefinition, type FlowNode } from "@openkira/flows";
import type { Db } from "../db/client.js";
import {
  flowNodeSettings,
  flowRuns,
  flowRunSteps,
  flows,
  githubInstallations,
  projects,
} from "../db/schema.js";
import type { AgentDispatcher } from "../dispatch/dispatcher.js";
import type { GithubAppClient } from "../github/app.js";
import { buildPullRequestContext, type PullRequestContext } from "./context.js";
import {
  actionRunner,
  agentRunner,
  triggerRunner,
  SkipFlowError,
  type NodeRunCtx,
} from "./nodeRunners.js";

export interface PlatformEventInput {
  id: string;
  type: string;
  projectId: string | null;
  payload: unknown;
}

export interface FlowEngineDeps {
  db: Db;
  pg: Sql;
  app: GithubAppClient;
  dispatcher: AgentDispatcher;
}

export class FlowEngine {
  constructor(private deps: FlowEngineDeps) {}

  /** Fire-and-forget: webhook caller should NOT await this. */
  onPlatformEvent(event: PlatformEventInput): void {
    if (!event.projectId) return;
    setImmediate(() => {
      this.dispatchEvent(event).catch((err) => {
        console.error("[flow-engine] dispatch error", { eventId: event.id, err });
      });
    });
  }

  /**
   * Manually trigger a single flow. Allocates the flow_run row up front so the
   * caller can return its id, then runs the loop on setImmediate.
   * Throws if the flow is missing/invalid or its project lookup fails.
   */
  async triggerFlow(
    flowId: string,
    event: PlatformEventInput,
  ): Promise<{ flowRunId: string }> {
    const row = await this.deps.db.query.flows.findFirst({
      where: eq(flows.id, flowId),
    });
    if (!row) throw new Error(`flow ${flowId} not found`);
    if (!row.enabled) throw new Error(`flow ${flowId} is disabled`);

    const def = parseFlowDefinition(row);
    if (!def) throw new Error(`flow ${flowId} has an invalid graph`);

    const prepared = await this.prepareRun(row.id, event);
    if (!prepared) throw new Error(`flow ${flowId} project/installation missing`);

    setImmediate(() => {
      this.executeFlow(prepared, def, event).catch((err) => {
        console.error("[flow-engine] runFlow failed", { flowId: row.id, err });
      });
    });
    return { flowRunId: prepared.flowRunId };
  }

  private async dispatchEvent(event: PlatformEventInput): Promise<void> {
    const projectFlows = await this.deps.db.query.flows.findMany({
      where: eq(flows.projectId, event.projectId!),
    });
    for (const row of projectFlows) {
      if (!row.enabled) continue;
      const def = parseFlowDefinition(row);
      if (!def) continue;

      try {
        const prepared = await this.prepareRun(row.id, event);
        if (!prepared) continue;
        await this.executeFlow(prepared, def, event);
      } catch (err) {
        console.error("[flow-engine] runFlow failed", { flowId: row.id, err });
      }
    }
  }

  private async prepareRun(
    flowId: string,
    event: PlatformEventInput,
  ): Promise<PreparedRun | null> {
    const project = await this.deps.db.query.projects.findFirst({
      where: eq(projects.id, event.projectId!),
    });
    if (!project) return null;
    const installation = await this.deps.db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.id, project.installationId),
    });
    if (!installation) return null;

    const flowRunId = ulid();
    await this.deps.db.insert(flowRuns).values({
      id: flowRunId,
      flowId,
      projectId: project.id,
      triggerEventId: event.id,
      status: "running",
      startedAt: new Date(),
    });
    await this.deps.pg.notify("flow_runs", flowRunId);

    return { flowRunId, flowId, project, installation };
  }

  private async executeFlow(
    prepared: PreparedRun,
    def: FlowDefinition,
    event: PlatformEventInput,
  ): Promise<void> {
    const { flowRunId, flowId, project, installation } = prepared;

    // Pre-build PR context once if it's a pull_request event (cheap optimization;
    // avoids re-fetching the diff for every agent node in the chain).
    let prContext: PullRequestContext | undefined;
    if (event.type === "pull_request") {
      try {
        prContext = await buildPullRequestContext(
          this.deps.app,
          installation,
          project,
          event.payload as never,
        );
      } catch (err) {
        console.error("[flow-engine] pr context fetch failed", err);
      }
    }

    // Per-node custom labels (rename feature). Used by buildFanInInput so
    // synthesizer prompts read "## From Correctness reviewer" rather than
    // the raw node id.
    const settingsRows = await this.deps.db.query.flowNodeSettings.findMany({
      where: eq(flowNodeSettings.flowId, flowId),
    });
    const labels = new Map<string, string>();
    for (const r of settingsRows) {
      if (r.label) labels.set(r.nodeId, r.label);
    }

    const outputs = new Map<string, string | undefined>();
    let nodeIdx = 0;
    let failed = false;
    let errorMsg: string | undefined;
    let skipped = false;

    let layers: FlowNode[][];
    try {
      layers = buildLayers(def);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.deps.db
        .update(flowRuns)
        .set({ status: "failed", finishedAt: new Date(), error: message })
        .where(eq(flowRuns.id, flowRunId));
      await this.deps.pg.notify("flow_runs", flowRunId);
      return;
    }

    outer: for (const layer of layers) {
      // Snapshot idx per node before launching the layer so step rows have
      // stable, sequential idx even when siblings run concurrently.
      const layerJobs = layer.map((node) => ({
        node,
        idx: nodeIdx++,
        previousOutput: buildFanInInput(node, def.edges, outputs, labels),
      }));

      const results = await Promise.allSettled(
        layerJobs.map((job) => this.runNodeStep(prepared, def, job, event, prContext)),
      );

      for (let i = 0; i < layerJobs.length; i++) {
        const r = results[i]!;
        const node = layerJobs[i]!.node;
        if (r.status === "fulfilled") {
          if (r.value.skipped) {
            skipped = true;
            continue;
          }
          outputs.set(node.id, r.value.stdoutCaptured);
        } else {
          failed = true;
          errorMsg ??= r.reason instanceof Error ? r.reason.message : String(r.reason);
        }
      }

      if (failed || skipped) break outer;
    }

    await this.deps.db
      .update(flowRuns)
      .set({
        status: failed ? "failed" : skipped ? "cancelled" : "succeeded",
        finishedAt: new Date(),
        error: errorMsg,
      })
      .where(eq(flowRuns.id, flowRunId));
    await this.deps.pg.notify("flow_runs", flowRunId);
  }

  /**
   * Run a single node: insert the step row, dispatch to its runner, persist
   * the outcome. Returns the captured stdout (for downstream fan-in) and a
   * skipped flag (SkipFlowError = the run should cancel cleanly).
   *
   * Throws on any non-skip failure so the caller's Promise.allSettled marks
   * the layer as failed.
   */
  private async runNodeStep(
    prepared: PreparedRun,
    def: FlowDefinition,
    job: { node: FlowNode; idx: number; previousOutput: string | undefined },
    event: PlatformEventInput,
    prContext: PullRequestContext | undefined,
  ): Promise<{ stdoutCaptured?: string; skipped: boolean }> {
    void def;
    const { flowRunId, flowId, project, installation } = prepared;
    const { node, idx, previousOutput } = job;

    const stepId = ulid();
    await this.deps.db.insert(flowRunSteps).values({
      id: stepId,
      flowRunId,
      nodeId: node.id,
      nodeKind: node.kind,
      idx,
      status: "running",
      startedAt: new Date(),
      inputJson: {
        nodeKind: node.kind,
        nodeConfig: node.config,
        previousOutput: previousOutput ? truncate(previousOutput, 4000) : null,
        eventType: event.type,
      },
    });
    await this.deps.pg.notify("flow_run_steps", flowRunId);

    const baseCtx: NodeRunCtx = {
      db: this.deps.db,
      pg: this.deps.pg,
      app: this.deps.app,
      dispatcher: this.deps.dispatcher,
      flowId,
      flowRunId,
      flowRunStepId: stepId,
      projectId: project.id,
      installation: {
        id: installation.id,
        githubInstallationId: installation.githubInstallationId,
      },
      project: { owner: project.owner, name: project.name },
      event,
      prContext,
      previousOutput,
    };

    try {
      let result;
      if (node.kind === "github.pull_request") {
        result = await triggerRunner(baseCtx, node);
      } else if (node.kind === "agent") {
        result = await agentRunner(baseCtx, node);
      } else {
        result = await actionRunner(baseCtx, node as never);
      }

      await this.deps.db
        .update(flowRunSteps)
        .set({
          status: "succeeded",
          outputJson: (result.output ?? null) as object | null,
          finishedAt: new Date(),
        })
        .where(eq(flowRunSteps.id, stepId));
      await this.deps.pg.notify("flow_run_steps", flowRunId);

      return { stdoutCaptured: result.stdoutCaptured, skipped: false };
    } catch (err) {
      if (err instanceof SkipFlowError) {
        await this.deps.db
          .update(flowRunSteps)
          .set({ status: "skipped", finishedAt: new Date(), error: err.message })
          .where(eq(flowRunSteps.id, stepId));
        await this.deps.pg.notify("flow_run_steps", flowRunId);
        return { skipped: true };
      }
      const message = err instanceof Error ? err.message : String(err);
      await this.deps.db
        .update(flowRunSteps)
        .set({ status: "failed", finishedAt: new Date(), error: message })
        .where(eq(flowRunSteps.id, stepId));
      await this.deps.pg.notify("flow_run_steps", flowRunId);
      throw err;
    }
  }
}

interface PreparedRun {
  flowRunId: string;
  flowId: string;
  project: InferSelectModel<typeof projects>;
  installation: InferSelectModel<typeof githubInstallations>;
}

function parseFlowDefinition(row: {
  slug: string;
  name: string;
  graphJson: unknown;
}): FlowDefinition | null {
  const graph = row.graphJson as {
    nodes: unknown;
    edges: unknown;
    description?: string;
  };
  try {
    return FlowDefinitionSchema.parse({
      slug: row.slug,
      name: row.name,
      description: graph.description ?? "",
      nodes: graph.nodes,
      edges: graph.edges,
    });
  } catch (err) {
    console.error("[flow-engine] invalid flow graph", { slug: row.slug, err });
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…[truncated ${s.length - n} chars]`;
}

/**
 * Topological grouping of a flow graph. Each layer contains nodes whose
 * incoming edges are all satisfied by previous layers — siblings within a
 * layer have no inter-dependency and are safe to run in parallel.
 *
 * Throws if the graph contains a cycle. Linear flows degenerate to one node
 * per layer (preserves the previous engine's execution order).
 */
function buildLayers(def: FlowDefinition): FlowNode[][] {
  const incoming = new Map<string, Set<string>>();
  const nodeById = new Map<string, FlowNode>();
  for (const n of def.nodes) {
    nodeById.set(n.id, n);
    incoming.set(n.id, new Set());
  }
  for (const e of def.edges) {
    if (!nodeById.has(e.source) || !nodeById.has(e.target)) continue;
    incoming.get(e.target)!.add(e.source);
  }

  const layers: FlowNode[][] = [];
  const remaining = new Set(nodeById.keys());
  const completed = new Set<string>();

  while (remaining.size > 0) {
    const layerIds: string[] = [];
    for (const id of remaining) {
      const ins = incoming.get(id)!;
      let ok = true;
      for (const upstream of ins) {
        if (!completed.has(upstream)) {
          ok = false;
          break;
        }
      }
      if (ok) layerIds.push(id);
    }
    if (layerIds.length === 0) {
      throw new Error(`flow has a cycle (or unreachable nodes): ${[...remaining].join(",")}`);
    }
    // Stable order within a layer: source array order.
    const layer = def.nodes.filter((n) => layerIds.includes(n.id));
    layers.push(layer);
    for (const id of layerIds) {
      remaining.delete(id);
      completed.add(id);
    }
  }
  return layers;
}

/**
 * Compose a node's previousOutput from its upstream nodes' captured stdout.
 * - 0 incoming: undefined (e.g. trigger nodes)
 * - 1 incoming: that node's output verbatim — preserves the linear chain that
 *   single-agent flows expect
 * - 2+ incoming: markdown sections so a synthesizer agent can parse them
 */
function buildFanInInput(
  node: FlowNode,
  edges: FlowDefinition["edges"],
  outputs: Map<string, string | undefined>,
  labels: Map<string, string>,
): string | undefined {
  const incoming = edges.filter((e) => e.target === node.id);
  if (incoming.length === 0) return undefined;
  if (incoming.length === 1) return outputs.get(incoming[0]!.source);
  return incoming
    .map((e) => {
      const heading = labels.get(e.source) ?? e.source;
      return `## From ${heading}\n\n${outputs.get(e.source) ?? ""}`;
    })
    .join("\n\n---\n\n");
}

export type { FlowNode };
