import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseReviewVerdict } from "../verdict.js";

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

  it("returns null when the verdict is preceded by non-blank content (preamble)", () => {
    const result = parseReviewVerdict(
      "I reviewed the diff carefully.\n\nverdict: approve\n\nbody",
    );
    assert.equal(result, null);
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
