import { ulid } from "ulid";
import { eq, sql, type InferSelectModel } from "drizzle-orm";
import type { Sql } from "postgres";
import {
  FlowDefinitionSchema,
  isTriggerKind,
  type FlowDefinition,
  type FlowNode,
} from "@opencara/flows";
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
  pmWaveItems,
  pmWaves,
  projects,
} from "../db/schema.js";
import { and, asc, not } from "drizzle-orm";
import type { AgentDispatcher } from "../dispatch/dispatcher.js";
import type { GithubAppClient } from "../github/app.js";
import {
  buildIssueStatusContext,
  buildManualIssueContext,
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
import { extractAgentResultText } from "../agents/output.js";
import {
  FLOW_RUNS_CHANNEL,
  serializeFlowRunsNotify,
} from "./notify.js";

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
      this.executeFlow(prepared, def, event, preloaded, { rerun: true }).catch((err) => {
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
      // Strip agent envelope/JSONL noise so downstream nodes see clean
      // text. Without this, fan-in to a synthesizer overflows context
      // (codex's --json output runs to >1MB on tool-use turns; claude's
      // single-JSON envelope adds ~500B of metadata per call).
      outputs.set(
        s.nodeId,
        stdoutCaptured !== undefined ? extractAgentResultText(stdoutCaptured) : undefined,
      );
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
    // Content-level idempotency: derive a key from stable payload fields so a
    // webhook GitHub re-delivered as a fresh original (new GUID) collapses
    // onto the first run instead of spawning a duplicate. See issue #147 and
    // computeEventDedupeKey. Computed once and shared across all this
    // project's flows — each flow dedups within its own (flow_id, key) space.
    const dedupeKey = computeEventDedupeKey(event);
    const projectFlows = await this.deps.db.query.flows.findMany({
      where: eq(flows.projectId, event.projectId!),
    });
    for (const row of projectFlows) {
      if (!row.enabled) continue;
      const def = parseFlowDefinition(row);
      if (!def) continue;

      try {
        const prepared = await this.prepareRun(row.id, event, dedupeKey);
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
    dedupeKey: string | null = null,
  ): Promise<PreparedRun | null> {
    const project = await this.deps.db.query.projects.findFirst({
      where: eq(projects.id, event.projectId!),
    });
    if (!project) return null;
    const installation = await this.deps.db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.id, project.installationId),
    });
    if (!installation) return null;

    // Insert with ON CONFLICT DO NOTHING + RETURNING, targeting ONLY the
    // partial dedupe index flow_runs_flow_dedupe_uq (flow_id, dedupe_key)
    // WHERE dedupe_key IS NOT NULL. With the target pinned, an empty RETURNING
    // means exactly "a run for this (flow, content) already exists" — a
    // re-delivered webhook we should drop (issue #147) — and we don't silently
    // swallow some unrelated future unique conflict as a dedupe-drop. dedupeKey
    // is null on manual/rerun paths (and event types without a stable
    // identity), where the partial predicate excludes the row and the insert
    // always lands.
    const flowRunId = ulid();
    const inserted = await this.deps.db
      .insert(flowRuns)
      .values({
        id: flowRunId,
        flowId,
        projectId: project.id,
        triggerEventId: event.id,
        status: "running",
        startedAt: new Date(),
        dedupeKey,
      })
      .onConflictDoNothing({
        target: [flowRuns.flowId, flowRuns.dedupeKey],
        where: sql`dedupe_key is not null`,
      })
      .returning({ id: flowRuns.id });
    if (inserted.length === 0) {
      console.log("[flow-engine] dedup: dropping duplicate dispatch", {
        flowId,
        dedupeKey,
        eventId: event.id,
      });
      return null;
    }
    await this.deps.pg.notify(
      FLOW_RUNS_CHANNEL,
      serializeFlowRunsNotify({ flowRunId, projectId: project.id }),
    );

    return { flowRunId, flowId, project, installation };
  }

  private async executeFlow(
    prepared: PreparedRun,
    def: FlowDefinition,
    event: PlatformEventInput,
    preloaded?: PreloadedRun,
    opts: { rerun?: boolean } = {},
  ): Promise<void> {
    const { flowRunId, flowId, project, installation } = prepared;

    // Pre-build PR context once if it's a pull_request event (cheap optimization;
    // avoids re-fetching the diff for every agent node in the chain).
    // pull_request_review events use the same context shape — both carry a
    // `pull_request` field and the buildPullRequestContext helper extracts
    // review.state / review.body into envExtras when present.
    // issue_comment events get the same context only when the comment is on
    // a PR (issue.pull_request set) — buildPullRequestContext fetches the
    // PR object by issue.number on that path. Plain-issue comments fall
    // through and never pay a PR fetch.
    let prContext: PullRequestContext | undefined;
    const isCommentOnPr =
      event.type === "issue_comment" &&
      Boolean(
        (event.payload as { issue?: { pull_request?: unknown } }).issue?.pull_request,
      );
    if (
      event.type === "pull_request" ||
      event.type === "pull_request_review" ||
      isCommentOnPr
    ) {
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

    // Manual triggers with an issueNumber (kanban Start button): build the
    // same IssueStatusContext the webhook path does so label-based agent
    // routing and env-var injection work identically.
    if (
      event.type === "manual" &&
      typeof (event.payload as { issueNumber?: unknown }).issueNumber === "number"
    ) {
      try {
        issueContext = await buildManualIssueContext(
          this.deps.db,
          project,
          (event.payload as { issueNumber: number }).issueNumber,
        );
      } catch (err) {
        console.error("[flow-engine] manual issue context fetch failed", err);
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
      await this.deps.pg.notify(
        FLOW_RUNS_CHANNEL,
        serializeFlowRunsNotify({ flowRunId, projectId: project.id }),
      );
      return;
    }

    // ── Trigger phase ───────────────────────────────────────────────
    // A flow may carry multiple trigger entry-points (issue #124's
    // unified lifecycle graph). Evaluate the trigger nodes first; each
    // either MATCHES the event or throws SkipFlowError ("this entry-point
    // doesn't apply"). Only the subgraph(s) downstream of a matched
    // trigger run — a non-matching trigger prunes its own subgraph for
    // this event instead of cancelling the whole run. The run is a clean
    // `trigger_skip` only when NO trigger matched, which preserves the
    // single-trigger flows' behavior exactly.
    const allTriggers = def.nodes.filter((node) => isTriggerKind(node.kind));
    const matchedTriggerIds = new Set<string>();
    let firstTriggerSkipReason: string | undefined;

    if (allTriggers.length > 0) {
      // Rerun-from-failed may preload an already-succeeded trigger's
      // output; treat those as matched without re-running them.
      for (const t of allTriggers) {
        if (outputs.has(t.id)) matchedTriggerIds.add(t.id);
      }

      // Manual runs (kanban Start / flow inspection) bypass trigger
      // filters — triggerRunner matches every trigger. For a manual run
      // tied to a specific issue (issueContext present, e.g. the kanban
      // Start button), only the issue-implement entry-point is relevant;
      // running the review / fix subgraphs against a bare issue would
      // just fail. Restrict evaluation to projects_v2_item triggers there.
      // A manual run with no issue context (pure inspection) still lights
      // up every entry-point.
      let triggersToEval = allTriggers.filter((t) => !outputs.has(t.id));
      if (event.type === "manual" && issueContext) {
        triggersToEval = triggersToEval.filter(
          (t) => t.kind === "github.projects_v2_item",
        );
      }

      const triggerResults = await Promise.allSettled(
        triggersToEval.map((node) =>
          this.runNodeStep(
            prepared,
            def,
            { node, idx: nodeIdx++, previousOutput: undefined },
            event,
            prContext,
            issueContext,
            opts,
          ),
        ),
      );
      for (let i = 0; i < triggersToEval.length; i++) {
        const r = triggerResults[i]!;
        const node = triggersToEval[i]!;
        if (r.status === "fulfilled") {
          if (r.value.skipped) {
            // A skipped trigger deactivates ONLY its own subgraph. Stash
            // the reason in case EVERY trigger skips (→ the run's
            // trigger_skip message); don't fail/cancel the run here.
            firstTriggerSkipReason ??= r.value.skipReason;
            continue;
          }
          matchedTriggerIds.add(node.id);
          outputs.set(
            node.id,
            r.value.stdoutCaptured !== undefined
              ? extractAgentResultText(r.value.stdoutCaptured)
              : undefined,
          );
        } else {
          failed = true;
          errorMsg ??= r.reason instanceof Error ? r.reason.message : String(r.reason);
        }
      }

      // No trigger matched → clean trigger_skip (the whole run cancels,
      // exactly like a single-trigger flow whose only trigger skipped).
      // Only when nothing hard-failed in the trigger phase.
      if (!failed && matchedTriggerIds.size === 0) {
        skipped = true;
        errorMsg ??= firstTriggerSkipReason;
      }
    }

    // Nodes reachable from a matched trigger are the only ones that run.
    // A graph with no trigger nodes at all (defensive — none ship today)
    // runs every node, preserving the prior "execute the whole graph"
    // behavior.
    const activeNodeIds =
      allTriggers.length > 0
        ? computeActiveSubgraph(def, matchedTriggerIds)
        : new Set(def.nodes.map((n) => n.id));

    // ── Layer phase ─────────────────────────────────────────────────
    // Run the rest of the active subgraph layer by layer. Triggers are
    // already done (their ids are in `outputs`); pruned nodes — not
    // downstream of any matched trigger — are filtered out, so they get
    // no step row and don't affect the run's status.
    if (!failed && !skipped) {
      outer: for (const layer of layers) {
        // Snapshot idx per node before launching the layer so step rows
        // have stable, sequential idx even when siblings run
        // concurrently. Skip nodes whose output is already in the map
        // (triggers + rerun-from-failed preload) and nodes pruned out of
        // the active subgraph.
        const layerJobs = layer
          .filter((node) => activeNodeIds.has(node.id) && !outputs.has(node.id))
          .map((node) => ({
            node,
            idx: nodeIdx++,
            previousOutput: buildFanInInput(node, def.edges, outputs, labels),
          }));
        if (layerJobs.length === 0) continue;

        const results = await Promise.allSettled(
          layerJobs.map((job) =>
            this.runNodeStep(prepared, def, job, event, prContext, issueContext, opts),
          ),
        );

        for (let i = 0; i < layerJobs.length; i++) {
          const r = results[i]!;
          const node = layerJobs[i]!.node;
          if (r.status === "fulfilled") {
            if (r.value.skipped) {
              skipped = true;
              // Carry the SkipFlowError message up to flow_runs.error so
              // operators can see why a run stopped from the run header
              // (not just by drilling into the step).
              errorMsg ??= r.value.skipReason;
              continue;
            }
            // Same envelope/JSONL extraction as the recovery path above —
            // see comment there for why.
            outputs.set(
              node.id,
              r.value.stdoutCaptured !== undefined
                ? extractAgentResultText(r.value.stdoutCaptured)
                : undefined,
            );
          } else {
            failed = true;
            errorMsg ??= r.reason instanceof Error ? r.reason.message : String(r.reason);
          }
        }

        if (failed || skipped) break outer;
      }
    }

    // Worktrees no longer get cleaned up at end-of-run — they
    // persist across iterations on the same PR branch (implementer
    // run, then review-fix runs) and are removed by the
    // pull_request.closed webhook handler. See
    // routes/webhooks.ts + worktrees/cleanup.ts.

    const flowStatus = failed ? "failed" : skipped ? "cancelled" : "succeeded";
    await this.deps.db
      .update(flowRuns)
      .set({
        status: flowStatus,
        finishedAt: new Date(),
        error: errorMsg,
        // skipped → trigger_skip so the Flow runs page can hide these by
        // default. (Other 'cancelled' rows come from the reaper, which
        // sets cancel_reason='abandoned'.)
        cancelReason: skipped ? "trigger_skip" : null,
      })
      .where(eq(flowRuns.id, flowRunId));
    await this.deps.pg.notify(
      FLOW_RUNS_CHANNEL,
      serializeFlowRunsNotify({ flowRunId, projectId: project.id }),
    );

    await this.settleWaveItem(flowRunId, flowStatus);
  }

  /**
   * Mirror a flow run's terminal state onto the pm_wave_items row that
   * dispatched it (if any), then collapse the parent pm_waves row to
   * `done` once every item has settled. Without this, kanban dispatch
   * waves never leave `running` — the wave chip in the UI sticks
   * forever and the PM skill's `activeWaves` hydration treats every
   * past dispatch as in-flight. PM tables are coupled here (rather
   * than going through a pg.notify("flow_runs") listener) because the
   * settlement has to be transactional with the flow_runs state
   * transition for the UI to stay honest.
   */
  private async settleWaveItem(
    flowRunId: string,
    flowStatus: "failed" | "cancelled" | "succeeded",
  ): Promise<void> {
    const item = await this.deps.db.query.pmWaveItems.findFirst({
      where: eq(pmWaveItems.flowRunId, flowRunId),
    });
    if (!item) return;

    // Guard: don't overwrite a "cancelled" item — the cancel endpoint wins.
    // A user-cancelled wave whose underlying flow run then finishes should
    // remain cancelled, not flip to "succeeded".
    await this.deps.db
      .update(pmWaveItems)
      .set({ status: flowStatus })
      .where(and(eq(pmWaveItems.id, item.id), not(eq(pmWaveItems.status, "cancelled"))));

    const siblings = await this.deps.db.query.pmWaveItems.findMany({
      where: eq(pmWaveItems.waveId, item.waveId),
    });
    const allDone = siblings.every(
      (s) => s.status !== "pending" && s.status !== "running",
    );
    if (allDone) {
      // Guard: don't overwrite a "cancelled" wave — the cancel endpoint wins.
      await this.deps.db
        .update(pmWaves)
        .set({ status: "done", finishedAt: new Date() })
        .where(and(eq(pmWaves.id, item.waveId), not(eq(pmWaves.status, "cancelled"))));
    }
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
    opts: { rerun?: boolean },
  ): Promise<{
    stdoutCaptured?: string;
    skipped: boolean;
    skipReason?: string;
  }> {
    const { flowRunId, flowId, project, installation } = prepared;
    const { node, idx, previousOutput } = job;

    // Reviewer-agent verdict contract: when this node's outputs flow
    // (transitively) into a `github.post_review` action, the agent
    // runner auto-injects the verdict-line skill so the post-review
    // parser can drive GitHub's review `event` enum from the agent
    // body. See agents/verdict.ts + skills/prReviewVerdict.ts.
    const downstreamIds = computeDownstreamSet(def, node.id);
    let hasDownstreamPostReview = false;
    for (const id of downstreamIds) {
      if (id === node.id) continue;
      const n = def.nodes.find((x) => x.id === id);
      if (n?.kind === "github.post_review") {
        hasDownstreamPostReview = true;
        break;
      }
    }

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
        instructionsFile: project.instructionsFile,
      },
      event,
      prContext,
      issueContext,
      previousOutput,
      publicBaseUrl: this.deps.publicBaseUrl,
      hasDownstreamPostReview,
      rerun: opts.rerun ?? false,
    };

    try {
      let result;
      if (isTriggerKind(node.kind)) {
        result = await triggerRunner(baseCtx, node as never);
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

/**
 * Derive a content-level idempotency key for a webhook-driven event, or null
 * when the event has no stable identity to dedup on.
 *
 * GitHub delivers webhooks at-least-once: an endpoint that doesn't ACK within
 * the 10s window gets the same logical event re-sent as a *fresh* original —
 * a NEW x-github-delivery GUID with redelivery=false, not a flagged retry.
 * platform_events dedups on that GUID, so two GUIDs for one push slip through
 * as two rows and (historically) two flow runs + two posted reviews
 * (issue #147). The key is built only from payload fields that are byte-for-byte
 * identical across such duplicate deliveries:
 *   - pull_request: PR number + action + head SHA — but ONLY for actions where
 *     (action, SHA) is a genuine one-shot identity: `synchronize` (every push
 *     mints a new SHA, so a real recurrence always changes the key) and
 *     `opened` (fires once per PR). Actions like `reopened` / `ready_for_review`
 *     can legitimately recur on an UNCHANGED SHA (close→reopen, or
 *     ready→draft→ready, with no intervening commit), so SHA-identity dedup
 *     would permanently suppress a real re-trigger — they return null and keep
 *     GUID-only behavior. This is the "(eventType, action, after-SHA)" key the
 *     issue proposes, narrowed to the actions where it's safe.
 *   - pull_request_review: the review id (stable, globally unique) + action. A
 *     new submitted review always gets a fresh id, so recurrence is impossible
 *     and only a redelivery collides.
 *   - issue_comment: the comment id + action (covers the `@opencara fix`
 *     review-fix path). A comment is created once; only a redelivery repeats
 *     (id, created).
 * Other event types return null and keep today's GUID-only behavior — they're
 * either cheap mirror upkeep (projects_v2_item) or lack a single stable id, and
 * over-deduping legitimately-distinct events there would be worse than the
 * occasional duplicate.
 */
// pull_request actions whose (action, head SHA) pair is a stable one-shot
// identity — safe to dedup on. Everything else (reopened, ready_for_review,
// edited, labeled, …) can recur on an unchanged SHA, so we don't.
const SHA_DEDUPABLE_PR_ACTIONS = new Set(["opened", "synchronize"]);

export function computeEventDedupeKey(event: PlatformEventInput): string | null {
  const p = event.payload;
  if (!p || typeof p !== "object") return null;
  const payload = p as {
    action?: unknown;
    pull_request?: { number?: unknown; head?: { sha?: unknown } };
    review?: { id?: unknown };
    comment?: { id?: unknown };
  };
  const action = typeof payload.action === "string" ? payload.action : "";

  switch (event.type) {
    case "pull_request": {
      if (!SHA_DEDUPABLE_PR_ACTIONS.has(action)) return null;
      const num = payload.pull_request?.number;
      const sha = payload.pull_request?.head?.sha;
      if (typeof num !== "number" || typeof sha !== "string" || sha.length === 0) {
        return null;
      }
      return `pull_request:${num}:${action}:${sha}`;
    }
    case "pull_request_review": {
      const id = payload.review?.id;
      if (typeof id !== "number") return null;
      return `pull_request_review:${id}:${action}`;
    }
    case "issue_comment": {
      const id = payload.comment?.id;
      if (typeof id !== "number") return null;
      return `issue_comment:${id}:${action}`;
    }
    default:
      return null;
  }
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
 * The set of node ids the engine should execute for a given event: every
 * node reachable (over forward edges) from a trigger node that MATCHED the
 * event. This is what makes a single graph carry multiple trigger
 * entry-points (issue #124) — a `projects_v2_item` event lights up only
 * the implement subgraph, a `pull_request` event only the review subgraph,
 * etc. Nodes that are not downstream of any matched trigger are pruned for
 * this run (no step row, not failed) rather than cancelling the whole flow.
 *
 * The matched trigger ids themselves are included so the caller can mark
 * their step rows succeeded. Disconnected components rooted at a trigger
 * that did NOT match contribute nothing.
 */
export function computeActiveSubgraph(
  def: FlowDefinition,
  matchedTriggerIds: Iterable<string>,
): Set<string> {
  const active = new Set<string>();
  for (const triggerId of matchedTriggerIds) {
    for (const id of computeDownstreamSet(def, triggerId)) {
      active.add(id);
    }
  }
  return active;
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
