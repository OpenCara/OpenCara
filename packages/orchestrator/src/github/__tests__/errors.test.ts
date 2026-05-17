import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSelfReviewError } from "../errors.js";

const makeErr = (status: number, message: string): Error => {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  return e;
};

describe("isSelfReviewError", () => {
  it("matches the REQUEST_CHANGES self-review phrasing (has 'on your')", () => {
    const err = makeErr(
      422,
      'Validation Failed: "Review Can not request changes on your own pull request" - https://docs.github.com/rest/pulls/reviews',
    );
    assert.equal(isSelfReviewError(err, "REQUEST_CHANGES"), true);
  });

  it("matches the APPROVE self-review phrasing (no 'on', just 'your')", () => {
    // Regression: original regex required `on your` literally and silently
    // skipped the APPROVE downgrade. GitHub omits `on` for approvals.
    const err = makeErr(
      422,
      'Validation Failed: "Review Can not approve your own pull request" - https://docs.github.com/rest/pulls/reviews',
    );
    assert.equal(isSelfReviewError(err, "APPROVE"), true);
  });

  it("matches case-insensitively", () => {
    const err = makeErr(422, "CAN NOT APPROVE YOUR OWN PULL REQUEST");
    assert.equal(isSelfReviewError(err, "APPROVE"), true);
  });

  it("returns false for a 422 with an unrelated message", () => {
    const err = makeErr(422, "Validation Failed: commit_id is stale");
    assert.equal(isSelfReviewError(err, "REQUEST_CHANGES"), false);
  });

  it("returns false for a 403 with the self-review message", () => {
    // Status discriminator: only 422s should downgrade. A 403 on the same
    // endpoint means a permissions problem the operator must see.
    const err = makeErr(403, "Can not approve your own pull request");
    assert.equal(isSelfReviewError(err, "APPROVE"), false);
  });

  it("returns false when event is COMMENT (no GitHub restriction to downgrade past)", () => {
    const err = makeErr(422, "Can not approve your own pull request");
    assert.equal(isSelfReviewError(err, "COMMENT"), false);
  });

  it("returns false when event is unknown / not a review verdict", () => {
    const err = makeErr(422, "Can not approve your own pull request");
    assert.equal(isSelfReviewError(err, ""), false);
    assert.equal(isSelfReviewError(err, "DISMISS"), false);
  });

  it("returns false for null / non-object errors", () => {
    assert.equal(isSelfReviewError(null, "APPROVE"), false);
    assert.equal(isSelfReviewError(undefined, "APPROVE"), false);
    assert.equal(isSelfReviewError("a string", "APPROVE"), false);
  });

  it("returns false when the error has no message field", () => {
    const e = { status: 422 } as unknown;
    assert.equal(isSelfReviewError(e, "REQUEST_CHANGES"), false);
  });
});
