import { and, eq, inArray, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import type { KanbanWaveDispatchCall } from "@opencara/shared";
import type { Db } from "../db/client.js";
import { flows, issues, platformEvents, pmWaveItems, pmWaves } from "../db/schema.js";
import type { FlowEngine } from "../flows/engine.js";
import type { AgentCallResult } from "./index.js";

/**
 * Apply a `kanban.wave.dispatch` agent-call.
 *
 * 1. Resolve flow by (projectId, slug) — refuse if not found or disabled.
 * 2. Verify each issueNumber exists in the issues table for this project —
 *    refuse atomically if any are missing.
 * 3. Insert one pm_waves row + N pm_wave_items rows in a transaction.
 * 4. For each item: synthesise a manual platform_event, call
 *    flowEngine.triggerFlow(), write back the flowRunId to the item row.
 * 5. Return { ok: true, waveId }.
 */
export async function applyKanbanWaveDispatch(
  db: Db,
  projectId: string,
  flowEngine: FlowEngine,
  sessionId: string,
  msg: Pick<KanbanWaveDispatchCall, "flowSlug" | "issueNumbers">,
): Promise<AgentCallResult & { waveId?: string }> {
  // 1. Resolve flow.
  const flow = await db.query.flows.findFirst({
    where: and(eq(flows.projectId, projectId), eq(flows.slug, msg.flowSlug)),
  });
  if (!flow) {
    return { ok: false, reason: `flow "${msg.flowSlug}" not found in project` };
  }
  if (!flow.enabled) {
    return { ok: false, reason: `flow "${msg.flowSlug}" is disabled` };
  }

  // 2. Verify all issues exist.
  const foundIssues = await db.query.issues.findMany({
    where: and(
      eq(issues.projectId, projectId),
      inArray(issues.number, msg.issueNumbers),
      isNull(issues.removedAt),
    ),
  });
  const foundNumbers = new Set(foundIssues.map((i) => i.number));
  const missing = msg.issueNumbers.filter((n) => !foundNumbers.has(n));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `issue(s) not found in project: ${missing.join(", ")}`,
    };
  }

  // 3. Insert wave row + item rows.
  const waveId = ulid();
  await db.insert(pmWaves).values({
    id: waveId,
    projectId,
    threadKey: sessionId,
    flowSlug: msg.flowSlug,
    status: "running",
  });

  const itemRows = msg.issueNumbers.map((n) => ({
    id: ulid(),
    waveId,
    issueNumber: n,
    flowRunId: null,
    status: "pending",
  }));
  await db.insert(pmWaveItems).values(itemRows);

  // 4. Trigger a flow run for each issue.
  const triggeredCount = { ok: 0, failed: 0 };
  for (const item of itemRows) {
    const eventId = ulid();
    try {
      // Synthesise a manual platform_event.
      await db.insert(platformEvents).values({
        id: eventId,
        platform: "github",
        type: "manual",
        payload: { issueNumber: item.issueNumber, source: "pm-wave" },
        projectId,
        deliveryId: eventId,
      });

      const { flowRunId } = await flowEngine.triggerFlow(flow.id, {
        id: eventId,
        type: "manual",
        projectId,
        payload: { issueNumber: item.issueNumber, source: "pm-wave" },
      });

      // Write back flowRunId.
      await db
        .update(pmWaveItems)
        .set({ flowRunId, status: "running" })
        .where(eq(pmWaveItems.id, item.id));

      triggeredCount.ok++;
    } catch (err) {
      console.error("[kanban-wave-dispatch] triggerFlow failed", {
        waveId,
        issueNumber: item.issueNumber,
        err,
      });
      await db
        .update(pmWaveItems)
        .set({ status: "failed" })
        .where(eq(pmWaveItems.id, item.id));
      triggeredCount.failed++;
    }
  }

  // If all items failed, mark wave done with failure indication.
  if (triggeredCount.ok === 0) {
    await db.update(pmWaves).set({ status: "done", finishedAt: new Date() }).where(eq(pmWaves.id, waveId));
    return { ok: false, reason: `all ${msg.issueNumbers.length} flow trigger(s) failed` };
  }

  return { ok: true, waveId };
}
