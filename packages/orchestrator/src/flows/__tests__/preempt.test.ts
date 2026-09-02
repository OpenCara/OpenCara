import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { preemptionReason, reviewPreemptionFor } from "../preempt.js";

describe("reviewPreemptionFor", () => {
  it("closed + merged → merged", () => {
    assert.deepEqual(
      reviewPreemptionFor({ type: "pull_request", payload: { action: "closed", pull_request: { number: 7, merged: true } } }),
      { kind: "merged", prNumber: 7 },
    );
  });

  it("closed without merge → closed", () => {
    assert.deepEqual(
      reviewPreemptionFor({ type: "pull_request", payload: { action: "closed", pull_request: { number: 7, merged: false } } }),
      { kind: "closed", prNumber: 7 },
    );
  });

  it("labeled carries the label name", () => {
    assert.deepEqual(
      reviewPreemptionFor({
        type: "pull_request",
        payload: { action: "labeled", pull_request: { number: 9 }, label: { name: "no-review" } },
      }),
      { kind: "labeled", prNumber: 9, label: "no-review" },
    );
  });

  it("ignores other actions, other event types, and payloads without a PR number", () => {
    assert.equal(reviewPreemptionFor({ type: "pull_request", payload: { action: "synchronize", pull_request: { number: 1 } } }), null);
    assert.equal(reviewPreemptionFor({ type: "issue_comment", payload: { action: "created", issue: { number: 1 } } }), null);
    assert.equal(reviewPreemptionFor({ type: "pull_request", payload: { action: "closed" } }), null);
  });
});

describe("preemptionReason", () => {
  it("merged/closed cancel any review run regardless of trigger config", () => {
    assert.match(preemptionReason({ kind: "merged", prNumber: 3 }, {}) ?? "", /merged while the review was running/);
    assert.match(preemptionReason({ kind: "closed", prNumber: 3 }, null) ?? "", /closed while the review was running/);
  });

  it("labeled cancels only when the trigger's labelsIgnore lists that label", () => {
    const p = { kind: "labeled" as const, prNumber: 3, label: "no-review" };
    assert.match(preemptionReason(p, { labelsIgnore: ["wip", "no-review"] }) ?? "", /labels-ignore 'no-review'/);
    assert.equal(preemptionReason(p, { labelsIgnore: ["wip"] }), null);
    assert.equal(preemptionReason(p, {}), null);
    assert.equal(preemptionReason(p, undefined), null);
  });
});
