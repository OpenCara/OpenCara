import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { effectivePoolShape } from "../agentPool.js";
import {
  AgentPoolExhaustedError,
  clampConcurrency,
  clampQuorum,
  clampRetrySame,
  classifyAttemptError,
  orderPoolCandidates,
  runWithAgentPool,
} from "../agentPool.js";
import { AgentUnusableError, FlowConfigError, SkipFlowError } from "../errors.js";

describe("orderPoolCandidates", () => {
  it("pinned runs first, then primary, then fallbacks in order", () => {
    assert.deepEqual(
      orderPoolCandidates({ pinned: "p", primary: "a", fallbacks: ["b", "c"] }),
      ["p", "a", "b", "c"],
    );
  });

  it("collapses duplicates onto their first position", () => {
    assert.deepEqual(
      orderPoolCandidates({ pinned: "b", primary: "a", fallbacks: ["b", "a", "c"] }),
      ["b", "a", "c"],
    );
  });

  it("tolerates missing tiers", () => {
    assert.deepEqual(orderPoolCandidates({ pinned: null, primary: null, fallbacks: null }), []);
    assert.deepEqual(orderPoolCandidates({ pinned: null, primary: null, fallbacks: ["x"] }), ["x"]);
  });
});

describe("clampRetrySame", () => {
  it("clamps into [0, 5] and truncates", () => {
    assert.equal(clampRetrySame(-3), 0);
    assert.equal(clampRetrySame(2.9), 2);
    assert.equal(clampRetrySame(99), 5);
    assert.equal(clampRetrySame("2"), 2);
    assert.equal(clampRetrySame(undefined), 0);
    assert.equal(clampRetrySame(NaN), 0);
  });
});

describe("clampConcurrency / clampQuorum", () => {
  it("clamps into [1, 8]", () => {
    assert.equal(clampConcurrency(0), 1);
    assert.equal(clampConcurrency(3), 3);
    assert.equal(clampConcurrency(99), 8);
    assert.equal(clampConcurrency(undefined), 1);
    assert.equal(clampQuorum(-1), 1);
    assert.equal(clampQuorum(2.7), 2);
  });
});

describe("classifyAttemptError", () => {
  it("maps marker errors to dispositions", () => {
    assert.equal(classifyAttemptError(new SkipFlowError("max iterations")), "abort");
    assert.equal(classifyAttemptError(new FlowConfigError("bad template")), "abort");
    assert.equal(classifyAttemptError(new AgentUnusableError("kind not eligible")), "next");
    assert.equal(classifyAttemptError(new Error("agent exited with code 1")), "retry");
    assert.equal(classifyAttemptError("string"), "retry");
  });
});

describe("runWithAgentPool (concurrency 1: priority failover)", () => {
  const seq = (results: Array<"ok" | Error>) => {
    const calls: Array<{ c: string; attempt: number; retryIndex: number }> = [];
    let i = 0;
    const attempt = async (c: string, info: { attempt: number; retryIndex: number }) => {
      calls.push({ c, attempt: info.attempt, retryIndex: info.retryIndex });
      const r = results[i++];
      if (r instanceof Error) throw r;
      return `${c}:done`;
    };
    return { calls, attempt };
  };

  it("returns the first success without touching later candidates", async () => {
    const { calls, attempt } = seq(["ok"]);
    const r = await runWithAgentPool({ candidates: ["a", "b"], retrySame: 2, attempt });
    assert.equal(r.successes.length, 1);
    assert.equal(r.successes[0]!.value, "a:done");
    assert.deepEqual(r.failures, []);
    assert.equal(calls.length, 1);
    assert.equal(r.target, 1);
    assert.equal(r.quorum, 1);
  });

  it("retries the same candidate retrySame times before moving on", async () => {
    const { calls, attempt } = seq([new Error("e1"), new Error("e2"), "ok"]);
    const r = await runWithAgentPool({ candidates: ["a", "b"], retrySame: 1, attempt });
    assert.equal(r.successes[0]!.value, "b:done");
    assert.deepEqual(
      calls.map((x) => [x.c, x.attempt, x.retryIndex]),
      [
        ["a", 0, 0],
        ["a", 1, 1],
        ["b", 2, 0],
      ],
    );
    assert.equal(r.failures.length, 2);
    assert.equal(r.failures[1]!.disposition, "retry");
  });

  it("retrySame 0 goes straight to the next candidate", async () => {
    const { calls, attempt } = seq([new Error("e1"), "ok"]);
    const r = await runWithAgentPool({ candidates: ["a", "b"], retrySame: 0, attempt });
    assert.equal(r.successes[0]!.value, "b:done");
    assert.deepEqual(calls.map((x) => x.c), ["a", "b"]);
  });

  it("an unusable agent skips its remaining retries", async () => {
    const { calls, attempt } = seq([new AgentUnusableError("nope"), "ok"]);
    const r = await runWithAgentPool({ candidates: ["a", "b"], retrySame: 3, attempt });
    assert.equal(r.successes[0]!.value, "b:done");
    assert.deepEqual(calls.map((x) => x.c), ["a", "b"]);
    assert.equal(r.failures[0]!.disposition, "next");
  });

  it("abort errors propagate untouched and stop the pool", async () => {
    const skip = new SkipFlowError("maxIterations reached");
    const { calls, attempt } = seq([skip]);
    await assert.rejects(
      runWithAgentPool({ candidates: ["a", "b"], retrySame: 3, attempt }),
      (err) => err === skip,
    );
    assert.equal(calls.length, 1);
  });

  it("throws AgentPoolExhaustedError with the trail once every candidate is spent", async () => {
    const { attempt } = seq([new Error("boom-a"), new Error("boom-b1"), new Error("boom-b2")]);
    await assert.rejects(
      runWithAgentPool({
        candidates: ["a", "b"],
        retrySame: 1,
        attempt,
        classify: (e) => ((e as Error).message === "boom-a" ? "next" : "retry"),
      }),
      (err: unknown) => {
        assert.ok(err instanceof AgentPoolExhaustedError);
        assert.equal(err.attempts.length, 3);
        assert.match(err.message, /0\/1 needed succeeded after 3 failed attempts/);
        assert.match(err.message, /last: boom-b2/);
        assert.match(err.message, /a#1: boom-a; b#1: boom-b1; b#2: boom-b2/);
        return true;
      },
    );
  });

  it("a single failed attempt surfaces the bare error message (no pool noise)", async () => {
    const { attempt } = seq([new Error("agent exited with code 1")]);
    await assert.rejects(
      runWithAgentPool({ candidates: ["a"], retrySame: 0, attempt }),
      (err: unknown) => {
        assert.ok(err instanceof AgentPoolExhaustedError);
        assert.equal(err.message, "agent exited with code 1");
        return true;
      },
    );
  });

  it("empty candidate list fails immediately", async () => {
    await assert.rejects(
      runWithAgentPool({ candidates: [] as string[], retrySame: 0, attempt: async () => "x" }),
      /no candidates/,
    );
  });
});

describe("runWithAgentPool (concurrency > 1: parallel slots + quorum)", () => {
  /**
   * Deterministic async harness: each attempt is a deferred the test settles
   * by hand, so start order and completion order are both under control.
   */
  const harness = () => {
    const started: Array<{ c: string; info: { attempt: number; candidateIndex: number; retryIndex: number } }> = [];
    const deferred = new Map<string, { resolve: (v: string) => void; reject: (e: unknown) => void }>();
    const attempt = (c: string, info: { attempt: number; candidateIndex: number; retryIndex: number }) =>
      new Promise<string>((resolve, reject) => {
        started.push({ c, info });
        deferred.set(`${c}#${info.retryIndex}`, { resolve, reject });
      });
    const tick = () => new Promise((r) => setImmediate(r));
    const ok = async (key: string) => {
      deferred.get(key)!.resolve(`${key}:done`);
      await tick();
    };
    const fail = async (key: string, err: unknown = new Error(`${key} failed`)) => {
      deferred.get(key)!.reject(err);
      await tick();
    };
    return { started, attempt, ok, fail, tick };
  };

  it("starts `concurrency` candidates at once and waits for all of them", async () => {
    const h = harness();
    const run = runWithAgentPool({
      candidates: ["a", "b", "c", "d"],
      retrySame: 0,
      concurrency: 3,
      quorum: 1,
      attempt: h.attempt,
    });
    await h.tick();
    assert.deepEqual(h.started.map((s) => s.c), ["a", "b", "c"]);
    await h.ok("a#0");
    // quorum reached but b, c still running — the pool waits, starts nothing new.
    assert.equal(h.started.length, 3);
    await h.ok("c#0");
    await h.ok("b#0");
    const r = await run;
    assert.deepEqual(r.successes.map((s) => s.value), ["a#0:done", "c#0:done", "b#0:done"]);
    assert.equal(r.target, 3);
    assert.equal(r.quorum, 1);
  });

  it("refills a failed slot from the next candidate, retries first", async () => {
    const h = harness();
    const run = runWithAgentPool({
      candidates: ["a", "b", "c", "d"],
      retrySame: 1,
      concurrency: 2,
      quorum: 2,
      attempt: h.attempt,
    });
    await h.tick();
    assert.deepEqual(h.started.map((s) => s.c), ["a", "b"]);
    await h.fail("b#0");
    // retry of b comes before c
    assert.deepEqual(h.started.map((s) => `${s.c}#${s.info.retryIndex}`), ["a#0", "b#0", "b#1"]);
    await h.fail("b#1");
    assert.deepEqual(h.started.map((s) => s.c), ["a", "b", "b", "c"]);
    await h.ok("c#0");
    await h.ok("a#0");
    const r = await run;
    assert.deepEqual(r.successes.map((s) => s.candidate), ["c", "a"]);
    assert.equal(r.failures.length, 2);
    // d never needed
    assert.ok(!h.started.some((s) => s.c === "d"));
  });

  it("succeeds below target but at/above quorum once the list is spent", async () => {
    const h = harness();
    const run = runWithAgentPool({
      candidates: ["a", "b", "c"],
      retrySame: 0,
      concurrency: 3,
      quorum: 1,
      attempt: h.attempt,
    });
    await h.tick();
    await h.fail("a#0");
    await h.fail("c#0");
    await h.ok("b#0");
    const r = await run;
    assert.equal(r.successes.length, 1);
    assert.equal(r.successes[0]!.candidate, "b");
    assert.equal(r.failures.length, 2);
  });

  it("fails when successes end below quorum, reporting the tally", async () => {
    const h = harness();
    const run = runWithAgentPool({
      candidates: ["a", "b", "c"],
      retrySame: 0,
      concurrency: 3,
      quorum: 2,
      attempt: h.attempt,
    });
    // Mark handled up front: the rejection lands during the ticks below,
    // before assert.rejects gets to attach its own handler.
    run.catch(() => undefined);
    await h.tick();
    await h.ok("a#0");
    await h.fail("b#0");
    await h.fail("c#0");
    await assert.rejects(run, (err: unknown) => {
      assert.ok(err instanceof AgentPoolExhaustedError);
      assert.equal(err.successes, 1);
      assert.equal(err.quorum, 2);
      assert.match(err.message, /1\/2 needed succeeded after 2 failed attempts/);
      return true;
    });
  });

  it("clamps target to the candidate count and quorum to the target", async () => {
    const h = harness();
    const run = runWithAgentPool({
      candidates: ["a", "b"],
      retrySame: 0,
      concurrency: 5,
      quorum: 4,
      attempt: h.attempt,
    });
    await h.tick();
    assert.equal(h.started.length, 2);
    await h.ok("a#0");
    await h.ok("b#0");
    const r = await run;
    assert.equal(r.target, 2);
    assert.equal(r.quorum, 2);
  });

  it("preferred below the slot count stops refilling once it is met", async () => {
    const h = harness();
    const run = runWithAgentPool({
      candidates: ["a", "b", "c", "d"],
      retrySame: 0,
      concurrency: 3,
      preferred: 2,
      quorum: 2,
      attempt: h.attempt,
    });
    await h.tick();
    // Only 2 slots are worth filling — the third would produce a success
    // nobody asked for.
    assert.deepEqual(h.started.map((s) => s.c), ["a", "b"]);
    await h.ok("a#0");
    await h.ok("b#0");
    const r = await run;
    assert.equal(r.target, 2);
    assert.equal(r.concurrency, 2);
    assert.equal(r.successes.length, 2);
  });

  it("preferred above the slot count runs the pool in waves", async () => {
    const h = harness();
    const run = runWithAgentPool({
      candidates: ["a", "b", "c", "d"],
      retrySame: 0,
      concurrency: 2,
      preferred: 3,
      quorum: 2,
      attempt: h.attempt,
    });
    await h.tick();
    assert.deepEqual(h.started.map((s) => s.c), ["a", "b"]);
    await h.ok("a#0");
    // A success frees a slot and the target is still 3 away — c joins b.
    assert.deepEqual(h.started.map((s) => s.c), ["a", "b", "c"]);
    await h.ok("b#0");
    await h.ok("c#0");
    const r = await run;
    assert.equal(r.target, 3);
    assert.equal(r.concurrency, 2);
    assert.equal(r.successes.length, 3);
    // Three succeeded == preferred, so d is never touched.
    assert.ok(!h.started.some((s) => s.c === "d"));
  });

  it("3 parallel / 3 preferred / 2 minimum delivers when one reviewer dies", async () => {
    const h = harness();
    const run = runWithAgentPool({
      candidates: ["a", "b", "c"],
      retrySame: 0,
      concurrency: 3,
      preferred: 3,
      quorum: 2,
      attempt: h.attempt,
    });
    await h.tick();
    assert.deepEqual(h.started.map((s) => s.c), ["a", "b", "c"]);
    await h.ok("a#0");
    await h.fail("b#0");
    await h.ok("c#0");
    const r = await run;
    assert.deepEqual(r.successes.map((s) => s.candidate), ["a", "c"]);
    assert.equal(r.failures.length, 1);
    assert.equal(r.quorum, 2);
  });

  it("chases preferred past a failure while candidates remain, delivers at quorum", async () => {
    const h = harness();
    const run = runWithAgentPool({
      candidates: ["a", "b", "c", "d"],
      retrySame: 0,
      concurrency: 3,
      preferred: 3,
      quorum: 2,
      attempt: h.attempt,
    });
    // Mark handled up front: the rejection lands during the ticks below.
    run.catch(() => undefined);
    await h.tick();
    await h.fail("b#0");
    // Still short of 3 successes with d unstarted: the pool refills.
    assert.deepEqual(h.started.map((s) => s.c), ["a", "b", "c", "d"]);
    await h.ok("a#0");
    await h.fail("c#0");
    await h.fail("d#0");
    // List spent at 1 success, below the minimum of 2.
    await assert.rejects(run, (err: unknown) => {
      assert.ok(err instanceof AgentPoolExhaustedError);
      assert.equal(err.successes, 1);
      assert.equal(err.quorum, 2);
      return true;
    });
  });

  it("an abort while others are in flight rejects immediately", async () => {
    const h = harness();
    const skip = new SkipFlowError("max iterations");
    const run = runWithAgentPool({
      candidates: ["a", "b"],
      retrySame: 0,
      concurrency: 2,
      attempt: h.attempt,
    });
    // Mark handled up front: the rejection lands during the ticks below,
    // before assert.rejects gets to attach its own handler.
    run.catch(() => undefined);
    await h.tick();
    await h.fail("a#0", skip);
    await assert.rejects(run, (err) => err === skip);
    // b settles later without an unhandled rejection
    await h.fail("b#0");
  });
});

describe("effectivePoolShape", () => {
  it("keeps a satisfiable shape untouched (worktree nodes get one checkout per slot)", () => {
    assert.deepEqual(
      effectivePoolShape({ concurrency: 2, quorum: 2, candidateCount: 5 }),
      { concurrency: 2, preferred: 2, quorum: 2, quorumCapped: false },
    );
  });

  it("an unset preferred follows concurrency (pre-`preferred` pools are unchanged)", () => {
    assert.deepEqual(
      effectivePoolShape({ concurrency: 3, preferred: null, quorum: 2, candidateCount: 5 }),
      { concurrency: 3, preferred: 3, quorum: 2, quorumCapped: false },
    );
  });

  it("preferred above concurrency runs the pool in waves", () => {
    assert.deepEqual(
      effectivePoolShape({ concurrency: 2, preferred: 3, quorum: 2, candidateCount: 5 }),
      { concurrency: 2, preferred: 3, quorum: 2, quorumCapped: false },
    );
  });

  it("caps slots down to preferred — a slot past the target is never filled", () => {
    assert.deepEqual(
      effectivePoolShape({ concurrency: 5, preferred: 2, quorum: 2, candidateCount: 5 }),
      { concurrency: 2, preferred: 2, quorum: 2, quorumCapped: false },
    );
  });

  it("caps both to the candidate count and quorum to preferred", () => {
    assert.deepEqual(
      effectivePoolShape({ concurrency: 3, quorum: 3, candidateCount: 2 }),
      { concurrency: 2, preferred: 2, quorum: 2, quorumCapped: true },
    );
    assert.deepEqual(
      effectivePoolShape({ concurrency: 1, quorum: 3, candidateCount: 4 }),
      { concurrency: 1, preferred: 1, quorum: 1, quorumCapped: true },
    );
    // Waves: 2 slots but 3 wanted, so a quorum of 3 is satisfiable after all.
    assert.deepEqual(
      effectivePoolShape({ concurrency: 2, preferred: 3, quorum: 3, candidateCount: 4 }),
      { concurrency: 2, preferred: 3, quorum: 3, quorumCapped: false },
    );
  });

  it("clamps garbage settings to the defaults", () => {
    assert.deepEqual(
      effectivePoolShape({ concurrency: "x", quorum: -4, candidateCount: 1 }),
      { concurrency: 1, preferred: 1, quorum: 1, quorumCapped: false },
    );
    assert.deepEqual(
      effectivePoolShape({ concurrency: 2, preferred: "nope", quorum: 1, candidateCount: 4 }),
      { concurrency: 2, preferred: 2, quorum: 1, quorumCapped: false },
    );
  });
});
