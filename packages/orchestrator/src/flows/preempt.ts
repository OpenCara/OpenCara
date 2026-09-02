/**
 * Event-driven pre-emption of review runs.
 *
 * A review that is still running when its PR gets merged, closed, or tagged
 * with one of the trigger's `labelsIgnore` labels is wasted work (and may
 * post a review on a dead PR). The engine calls `cancelPreemptedReviewRuns`
 * for every incoming platform event BEFORE dispatching it: in-flight runs
 * that were started by a `scm.pull_request` trigger for the same PR are
 * cancelled, agents included. This complements the trigger's grace period
 * (`delaySeconds`), which covers the window before agents start.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { flowRuns, flowRunSteps, flows, platformEvents } from "../db/schema.js";
import type { PlatformEventInput } from "./engine.js";
import { cancelFlowRun, type CancelFlowRunDeps } from "./cancelRun.js";

export type ReviewPreemption =
  | { kind: "merged"; prNumber: number }
  | { kind: "closed"; prNumber: number }
  | { kind: "labeled"; prNumber: number; label: string };

/** Pure: does this event pre-empt reviews of its PR, and how? */
export function reviewPreemptionFor(
  event: Pick<PlatformEventInput, "type" | "payload">,
): ReviewPreemption | null {
  if (event.type !== "pull_request") return null;
  const payload = event.payload as {
    action?: unknown;
    pull_request?: { number?: unknown; merged?: unknown };
    label?: { name?: unknown };
  };
  const prNumber = payload.pull_request?.number;
  if (typeof prNumber !== "number") return null;
  if (payload.action === "closed") {
    return payload.pull_request?.merged === true
      ? { kind: "merged", prNumber }
      : { kind: "closed", prNumber };
  }
  if (payload.action === "labeled" && typeof payload.label?.name === "string") {
    return { kind: "labeled", prNumber, label: payload.label.name };
  }
  return null;
}

/**
 * Pure: given the pre-emption and the config of the `scm.pull_request`
 * trigger that started a run, why the run should be cancelled (or null).
 */
export function preemptionReason(
  preemption: ReviewPreemption,
  triggerConfig: unknown,
): string | null {
  switch (preemption.kind) {
    case "merged":
      return `PR #${preemption.prNumber} was merged while the review was running`;
    case "closed":
      return `PR #${preemption.prNumber} was closed while the review was running`;
    case "labeled": {
      const ignore = (triggerConfig as { labelsIgnore?: unknown } | null)?.labelsIgnore;
      const list = Array.isArray(ignore) ? ignore.filter((l): l is string => typeof l === "string") : [];
      return list.includes(preemption.label)
        ? `PR #${preemption.prNumber} received labels-ignore '${preemption.label}' while the review was running`
        : null;
    }
  }
}

/** PR number a stored trigger event was about (pull_request or issue_comment). */
function eventPrNumber(payload: unknown): number | null {
  const p = payload as {
    pull_request?: { number?: unknown };
    issue?: { number?: unknown; pull_request?: unknown };
  } | null;
  if (typeof p?.pull_request?.number === "number") return p.pull_request.number;
  if (p?.issue?.pull_request && typeof p.issue.number === "number") return p.issue.number;
  return null;
}

export async function cancelPreemptedReviewRuns(
  deps: CancelFlowRunDeps & { db: Db },
  event: PlatformEventInput,
): Promise<number> {
  if (!event.projectId) return 0;
  const preemption = reviewPreemptionFor(event);
  if (!preemption) return 0;

  // In-flight runs of this project whose triggering event concerns the same PR.
  const candidates = await deps.db
    .select({
      id: flowRuns.id,
      projectId: flowRuns.projectId,
      payload: platformEvents.payload,
      graphJson: flows.graphJson,
    })
    .from(flowRuns)
    .innerJoin(platformEvents, eq(platformEvents.id, flowRuns.triggerEventId))
    .innerJoin(flows, eq(flows.id, flowRuns.flowId))
    .where(
      and(eq(flowRuns.projectId, event.projectId), inArray(flowRuns.status, ["pending", "running"])),
    );
  const samePr = candidates.filter((r) => eventPrNumber(r.payload) === preemption.prNumber);
  if (samePr.length === 0) return 0;

  // Only runs started by a `scm.pull_request` trigger are reviews; the step
  // row's inputJson carries that trigger's config (labelsIgnore).
  const steps = await deps.db
    .select({ flowRunId: flowRunSteps.flowRunId, inputJson: flowRunSteps.inputJson })
    .from(flowRunSteps)
    .where(
      and(
        inArray(
          flowRunSteps.flowRunId,
          samePr.map((r) => r.id),
        ),
        eq(flowRunSteps.nodeKind, "scm.pull_request"),
        inArray(flowRunSteps.status, ["succeeded", "running"]),
      ),
    );

  let cancelled = 0;
  for (const run of samePr) {
    // The trigger step carries the config that actually matched. A run minted
    // moments ago may not have inserted it yet — fall back to the flow graph's
    // scm.pull_request triggers so a merge in that window still cancels.
    const trigger = steps.find((s) => s.flowRunId === run.id);
    const configs: unknown[] = trigger
      ? [(trigger.inputJson as { nodeConfig?: unknown } | null)?.nodeConfig]
      : ((run.graphJson as { nodes?: Array<{ kind?: string; config?: unknown }> } | null)?.nodes ?? [])
          .filter((n) => n.kind === "scm.pull_request" || n.kind === "github.pull_request")
          .map((n) => n.config);
    if (configs.length === 0) continue;
    let reason: string | null = null;
    for (const cfg of configs) {
      reason = preemptionReason(preemption, cfg);
      if (reason) break;
    }
    if (!reason) continue;
    const result = await cancelFlowRun(
      deps,
      { id: run.id, projectId: run.projectId },
      { db: `review_preempted_${preemption.kind}`, wire: "review_preempted" },
      reason,
    );
    if (result.cancelled) {
      cancelled += 1;
      console.log("[flow-engine] review run pre-empted", {
        flowRunId: run.id,
        prNumber: preemption.prNumber,
        kind: preemption.kind,
        agentsSignalled: result.signalled,
      });
    }
  }
  return cancelled;
}
