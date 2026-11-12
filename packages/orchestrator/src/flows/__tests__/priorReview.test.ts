import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PRIOR_REVIEW_BODY_MAX_CHARS,
  loadPriorReview,
  priorReviewFromStepOutput,
  truncateReviewBody,
} from "../priorReview.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("priorReviewFromStepOutput", () => {
  it("reads a recorded post_review output", () => {
    assert.deepEqual(
      priorReviewFromStepOutput({
        reviewId: 1,
        htmlUrl: "https://github.com/o/r/pull/2#r1",
        prNumber: 2,
        headSha: SHA,
        verdict: "REQUEST_CHANGES",
        reviewBody: "## Summary\n\n1 important",
      }),
      {
        headSha: SHA,
        verdict: "REQUEST_CHANGES",
        body: "## Summary\n\n1 important",
        htmlUrl: "https://github.com/o/r/pull/2#r1",
      },
    );
  });

  it("ignores outputs recorded before headSha was stored", () => {
    assert.equal(priorReviewFromStepOutput({ reviewId: 1, htmlUrl: "u" }), null);
    assert.equal(priorReviewFromStepOutput(null), null);
    assert.equal(priorReviewFromStepOutput("x"), null);
  });

  it("refuses a non-hex sha, since it lands in a git command", () => {
    assert.equal(priorReviewFromStepOutput({ headSha: "HEAD; rm -rf ~" }), null);
    assert.equal(priorReviewFromStepOutput({ headSha: "main" }), null);
  });

  it("drops an unknown verdict and tolerates a missing body", () => {
    const r = priorReviewFromStepOutput({ headSha: SHA, verdict: "LGTM" });
    assert.equal(r?.verdict, null);
    assert.equal(r?.body, "");
    assert.equal(r?.htmlUrl, null);
  });
});

describe("truncateReviewBody", () => {
  it("leaves normal reviews alone and caps huge ones", () => {
    assert.equal(truncateReviewBody("short"), "short");
    const long = truncateReviewBody("x".repeat(PRIOR_REVIEW_BODY_MAX_CHARS + 50));
    assert.ok(long.startsWith("x".repeat(PRIOR_REVIEW_BODY_MAX_CHARS)));
    assert.ok(long.endsWith("(truncated)"));
  });
});

describe("loadPriorReview", () => {
  it("returns the latest recorded review (array result shape)", async () => {
    const db = { execute: async () => [{ output: { headSha: SHA, verdict: "APPROVE" } }] };
    const r = await loadPriorReview(db as never, "p1", 7);
    assert.equal(r?.headSha, SHA);
    assert.equal(r?.verdict, "APPROVE");
  });

  it("reads the { rows } result shape too", async () => {
    const db = { execute: async () => ({ rows: [{ output: { headSha: SHA } }] }) };
    assert.equal((await loadPriorReview(db as never, "p1", 7))?.headSha, SHA);
  });

  it("returns null when there is no earlier review", async () => {
    const db = { execute: async () => [] };
    assert.equal(await loadPriorReview(db as never, "p1", 7), null);
  });

  it("never fails the run: a query error means a first-pass review", async () => {
    const db = {
      execute: async () => {
        throw new Error("db down");
      },
    };
    assert.equal(await loadPriorReview(db as never, "p1", 7), null);
  });
});
