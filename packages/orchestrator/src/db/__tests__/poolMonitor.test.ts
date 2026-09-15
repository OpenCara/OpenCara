import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { poolMonitorMessage, startPoolMonitor } from "../poolMonitor.js";
import type { Sql } from "postgres";

const quiet = { active: 2, idle: 9, idle_in_tx: 0, longest_ms: 40, longest_query: "SELECT 1" };

describe("poolMonitorMessage", () => {
  it("stays silent while the pool is quiet", () => {
    assert.equal(
      poolMonitorMessage(quiet, { warnActiveConns: 8, warnQueryMs: 2_000 }),
      null,
    );
  });

  it("warns when active connections reach the threshold", () => {
    const msg = poolMonitorMessage(
      { ...quiet, active: 9 },
      { warnActiveConns: 8, warnQueryMs: 2_000 },
    );
    assert.ok(msg?.includes("active=9"));
    assert.ok(msg?.includes("[db-pool]"));
  });

  it("warns with the longest-running query when one exceeds the threshold", () => {
    const msg = poolMonitorMessage(
      { ...quiet, longest_ms: 3200, longest_query: "WITH mine AS (...)" },
      { warnActiveConns: 8, warnQueryMs: 2_000 },
    );
    assert.ok(msg?.includes("longest_query_ms=3200"));
    assert.ok(msg?.includes("WITH mine AS"));
  });

  it("treats a null longest-query row as quiet", () => {
    assert.equal(
      poolMonitorMessage(
        { ...quiet, longest_ms: null, longest_query: null },
        { warnActiveConns: 8, warnQueryMs: 2_000 },
      ),
      null,
    );
  });
});

describe("startPoolMonitor", () => {
  it("samples pg_stat_activity and logs only when thresholds trip", async () => {
    const scripted: Record<string, unknown>[] = [
      { ...quiet },
      { ...quiet, active: 10, longest_ms: 5_000, longest_query: "SELECT pg_sleep" },
    ];
    const queries: string[] = [];
    const pg = {
      unsafe: <T>(q: string): Promise<T> => {
        queries.push(q);
        const row = scripted.shift() ?? quiet;
        return Promise.resolve([row] as T);
      },
    } as unknown as Sql;
    const logs: string[] = [];
    const timer = startPoolMonitor(pg, {
      intervalMs: 5,
      log: (m) => logs.push(m),
    });
    try {
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(queries.length >= 2, "sampler ran repeatedly");
      assert.ok(queries[0]!.includes("pg_stat_activity"));
      assert.ok(queries[0]!.includes("application_name"));
      assert.equal(logs.length, 1, "only the saturated sample logged");
      assert.ok(logs[0]!.includes("active=10"));
    } finally {
      if (timer) clearInterval(timer);
    }
  });

  it("returns null when disabled (intervalMs 0)", () => {
    const pg = {} as Sql;
    assert.equal(startPoolMonitor(pg, { intervalMs: 0 }), null);
  });
});
