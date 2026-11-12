// Pins the review-fix completion contract. The "Fix PR Review Issues"
// prompt forbids commit/push "unless the surrounding workflow explicitly
// requests it" — this skill is that explicit request. ShiningPie PR 115
// (2026-09-30, run 01M3RPMK1KHZ5JE7S6PPTKVMH0): the agent fixed every
// valid item, validated, reported success — and never pushed, so the
// per-attempt worktree teardown destroyed 45 minutes of work while the
// run still reported `succeeded`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPrReviewFixContractSkill } from "../skills/prReviewFixContract.js";

const skill = buildPrReviewFixContractSkill({
  baseUrl: "https://opencara.example",
  runId: "01TESTRUN000000000000000",
  branchName: "feat/weapon-animations",
});

describe("buildPrReviewFixContractSkill", () => {
  it("requires add + commit + push back onto the worktree branch", () => {
    assert.match(skill.instructions, /git add/);
    assert.match(skill.instructions, /git commit -m/);
    assert.match(
      skill.instructions,
      /git push -u origin "\$OPENCARA_WORKTREE_BRANCH"/,
    );
    assert.match(skill.instructions, /feat\/weapon-animations/);
  });

  it("updates the existing PR — no pr-create step", () => {
    assert.match(skill.instructions, /Do not open a new pull request/);
    assert.doesNotMatch(skill.instructions, /pr create/);
    assert.match(skill.instructions, /OPENCARA_PR_NUMBER/);
  });

  it("permits the legitimate no-change exit instead of forcing commits", () => {
    assert.match(skill.instructions, /empty diff is a legitimate outcome/i);
  });

  it("scopes the fix to [Important] findings, whole class, unless a person asks", () => {
    assert.match(skill.instructions, /Fix every \[Important\] finding/);
    assert.match(skill.instructions, /fix every instance/);
    assert.match(skill.instructions, /Leave \[Nit\] and \[Pre-existing\] findings alone unless a person asked/);
    assert.match(skill.instructions, /`@opencara fix`/);
  });

  it("treats an OpenCara review with no [Important] finding as a no-op", () => {
    // `verdict: comment` (review incomplete) still fires the default fix
    // trigger; the run must end with no edits rather than invent work.
    assert.match(skill.instructions, /no \[Important\] finding/);
    assert.match(skill.instructions, /make no\s+edits, skip the commit and push/);
  });

  it("doesn't let the no-op override a person asking for the nits", () => {
    // A nit-only review approves (no fixer), but `@opencara fix` still
    // dispatches one: that run must do what the person asked (PR #274).
    assert.match(skill.instructions, /no \[Important\] finding[\s\S]*and no person asked for changes/);
    assert.match(skill.instructions, /When a person did ask[\s\S]*nits included/);
  });

  it("explains the push is what re-triggers review", () => {
    assert.match(skill.instructions, /pull_request\.synchronize/);
  });

  it("surfaces the run id for log correlation like the other skills", () => {
    assert.equal(skill.runId, "01TESTRUN000000000000000");
    assert.match(skill.instructions, /01TESTRUN000000000000000/);
  });
});
