// Regression pin for the quorum-cancel label: a pool attempt that was
// dispatched and then aborted when quorum landed must read 'cancelled',
// not 'skipped'. 'skipped' means "never ran" — a step that burned seven
// minutes of compute showing as skipped misleads anyone asking why the
// review they expected never arrived (devin swe-2, flow run
// 01M31D37N0FC5ZPCQ3DAPWA7FP).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentRuns, flowRunSteps } from "../../db/schema.js";
import { cancelFlowNodeAttempts } from "../cancelAgents.js";

interface Update {
  table: unknown;
  set: Record<string, unknown>;
}

function fakeDb(opts: { steps?: { id: string }[]; runs?: { id: string }[] } = {}) {
  const updates: Update[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => (table === flowRunSteps ? (opts.steps ?? []) : (opts.runs ?? [])),
      }),
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ table, set });
        return { where: async () => [] };
      },
    }),
  } as never;
  return { db, updates };
}

function fakeDispatcher() {
  const cancelled: { id: string; reason: string | undefined }[] = [];
  return {
    cancelled,
    dispatcher: {
      cancel: (id: string, reason?: string) => {
        cancelled.push({ id, reason });
        return true;
      },
    } as never,
  };
}

describe("cancelFlowNodeAttempts", () => {
  it("marks quorum-aborted steps 'cancelled', not 'skipped'", async () => {
    const { db, updates } = fakeDb({
      steps: [{ id: "step-1" }],
      runs: [{ id: "run-1" }],
    });
    const { dispatcher, cancelled } = fakeDispatcher();
    const result = await cancelFlowNodeAttempts(db, dispatcher, "flow-1", "reviewer", [1]);

    assert.deepEqual(result, { cancelled: 1, signalled: 1 });
    const stepUpdate = updates.find((u) => u.table === flowRunSteps);
    assert.equal(stepUpdate?.set.status, "cancelled");
    assert.equal(stepUpdate?.set.error, "pool quorum reached");
    const runUpdate = updates.find((u) => u.table === agentRuns);
    assert.equal(runUpdate?.set.status, "cancelled");
    assert.equal(runUpdate?.set.cancelReason, "wave_cancelled");
    assert.deepEqual(cancelled, [{ id: "run-1", reason: "wave_cancelled" }]);
  });

  it("does nothing when no attempts are outstanding", async () => {
    const { db, updates } = fakeDb();
    const { dispatcher, cancelled } = fakeDispatcher();
    const result = await cancelFlowNodeAttempts(db, dispatcher, "flow-1", "reviewer", [1, 2]);
    assert.deepEqual(result, { cancelled: 0, signalled: 0 });
    assert.equal(updates.length, 0);
    assert.equal(cancelled.length, 0);
  });
});
