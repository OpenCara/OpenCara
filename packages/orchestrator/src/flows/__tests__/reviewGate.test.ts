import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReviewGate, reviewGateKeyFor } from "../reviewGate.js";

const tick = () => new Promise((r) => setImmediate(r));

describe("ReviewGate", () => {
  it("first run acquires; second waits; a third supersedes the second (newest wins)", async () => {
    const gate = new ReviewGate();
    assert.equal(await gate.acquire("k", "r1"), "run");
    let queuedBehind: string | null = null;
    const second = gate.acquire("k", "r2", { onQueued: (ahead) => { queuedBehind = ahead; }, pollMs: 10 });
    await tick();
    assert.equal(queuedBehind, "r1");
    assert.deepEqual(gate.state("k"), { running: "r1", queued: "r2" });
    const third = gate.acquire("k", "r3", { pollMs: 10 });
    await tick();
    assert.equal(await second, "superseded");
    assert.deepEqual(gate.state("k"), { running: "r1", queued: "r3" });
    gate.release("k", "r1");
    // r3 is promoted synchronously on release; its acquire resolves next tick.
    assert.deepEqual(gate.state("k"), { running: "r3", queued: null });
    assert.equal(await third, "run");
  });

  it("a run older than the one in progress is superseded on arrival (grace-delayed trigger)", async () => {
    // r1 was created first (ready_for_review, held by its grace delay); r2
    // (the review comment) reached the gate first and is running. r1 must
    // not queue a second full review behind it.
    const gate = new ReviewGate();
    assert.equal(await gate.acquire("k", "r2"), "run");
    let queued = 0;
    assert.equal(await gate.acquire("k", "r1", { onQueued: () => { queued += 1; } }), "superseded");
    assert.equal(queued, 0);
    assert.deepEqual(gate.state("k"), { running: "r2", queued: null });
  });

  it("a run older than the queued waiter is superseded instead of replacing it", async () => {
    const gate = new ReviewGate();
    assert.equal(await gate.acquire("k", "r1"), "run");
    const third = gate.acquire("k", "r3", { pollMs: 5 });
    await tick();
    assert.equal(await gate.acquire("k", "r2"), "superseded");
    assert.deepEqual(gate.state("k"), { running: "r1", queued: "r3" });
    gate.release("k", "r1");
    assert.equal(await third, "run");
  });

  it("a queued run that gets cancelled leaves the queue", async () => {
    const gate = new ReviewGate();
    assert.equal(await gate.acquire("k", "r1"), "run");
    let cancelled = false;
    const second = gate.acquire("k", "r2", { isCancelled: () => cancelled, pollMs: 5 });
    await tick();
    cancelled = true;
    assert.equal(await second, "cancelled");
    assert.deepEqual(gate.state("k"), { running: "r1", queued: null });
    // the slot is free for a new waiter now
    const third = gate.acquire("k", "r3", { pollMs: 5 });
    await tick();
    assert.deepEqual(gate.state("k"), { running: "r1", queued: "r3" });
    gate.release("k", "r1");
    assert.equal(await third, "run");
    gate.release("k", "r3");
    assert.deepEqual(gate.state("k"), { running: null, queued: null });
  });

  it("a waiter promoted while its cancel check is in flight releases the slot", async () => {
    const gate = new ReviewGate();
    assert.equal(await gate.acquire("k", "r1"), "run");
    let releaseGate!: () => void;
    const pending = new Promise<boolean>((r) => (releaseGate = () => r(true)));
    // isCancelled resolves true only after r1 has released and promoted r2.
    const second = gate.acquire("k", "r2", { isCancelled: () => pending, pollMs: 1 });
    await tick();
    await new Promise((r) => setTimeout(r, 5)); // let the first poll tick start isCancelled
    gate.release("k", "r1");
    assert.deepEqual(gate.state("k"), { running: "r2", queued: null });
    releaseGate();
    assert.equal(await second, "cancelled");
    assert.deepEqual(gate.state("k"), { running: null, queued: null });
    assert.equal(await gate.acquire("k", "r3"), "run");
  });

  it("onResumed fires when a queued run is promoted", async () => {
    const gate = new ReviewGate();
    await gate.acquire("k", "r1");
    let resumed = 0;
    const second = gate.acquire("k", "r2", { onResumed: () => { resumed += 1; }, pollMs: 5 });
    await tick();
    gate.release("k", "r1");
    await second;
    assert.equal(resumed, 1);
  });

  it("a throwing onQueued hook leaves no waiter behind; a throwing onResumed releases the slot", async () => {
    const gate = new ReviewGate();
    await gate.acquire("k", "r1");
    await assert.rejects(
      gate.acquire("k", "r2", { onQueued: () => { throw new Error("db down"); }, pollMs: 5 }),
      /db down/,
    );
    assert.deepEqual(gate.state("k"), { running: "r1", queued: null });
    const third = gate.acquire("k", "r3", { onResumed: () => { throw new Error("db down"); }, pollMs: 5 });
    await tick();
    gate.release("k", "r1");
    await assert.rejects(third, /db down/);
    assert.deepEqual(gate.state("k"), { running: null, queued: null });
  });

  it("keys are independent and release by a non-holder is a no-op", async () => {
    const gate = new ReviewGate();
    assert.equal(await gate.acquire("a", "r1"), "run");
    assert.equal(await gate.acquire("b", "r2"), "run");
    gate.release("a", "r2"); // not the holder
    assert.deepEqual(gate.state("a"), { running: "r1", queued: null });
  });
});

describe("reviewGateKeyFor", () => {
  const def = {
    nodes: [
      { id: "t_pr", kind: "scm.pull_request" },
      { id: "t_rev", kind: "scm.pull_request_review" },
      { id: "a", kind: "agent" },
    ],
  };
  it("keys a run started by a scm.pull_request trigger on project + PR number", () => {
    assert.equal(
      reviewGateKeyFor(def, ["t_pr"], { payload: { pull_request: { number: 12 } } }, "proj"),
      "proj:pr:12",
    );
    assert.equal(
      reviewGateKeyFor(def, ["t_pr"], { payload: { issue: { number: 12, pull_request: {} } } }, "proj"),
      "proj:pr:12",
    );
  });
  it("returns null for non-review runs or events without a PR number", () => {
    assert.equal(reviewGateKeyFor(def, ["t_rev"], { payload: { pull_request: { number: 12 } } }, "proj"), null);
    assert.equal(reviewGateKeyFor(def, ["t_pr"], { payload: { issue: { number: 12 } } }, "proj"), null);
    assert.equal(reviewGateKeyFor(def, [], { payload: {} }, "proj"), null);
  });
});
