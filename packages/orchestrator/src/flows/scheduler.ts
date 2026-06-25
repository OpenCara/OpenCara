import { ulid } from "ulid";
import { and, eq, lte, isNotNull } from "drizzle-orm";
import { FlowDefinitionSchema, type FlowDefinition } from "@opencara/flows";
import { nextCronOccurrence } from "@opencara/shared";
import type { Db } from "../db/client.js";
import { flowScheduleState, flows, platformEvents } from "../db/schema.js";

/** A schedule.cron trigger extracted from a flow graph. */
export interface ScheduleTrigger {
  nodeId: string;
  name: string;
  cron: string;
  timezone: string;
  enabled: boolean;
}

/** The bookkeeping fields persisted in flow_schedule_state. */
export interface ScheduleStateLike {
  cron: string;
  timezone: string;
  nextFireAt: Date | null;
}

/**
 * Pull the enabled schedule.cron triggers out of a parsed flow graph. Disabled
 * schedules are dropped here so they never get a state row / next fire time.
 */
export function extractScheduleTriggers(def: FlowDefinition): ScheduleTrigger[] {
  const out: ScheduleTrigger[] = [];
  for (const node of def.nodes) {
    if (node.kind !== "schedule.cron") continue;
    const cfg = node.config;
    if (cfg.enabled === false) continue;
    out.push({
      nodeId: node.id,
      name: cfg.name,
      cron: cfg.cron,
      timezone: cfg.timezone,
      enabled: cfg.enabled,
    });
  }
  return out;
}

/**
 * Next fire instant for a cron/timezone after `after`, or null when the
 * expression is invalid or has no occurrence within a year. Never throws —
 * a bad cron simply yields a schedule that never fires (the UI validates on
 * the way in, so this is a defensive backstop).
 */
export function computeNextFireAt(
  cron: string,
  timezone: string,
  after: Date,
): Date | null {
  try {
    return nextCronOccurrence(cron, after, timezone);
  } catch {
    return null;
  }
}

/** Whether the persisted state was computed against a now-stale cron/timezone
 *  (operator edited the expression) and must be recomputed. */
export function scheduleConfigChanged(
  state: ScheduleStateLike,
  trigger: ScheduleTrigger,
): boolean {
  return state.cron !== trigger.cron || state.timezone !== trigger.timezone;
}

/** Stable idempotency key for one occurrence of one schedule. Collapses a
 *  re-fire (restart between dispatch and state advance, or overlapping tick)
 *  onto the first run via flow_runs' partial unique index. */
export function scheduleDedupeKey(
  flowId: string,
  nodeId: string,
  occurrence: Date,
): string {
  return `schedule:${flowId}:${nodeId}:${occurrence.getTime()}`;
}

interface SchedulerEngine {
  triggerFlow(
    flowId: string,
    event: {
      id: string;
      type: string;
      projectId: string | null;
      payload: unknown;
    },
    dedupeKey: string | null,
  ): Promise<{ flowRunId: string }>;
}

export interface SchedulerDeps {
  db: Db;
  engine: SchedulerEngine;
}

function parseGraph(graphJson: unknown): FlowDefinition | null {
  const g = graphJson as { nodes?: unknown; edges?: unknown; description?: string };
  try {
    return FlowDefinitionSchema.parse({
      slug: "x",
      name: "x",
      description: g.description ?? "",
      nodes: g.nodes,
      edges: g.edges,
    });
  } catch {
    return null;
  }
}

/**
 * One scheduler tick:
 *   1. Reconcile flow_schedule_state against the live schedule.cron triggers in
 *      every enabled flow — create rows for new schedules (next fire computed
 *      from `now`, so a freshly-created schedule never backfills) and recompute
 *      rows whose cron/timezone was edited.
 *   2. Fire every schedule whose next_fire_at has passed: insert a synthetic
 *      `schedule` platform event and dispatch the flow with a per-occurrence
 *      dedupe key, then advance the row to the next future occurrence.
 *
 * Returns the number of schedules fired. Best-effort and self-contained:
 * a failure on one schedule is logged and never blocks the others.
 */
export async function runSchedulerTick(
  deps: SchedulerDeps,
  now: Date = new Date(),
): Promise<number> {
  const enabledFlows = await deps.db.query.flows.findMany({
    where: eq(flows.enabled, true),
  });

  // ── Phase 1: reconcile state rows ────────────────────────────────────────
  for (const flow of enabledFlows) {
    const def = parseGraph(flow.graphJson);
    if (!def) continue;
    const schedules = extractScheduleTriggers(def);
    if (schedules.length === 0) continue;

    for (const sched of schedules) {
      const existing = await deps.db.query.flowScheduleState.findFirst({
        where: and(
          eq(flowScheduleState.flowId, flow.id),
          eq(flowScheduleState.nodeId, sched.nodeId),
        ),
      });
      if (!existing) {
        await deps.db
          .insert(flowScheduleState)
          .values({
            id: ulid(),
            flowId: flow.id,
            nodeId: sched.nodeId,
            cron: sched.cron,
            timezone: sched.timezone,
            nextFireAt: computeNextFireAt(sched.cron, sched.timezone, now),
            lastFiredAt: null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: [flowScheduleState.flowId, flowScheduleState.nodeId],
          });
      } else if (scheduleConfigChanged(existing, sched)) {
        await deps.db
          .update(flowScheduleState)
          .set({
            cron: sched.cron,
            timezone: sched.timezone,
            nextFireAt: computeNextFireAt(sched.cron, sched.timezone, now),
            updatedAt: now,
          })
          .where(eq(flowScheduleState.id, existing.id));
      } else if (existing.nextFireAt === null) {
        // Re-arm a dormant row: nextFireAt is nulled when a schedule's flow is
        // disabled (see phase 2). Re-enabling the flow brings it back into the
        // phase-1 scan, so recompute its next fire. Skip the write when the
        // cron genuinely has no upcoming occurrence (impossible date) — that
        // legitimately stays null, and avoids churning a write every tick.
        const next = computeNextFireAt(sched.cron, sched.timezone, now);
        if (next) {
          await deps.db
            .update(flowScheduleState)
            .set({ nextFireAt: next, updatedAt: now })
            .where(eq(flowScheduleState.id, existing.id));
        }
      }
    }
  }

  // ── Phase 2: fire everything due ─────────────────────────────────────────
  // Re-read after reconciliation so newly-initialised rows are considered.
  const due = await deps.db.query.flowScheduleState.findMany({
    where: and(
      isNotNull(flowScheduleState.nextFireAt),
      lte(flowScheduleState.nextFireAt, now),
    ),
  });

  let fired = 0;
  for (const state of due) {
    const occurrence = state.nextFireAt;
    if (!occurrence) continue;

    const flow = enabledFlows.find((f) => f.id === state.flowId);
    // The owning flow was disabled since we loaded it (a deleted flow would
    // have cascade-removed this row). Make the row dormant with a single write
    // — nulling nextFireAt drops it out of the `is not null` due query, so it
    // won't churn a write every tick. Phase 1 re-arms it if the flow is later
    // re-enabled. (PR #164 review item 5.)
    if (!flow) {
      await deps.db
        .update(flowScheduleState)
        .set({ nextFireAt: null, updatedAt: now })
        .where(eq(flowScheduleState.id, state.id));
      continue;
    }

    const def = parseGraph(flow.graphJson);
    const sched = def
      ? extractScheduleTriggers(def).find((s) => s.nodeId === state.nodeId)
      : undefined;
    // Schedule node removed or disabled since reconciliation — stop firing it.
    if (!sched) {
      await deps.db
        .update(flowScheduleState)
        .set({ nextFireAt: null, updatedAt: now })
        .where(eq(flowScheduleState.id, state.id));
      continue;
    }

    const eventId = ulid();
    const payload = {
      nodeId: state.nodeId,
      scheduleName: sched.name,
      cron: sched.cron,
      timezone: sched.timezone,
      occurrence: occurrence.toISOString(),
      dispatchedAt: now.toISOString(),
    };

    try {
      await deps.db.insert(platformEvents).values({
        id: eventId,
        platform: "github",
        type: "schedule",
        payload,
        projectId: flow.projectId,
        deliveryId: eventId,
      });
      await deps.engine.triggerFlow(
        flow.id,
        { id: eventId, type: "schedule", projectId: flow.projectId, payload },
        scheduleDedupeKey(flow.id, state.nodeId, occurrence),
      );
      fired++;
    } catch (err) {
      console.error("[scheduler] failed to dispatch schedule", {
        flowId: flow.id,
        nodeId: state.nodeId,
        err,
      });
    }

    // Advance past the fired occurrence regardless of dispatch outcome. We
    // resume from `now` (not the missed occurrence) so a long downtime fires
    // once on recovery and then jumps to the next future slot — no catch-up
    // storm.
    await deps.db
      .update(flowScheduleState)
      .set({
        lastFiredAt: occurrence,
        nextFireAt: computeNextFireAt(sched.cron, sched.timezone, now),
        cron: sched.cron,
        timezone: sched.timezone,
        updatedAt: now,
      })
      .where(eq(flowScheduleState.id, state.id));
  }

  return fired;
}
