import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  issueImplementFlow,
  prReviewFixFlow,
  prReviewFlow,
  prReviewMultiFlow,
} from "@opencara/flows";
import { flowMayMatchEvent } from "../eventMatch.js";

const ALL = [issueImplementFlow, prReviewMultiFlow, prReviewFlow, prReviewFixFlow];
const matching = (event: { type: string; payload: unknown }) =>
  ALL.filter((f) => flowMayMatchEvent(f, event)).map((f) => f.slug);

describe("flowMayMatchEvent routes each event to exactly the stage that can take it", () => {
  it("projects_v2_item → issue-implement only", () => {
    assert.deepEqual(matching({ type: "projects_v2_item", payload: { action: "edited" } }), ["issue-implement"]);
  });

  it("pull_request opened → pr-review-multi only", () => {
    assert.deepEqual(matching({ type: "pull_request", payload: { action: "opened" } }), ["pr-review-multi"]);
  });

  it("pull_request synchronize → pr-review only", () => {
    assert.deepEqual(matching({ type: "pull_request", payload: { action: "synchronize" } }), ["pr-review"]);
  });

  it("pull_request closed/labeled → nothing (pre-emption handles those, no run minted)", () => {
    assert.deepEqual(matching({ type: "pull_request", payload: { action: "closed" } }), []);
    assert.deepEqual(matching({ type: "pull_request", payload: { action: "labeled" } }), []);
  });

  it("pull_request_review → pr-review-fix only", () => {
    assert.deepEqual(matching({ type: "pull_request_review", payload: { action: "submitted" } }), ["pr-review-fix"]);
  });

  const comment = (body: string) => ({
    type: "issue_comment",
    payload: { action: "created", issue: { number: 1, pull_request: {} }, comment: { body } },
  });

  it("'@opencara review' → pr-review only; 'mreview' → pr-review-multi only; 'fix' → pr-review-fix only", () => {
    assert.deepEqual(matching(comment("please @opencara review")), ["pr-review"]);
    assert.deepEqual(matching(comment("@OpenCara mreview now")), ["pr-review-multi"]);
    assert.deepEqual(matching(comment("@opencara fix the tests")), ["pr-review-fix"]);
  });

  it("a comment on a plain issue, an edited comment, or no phrase → nothing", () => {
    assert.deepEqual(
      matching({ type: "issue_comment", payload: { action: "created", issue: { number: 1 }, comment: { body: "@opencara review" } } }),
      [],
    );
    assert.deepEqual(
      matching({ type: "issue_comment", payload: { action: "edited", issue: { number: 1, pull_request: {} }, comment: { body: "@opencara review" } } }),
      [],
    );
    assert.deepEqual(matching(comment("looks good")), []);
  });

  it("a flow without triggers is always a candidate (runner decides)", () => {
    assert.equal(flowMayMatchEvent({ ...prReviewFlow, nodes: prReviewFlow.nodes.filter((n) => n.kind === "agent") }, { type: "push", payload: {} }), true);
  });
});
