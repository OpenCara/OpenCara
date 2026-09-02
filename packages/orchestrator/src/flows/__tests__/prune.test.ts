// Unit tests for the daily retention prunes. The retention cutoff is pure
// arithmetic; each batch statement is rendered through the pg dialect so the
// guards that make these irreversible deletes safe (trigger_skip only,
// NOT EXISTS references, terminal status only) are asserted on the SQL text;
// the batching loop is exercised against a fake Db that scripts batch counts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  deleteInBatches,
  internalAgentRunsBatch,
  pruneInternalAgentRuns,
  pruneTriggerSkipFlowRuns,
  pruneUnreferencedPlatformEvents,
  retentionCutoff,
  triggerSkipFlowRunsBatch,
  unreferencedPlatformEventsBatch,
  DEFAULT_INTERNAL_RUN_RETENTION_DAYS,
  DEFAULT_TRIGGER_SKIP_RETENTION_DAYS,
  DEFAULT_UNREFERENCED_EVENT_RETENTION_DAYS,
  PRUNE_BATCH_SIZE,
} from "../prune.js";
import type { Db } from "../../db/client.js";

const dialect = new PgDialect();
const render = (q: SQL) => {
  const { sql, params } = dialect.sqlToQuery(q);
  return { sql: sql.replace(/\s+/g, " ").trim(), params };
};

/** Fake Db whose execute() returns the scripted batch counts in order. */
function scriptedDb(counts: number[]) {
  const executed: SQL[] = [];
  const db = {
    execute: async (q: SQL) => {
      executed.push(q);
      const n = counts.shift();
      if (n === undefined) throw new Error("unexpected extra batch");
      return [{ n }];
    },
  } as unknown as Db;
  return { db, executed };
}

describe("retentionCutoff", () => {
  it("subtracts the retention window in whole days", () => {
    const now = new Date("2026-06-04T12:00:00.000Z");
    const cutoff = retentionCutoff(now, 7);
    assert.equal(cutoff.toISOString(), "2026-05-28T12:00:00.000Z");
  });

  it("defaults: a week for trigger_skip runs and internal runs, 90 days for events", () => {
    assert.equal(DEFAULT_TRIGGER_SKIP_RETENTION_DAYS, 7);
    assert.equal(DEFAULT_INTERNAL_RUN_RETENTION_DAYS, 7);
    // Must cover webhooksAzure.ts previousPrDelivery's 90-day lookback.
    assert.ok(DEFAULT_UNREFERENCED_EVENT_RETENTION_DAYS >= 90);
  });
});

describe("deleteInBatches", () => {
  it("keeps issuing batches until one comes back short and sums the counts", async () => {
    const { db, executed } = scriptedDb([3, 3, 1]);
    const n = await deleteInBatches(db, (limit) => sql_`DELETE ${limit}`, 3);
    assert.equal(n, 7);
    assert.equal(executed.length, 3);
  });

  it("stops after a single empty batch", async () => {
    const { db, executed } = scriptedDb([0]);
    assert.equal(await deleteInBatches(db, (limit) => sql_`DELETE ${limit}`, 3), 0);
    assert.equal(executed.length, 1);
  });

  it("stops when a full batch is exactly the last one (next batch is empty)", async () => {
    const { db, executed } = scriptedDb([3, 0]);
    assert.equal(await deleteInBatches(db, (limit) => sql_`DELETE ${limit}`, 3), 3);
    assert.equal(executed.length, 2);
  });
});

const cutoff = new Date("2026-05-28T12:00:00.000Z");
const cutoffIso = cutoff.toISOString();

describe("triggerSkipFlowRunsBatch", () => {
  it("only touches cancelled trigger_skip rows older than the cutoff, in a bounded batch", () => {
    const { sql, params } = render(triggerSkipFlowRunsBatch(cutoff, 1000));
    assert.match(sql, /DELETE FROM flow_runs WHERE id IN \(SELECT id FROM victims\)/);
    assert.match(sql, /status = 'cancelled'/);
    assert.match(sql, /cancel_reason = 'trigger_skip'/);
    assert.match(sql, /created_at < \$1::timestamptz/);
    assert.match(sql, /LIMIT \$2/);
    assert.deepEqual(params, [cutoffIso, 1000]);
  });
});

describe("unreferencedPlatformEventsBatch", () => {
  it("keeps any event still referenced by a flow run or an agent run", () => {
    const { sql, params } = render(unreferencedPlatformEventsBatch(cutoff, 500));
    assert.match(sql, /DELETE FROM platform_events WHERE id IN \(SELECT id FROM victims\)/);
    assert.match(sql, /received_at < \$1::timestamptz/);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM flow_runs fr WHERE fr\.trigger_event_id = e\.id\)/);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM agent_runs r WHERE r\.trigger_event_id = e\.id\)/);
    assert.match(sql, /LIMIT \$2/);
    assert.deepEqual(params, [cutoffIso, 500]);
  });
});

describe("internalAgentRunsBatch", () => {
  it("only deletes terminal internal:* runs older than the cutoff", () => {
    const { sql, params } = render(internalAgentRunsBatch(cutoff, 200));
    assert.match(sql, /DELETE FROM agent_runs WHERE id IN \(SELECT id FROM victims\)/);
    assert.match(sql, /created_at < \$1::timestamptz/);
    assert.match(sql, /spec->>'kind' LIKE 'internal:%'/);
    assert.match(sql, /status::text IN \('succeeded', 'failed', 'cancelled'\)/);
    assert.match(sql, /LIMIT \$2/);
    assert.deepEqual(params, [cutoffIso, 200]);
  });
});

describe("prune entry points", () => {
  const now = new Date("2026-06-04T12:00:00.000Z");

  it("pruneTriggerSkipFlowRuns binds the 7-day cutoff and the default batch size", async () => {
    const { db, executed } = scriptedDb([2]);
    assert.equal(await pruneTriggerSkipFlowRuns(db, 7, now), 2);
    const { params } = render(executed[0]!);
    assert.deepEqual(params, [cutoffIso, PRUNE_BATCH_SIZE]);
  });

  it("pruneUnreferencedPlatformEvents targets platform_events with the requested cutoff", async () => {
    const { db, executed } = scriptedDb([0]);
    assert.equal(await pruneUnreferencedPlatformEvents(db, 7, now), 0);
    const { sql, params } = render(executed[0]!);
    assert.match(sql, /DELETE FROM platform_events/);
    assert.deepEqual(params, [cutoffIso, PRUNE_BATCH_SIZE]);
  });

  it("pruneInternalAgentRuns targets agent_runs with the requested cutoff", async () => {
    const { db, executed } = scriptedDb([1]);
    assert.equal(await pruneInternalAgentRuns(db, 7, now), 1);
    const { sql, params } = render(executed[0]!);
    assert.match(sql, /DELETE FROM agent_runs/);
    assert.deepEqual(params, [cutoffIso, PRUNE_BATCH_SIZE]);
  });
});

// Local alias so the batching tests don't need a real table; drizzle's `sql`
// tag builds the same SQL object the prune functions hand to execute().
import { sql as sql_ } from "drizzle-orm";
