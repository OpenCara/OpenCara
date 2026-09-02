import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveWorktreeBranch, worktreeKeyForStep, WorktreeBranchError } from "../branch.js";

describe("deriveWorktreeBranch", () => {
  it("checks out the PR head ref itself on PR triggers, ignoring fromBranch", () => {
    assert.deepEqual(
      deriveWorktreeBranch({
        expected: "pr",
        prHeadRef: "opencara/issue-42",
        issueNumber: null,
        flowRunId: "01RUN",
        fromBranch: "develop",
        defaultBranch: "main",
      }),
      { branch: "opencara/issue-42", fromBranch: "opencara/issue-42", source: "pr" },
    );
  });

  it("names the branch after the issue and branches off fromBranch, else the default", () => {
    assert.deepEqual(
      deriveWorktreeBranch({
        expected: "issue",
        prHeadRef: undefined,
        issueNumber: 7,
        flowRunId: "01RUN",
        fromBranch: "develop",
        defaultBranch: "main",
      }),
      { branch: "opencara/issue-7", fromBranch: "develop", source: "issue" },
    );
    assert.equal(
      deriveWorktreeBranch({
        expected: "issue",
        prHeadRef: "",
        issueNumber: 7,
        flowRunId: "01RUN",
        fromBranch: null,
        defaultBranch: "main",
      }).fromBranch,
      "main",
    );
  });

  it("falls back to a per-run branch for schedule / manual triggers", () => {
    assert.deepEqual(
      deriveWorktreeBranch({
        expected: null,
        prHeadRef: null,
        issueNumber: undefined,
        flowRunId: "01M1H5VWBQ",
        fromBranch: "",
        defaultBranch: null,
      }),
      { branch: "opencara/run-01m1h5vwbq", fromBranch: "", source: "run" },
    );
  });
});

describe("deriveWorktreeBranch — missing trigger context fails loud", () => {
  it("throws when a PR-triggered run has no head ref (PR context fetch failed)", () => {
    assert.throws(
      () =>
        deriveWorktreeBranch({
          expected: "pr",
          prHeadRef: undefined,
          issueNumber: null,
          flowRunId: "01RUN",
          fromBranch: null,
          defaultBranch: "main",
        }),
      WorktreeBranchError,
    );
  });

  it("throws when an issue-triggered run has no issue number", () => {
    assert.throws(
      () =>
        deriveWorktreeBranch({
          expected: "issue",
          prHeadRef: null,
          issueNumber: undefined,
          flowRunId: "01RUN",
          fromBranch: null,
          defaultBranch: "main",
        }),
      WorktreeBranchError,
    );
  });
});

describe("worktreeKeyForStep", () => {
  it("is unique per attempt and safe for the CLI slug sanitizer", () => {
    assert.equal(worktreeKeyForStep("acme/app", "01STEP"), "acme/app/step-01STEP");
    assert.notEqual(worktreeKeyForStep("acme/app", "01A"), worktreeKeyForStep("acme/app", "01B"));
    assert.equal(worktreeKeyForStep("acme/app", "a/b c"), "acme/app/step-a_b_c");
  });
});
