import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviewBodyForPublication } from "../reviewBody.js";

describe("reviewBodyForPublication", () => {
  it("drops narration before the final structured review", () => {
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
      reviewBodyForPublication(body),
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
    assert.equal(reviewBodyForPublication(body), body);
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
      reviewBodyForPublication(body),
      [
        "verdict: request_changes",
        "One blocking issue remains.",
        "verdict: comment",
        "is the marker used for non-blocking feedback.",
      ].join("\n\n"),
    );
  });

  it("keeps a verdict-first review body unchanged", () => {
    const body = "verdict: approve\n\nShip it.";
    assert.equal(reviewBodyForPublication(body), body);
  });

  it("drops narration before the verdict — the PR #322 leak", () => {
    // The agent sent working narration on the same channel as the answer,
    // so its review body began with eleven paragraphs of "Let me check X…"
    // (review 5256477256).
    const body = [
      "All checks complete. The delta is verified end-to-end.",
      "",
      "verdict: approve",
      "",
      "**Re-review: no blocking issues.**",
      "",
      "### Prior review items",
      "- All resolved.",
    ].join("\n");
    assert.equal(
      reviewBodyForPublication(body),
      "verdict: approve\n\n**Re-review: no blocking issues.**\n\n### Prior review items\n- All resolved.",
    );
  });

  it("keeps the body when the verdict arrives last", () => {
    // Contract violation, but the content before the verdict is the real
    // review — slicing at the verdict would post an empty body. Keep the
    // whole thing and let parseReviewVerdict strip the marker.
    const body = "### Findings\n- Looks good.\n\nverdict: approve";
    assert.equal(reviewBodyForPublication(body), body);
  });

  it("keeps the body verbatim when no verdict line exists", () => {
    const body = "Nothing to flag; the change is small and mechanical.";
    assert.equal(reviewBodyForPublication(body), body);
  });

  it("anchors on the structured skeleton when narration precedes a verdict-less review", () => {
    // Synthesizer shape (PR #322 review 5238353647): it streams
    // "Now let me verify X…" narration and finishes with the
    // ## Summary/## Findings contract — no standalone verdict line. The
    // skeleton is the review; everything before it is narration.
    const body = [
      "Now let me verify the ReplaceGroup ordering.",
      "",
      "## Summary",
      "Both upstream reviews approve.",
      "",
      "## Findings",
      "None blocking.",
    ].join("\n");
    assert.equal(
      reviewBodyForPublication(body),
      "## Summary\nBoth upstream reviews approve.\n\n## Findings\nNone blocking.",
    );
  });

  it("anchors a verdict-bearing body on the structured skeleton too", () => {
    const body = [
      "verdict: approve",
      "",
      "Everything checks out, posting now.",
      "",
      "## Summary",
      "The change is sound.",
      "",
      "## Findings",
      "None.",
    ].join("\n");
    assert.equal(
      reviewBodyForPublication(body),
      "verdict: approve\n\n## Summary\nThe change is sound.\n\n## Findings\nNone.",
    );
  });
});
