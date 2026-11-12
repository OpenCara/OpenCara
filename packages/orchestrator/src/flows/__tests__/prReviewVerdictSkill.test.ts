// Pins the reviewer contract: the verdict line the post-review parser reads,
// plus the review rules from the Claude Code team's code-review write-up
// (severity tags, evidence, count-first summary, nit cap, convergence on
// re-review, a synthesizer that verifies instead of merging).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPrReviewVerdictSkill } from "../skills/prReviewVerdict.js";
import { parseReviewVerdict } from "../../agents/verdict.js";

const base = { baseUrl: "https://opencara.example/", runId: "01TESTRUN000000000000000" };
const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("buildPrReviewVerdictSkill", () => {
  const reviewer = buildPrReviewVerdictSkill(base);

  it("keeps the verdict-line contract and envelope fields", () => {
    assert.equal(reviewer.name, "opencara-pr-review-verdict");
    assert.equal(reviewer.baseUrl, "https://opencara.example");
    assert.equal(reviewer.runId, base.runId);
    assert.match(reviewer.instructions, /`verdict: approve`/);
    assert.match(reviewer.instructions, /`verdict: request_changes`/);
    assert.match(reviewer.instructions, /`verdict: comment`/);
    assert.match(reviewer.instructions, /first non-blank line/);
  });

  it("maps findings to verdicts so nits never cost a fix round", () => {
    assert.match(reviewer.instructions, /`verdict: request_changes`: at least one \[Important\] finding/);
    assert.match(reviewer.instructions, /`verdict: approve`: no \[Important\] finding/);
    assert.match(reviewer.instructions, /only when you could not complete the review/);
  });

  it("asks for tagged, evidenced, deduplicated findings and a count-first summary", () => {
    for (const tag of ["[Important]", "[Nit]", "[Pre-existing]"]) {
      assert.ok(reviewer.instructions.includes(tag), tag);
    }
    assert.match(reviewer.instructions, /`path:line`/);
    assert.match(reviewer.instructions, /report it once as a\s+class and list every location/);
    assert.match(reviewer.instructions, /at most 3 nits/i);
    assert.match(reviewer.instructions, /summary's first line is the count/);
    assert.match(reviewer.instructions, /Nothing to fix\./);
    assert.match(reviewer.instructions, /root cause/);
  });

  it("keeps the example body free of a parseable verdict line", () => {
    // Agents quote the skill; a standalone marker in the example would
    // outrank the agent's real verdict in the parser's first pass.
    const example = reviewer.instructions.split("```")[1] ?? "";
    assert.ok(example.includes("## Findings"));
    assert.equal(parseReviewVerdict(example), null);
  });

  it("gives the reviewer role by default and the synthesizer role on fan-in", () => {
    assert.match(reviewer.instructions, /## What to look for/);
    assert.doesNotMatch(reviewer.instructions, /synthesizer/);
    const synth = buildPrReviewVerdictSkill({ ...base, role: "synthesizer" });
    assert.match(synth.instructions, /## Your role: synthesizer/);
    assert.match(synth.instructions, /at least two reviewers raised it independently/);
    assert.match(synth.instructions, /not from the reviewers'\s+verdicts/);
  });

  it("adds no re-review section on a first review", () => {
    assert.doesNotMatch(reviewer.instructions, /re-review/i);
    assert.doesNotMatch(reviewer.instructions, /OPENCARA_PR_LAST_REVIEWED_SHA/);
  });

  it("scopes a re-review to the delta and forbids repeating posted findings", () => {
    const skill = buildPrReviewVerdictSkill({
      ...base,
      priorReview: { headSha: SHA, verdict: "REQUEST_CHANGES", htmlUrl: "https://x/r/1" },
      hasCheckout: true,
    });
    assert.match(skill.instructions, /## This is a re-review/);
    assert.ok(skill.instructions.includes(`git diff ${SHA}..HEAD`));
    assert.match(skill.instructions, /verdict request_changes, https:\/\/x\/r\/1/);
    assert.match(skill.instructions, /Never repeat a finding/);
    assert.match(skill.instructions, /## Prior findings/);
    assert.match(skill.instructions, /OPENCARA_PR_LAST_REVIEWED_SHA/);
  });

  it("keeps request_changes while an earlier [Important] finding is still open", () => {
    // Without this, "don't repeat findings" + "request_changes needs an
    // [Important] finding" would let a re-review approve a known bug.
    const skill = buildPrReviewVerdictSkill({
      ...base,
      priorReview: { headSha: SHA, verdict: "REQUEST_CHANGES", htmlUrl: null },
    });
    assert.match(skill.instructions, /still open counts toward the\s+verdict/);
    assert.match(skill.instructions, /`request_changes` until every one is fixed/);
  });

  it("falls back to the whole PR diff when the delta is empty or gone", () => {
    const skill = buildPrReviewVerdictSkill({
      ...base,
      priorReview: { headSha: SHA, verdict: null, htmlUrl: null },
      hasCheckout: true,
      currentHeadSha: "fedcba9876543210fedcba9876543210fedcba98",
    });
    assert.match(skill.instructions, /or that diff is empty, review the whole PR diff/);
  });

  it("lets a second look at the same commit report new findings anywhere", () => {
    // `@opencara review` / `mreview` and reruns hit the same head: an empty
    // delta must not forbid what the second look was asked for (PR #274).
    const skill = buildPrReviewVerdictSkill({
      ...base,
      priorReview: { headSha: SHA, verdict: "APPROVE", htmlUrl: null },
      hasCheckout: true,
      currentHeadSha: SHA.toUpperCase(),
    });
    assert.match(skill.instructions, /## This is a second look at the same commit/);
    assert.match(skill.instructions, /Review the whole pull request diff/);
    assert.doesNotMatch(skill.instructions, /git diff/);
    assert.doesNotMatch(skill.instructions, /out of scope, unless/);
    // The no-repeat and still-open rules still apply.
    assert.match(skill.instructions, /Never repeat a finding/);
    assert.match(skill.instructions, /`request_changes` until every one is fixed/);
  });

  it("doesn't hand a git command to a reviewer without a checkout", () => {
    const skill = buildPrReviewVerdictSkill({
      ...base,
      priorReview: { headSha: SHA, verdict: null, htmlUrl: null },
      hasCheckout: false,
    });
    assert.match(skill.instructions, /## This is a re-review/);
    assert.doesNotMatch(skill.instructions, /git diff/);
    assert.match(skill.instructions, /covers the whole PR/);
  });
});
