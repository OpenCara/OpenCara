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
  agents,
  flowRuns,
  flowRunSteps,
  flows,
  azureDevopsConnections,
  githubInstallations,
  platformEvents,
  pmWaveItems,
  pmWaves,
  projects,
} from "../db/schema.js";
import { and, asc, inArray, not } from "drizzle-orm";
import type { AgentDispatcher } from "../dispatch/dispatcher.js";
import { requireGithubApp } from "../github/app.js";
import type { GithubAppClient } from "../github/app.js";
import {
  buildIssueStatusContext,
  buildManualIssueContext,
  buildAzurePullRequestContext,
  buildPullRequestContext,
  buildScheduleContext,
  type IssueStatusContext,
  type PullRequestContext,
  type ScheduleContext,
} from "./context.js";
import {
  actionRunner,
  resolveAgentPool,
  runAgentAttempt,
  triggerRunner,
  SkipFlowError,
  type NodeRunCtx,
  type NodeRunResult,
  type PlatformRunCtx,
  type ResolvedAgentPool,
} from "./nodeRunners.js";
import { runWithAgentPool } from "./agentPool.js";
import { loadEffectiveNodeSettings, type EffectiveNodeSetting } from "./nodeSettings.js";
import { cancelPreemptedReviewRuns } from "./preempt.js";
import { flowMayMatchEvent } from "./eventMatch.js";
import { azureCloneUrl, parseAzureOwnerLabel } from "../azure/repos.js";
import { clientForConnection } from "../azure/client.js";
import { normalizeAzureEvent, pullRequestPayload } from "../azure/events.js";
import type { AzureDevopsClientDeps } from "../azure/client.js";
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
  /** Absent on an Azure-DevOps-only deployment. */
  app?: GithubAppClient;
  /** Present when AZDO_ENTRA_* is configured. */
  azure?: AzureDevopsClientDeps;
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
      // Pre-empt first: a merge / close / ignored label must stop an in-flight
      // review before this same event gets a chance to start anything new.
      cancelPreemptedReviewRuns(this.deps, event)
        .catch((err) => {
          console.error("[flow-engine] review pre-emption error", { eventId: event.id, err });
        })
        .then(() => this.dispatchEvent(event))
        .catch((err) => {
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
    dedupeKey: string | null = null,
  ): Promise<{ flowRunId: string }> {
    const row = await this.deps.db.query.flows.findFirst({
      where: eq(flows.id, flowId),
    });
    if (!row) throw new Error(`flow ${flowId} not found`);
    if (!row.enabled) throw new Error(`flow ${flowId} is disabled`);

    const def = parseFlowDefinition(row);
    if (!def) throw new Error(`flow ${flowId} has an invalid graph`);

    // dedupeKey is set by the scheduler (schedule:<flow>:<node>:<occurrence>)
    // so a re-fire across a restart / overlapping tick collapses onto the
    // first run via flow_runs' partial unique index, exactly like the
    // webhook content-dedup path. null on the manual/kanban trigger path.
    const prepared = await this.prepareRun(row.id, event, dedupeKey);
    if (prepared === "dedupe") {
      // The dedupe index swallowed a duplicate fire (e.g. an overlapping
      // scheduler tick). Benign — return an empty sentinel so the scheduler's
      // bookkeeping still advances without treating it as an error.
      return { flowRunId: "" };
    }
    if (prepared === "missing") {
      // Genuinely broken: the project/installation is gone. Throw so the
      // caller (scheduler/manual-trigger route) surfaces it instead of
      // silently advancing a dead schedule (PR #164 review item 2).
      throw new Error(`flow ${flowId} project/installation missing`);
    }

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
        payload: replayPayload(ev.platform, ev.type, ev.payload),
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
    // Rerun never sets a dedupeKey, so "dedupe" can't occur here; treat any
    // non-PreparedRun result as the missing-project/installation error.
    if (prepared === "missing" || prepared === "dedupe") {
      throw new Error("project/installation missing");
    }

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

    // Deterministic order: idx then attempt, so a multi-success pool's
    // fan-in sections come out in a stable order on every rerun.
    const allSteps = await this.deps.db.query.flowRunSteps.findMany({
      where: eq(flowRunSteps.flowRunId, originalRunId),
      orderBy: [asc(flowRunSteps.idx), asc(flowRunSteps.attempt)],
    });

    // Note: worktree state used to invalidate reuse (the per-run
    // workdir got rm-rf'd at end of run, so any descendant that wrote
    // into it had to re-execute on the rerun's fresh checkout). With
    // worktrees now persisting across flow runs (PR-close cleanup
    // model), the workdir is still around, so descendant reuse is
    // safe — the rerun fetches + checks out the same branch and the
    // agent re-executes against current state.
    const outputs = new Map<string, NodeOutput>();
    // Agent-pool nodes can have SEVERAL succeeded attempts (concurrency > 1);
    // collect them per node so the rerun's fan-in sees the same per-agent
    // sections the original run produced.
    const partsByNode = new Map<string, PoolOutputPart[]>();
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
      const text = stdoutCaptured !== undefined ? extractAgentResultText(stdoutCaptured) : undefined;
      const agentName = readAgentName(s.inputJson);
      const parts = partsByNode.get(s.nodeId) ?? [];
      parts.push({ agentName: agentName ?? s.nodeId, text: text ?? "" });
      partsByNode.set(s.nodeId, parts);
      outputs.set(s.nodeId, parts.length > 1 ? parts : text);
      reused.push({
        nodeId: s.nodeId,
        nodeKind: s.nodeKind,
        attempt: s.attempt,
        outputJson: s.outputJson,
        agentName,
        agentId: readStringField(s.inputJson, "agentId"),
        pool: readField(s.inputJson, "pool"),
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

      // A flow whose only entry-points are schedule.cron triggers can never
      // match a webhook event — dispatching it would just mint a cancelled
      // `trigger_skip` run for every push/comment/review. Skip it here; the
      // scheduler drives those flows directly via triggerFlow.
      const triggers = def.nodes.filter((n) => isTriggerKind(n.kind));
      if (triggers.length > 0 && triggers.every((t) => t.kind === "schedule.cron")) {
        continue;
      }
      // Same idea for the stage flows: an event whose type / action / comment
      // phrase can't satisfy ANY trigger of this flow gets no run at all,
      // instead of a cancelled `trigger_skip` one. Filters that need PR
      // context (branches, paths, labels, drafts) still run — and record
      // their skip — inside the trigger step.
      if (!flowMayMatchEvent(def, event)) continue;

      try {
        const prepared = await this.prepareRun(row.id, event, dedupeKey);
        // Both "missing" (no project/installation) and "dedupe" (duplicate
        // webhook) are non-errors on the fan-out path — skip this flow.
        if (prepared === "missing" || prepared === "dedupe") continue;
        await this.executeFlow(prepared, def, event);
      } catch (err) {
        console.error("[flow-engine] runFlow failed", { flowId: row.id, err });
      }
    }
  }

  // Returns the prepared run, or a discriminated reason it couldn't start:
  //   - "missing": the project or its installation row is gone — a genuine
  //     misconfiguration the caller should surface (the scheduler logs it).
  //   - "dedupe": the partial unique index swallowed a duplicate dispatch —
  //     benign; the caller should drop the event quietly.
  // Distinguishing the two keeps a permanently-broken schedule from looking
  // identical to a routine duplicate fire (PR #164 review).
  /**
   * Build the `PlatformRunCtx` for a project, or null when the run cannot
   * proceed (connection row deleted, platform not configured on this
   * deployment). Null is treated as "missing" by callers — same as a deleted
   * project — because in every case there is nothing left to run against.
   */
  private async resolvePlatformCtx(
    project: InferSelectModel<typeof projects>,
  ): Promise<PlatformRunCtx | null> {
    if (project.platform === "github") {
      if (!project.installationId || project.githubRepoId === null) {
        console.warn(
          `[flow-engine] project ${project.id} is marked github but has no installation/repo id`,
        );
        return null;
      }
      const installation = await this.deps.db.query.githubInstallations.findFirst({
        where: eq(githubInstallations.id, project.installationId),
      });
      if (!installation) return null;
      return {
        platform: "github",
        installation,
        githubRepoId: project.githubRepoId,
      };
    }

    if (!project.azdoConnectionId) {
      console.warn(
        `[flow-engine] project ${project.id} is marked azure_devops but has no connection`,
      );
      return null;
    }
    const connection = await this.deps.db.query.azureDevopsConnections.findFirst({
      where: eq(azureDevopsConnections.id, project.azdoConnectionId),
    });
    if (!connection) return null;
    // `owner` is the "org/project" label; the clone URL and API paths need the
    // team project on its own.
    const parsed = parseAzureOwnerLabel(project.owner);
    if (!parsed) {
      console.warn(
        `[flow-engine] project ${project.id} owner '${project.owner}' is not "org/project"`,
      );
      return null;
    }
    return {
      platform: "azure_devops",
      connectionId: connection.id,
      orgName: parsed.orgName,
      projectName: parsed.projectName,
      externalRepoId: project.externalRepoId,
      cloneUrl: azureCloneUrl(parsed.orgName, parsed.projectName, project.name),
    };
  }

  private async prepareRun(
    flowId: string,
    event: PlatformEventInput,
    dedupeKey: string | null = null,
  ): Promise<PreparedRun | "missing" | "dedupe"> {
    const project = await this.deps.db.query.projects.findFirst({
      where: eq(projects.id, event.projectId!),
    });
    if (!project) return "missing";
    // Resolve the platform-specific identity + credentials for this run. The
    // rest of the pipeline consumes the resulting discriminated union and never
    // re-checks the platform.
    const scm = await this.resolvePlatformCtx(project);
    if (!scm) return "missing";

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
      return "dedupe";
    }
    // NOTE: intentionally NO flow_runs notify here. The run row exists but its
    // trigger hasn't been evaluated yet, so we don't know if it's a real run or
    // an about-to-be `trigger_skip`. Notifying at creation woke every open
    // kanban board (which LISTENs on `flow_runs`) for EVERY dispatched flow on
    // EVERY webhook — and most are trigger_skips — a rebuild firehose that
    // starved the DB pool and shed auth 503s (2026-06-24). executeFlow emits
    // the "run started" notify once a trigger actually matches; trigger_skips
    // never notify. The run-scoped SSE stream (/flow-runs/:id/events/stream)
    // doesn't need this notify — it loads its own initial snapshot on connect.
    return { flowRunId, flowId, project, scm };
  }

  private async executeFlow(
    prepared: PreparedRun,
    def: FlowDefinition,
    event: PlatformEventInput,
    preloaded?: PreloadedRun,
    opts: { rerun?: boolean } = {},
  ): Promise<void> {
    const { flowRunId, flowId, project, scm } = prepared;

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
        prContext =
          scm.platform === "github"
            ? await buildPullRequestContext(
                requireGithubApp(this.deps.app),
                scm.installation,
                project,
                event.payload as never,
              )
            : // PR events carry the pull request inline; the COMMENT event does
              // not carry one at all, so a fetcher is supplied for that case.
              await buildAzurePullRequestContext(
                event.payload as never,
                project,
                async (prNumber) => {
                  if (scm.platform !== "azure_devops" || !this.deps.azure) return undefined;
                  const client = await clientForConnection(
                    this.deps.azure,
                    scm.connectionId,
                  );
                  if (!client) return undefined;
                  const raw = await client.request<Record<string, unknown>>(
                    `${client.orgUrl}/${encodeURIComponent(scm.projectName)}/_apis/git/repositories/${encodeURIComponent(scm.externalRepoId)}/pullRequests/${prNumber}`,
                  );
                  return (pullRequestPayload(raw as never) as { pull_request?: never })
                    .pull_request;
                },
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

    // Schedule (cron) runs carry no GitHub entity — the synthetic event the
    // scheduler dispatched already holds every field, so this is pure (no
    // fetch). Surfaces OPENCARA_SCHEDULE_* env vars + stdin.schedule to the
    // dispatched agent.
    let scheduleContext: ScheduleContext | undefined;
    if (event.type === "schedule") {
      scheduleContext = buildScheduleContext(project, event.payload as never);
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

    // Per-node display names. Used by buildFanInInput so synthesizer prompts
    // read "## From opus-reviewer" rather than the raw node id. Agent nodes
    // are named by the AGENT that runs them (see buildNodeLabels); the
    // per-node rename only survives on nodes with no linked agent.
    const settingsRows = await loadEffectiveNodeSettings(this.deps.db, flowId);
    const linkedAgentIds = [
      ...new Set(settingsRows.map((r) => r.agentId).filter((id): id is string => !!id)),
    ];
    const agentNamesById = new Map<string, string>();
    if (linkedAgentIds.length > 0) {
      const agentRows = await this.deps.db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(inArray(agents.id, linkedAgentIds));
      for (const a of agentRows) agentNamesById.set(a.id, a.name);
    }
    const labels = buildNodeLabels(def.nodes, settingsRows, agentNamesById);
    // A rerun reuses upstream steps without re-executing them, so their
    // runtime-resolved agent never comes back through runNodeStep. Recover it
    // from the original step row instead, or the rerun's headings would name
    // the linked agent while the reused output came from another one.
    for (const r of preloaded?.reused ?? []) {
      if (r.agentName) labels.set(r.nodeId, r.agentName);
    }

    // For rerun-from-failed: preload the upstream nodes' captured stdout.
    // The layer loop below skips any node whose id is already in `outputs`,
    // so those upstream nodes don't re-execute and their previousOutput
    // values still flow into the failed/downstream nodes correctly.
    const outputs = new Map<string, NodeOutput>(preloaded?.outputs);
    let nodeIdx = 0;

    // Materialise a flow_run_steps row for each reused upstream node so the
    // new run's graph shows them as already-succeeded (otherwise they'd be
    // rendered idle, even though their output is being threaded through to
    // the re-executed downstream). The original step + agent_run stay
    // untouched on the source run; we just stamp a "reused" marker into
    // inputJson with the originals' ids for traceability.
    if (preloaded) {
      // A pool node with several successes reuses several rows: they share
      // ONE idx (like the original attempts did) and keep their attempt
      // ordinal + agent/pool stamps so the run page renders the same attempt
      // strip and steering chat targets the right agent.
      const reusedIdxByNode = new Map<string, number>();
      for (const r of preloaded.reused) {
        const stepId = ulid();
        let idx = reusedIdxByNode.get(r.nodeId);
        if (idx === undefined) {
          idx = nodeIdx++;
          reusedIdxByNode.set(r.nodeId, idx);
        }
        await this.deps.db.insert(flowRunSteps).values({
          id: stepId,
          flowRunId,
          nodeId: r.nodeId,
          nodeKind: r.nodeKind,
          idx,
          attempt: r.attempt,
          status: "succeeded",
          startedAt: r.startedAt ?? new Date(),
          finishedAt: r.finishedAt ?? new Date(),
          outputJson: (r.outputJson ?? null) as object | null,
          inputJson: {
            reusedFromRunId: r.originalRunId,
            reusedFromStepId: r.originalStepId,
            reusedAgentRunId: r.originalAgentRunId,
            ...(r.agentName ? { agentName: r.agentName } : {}),
            ...(r.agentId ? { agentId: r.agentId } : {}),
            ...(r.pool !== undefined ? { pool: r.pool } : {}),
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

    if (allTriggers.length > 0) {
      // Rerun-from-failed may preload an already-succeeded trigger's
      // output; treat those as matched without re-running them.
      for (const t of allTriggers) {
        if (outputs.has(t.id)) matchedTriggerIds.add(t.id);
      }

      // Which triggers actually get evaluated this run. Manual runs tied to
      // an issue (kanban dispatch) are narrowed to the issue-implement
      // entry-point — see selectTriggersToEvaluate. The narrowing can key
      // on issueContext alone (no bare-PR escape hatch) because manual
      // events never carry prContext: executeFlow only builds prContext for
      // pull_request / pull_request_review / issue_comment-on-PR events.
      const triggersToEval = selectTriggersToEvaluate(allTriggers, {
        eventType: event.type,
        hasIssueContext: Boolean(issueContext),
        isAlreadyMatched: (id) => outputs.has(id),
      });

      const triggerResults = await Promise.allSettled(
        triggersToEval.map((node) =>
          this.runNodeStep(
            prepared,
            def,
            { node, idx: nodeIdx++, previousOutput: undefined },
            event,
            prContext,
            issueContext,
            scheduleContext,
            { ...opts, nodeSettings: settingsRows },
          ),
        ),
      );

      // Normalise the settled results into a pure outcome list, then let
      // summarizeTriggerOutcomes decide matched/failed/skip. That decision —
      // the regression-prone seam — is unit-tested in isolation
      // (triggerPhase.test.ts) without needing the DB-backed runNodeStep.
      const outcomes: TriggerOutcome[] = triggersToEval.map((node, i) => {
        const r = triggerResults[i]!;
        if (r.status === "rejected") {
          return {
            id: node.id,
            status: "failed",
            errorMessage: r.reason instanceof Error ? r.reason.message : String(r.reason),
          };
        }
        if (r.value.skipped) {
          // A skipped trigger deactivates ONLY its own subgraph; it does
          // not fail/cancel the run.
          return { id: node.id, status: "skipped", skipReason: r.value.skipReason };
        }
        return { id: node.id, status: "matched", stdoutCaptured: r.value.stdoutCaptured };
      });

      // Thread each matched trigger's captured stdout into the outputs map
      // for downstream fan-in (same envelope/JSONL extraction as elsewhere).
      for (const o of outcomes) {
        if (o.status !== "matched") continue;
        matchedTriggerIds.add(o.id);
        outputs.set(
          o.id,
          o.stdoutCaptured !== undefined
            ? extractAgentResultText(o.stdoutCaptured)
            : undefined,
        );
      }

      const summary = summarizeTriggerOutcomes(outcomes);
      if (summary.failed) {
        // A hard trigger failure fails the whole run, even if a sibling
        // trigger matched.
        failed = true;
        errorMsg ??= summary.errorMessage;
      } else if (matchedTriggerIds.size === 0) {
        // No trigger matched (and none were preloaded) → clean trigger_skip,
        // exactly like a single-trigger flow whose only trigger skipped.
        // A sibling trigger's skip reason is NOT promoted to errorMsg when
        // some other trigger matched — that run succeeds.
        skipped = true;
        errorMsg ??= summary.firstSkipReason;
      }
    }

    // Whether this run is "real" — at least one trigger matched (or it's a
    // defensive no-trigger flow that runs everything). A run that matched
    // nothing becomes a `trigger_skip` and must NOT wake any board: those are
    // the bulk of dispatches (every unrelated webhook hits every flow's trigger
    // and is rejected) and rebuilding open kanban boards for them is what
    // starved the DB pool. See the prepareRun note above.
    const triggerMatched = runNotifiesBoard({
      hasTriggers: allTriggers.length > 0,
      matchedTriggerCount: matchedTriggerIds.size,
    });

    // "Run started" board signal: now that we know a trigger matched, tell the
    // kanban board (and any run-scoped SSE) the run is live so cards can show
    // "Implementing…". A trigger-phase hard failure skips this — the terminal
    // notify below carries the failed state instead.
    if (triggerMatched && !failed) {
      await this.deps.pg.notify(
        FLOW_RUNS_CHANNEL,
        serializeFlowRunsNotify({ flowRunId, projectId: project.id }),
      );
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
            this.runNodeStep(
              prepared,
              def,
              job,
              event,
              prContext,
              issueContext,
              scheduleContext,
              { ...opts, nodeSettings: settingsRows },
            ),
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
            // Runtime agent resolution outranks the flow-node link (issue/PR
            // `agent:<name>` label, project default implement agent), so the
            // heading downstream nodes see must name the agent that actually
            // ran, not the one the graph was configured with.
            if (r.value.agentName) labels.set(node.id, r.value.agentName);
            // Same envelope/JSONL extraction as the recovery path above —
            // see comment there for why. A pool that finished with several
            // successes hands downstream one section per agent.
            if (r.value.poolOutputs) {
              outputs.set(
                node.id,
                r.value.poolOutputs.map((o) => ({
                  agentName: o.agentName,
                  text:
                    o.stdoutCaptured !== undefined
                      ? extractAgentResultText(o.stdoutCaptured)
                      : "",
                })),
              );
            } else {
              outputs.set(
                node.id,
                r.value.stdoutCaptured !== undefined
                  ? extractAgentResultText(r.value.stdoutCaptured)
                  : undefined,
              );
            }
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
    // Guarded terminal write: the cancel endpoint (and the reaper) may have
    // already flipped this run to `cancelled` while the layers were still
    // executing. Overwriting that would erase the user's cancel — and null
    // its cancel_reason — the moment the in-flight agent finished. Zero rows
    // updated means "someone else terminated this run first"; their status
    // wins, including for wave settlement below.
    const terminal = await this.deps.db
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
      .where(
        and(
          eq(flowRuns.id, flowRunId),
          inArray(flowRuns.status, ["pending", "running"]),
        ),
      )
      .returning({ id: flowRuns.id });
    const terminalWriteApplied = terminal.length > 0;
    // Only notify for runs the board ever saw. A pure `trigger_skip` (no
    // trigger matched) never emitted a "run started" notify, so emitting a
    // terminal one here would wake every board for a no-op — the exact
    // firehose we're killing. A run that matched then skipped a node mid-flow
    // (skipped === true but triggerMatched) DID start, so it still notifies so
    // the card clears. settleWaveItem still runs unconditionally — PM wave
    // bookkeeping is independent of board notifications.
    if (triggerMatched && terminalWriteApplied) {
      await this.deps.pg.notify(
        FLOW_RUNS_CHANNEL,
        serializeFlowRunsNotify({ flowRunId, projectId: project.id }),
      );
    }

    // If the guarded write lost (user cancel / reaper won), settle the wave
    // item as cancelled — mirroring the status that actually stuck on the run.
    await this.settleWaveItem(
      flowRunId,
      terminalWriteApplied ? flowStatus : "cancelled",
    );
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
   * Run a single node. Non-agent nodes get exactly one step row. Agent nodes
   * resolve their candidate pool once, then run ONE attempt per step row —
   * retries on the same agent and failovers to the next candidate each get
   * their own row sharing `nodeId`/`idx`, ordered by `attempt`.
   *
   * Returns the captured stdout (for downstream fan-in) and a skipped flag
   * (SkipFlowError = the run should cancel cleanly). Throws on any non-skip
   * failure so the caller's Promise.allSettled marks the layer as failed;
   * for an agent node that's the pool-exhausted error carrying the trail.
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
    scheduleContext: ScheduleContext | undefined,
    opts: { rerun?: boolean; nodeSettings?: readonly EffectiveNodeSetting[] },
  ): Promise<StepOutcome> {
    const { flowRunId, flowId, project, scm } = prepared;
    const { node, idx, previousOutput } = job;

    // Reviewer-agent verdict contract: when this node's outputs flow
    // (transitively) into a `scm.post_review` action, the agent
    // runner auto-injects the verdict-line skill so the post-review
    // parser can drive GitHub's review `event` enum from the agent
    // body. See agents/verdict.ts + skills/prReviewVerdict.ts.
    const downstreamIds = computeDownstreamSet(def, node.id);
    let hasDownstreamPostReview = false;
    for (const id of downstreamIds) {
      if (id === node.id) continue;
      const n = def.nodes.find((x) => x.id === id);
      if (n?.kind === "scm.post_review") {
        hasDownstreamPostReview = true;
        break;
      }
    }

    const baseCtx: StepBaseCtx = {
      db: this.deps.db,
      pg: this.deps.pg,
      app: this.deps.app,
      azure: this.deps.azure,
      dispatcher: this.deps.dispatcher,
      flowId,
      flowRunId,
      projectId: project.id,
      scm,
      project: {
        owner: project.owner,
        name: project.name,
        defaultBranch: project.defaultBranch,
        instructionsFile: project.instructionsFile,
      },
      event,
      prContext,
      issueContext,
      scheduleContext,
      previousOutput,
      publicBaseUrl: this.deps.publicBaseUrl,
      hasDownstreamPostReview,
      rerun: opts.rerun ?? false,
      nodeSettings: opts.nodeSettings,
    };
    const meta = { node, idx, previousOutput, event };

    if (node.kind !== "agent") {
      return this.runStepAttempt(baseCtx, { ...meta, attempt: 0 }, (ctx) =>
        isTriggerKind(node.kind)
          ? triggerRunner(ctx, node as never)
          : actionRunner(ctx, node as never),
      );
    }

    // Agent node: resolve the pool ONCE (settings, labels, project default,
    // shared prompt). A resolution failure happens before any attempt can
    // start, so materialise it as attempt 0 — the run page then shows the
    // same failed/skipped step the single-agent runner used to produce.
    let pool: ResolvedAgentPool;
    try {
      pool = await resolveAgentPool(baseCtx, node);
    } catch (err) {
      return this.runStepAttempt(baseCtx, { ...meta, attempt: 0 }, async () => {
        throw err;
      });
    }

    const { successes } = await runWithAgentPool({
      candidates: pool.candidates,
      retrySame: pool.retrySame,
      concurrency: pool.concurrency,
      quorum: pool.quorum,
      describe: (agent) => agent.name,
      onAttemptFailed: (rec) => {
        console.warn("[flow-engine] agent pool attempt failed", {
          flowRunId,
          nodeId: node.id,
          attempt: rec.info.attempt,
          agent: rec.candidate.name,
          disposition: rec.disposition,
          error: rec.error instanceof Error ? rec.error.message : String(rec.error),
        });
      },
      attempt: (agent, info) =>
        this.runStepAttempt(
          baseCtx,
          {
            ...meta,
            attempt: info.attempt,
            pool: {
              agentId: agent.id,
              agentName: agent.name,
              candidateIndex: info.candidateIndex,
              retryIndex: info.retryIndex,
              candidateCount: info.candidateCount,
              retrySame: pool.retrySame,
              concurrency: pool.concurrency,
              quorum: pool.quorum,
            },
          },
          (ctx) => runAgentAttempt(ctx, node, agent, pool.promptBody),
        ),
    });
    // A skip (maxIterations etc.) is decided per node, not per agent — any
    // attempt reporting it means the run should cancel cleanly.
    const skipped = successes.find((s) => s.value.skipped);
    if (skipped) return skipped.value;
    if (successes.length === 1) return successes[0]!.value;
    return {
      skipped: false,
      agentName: successes[0]!.value.agentName ?? successes[0]!.candidate.name,
      poolOutputs: successes.map((s) => ({
        agentName: s.value.agentName ?? s.candidate.name,
        stdoutCaptured: s.value.stdoutCaptured,
      })),
    };
  }

  /**
   * One step row, start to finish: insert as `running`, invoke the runner
   * with a ctx bound to that row, persist succeeded / skipped / failed.
   * Throws on any non-skip failure (after recording it) so the caller — the
   * layer loop or the agent-pool loop — decides what happens next.
   */
  private async runStepAttempt(
    baseCtx: StepBaseCtx,
    meta: {
      node: FlowNode;
      idx: number;
      previousOutput: string | undefined;
      event: PlatformEventInput;
      attempt: number;
      pool?: StepPoolMeta;
    },
    invoke: (ctx: NodeRunCtx) => Promise<NodeRunResult>,
  ): Promise<StepOutcome> {
    const { flowRunId } = baseCtx;
    const { node, idx, previousOutput, event, attempt, pool } = meta;
    const stepId = ulid();
    await this.deps.db.insert(flowRunSteps).values({
      id: stepId,
      flowRunId,
      nodeId: node.id,
      nodeKind: node.kind,
      idx,
      attempt,
      status: "running",
      startedAt: new Date(),
      inputJson: {
        nodeKind: node.kind,
        nodeConfig: node.config,
        previousOutput: previousOutput ? truncate(previousOutput, 4000) : null,
        eventType: event.type,
        // Stamp the candidate up front so the run page can name the agent
        // (and its position in the pool) while the attempt is still queued.
        ...(pool ? { agentName: pool.agentName, agentId: pool.agentId, pool } : {}),
      },
    });
    await this.deps.pg.notify("flow_run_steps", flowRunId);

    const ctx: NodeRunCtx = { ...baseCtx, flowRunStepId: stepId };
    try {
      const result = await invoke(ctx);

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
        agentName: result.agentName,
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

/** Everything a step's runner ctx needs except the step row id. */
type StepBaseCtx = Omit<NodeRunCtx, "flowRunStepId">;

/** Pool bookkeeping stamped into an agent attempt's `inputJson`. */
interface StepPoolMeta {
  agentId: string;
  agentName: string;
  candidateIndex: number;
  retryIndex: number;
  candidateCount: number;
  retrySame: number;
  concurrency: number;
  quorum: number;
}

interface StepOutcome {
  stdoutCaptured?: string;
  skipped: boolean;
  skipReason?: string;
  /** Set by agent nodes: the agent that was actually resolved and run. */
  agentName?: string;
  /**
   * Set when an agent pool finished with MORE than one success: one entry per
   * agent, in completion order. `stdoutCaptured` is then unset.
   */
  poolOutputs?: Array<{ agentName: string; stdoutCaptured?: string }>;
}

/** One agent's contribution when a pool node produced several outputs. */
export interface PoolOutputPart {
  agentName: string;
  text: string;
}

/** What a node leaves in the run's outputs map for downstream fan-in. */
export type NodeOutput = string | undefined | PoolOutputPart[];

interface PreparedRun {
  flowRunId: string;
  flowId: string;
  project: InferSelectModel<typeof projects>;
  /**
   * Platform identity + credentials, resolved once in `prepareRun`. Consumers
   * switch on `scm.platform` rather than re-reading nullable project columns.
   */
  scm: PlatformRunCtx;
}

interface ReusedStep {
  nodeId: string;
  nodeKind: string;
  /** Original attempt ordinal (pool nodes reuse one row per success). */
  attempt: number;
  outputJson: unknown;
  /** `inputJson.agentName` of the original step, when it was an agent node. */
  agentName: string | null;
  /** `inputJson.agentId` / `inputJson.pool` stamps of a pool attempt, if any. */
  agentId: string | null;
  pool: unknown;
  startedAt: Date | null;
  finishedAt: Date | null;
  originalStepId: string;
  originalRunId: string;
  originalAgentRunId: string | null;
}

interface PreloadedRun {
  outputs: Map<string, NodeOutput>;
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
 *     (id, created). GitHub comment ids are globally unique; Azure DevOps ones
 *     are per-thread ordinals, so those are keyed on (thread id, comment id) —
 *     see the `thread_id` branch below for why getting this wrong is
 *     unrecoverable rather than merely noisy.
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
    comment?: { id?: unknown; thread_id?: unknown };
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
      const comment = payload.comment;
      const id = comment?.id;
      if (typeof id !== "number") return null;
      // A comment id is only an identity on platforms that number comments
      // globally. Azure DevOps numbers them WITHIN their thread, so the first
      // comment of every new thread is id 1 — and because this key feeds a
      // unique index with no time bound, the first such comment to arrive
      // claims `issue_comment:1:created` and permanently mutes every later
      // one. That is exactly what happened: `@opencara review` stopped
      // starting flows entirely, with no run row to show for it.
      // `thread_id` is set by normalizeAzureEvent and absent on GitHub, so
      // its presence — not the platform — selects the scoped key.
      if (comment && "thread_id" in comment) {
        const thread = comment.thread_id;
        // Azure comment whose thread we couldn't determine: no identity, so
        // fall back to GUID-only dedup. Over-deduping here is unrecoverable
        // (a burned key never expires); under-deduping costs one extra run.
        if (typeof thread !== "number") return null;
        // Thread ids are repository-scoped and dedupe keys are already scoped
        // per flow, so (thread, id) is unique everywhere this is compared.
        return `issue_comment:${thread}:${id}:${action}`;
      }
      return `issue_comment:${id}:${action}`;
    }
    default:
      return null;
  }
}

/**
 * The payload a stored delivery must be replayed with.
 *
 * `platform_events.payload` is not uniformly the shape the engine consumes.
 * The GitHub handler inserts and dispatches the same object, so replaying its
 * row is faithful. The Azure DevOps handler deliberately stores the RAW
 * service hook body for forensics and dispatches `normalizeAzureEvent`'s
 * GitHub-shaped translation instead — so replaying an Azure row verbatim hands
 * the engine a body with no `action`, no `pull_request`, no `comment`. Every
 * trigger then skips with "action '' not in trigger filter" and Restart Flow
 * appears to do nothing, on a run that worked the first time.
 *
 * Re-normalizing here (rather than storing the normalized payload) keeps the
 * raw body authoritative on disk and needs no backfill, so runs recorded before
 * this fix replay correctly too.
 *
 * NOT re-applied: `refinePullRequestAction`'s metadata-only demotion. It
 * compares against the PR's *previous* delivery, and at replay time that
 * neighbour is no longer the one it was at ingest — re-running it could demote
 * a legitimate rerun to `edited` and reproduce the very silence this fixes. A
 * rerun is explicitly user-initiated, so failing open (the review runs) is the
 * right side to err on.
 *
 * Falls back to the stored payload whenever normalization can't produce one;
 * that is no worse than today's behaviour.
 */
export function replayPayload(
  platform: string,
  type: string,
  stored: unknown,
): unknown {
  if (platform !== "azure_devops") return stored;
  const normalized = normalizeAzureEvent(stored);
  if (!normalized) {
    console.warn("[flow-engine] azure replay could not be normalized", { type });
    return stored;
  }
  return normalized.payload;
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

/**
 * `agentName` off a persisted step's inputJson (written by agentRunner before
 * dispatch). Null for non-agent steps and for rows written before the field
 * existed.
 */
function readField(inputJson: unknown, key: string): unknown {
  if (!inputJson || typeof inputJson !== "object") return undefined;
  return (inputJson as Record<string, unknown>)[key];
}

function readStringField(inputJson: unknown, key: string): string | null {
  const v = readField(inputJson, key);
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readAgentName(inputJson: unknown): string | null {
  if (!inputJson || typeof inputJson !== "object") return null;
  const name = (inputJson as { agentName?: unknown }).agentName;
  return typeof name === "string" && name.length > 0 ? name : null;
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

/** The result of evaluating one trigger node against the incoming event. */
export interface TriggerOutcome {
  id: string;
  status: "matched" | "skipped" | "failed";
  /** SkipFlowError message — present only for `skipped`. */
  skipReason?: string;
  /** Thrown error message — present only for `failed`. */
  errorMessage?: string;
  /** Captured stdout — present only for `matched`; the engine threads it
   *  into downstream fan-in. Ignored by summarizeTriggerOutcomes. */
  stdoutCaptured?: string;
}

/**
 * Should a flow run's lifecycle transitions wake project boards (the kanban
 * `flow_runs` LISTENers)? Only runs that actually started are board-relevant:
 * a trigger matched, or the run belongs to a defensive no-trigger flow that
 * executes every node. A pure `trigger_skip` run — dispatched then rejected by
 * every trigger — must never notify, otherwise every unrelated webhook
 * (issue_comment, push, pull_request, a status move to an unwatched column…)
 * rebuilds every open board and starves the DB pool. This is the seam that the
 * 2026-06-24 auth-503 incident traced back to, extracted so the rule is
 * unit-tested without standing up the DB-backed engine.
 */
export function runNotifiesBoard(opts: {
  hasTriggers: boolean;
  matchedTriggerCount: number;
}): boolean {
  return !opts.hasTriggers || opts.matchedTriggerCount > 0;
}

/**
 * Pick which trigger nodes to evaluate for a run.
 * - Drops triggers already satisfied this run (rerun-from-failed preload).
 * - Manual runs tied to an issue (kanban dispatch, `hasIssueContext`) are
 *   narrowed to the `projects_v2_item` entry-point: triggerRunner matches
 *   every trigger on a manual event, but only the implement stage makes
 *   sense against a bare issue. Manual runs with no issue context (pure
 *   flow inspection) light up every entry-point. Non-manual (webhook) runs
 *   evaluate every not-yet-matched trigger and let each one's filter decide.
 */
export function selectTriggersToEvaluate(
  triggers: FlowNode[],
  opts: {
    eventType: string;
    hasIssueContext: boolean;
    isAlreadyMatched: (id: string) => boolean;
  },
): FlowNode[] {
  let toEval = triggers.filter((t) => !opts.isAlreadyMatched(t.id));
  if (opts.eventType === "manual" && opts.hasIssueContext) {
    toEval = toEval.filter((t) => t.kind === "scm.board_item");
  }
  return toEval;
}

/**
 * Reduce the trigger nodes' evaluation outcomes into the flow-level verdict.
 * - `failed` (with the first error message) when any trigger threw a
 *   non-skip error — that fails the whole run even if a sibling matched.
 * - `matchedIds` are the triggers whose subgraphs should run.
 * - `firstSkipReason` is surfaced as the run's trigger_skip message, but
 *   only when NO trigger matched (the caller also factors in preloaded
 *   matches before deciding to skip).
 */
export function summarizeTriggerOutcomes(outcomes: TriggerOutcome[]): {
  matchedIds: string[];
  failed: boolean;
  errorMessage?: string;
  firstSkipReason?: string;
} {
  const matchedIds: string[] = [];
  let failed = false;
  let errorMessage: string | undefined;
  let firstSkipReason: string | undefined;
  for (const o of outcomes) {
    if (o.status === "matched") {
      matchedIds.push(o.id);
    } else if (o.status === "skipped") {
      firstSkipReason ??= o.skipReason;
    } else {
      failed = true;
      errorMessage ??= o.errorMessage;
    }
  }
  return { matchedIds, failed, errorMessage, firstSkipReason };
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
 * Display name per node id, used as the `## From <heading>` section title when
 * a node's output is pasted into a downstream agent (see buildFanInInput).
 *
 * An agent node is named by the AGENT that runs it, not by a per-node rename:
 * a fan-out of "Reviewer 1 / Reviewer 2 / Reviewer 3" tells the synthesizer
 * (and the operator reading the graph) nothing about what actually produced
 * each section, while the agent's name does. So a linked agent's name wins
 * over `flow_node_settings.label`; the stored label only survives on nodes
 * with no agent linked (legacy renames, non-agent nodes). Nodes with neither
 * fall through to their raw id in buildFanInInput.
 *
 * The link is the flow-node default. Runtime agent resolution can override it
 * (an `agent:<name>` label on the issue/PR, or the project default implement
 * agent — see agentRunner), so the engine re-stamps the label with the agent
 * that actually ran once the step completes.
 *
 * Exported for unit tests.
 */
export function buildNodeLabels(
  nodes: readonly { id: string; kind: string }[],
  settings: readonly { nodeId: string; label: string | null; agentId: string | null }[],
  agentNamesById: ReadonlyMap<string, string>,
): Map<string, string> {
  const kindByNodeId = new Map(nodes.map((n) => [n.id, n.kind]));
  const labels = new Map<string, string>();
  for (const s of settings) {
    const agentName =
      kindByNodeId.get(s.nodeId) === "agent" && s.agentId
        ? agentNamesById.get(s.agentId)
        : undefined;
    const label = agentName ?? s.label;
    if (label) labels.set(s.nodeId, label);
  }
  return labels;
}

/**
 * Compose a node's previousOutput from its upstream nodes' captured stdout.
 * - 0 incoming: undefined (e.g. trigger nodes)
 * - 1 incoming into an action node: that node's output verbatim — post_review
 *   and add_comment publish the body as-is, so a section header would leak
 *   into the posted review and unseat the verdict line
 * - 1 incoming into an agent node: labeled section. An unlabeled pasted
 *   review reads as the agent's own completed work and produces "I've
 *   completed my review" stub replies (ParadiseGodot#25 review 4618560289)
 * - 2+ incoming: markdown sections so a synthesizer agent can parse them
 *
 * Exported for unit tests.
 */
export function buildFanInInput(
  node: FlowNode,
  edges: FlowDefinition["edges"],
  outputs: Map<string, NodeOutput>,
  labels: Map<string, string>,
): string | undefined {
  const incoming = edges.filter((e) => e.target === node.id);
  if (incoming.length === 0) return undefined;
  if (incoming.length === 1 && !Array.isArray(outputs.get(incoming[0]!.source))) {
    const output = outputs.get(incoming[0]!.source) as string | undefined;
    // Empty/absent upstream (trigger sources) must stay undefined so the
    // agent runner's "(no upstream output)" sentinel still fires.
    if (node.kind !== "agent" || !output?.trim()) return output;
    const heading = labels.get(incoming[0]!.source) ?? incoming[0]!.source;
    return `## From ${heading}\n\n${output}`;
  }
  // One section per upstream contribution. A pool node that finished with
  // several successful attempts contributes one section PER AGENT (its
  // parts carry the agent names); every other upstream contributes one
  // section under its node label.
  const sections: Array<{ heading: string; suffix: string; text: string }> = [];
  for (const e of incoming) {
    const out = outputs.get(e.source);
    if (Array.isArray(out)) {
      for (const part of out) {
        sections.push({ heading: part.agentName, suffix: e.source, text: part.text });
      }
    } else {
      sections.push({
        heading: labels.get(e.source) ?? e.source,
        suffix: e.source,
        text: out ?? "",
      });
    }
  }
  // Now that agent nodes are named by their agent (buildNodeLabels), two
  // siblings can legitimately resolve to the SAME heading — one agent wired
  // into two reviewer nodes with different prompts. Suffix the node id on the
  // collisions only, so the synthesizer can still tell the sections apart
  // without the common case getting noisier.
  const seen = new Map<string, number>();
  for (const sct of sections) seen.set(sct.heading, (seen.get(sct.heading) ?? 0) + 1);
  return sections
    .map((sct) => {
      const heading = seen.get(sct.heading)! > 1 ? `${sct.heading} (${sct.suffix})` : sct.heading;
      return `## From ${heading}\n\n${sct.text}`;
    })
    .join("\n\n---\n\n");
}

export type { FlowNode };
