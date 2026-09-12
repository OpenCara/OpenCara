import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviewBodyForPublication } from "../reviewBody.js";

describe("reviewBodyForPublication", () => {
  it("drops agy narration before the final structured review", () => {
    const body = [
      "Let me inspect the diff before deciding.",
      "verdict: approve",
      "Now I will verify the data layout.",
      "## Summary",
      "The change is sound.",
      "## Findings",
      "None.",
    ].join("\n\n");
    assert.equal(
      reviewBodyForPublication(body, "agy opus 4.6"),
      "verdict: approve\n\n## Summary\n\nThe change is sound.\n\n## Findings\n\nNone.",
    );
  });

  it("keeps a valid follow-up review format after the verdict", () => {
    const body = [
      "verdict: approve",
      "5 of 6 prior items resolved; 1 remains.",
      "### Prior Review Feedback Status",
      "- Fixed: disposal is idempotent.",
    ].join("\n\n");
    assert.equal(reviewBodyForPublication(body, "agy gemini-flash"), body);
  });

  it("keeps the first standalone verdict when the review later quotes another", () => {
    const body = [
      "Narration before the answer.",
      "verdict: request_changes",
      "One blocking issue remains.",
      "verdict: comment",
      "is the marker used for non-blocking feedback.",
    ].join("\n\n");
    assert.equal(
      reviewBodyForPublication(body, "agy gemini-flash"),
      [
        "verdict: request_changes",
        "One blocking issue remains.",
        "verdict: comment",
        "is the marker used for non-blocking feedback.",
      ].join("\n\n"),
    );
  });

  it("refuses agy output without a verdict instead of publishing narration", () => {
    assert.equal(reviewBodyForPublication("Let me inspect the diff.", "agy gemini-flash"), null);
  });

  it("keeps other agents' review bodies unchanged", () => {
    const body = "verdict: approve\n\nShip it.";
    assert.equal(reviewBodyForPublication(body, "codex"), body);
  });
});
