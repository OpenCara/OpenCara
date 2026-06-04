// Unit tests for trigger_skip flow_run pruning (OpenCara#146). The retention
// cutoff is pure arithmetic; the delete itself is exercised against a fake Db
// surface that records which table it targeted and feeds back a row set so the
// returned count is verified.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pruneTriggerSkipFlowRuns,
  retentionCutoff,
  DEFAULT_TRIGGER_SKIP_RETENTION_DAYS,
} from "../prune.js";
import { flowRuns } from "../../db/schema.js";
import type { Db } from "../../db/client.js";

describe("retentionCutoff", () => {
  it("subtracts the retention window in whole days", () => {
    const now = new Date("2026-06-04T12:00:00.000Z");
    const cutoff = retentionCutoff(now, 7);
    assert.equal(cutoff.toISOString(), "2026-05-28T12:00:00.000Z");
  });

  it("default retention is a week", () => {
    assert.equal(DEFAULT_TRIGGER_SKIP_RETENTION_DAYS, 7);
  });
});

describe("pruneTriggerSkipFlowRuns", () => {
  it("deletes from flow_runs and returns the number of rows removed", async () => {
    let deletedTable: unknown = null;
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const fakeDb = {
      delete: (table: unknown) => {
        deletedTable = table;
        return {
          where: () => ({
            returning: async () => rows,
          }),
        };
      },
    } as unknown as Db;

    const n = await pruneTriggerSkipFlowRuns(fakeDb, 7, new Date());

    assert.equal(deletedTable, flowRuns, "must target the flow_runs table");
    assert.equal(n, rows.length);
  });

  it("returns 0 when nothing matches", async () => {
    const fakeDb = {
      delete: () => ({ where: () => ({ returning: async () => [] }) }),
    } as unknown as Db;
    assert.equal(await pruneTriggerSkipFlowRuns(fakeDb), 0);
  });
});
