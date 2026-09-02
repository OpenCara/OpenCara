import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentSpec } from "@opencara/shared";
import { DevicePool, WebSocketDispatcher, type ConnectedDevice } from "../devices.js";

function fakeDb(): any {
  const chain = { set: () => chain, where: () => Promise.resolve() };
  return { update: () => chain };
}

/** WS stand-in that records every frame the pool sends to the device. */
interface SendCapturingWs {
  sent: Array<Record<string, unknown>>;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
}

function fakeWs(): SendCapturingWs {
  return {
    sent: [],
    send(payload) {
      this.sent.push(JSON.parse(payload));
    },
    close() {},
  };
}

function makeDevice(hostId: string, connId: string, ws: SendCapturingWs): ConnectedDevice {
  return {
    agentHostId: hostId,
    connId,
    userId: null,
    isAlive: true,
    ws: ws as never,
    inflight: new Set<string>(),
  };
}

const SPEC: AgentSpec = { kind: "test", command: "true", args: [], env: {} };

function doneFrame(runId: string) {
  return {
    type: "done" as const,
    runId,
    status: "succeeded" as const,
    exitCode: 0,
  } as never;
}

describe("DevicePool.expireJob", () => {
  it("rejects the pending job, clears inflight, and emits a stderr line", async () => {
    const pool = new DevicePool(fakeDb());
    const ws = fakeWs();
    const dev = makeDevice("host", "connA", ws);
    pool.register(dev);
    dev.inflight.add("run-1");

    const logs: Array<{ stream: string; chunk: string }> = [];
    const job = pool.awaitJob(
      "run-1",
      "host",
      "connA",
      (stream, chunk) => logs.push({ stream, chunk }),
      null,
      null,
      null,
    );

    assert.equal(pool.expireJob("run-1", "deadline exceeded"), true);
    await assert.rejects(job, /deadline exceeded/);
    assert.equal(dev.inflight.has("run-1"), false);
    assert.equal(pool.hostForRun("run-1"), null);
    assert.ok(
      logs.some((l) => l.stream === "stderr" && l.chunk.includes("deadline exceeded")),
    );
  });

  it("is a no-op for a run that already settled", () => {
    const pool = new DevicePool(fakeDb());
    assert.equal(pool.expireJob("run-never-dispatched", "too late"), false);
  });
});

describe("WebSocketDispatcher job timeout", () => {
  it("rejects a run that never sends `done` and signals the device to cancel", async () => {
    const pool = new DevicePool(fakeDb());
    const ws = fakeWs();
    pool.register(makeDevice("host", "connA", ws));
    const dispatcher = new WebSocketDispatcher(pool, 20);

    const run = dispatcher.run(SPEC, { runId: "run-hung", onLog: () => {} });
    await assert.rejects(run, /job timeout/);

    const cancels = ws.sent.filter((m) => m["type"] === "cancel");
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0]!["runId"], "run-hung");
    // Pending entry must be gone so a late `done` can't double-settle.
    assert.equal(pool.hostForRun("run-hung"), null);
  });

  it("does not fire after the run completes in time", async () => {
    const pool = new DevicePool(fakeDb());
    const ws = fakeWs();
    pool.register(makeDevice("host", "connA", ws));
    const dispatcher = new WebSocketDispatcher(pool, 30);

    const run = dispatcher.run(SPEC, { runId: "run-fast", onLog: () => {} });
    pool.handleMessage("host", doneFrame("run-fast"));
    const result = await run;
    assert.equal(result.exitCode, 0);

    // Ride past the deadline: no cancel frame may appear for a settled run.
    await delay(50);
    assert.equal(ws.sent.filter((m) => m["type"] === "cancel").length, 0);
  });

  it("honours ctx.timeoutMs=0 as 'no deadline for this run'", async () => {
    const pool = new DevicePool(fakeDb());
    const ws = fakeWs();
    pool.register(makeDevice("host", "connA", ws));
    // Aggressive default that WOULD fire if the per-run override were ignored.
    const dispatcher = new WebSocketDispatcher(pool, 10);

    const run = dispatcher.run(SPEC, {
      runId: "run-exempt",
      onLog: () => {},
      timeoutMs: 0,
    });
    await delay(40);
    // Still pending — no timeout rejection, no cancel frame.
    assert.equal(pool.hostForRun("run-exempt"), "host");
    assert.equal(ws.sent.filter((m) => m["type"] === "cancel").length, 0);
    // Settle so the test leaves no dangling promise.
    pool.handleMessage("host", doneFrame("run-exempt"));
    await run;
  });
});
