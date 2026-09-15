import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentLogSink } from "../logSink.js";
import type { Db } from "../../db/client.js";
import type { Sql } from "postgres";

// Fakes: a Db whose insert().values() captures every flushed batch, and a Sql
// whose notify() records each wake-up. Together they assert the whole point of
// the sink (OpenCara#245): N chunks must collapse into a bounded number of
// insert+notify pairs instead of two pool checkouts per chunk.
function fakeDeps(opts: { failInsert?: boolean } = {}) {
  const inserts: unknown[][] = [];
  const notifies: [string, string][] = [];
  const db = {
    insert: () => ({
      values: (rows: unknown[]) =>
        opts.failInsert
          ? Promise.reject(new Error("pool starved"))
          : Promise.resolve((inserts.push(rows), rows)),
    }),
  } as unknown as Db;
  const pg = {
    notify: (channel: string, payload: string) => {
      notifies.push([channel, payload]);
      return Promise.resolve();
    },
  } as unknown as Sql;
  return { db, pg, inserts, notifies };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AgentLogSink", () => {
  it("batches many chunks into one insert + one notify on close", async () => {
    const { db, pg, inserts, notifies } = fakeDeps();
    const sink = new AgentLogSink(db, pg, "run-1", { flushIntervalMs: 60_000 });

    for (let i = 0; i < 50; i++) sink.push("stdout", `chunk-${i}`);
    assert.equal(inserts.length, 0, "nothing flushed before close without a trigger");

    await sink.close();
    assert.equal(inserts.length, 1, "all 50 chunks flushed in ONE insert");
    assert.equal(inserts[0]!.length, 50);
    const rows = inserts[0] as { seq: number; chunk: string }[];
    assert.deepEqual(
      rows.map((r) => r.seq),
      Array.from({ length: 50 }, (_, i) => i),
      "seq must be 0..n-1 in arrival order",
    );
    assert.deepEqual(notifies, [["agent_run_logs", "run-1"]]);
  });

  it("flushes early when the byte cap is hit", async () => {
    const { db, pg, inserts } = fakeDeps();
    const sink = new AgentLogSink(db, pg, "run-2", {
      flushIntervalMs: 60_000,
      maxFlushBytes: 100,
    });
    sink.push("stdout", "x".repeat(60));
    sink.push("stderr", "y".repeat(60)); // crosses the 100-byte cap → flush
    await sink.flushNow();
    assert.equal(inserts.length, 1);
    assert.equal((inserts[0] as { stream: string }[])[1]!.stream, "stderr");
    await sink.close();
  });

  it("flushes on the timer when the buffer is non-empty", async () => {
    const { db, pg, inserts } = fakeDeps();
    const sink = new AgentLogSink(db, pg, "run-3", { flushIntervalMs: 15 });
    sink.push("stdout", "tick");
    await sleep(60);
    assert.equal(inserts.length, 1, "timer-driven flush ran without close()");
    await sink.close();
  });

  it("serializes flushes — at most one insert in flight per run", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const inserts: unknown[][] = [];
    const db = {
      insert: () => ({
        values: async (rows: unknown[]) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await sleep(20);
          inFlight--;
          inserts.push(rows);
          return rows;
        },
      }),
    } as unknown as Db;
    const pg = { notify: () => Promise.resolve() } as unknown as Sql;
    const sink = new AgentLogSink(db, pg, "run-4", { flushIntervalMs: 60_000 });

    // Three overlapping flush requests must queue, not overlap. Each push is
    // separated by a microtask tick so the prior drain has already claimed its
    // rows — otherwise synchronous pushes correctly coalesce into one batch.
    sink.push("stdout", "a");
    const p1 = sink.flushNow();
    await Promise.resolve(); // drain #1 claims [a] and sleeps
    sink.push("stdout", "b");
    const p2 = sink.flushNow();
    await Promise.resolve();
    sink.push("stdout", "c");
    const p3 = sink.flushNow();
    await Promise.all([p1, p2, p3]);
    await sink.close();
    assert.equal(maxInFlight, 1, "flushes must never overlap");
    assert.equal(
      inserts.flat().length,
      3,
      "all chunks persisted across serialized flushes",
    );
  });

  it("a failed flush logs, drops the batch, and does not poison later flushes", async () => {
    const origError = console.error;
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const { db, pg, inserts } = fakeDeps({ failInsert: true });
      const sink = new AgentLogSink(db, pg, "run-5", { flushIntervalMs: 60_000 });
      sink.push("stdout", "lost");
      await sink.flushNow();
      assert.equal(inserts.length, 0);
      assert.equal(errors.length, 1, "flush failure was logged");
    } finally {
      console.error = origError;
    }
  });

  it("drops chunks pushed after close()", async () => {
    const { db, pg, inserts } = fakeDeps();
    const sink = new AgentLogSink(db, pg, "run-6", { flushIntervalMs: 60_000 });
    sink.push("stdout", "kept");
    await sink.close();
    sink.push("stdout", "late");
    await sink.flushNow();
    assert.equal(inserts.length, 1);
    assert.equal((inserts[0] as { chunk: string }[])[0]!.chunk, "kept");
  });
});
