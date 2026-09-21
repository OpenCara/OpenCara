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

  it("drops devin narration before the verdict — the PR #322 leak", () => {
    // devin sends working narration as agent_message chunks on the same
    // channel as the answer, so its review body began with eleven
    // paragraphs of "Let me check X…" (review 5256477256).
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
      reviewBodyForPublication(body, "devin swe-2"),
      "verdict: approve\n\n**Re-review: no blocking issues.**\n\n### Prior review items\n- All resolved.",
    );
  });

  it("keeps a non-agy body when the verdict arrives last", () => {
    // Contract violation, but the content before the verdict is the real
    // review — slicing at the verdict would post an empty body. Keep the
    // whole thing and let parseReviewVerdict strip the marker.
    const body = "### Findings\n- Looks good.\n\nverdict: approve";
    assert.equal(reviewBodyForPublication(body, "codex mimo-v2.5-pro"), body);
  });

  it("keeps a non-agy body verbatim when no verdict line exists", () => {
    const body = "Nothing to flag; the change is small and mechanical.";
    assert.equal(reviewBodyForPublication(body, "codex mimo-v2.5-pro"), body);
  });

  it("anchors on the structured skeleton when narration precedes a verdict-less review", () => {
    // codex synthesizer shape (PR #322 review 5238353647): it streams
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
      reviewBodyForPublication(body, "codex mimo-v2.5-pro"),
      "## Summary\nBoth upstream reviews approve.\n\n## Findings\nNone blocking.",
    );
  });

  it("recovers an agy structured review that skipped the verdict line", () => {
    // agy narration with no verdict is refused — but a body carrying the
    // full structured skeleton is a real review, not narration.
    const body = "Let me look at the diff.\n\n## Summary\nFine.\n\n## Findings\nNone.";
    assert.equal(
      reviewBodyForPublication(body, "agy gemini-flash"),
      "## Summary\nFine.\n\n## Findings\nNone.",
    );
  });

  it("anchors a non-agy verdict-bearing body on the structured skeleton too", () => {
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
      reviewBodyForPublication(body, "codex mimo-v2.5-pro"),
      "verdict: approve\n\n## Summary\nThe change is sound.\n\n## Findings\nNone.",
    );
  });
});
