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

  it("explains the push is what re-triggers review", () => {
    assert.match(skill.instructions, /pull_request\.synchronize/);
  });

  it("surfaces the run id for log correlation like the other skills", () => {
    assert.equal(skill.runId, "01TESTRUN000000000000000");
    assert.match(skill.instructions, /01TESTRUN000000000000000/);
  });
});
