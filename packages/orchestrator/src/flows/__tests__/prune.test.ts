// Unit tests for trigger_skip flow_run pruning (OpenCara#146). The retention
// cutoff is pure arithmetic; the delete itself is exercised against a fake Db
// surface that records which table it targeted and feeds back a row set so the
// returned count is verified.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pruneInternalAgentRuns,
  pruneTriggerSkipFlowRuns,
  pruneUnreferencedPlatformEvents,
  retentionCutoff,
  DEFAULT_INTERNAL_RUN_RETENTION_DAYS,
  DEFAULT_TRIGGER_SKIP_RETENTION_DAYS,
  DEFAULT_UNREFERENCED_EVENT_RETENTION_DAYS,
} from "../prune.js";
import { agentRuns, flowRuns, platformEvents } from "../../db/schema.js";
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

/** Fake Db that records the deleted table and echoes `rows` back. */
function fakeDeleteDb(rows: { id: string }[]) {
  const seen: { table: unknown } = { table: null };
  const db = {
    delete: (table: unknown) => {
      seen.table = table;
      return { where: () => ({ returning: async () => rows }) };
    },
  } as unknown as Db;
  return { db, seen };
}

describe("pruneUnreferencedPlatformEvents", () => {
  it("keeps a month by default", () => {
    assert.equal(DEFAULT_UNREFERENCED_EVENT_RETENTION_DAYS, 30);
  });

  it("deletes from platform_events and returns the number of rows removed", async () => {
    const { db, seen } = fakeDeleteDb([{ id: "e1" }, { id: "e2" }]);
    const n = await pruneUnreferencedPlatformEvents(db, 30, new Date());
    assert.equal(seen.table, platformEvents, "must target the platform_events table");
    assert.equal(n, 2);
  });

  it("returns 0 when nothing matches", async () => {
    const { db } = fakeDeleteDb([]);
    assert.equal(await pruneUnreferencedPlatformEvents(db), 0);
  });
});

describe("pruneInternalAgentRuns", () => {
  it("keeps a week by default", () => {
    assert.equal(DEFAULT_INTERNAL_RUN_RETENTION_DAYS, 7);
  });

  it("deletes from agent_runs and returns the number of rows removed", async () => {
    const { db, seen } = fakeDeleteDb([{ id: "r1" }]);
    const n = await pruneInternalAgentRuns(db, 7, new Date());
    assert.equal(seen.table, agentRuns, "must target the agent_runs table");
    assert.equal(n, 1);
  });

  it("returns 0 when nothing matches", async () => {
    const { db } = fakeDeleteDb([]);
    assert.equal(await pruneInternalAgentRuns(db), 0);
  });
});
