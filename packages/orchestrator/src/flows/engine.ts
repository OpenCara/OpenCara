import { ulid } from "ulid";
import { eq, type InferSelectModel } from "drizzle-orm";
import type { Sql } from "postgres";
import { FlowDefinitionSchema, type FlowDefinition, type FlowNode } from "@opencara/flows";
import type { Db } from "../db/client.js";
import {
  agentRunLogs,
  agentRuns,
  flowNodeSettings,
  flowRuns,
  flowRunSteps,
  flows,
  githubInstallations,
  platformEvents,
  projects,
} from "../db/schema.js";
import { and, asc } from "drizzle-orm";
import type { AgentDispatcher } from "../dispatch/dispatcher.js";
import type { GithubAppClient } from "../github/app.js";
import {
  buildIssueStatusContext,
  buildPullRequestContext,
  type IssueStatusContext,
  type PullRequestContext,
} from "./context.js";
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
  /** Base URL the agent uses to call back into /api/agent/* — threaded
   * down to NodeRunCtx so the agent runner can stamp it onto env vars. */
  publicBaseUrl: string;
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

  /**
   * Re-run a previous flow run.
   * - From start: re-execute every node from scratch using the original
   *   trigger event (same payload, same prContext source).
   * - From a specific failed step (`fromStepId`): preload upstream nodes'
   *   captured stdout from the prior run's agent_run_logs so the failed
   *   step + downstream see the same `previousOutput` as before. Skips
   *   re-execution of already-succeeded upstream nodes.
   */
  async rerunFlow(
    originalRunId: string,
    opts: { fromStepId?: string } = {},
  ): Promise<{ flowRunId: string }> {
    const original = await this.deps.db.query.flowRuns.findFirst({
      where: eq(flowRuns.id, originalRunId),
    });
    if (!original) throw new Error(`flow run ${originalRunId} not found`);

    const flowRow = await this.deps.db.query.flows.findFirst({
      where: eq(flows.id, original.flowId),
    });
    if (!flowRow) throw new Error(`flow ${original.flowId} not found`);
    if (!flowRow.enabled) throw new Error(`flow ${original.flowId} is disabled`);
    const def = parseFlowDefinition(flowRow);
    if (!def) throw new Error(`flow ${original.flowId} has an invalid graph`);

    let event: PlatformEventInput;
    if (original.triggerEventId) {
      const ev = await this.deps.db.query.platformEvents.findFirst({
        where: eq(platformEvents.id, original.triggerEventId),
      });
      if (!ev) throw new Error("original trigger event missing");
      event = {
        id: ev.id,
        type: ev.type,
        projectId: ev.projectId,
        payload: ev.payload,
      };
    } else {
      throw new Error("original run has no trigger event to replay");
    }

    let preloaded: PreloadedRun | undefined;
    if (opts.fromStepId) {
      preloaded = await this.buildPreloadedOutputs(
        originalRunId,
        opts.fromStepId,
        def,
      );
    }

    const prepared = await this.prepareRun(flowRow.id, event);
    if (!prepared) throw new Error("project/installation missing");

    setImmediate(() => {
      this.executeFlow(prepared, def, event, preloaded).catch((err) => {
        console.error("[flow-engine] rerunFlow failed", {
          flowId: flowRow.id,
          err,
        });
      });
    });
    return { flowRunId: prepared.flowRunId };
  }

  /**
   * Build the outputs map used by a "rerun from failed step": every node
   * that's NOT downstream of (or equal to) the failed node gets its prior
   * captured stdout slotted in, so the engine's layer loop sees them as
   * already-finished. Reconstruction sources stdout chunks from
   * agent_run_logs since flow_run_steps doesn't persist stdoutCaptured.
   */
  private async buildPreloadedOutputs(
    originalRunId: string,
    fromStepId: string,
    def: FlowDefinition,
  ): Promise<PreloadedRun> {
    const failedStep = await this.deps.db.query.flowRunSteps.findFirst({
      where: eq(flowRunSteps.id, fromStepId),
    });
    if (!failedStep || failedStep.flowRunId !== originalRunId) {
      throw new Error(`step ${fromStepId} not found in run ${originalRunId}`);
    }
    const downstream = computeDownstreamSet(def, failedStep.nodeId);

    const allSteps = await this.deps.db.query.flowRunSteps.findMany({
      where: eq(flowRunSteps.flowRunId, originalRunId),
    });

    // Note: worktree state used to invalidate reuse (the per-run
    // workdir got rm-rf'd at end of run, so any descendant that wrote
    // into it had to re-execute on the rerun's fresh checkout). With
    // worktrees now persisting across flow runs (PR-close cleanup
    // model), the workdir is still around, so descendant reuse is
    // safe — the rerun fetches + checks out the same branch and the
    // agent re-executes against current state.
    const outputs = new Map<string, string | undefined>();
    const reused: ReusedStep[] = [];
    for (const s of allSteps) {
      if (s.status !== "succeeded") continue;
      if (downstream.has(s.nodeId)) continue;
      // Reconstruct stdoutCaptured by stitching the agent_run's stdout chunks.
      // Non-agent steps (trigger, action) have no agent_run; their downstream
      // gets undefined, which matches the original execution's previousOutput.
      const ar = await this.deps.db.query.agentRuns.findFirst({
        where: eq(agentRuns.flowRunStepId, s.id),
      });
      let stdoutCaptured: string | undefined;
      if (ar) {
        const logRows = await this.deps.db
          .select({ chunk: agentRunLogs.chunk })
          .from(agentRunLogs)
          .where(
            and(eq(agentRunLogs.agentRunId, ar.id), eq(agentRunLogs.stream, "stdout")),
          )
          .orderBy(asc(agentRunLogs.seq));
        stdoutCaptured = logRows.map((r) => r.chunk).join("");
      }
      outputs.set(s.nodeId, stdoutCaptured);
      reused.push({
        nodeId: s.nodeId,
        nodeKind: s.nodeKind,
        outputJson: s.outputJson,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        originalStepId: s.id,
        originalRunId,
        originalAgentRunId: ar?.id ?? null,
      });
    }
    return { outputs, reused };
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
    preloaded?: PreloadedRun,
  ): Promise<void> {
    const { flowRunId, flowId, project, installation } = prepared;

    // Pre-build PR context once if it's a pull_request event (cheap optimization;
    // avoids re-fetching the diff for every agent node in the chain).
    // pull_request_review events use the same context shape — both carry a
    // `pull_request` field and the buildPullRequestContext helper extracts
    // review.state / review.body into envExtras when present.
    let prContext: PullRequestContext | undefined;
    if (event.type === "pull_request" || event.type === "pull_request_review") {
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

    // Same pre-build for Projects v2 status changes — the issue row lookup
    // is local so this is essentially free, but caching once keeps the env
    // injection consistent across multiple agent nodes if a flow ever fans
    // out from one trigger.
    let issueContext: IssueStatusContext | undefined;
    if (event.type === "projects_v2_item") {
      try {
        issueContext = await buildIssueStatusContext(
          this.deps.db,
          project,
          event.payload as never,
        );
      } catch (err) {
        console.error("[flow-engine] issue context fetch failed", err);
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

    // For rerun-from-failed: preload the upstream nodes' captured stdout.
    // The layer loop below skips any node whose id is already in `outputs`,
    // so those upstream nodes don't re-execute and their previousOutput
    // values still flow into the failed/downstream nodes correctly.
    const outputs = new Map<string, string | undefined>(preloaded?.outputs);
    let nodeIdx = 0;

    // Materialise a flow_run_steps row for each reused upstream node so the
    // new run's graph shows them as already-succeeded (otherwise they'd be
    // rendered idle, even though their output is being threaded through to
    // the re-executed downstream). The original step + agent_run stay
    // untouched on the source run; we just stamp a "reused" marker into
    // inputJson with the originals' ids for traceability.
    if (preloaded) {
      for (const r of preloaded.reused) {
        const stepId = ulid();
        await this.deps.db.insert(flowRunSteps).values({
          id: stepId,
          flowRunId,
          nodeId: r.nodeId,
          nodeKind: r.nodeKind,
          idx: nodeIdx++,
          status: "succeeded",
          startedAt: r.startedAt ?? new Date(),
          finishedAt: r.finishedAt ?? new Date(),
          outputJson: (r.outputJson ?? null) as object | null,
          inputJson: {
            reusedFromRunId: r.originalRunId,
            reusedFromStepId: r.originalStepId,
            reusedAgentRunId: r.originalAgentRunId,
          },
        });
        await this.deps.pg.notify("flow_run_steps", flowRunId);
      }
    }
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
      // stable, sequential idx even when siblings run concurrently. Skip
      // nodes whose output is already in the map (rerun-from-failed
      // preload) — they don't get a fresh step row.
      const layerJobs = layer
        .filter((node) => !outputs.has(node.id))
        .map((node) => ({
          node,
          idx: nodeIdx++,
          previousOutput: buildFanInInput(node, def.edges, outputs, labels),
        }));
      if (layerJobs.length === 0) continue;

      const results = await Promise.allSettled(
        layerJobs.map((job) =>
          this.runNodeStep(prepared, def, job, event, prContext, issueContext),
        ),
      );

      for (let i = 0; i < layerJobs.length; i++) {
        const r = results[i]!;
        const node = layerJobs[i]!.node;
        if (r.status === "fulfilled") {
          if (r.value.skipped) {
            skipped = true;
            // Carry the SkipFlowError message up to flow_runs.error so
            // operators can see why a webhook didn't trigger from the run
            // header (not just by drilling into the trigger step).
            errorMsg ??= r.value.skipReason;
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

    // Worktrees no longer get cleaned up at end-of-run — they
    // persist across iterations on the same PR branch (implementer
    // run, then review-fix runs) and are removed by the
    // pull_request.closed webhook handler. See
    // routes/webhooks.ts + worktrees/cleanup.ts.

    await this.deps.db
      .update(flowRuns)
      .set({
        status: failed ? "failed" : skipped ? "cancelled" : "succeeded",
        finishedAt: new Date(),
        error: errorMsg,
        // skipped → trigger_skip so the Flow runs page can hide these by
        // default. (Other 'cancelled' rows come from the reaper, which
        // sets cancel_reason='abandoned'.)
        cancelReason: skipped ? "trigger_skip" : null,
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
    job: {
      node: FlowNode;
      idx: number;
      previousOutput: string | undefined;
    },
    event: PlatformEventInput,
    prContext: PullRequestContext | undefined,
    issueContext: IssueStatusContext | undefined,
  ): Promise<{
    stdoutCaptured?: string;
    skipped: boolean;
    skipReason?: string;
  }> {
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
      project: {
        owner: project.owner,
        name: project.name,
        githubRepoId: project.githubRepoId,
        defaultBranch: project.defaultBranch,
      },
      event,
      prContext,
      issueContext,
      previousOutput,
      publicBaseUrl: this.deps.publicBaseUrl,
    };

    try {
      let result;
      if (node.kind === "github.pull_request" || node.kind === "github.projects_v2_item") {
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

      return {
        stdoutCaptured: result.stdoutCaptured,
        skipped: false,
      };
    } catch (err) {
      if (err instanceof SkipFlowError) {
        await this.deps.db
          .update(flowRunSteps)
          .set({ status: "skipped", finishedAt: new Date(), error: err.message })
          .where(eq(flowRunSteps.id, stepId));
        await this.deps.pg.notify("flow_run_steps", flowRunId);
        return { skipped: true, skipReason: err.message };
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

interface ReusedStep {
  nodeId: string;
  nodeKind: string;
  outputJson: unknown;
  startedAt: Date | null;
  finishedAt: Date | null;
  originalStepId: string;
  originalRunId: string;
  originalAgentRunId: string | null;
}

interface PreloadedRun {
  outputs: Map<string, string | undefined>;
  reused: ReusedStep[];
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
 * BFS the edge graph from `startNodeId` and return the set of node ids it
 * can reach (inclusive of `startNodeId`). Used by rerun-from-failed to
 * decide which nodes' prior outputs are still valid (= NOT in the set).
 */
function computeDownstreamSet(
  def: FlowDefinition,
  startNodeId: string,
): Set<string> {
  const out = new Set<string>([startNodeId]);
  const queue = [startNodeId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const e of def.edges) {
      if (e.source !== cur) continue;
      if (out.has(e.target)) continue;
      out.add(e.target);
      queue.push(e.target);
    }
  }
  return out;
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
