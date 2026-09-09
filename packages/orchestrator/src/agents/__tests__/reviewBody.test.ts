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
      "## Summary\n\nThe change is sound.\n\n## Findings\n\nNone.",
    );
  });

  it("refuses unstructured agy output instead of publishing narration", () => {
    assert.equal(reviewBodyForPublication("Let me inspect the diff.", "agy gemini-flash"), null);
  });

  it("keeps other agents' review bodies unchanged", () => {
    const body = "verdict: approve\n\nShip it.";
    assert.equal(reviewBodyForPublication(body, "codex"), body);
  });
});
