import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseReviewVerdict,
  resolveReviewStateFromBody,
  VERDICT_TO_REVIEW_STATE,
} from "../verdict.js";

describe("parseReviewVerdict", () => {
  it("parses APPROVE from the top and strips the line", () => {
    const result = parseReviewVerdict(
      "verdict: approve\n\n## Summary\nLooks good. Ship it.",
    );
    assert.deepEqual(result, {
      verdict: "APPROVE",
      bodyWithoutVerdict: "## Summary\nLooks good. Ship it.",
    });
  });

  it("parses REQUEST_CHANGES", () => {
    const result = parseReviewVerdict(
      "verdict: request_changes\n\nThe migration is missing a NOT NULL guard.",
    );
    assert.equal(result?.verdict, "REQUEST_CHANGES");
    assert.equal(
      result?.bodyWithoutVerdict,
      "The migration is missing a NOT NULL guard.",
    );
  });

  it("parses COMMENT", () => {
    const result = parseReviewVerdict("verdict: comment\n\nDrive-by note.");
    assert.equal(result?.verdict, "COMMENT");
    assert.equal(result?.bodyWithoutVerdict, "Drive-by note.");
  });

  it("is case-insensitive on the label and the token", () => {
    const result = parseReviewVerdict("Verdict: Approve\n\nbody");
    assert.equal(result?.verdict, "APPROVE");
  });

  it("tolerates trailing whitespace on the verdict line", () => {
    const result = parseReviewVerdict("verdict: approve   \n\nbody");
    assert.equal(result?.verdict, "APPROVE");
    assert.equal(result?.bodyWithoutVerdict, "body");
  });

  it("tolerates leading whitespace on the verdict line", () => {
    // Not really expected from a well-behaved agent, but the parser
    // trims the line before matching so a stray space doesn't trip it.
    const result = parseReviewVerdict("  verdict: comment\n\nbody");
    assert.equal(result?.verdict, "COMMENT");
  });

  it("tolerates CRLF line endings", () => {
    const result = parseReviewVerdict("verdict: approve\r\n\r\nbody");
    assert.equal(result?.verdict, "APPROVE");
    assert.equal(result?.bodyWithoutVerdict, "body");
  });

  it("matches when the verdict is preceded by blank lines (still first non-blank)", () => {
    const result = parseReviewVerdict("\n\nverdict: approve\n\nbody");
    assert.equal(result?.verdict, "APPROVE");
    assert.equal(result?.bodyWithoutVerdict, "body");
  });

  it("finds the verdict line even when preceded by reasoning preamble", () => {
    // Regression: codex synthesizer emits chatter ("Let me independently
    // inspect…") before honoring the verdict contract. The strict-first
    // rule used to demote these to the static fallback (COMMENT) —
    // surfaced on flow_run_id=01KRDJSG99079G72EB0T76B9A3. The parser now
    // scans, but preserves the preamble in the posted body so the
    // operator sees what the agent actually wrote.
    const result = parseReviewVerdict(
      "I reviewed the diff carefully.\n\nverdict: approve\n\nbody",
    );
    assert.equal(result?.verdict, "APPROVE");
    assert.equal(
      result?.bodyWithoutVerdict,
      "I reviewed the diff carefully.\n\n\nbody",
    );
  });

  it("handles the codex-preamble shape from the original repro", () => {
    const input =
      "Let me independently inspect the diff. I have all the context I need.\n\n" +
      "verdict: approve\n\n" +
      "## Summary\n\nClean PR.";
    const result = parseReviewVerdict(input);
    assert.equal(result?.verdict, "APPROVE");
    // Preamble is preserved; only the verdict line itself is removed.
    assert.match(result?.bodyWithoutVerdict ?? "", /Let me independently inspect/);
    assert.match(result?.bodyWithoutVerdict ?? "", /## Summary/);
    assert.doesNotMatch(result?.bodyWithoutVerdict ?? "", /verdict:\s*approve/);
  });

  it("first matching verdict line wins when multiple are present", () => {
    const result = parseReviewVerdict(
      "verdict: approve\n\nNote: not request_changes.\n\nverdict: comment\n",
    );
    assert.equal(result?.verdict, "APPROVE");
  });

  it("returns null for unknown tokens", () => {
    assert.equal(parseReviewVerdict("verdict: maybe\n\nbody"), null);
    assert.equal(parseReviewVerdict("verdict: lgtm\n\nbody"), null);
  });

  it("returns null for the space-separated 'request changes' variant", () => {
    // Canonical token is `request_changes`; the spaced form is not
    // recognized to keep the regex strict.
    assert.equal(parseReviewVerdict("verdict: request changes\n\nbody"), null);
  });

  it("returns null when the colon is missing", () => {
    assert.equal(parseReviewVerdict("verdict approve\n\nbody"), null);
  });

  it("returns null on empty / whitespace-only input", () => {
    assert.equal(parseReviewVerdict(""), null);
    assert.equal(parseReviewVerdict("   "), null);
    assert.equal(parseReviewVerdict("\n\n\n"), null);
  });

  it("returns null when no verdict line is anywhere", () => {
    assert.equal(parseReviewVerdict("## Summary\n\nLooks great!"), null);
  });

  it("handles a body that is just the verdict line (no following content)", () => {
    const result = parseReviewVerdict("verdict: approve");
    assert.deepEqual(result, {
      verdict: "APPROVE",
      bodyWithoutVerdict: "",
    });
  });

  it("trims trailing blank lines from the stripped body", () => {
    const result = parseReviewVerdict(
      "verdict: comment\n\n\n\n## Notes\nfoo\n\n",
    );
    assert.equal(result?.bodyWithoutVerdict, "## Notes\nfoo");
  });
});

describe("VERDICT_TO_REVIEW_STATE", () => {
  it("maps each verdict token to the GitHub review.state string", () => {
    assert.equal(VERDICT_TO_REVIEW_STATE.APPROVE, "approved");
    assert.equal(VERDICT_TO_REVIEW_STATE.REQUEST_CHANGES, "changes_requested");
    assert.equal(VERDICT_TO_REVIEW_STATE.COMMENT, "commented");
  });
});

describe("resolveReviewStateFromBody", () => {
  it("returns null when the body carries no verdict line", () => {
    assert.equal(resolveReviewStateFromBody("## Notes\n\nNothing here."), null);
    assert.equal(resolveReviewStateFromBody(""), null);
    assert.equal(resolveReviewStateFromBody(null), null);
    assert.equal(resolveReviewStateFromBody(undefined), null);
  });

  it("recovers the intended state when a downgraded COMMENT review hides a request_changes verdict", () => {
    // Mirrors the body shape post_review writes when it falls back from
    // REQUEST_CHANGES → COMMENT on a self-PR: the verdict line stays in
    // the body so pr-review-fix can still see the intent.
    const body =
      '_Downgraded to "Commented" — GitHub forbids "Request changes" on a PR you opened._\n\n' +
      "verdict: request_changes\n\n" +
      "The migration is missing a NOT NULL guard.";
    const resolved = resolveReviewStateFromBody(body);
    assert.equal(resolved?.state, "changes_requested");
    assert.equal(resolved?.verdict, "REQUEST_CHANGES");
    assert.match(resolved?.body ?? "", /NOT NULL guard/);
    assert.doesNotMatch(resolved?.body ?? "", /verdict:\s*request_changes/);
  });

  it("strips the verdict line from the returned body", () => {
    const resolved = resolveReviewStateFromBody(
      "verdict: approve\n\n## Summary\nShip it.",
    );
    assert.equal(resolved?.state, "approved");
    assert.equal(resolved?.body, "## Summary\nShip it.");
  });
});
