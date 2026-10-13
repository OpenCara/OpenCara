import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractAgentResultText } from "../output.js";
import { stripAgentMarkers } from "@opencara/shared";

describe("extractAgentResultText", () => {
  it("returns plain markdown verbatim", () => {
    const raw = "## Plain markdown review\n\nLooks good to me.";
    assert.equal(extractAgentResultText(raw), raw);
  });

  it("returns empty string for empty input", () => {
    assert.equal(extractAgentResultText(""), "");
    assert.equal(extractAgentResultText("   "), "");
  });

  it("is idempotent on already-extracted text (safe to apply twice)", () => {
    // engine.ts extracts before storing in `outputs`; nodeRunners.ts's
    // actionRunner also extracts before posting to GitHub. Both layers
    // calling extract is fine — plain markdown falls through verbatim.
    const clean = "## Verdict\n\nCOMMENT\n\nLooks good.";
    assert.equal(extractAgentResultText(clean), clean);
    assert.equal(extractAgentResultText(extractAgentResultText(clean)), clean);
  });
});

describe("stripAgentMarkers", () => {
  it("removes a [think] block including both fences", () => {
    const raw = "Before.\n[think]\nreasoning the user must not see\n[/think]\nAfter.";
    assert.equal(stripAgentMarkers(raw), "Before.\nAfter.");
  });

  it("removes both [tool] line shapes the runner emits", () => {
    const raw = [
      "verdict: comment",
      "[tool] Read File",
      "[tool] Read /abs/path.md \u2192 completed",
      "[tool] grep \u2192 failed",
      "The diff looks fine.",
    ].join("\n");
    assert.equal(stripAgentMarkers(raw), "verdict: comment\nThe diff looks fine.");
  });

  it("leaves a bracketed word mid-line alone (only whole marker lines go)", () => {
    const raw = "We should log [tool] usage counts per run.";
    assert.equal(stripAgentMarkers(raw), raw);
  });

  it("leaves an unterminated [think] alone rather than eating the answer", () => {
    // A cancelled run can emit an opener with no closer. Dropping to
    // end-of-string there would delete a real reply.
    const raw = "[think]\nhalf a thought";
    assert.equal(stripAgentMarkers(raw), raw.trim());
  });

  it("collapses the blank-line craters the stripping leaves behind", () => {
    const raw = "A\n\n[tool] Read File\n\n[tool] Read File \u2192 completed\n\nB";
    assert.equal(stripAgentMarkers(raw), "A\n\nB");
  });

  it("is a no-op on output that carries no markers", () => {
    const raw = "verdict: approve\n\nNothing to flag.";
    assert.equal(stripAgentMarkers(raw), raw);
  });
});

describe("extractAgentResultText — marker stripping", () => {
  it("strips the markers a real posted review carried to GitHub", () => {
    // Shape taken verbatim from flow_run_step 01M1EJVTTSPJDS1FMGA9C4Z5A6,
    // whose review body reached GitHub with these lines above the verdict.
    // The narration paragraph before the tool calls is now dropped too —
    // it's a message run, not part of the answer.
    const raw = [
      "I'll inspect the PR diff and the changed files first.",
      "",
      "[tool] Read File",
      "",
      "[tool] Read File \u2192 completed",
      "",
      "[tool] Read /home/quabug/.cursor/skills/autopilot/SKILL.md \u2192 completed",
      "",
      "verdict: comment",
      "",
      "The change looks correct.",
    ].join("\n");
    const out = extractAgentResultText(raw);
    assert.equal(out.includes("[tool]"), false);
    assert.equal(out, "verdict: comment\n\nThe change looks correct.");
  });
});

describe("extractAgentResultText — narration segments", () => {
  it("keeps only the final message run — the review that posted narration", () => {
    // Shape from agent_run 01M2X7YS19RHDX1T8S8ES5QDNS, whose review
    // (ParadiseEngine#322 review 5256477256) shipped eleven paragraphs of
    // "Let me check X" narration above the verdict because the agent sent
    // working narration on the answer's channel.
    const raw = [
      "[think]",
      "I need to re-review PR 322.",
      "[/think]",
      "I'll start by gathering the PR's review history and diff.",
      "[tool] Ran git \u2192 completed",
      "",
      "[think]",
      "The checkout is at the PR head.",
      "[/think]",
      "Now let me fetch the previous review comments.",
      "[tool] Ran gh \u2192 completed",
      "",
      "All checks complete. The delta is verified end-to-end.",
      "",
      "verdict: approve",
      "",
      "**Re-review: no blocking issues.**",
    ].join("\n");
    assert.equal(
      extractAgentResultText(raw),
      "All checks complete. The delta is verified end-to-end.\n\nverdict: approve\n\n**Re-review: no blocking issues.**",
    );
  });

  it("keeps the verdict-bearing segment when a sign-off follows the answer", () => {
    // If the agent emits a trailing tool call + "Done!" after its review,
    // the last segment is the sign-off — taking it alone would hand
    // post_review a stub it must refuse. The verdict's segment (and
    // anything after it) is the answer.
    const raw = [
      "The review.",
      "",
      "verdict: approve",
      "",
      "Looks good.",
      "[tool] git status \u2192 completed",
      "Done!",
    ].join("\n");
    assert.equal(
      extractAgentResultText(raw),
      "The review.\n\nverdict: approve\n\nLooks good.\n\nDone!",
    );
  });

  it("keeps the whole stripped stream when no verdict line exists", () => {
    // Synthesizer shape: narration between tool calls, then the
    // structured review with no verdict line. extract can't tell
    // narration from content without guessing, and non-review consumers
    // (add_comment, fan-in) need the full stream — the review layer's
    // ## Summary anchor drops the narration when this is posted.
    const raw = [
      "[think]",
      "Let me extract the findings.",
      "[/think]",
      "Now let me verify the ordering:",
      "[tool] git diff \u2192 completed",
      "",
      "## Summary",
      "Both upstream reviews approve.",
      "",
      "## Findings",
      "None blocking.",
    ].join("\n");
    assert.equal(
      extractAgentResultText(raw),
      "Now let me verify the ordering:\n\n## Summary\nBoth upstream reviews approve.\n\n## Findings\nNone blocking.",
    );
  });

  it("does not anchor on a quoted or non-contract verdict mention", () => {
    // "verdict: pending further inspection" isn't a contract token — the
    // segment scan must not start the answer there.
    const raw = [
      "verdict: pending further inspection",
      "[tool] git diff → completed",
      "verdict: approve",
      "Ship it.",
    ].join("\n");
    assert.equal(extractAgentResultText(raw), "verdict: approve\nShip it.");
  });

  it("excludes a trailing unterminated [think] from the answer", () => {
    const raw = "verdict: approve\n\nLooks good.\n[think]\ndangling thought";
    assert.equal(extractAgentResultText(raw), "verdict: approve\n\nLooks good.");
  });

  it("keeps a lone unterminated [think] rather than returning nothing", () => {
    const raw = "[think]\nhalf a thought";
    assert.equal(extractAgentResultText(raw), raw);
  });

  it("falls back to the full text when the stream ends on a tool call", () => {
    const raw = "Working on it.\n[tool] Read File";
    assert.equal(extractAgentResultText(raw), "Working on it.");
  });
});
