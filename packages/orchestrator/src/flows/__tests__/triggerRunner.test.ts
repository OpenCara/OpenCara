import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TriggerNode } from "@opencara/flows";
import { SkipFlowError, triggerRunner, type NodeRunCtx } from "../nodeRunners.js";

const pullRequestTrigger: TriggerNode = {
  id: "t1",
  kind: "github.pull_request",
  position: { x: 0, y: 0 },
  config: {
    actions: ["opened", "synchronize", "reopened", "commented"],
    branches: [],
    branchesIgnore: [],
    paths: [],
    pathsIgnore: [],
    labels: [],
    labelsIgnore: [],
    ignoreDrafts: false,
    commentPhrase: "@opencara review",
  },
};

function ctxForComment(body: string): NodeRunCtx {
  return {
    db: {} as never,
    pg: {} as never,
    app: {} as never,
    dispatcher: {} as never,
    flowId: "flow-1",
    flowRunId: "run-1",
    flowRunStepId: "step-1",
    projectId: "project-1",
    installation: { id: "installation-1", githubInstallationId: 1 },
    project: {
      owner: "octo-org",
      name: "octo-repo",
      githubRepoId: 1,
      defaultBranch: "main",
    },
    event: {
      id: "event-1",
      type: "issue_comment",
      payload: {
        action: "created",
        issue: { number: 7, pull_request: {} },
        comment: { body, user: { login: "operator" } },
      },
    },
    publicBaseUrl: "https://opencara.example",
  };
}

describe("triggerRunner pull_request commentPhrase", () => {
  it("matches @opencara review comments on pull requests", async () => {
    const result = await triggerRunner(
      ctxForComment("please @OpenCara Review this again"),
      pullRequestTrigger,
    );

    assert.deepEqual(result.output, {
      matched: true,
      comment: true,
      commenter: "operator",
    });
  });

  it("skips when commentPhrase is empty", async () => {
    await assert.rejects(
      triggerRunner(ctxForComment("any comment"), {
        ...pullRequestTrigger,
        config: { ...pullRequestTrigger.config, commentPhrase: "" },
      }),
      (err) =>
        err instanceof SkipFlowError &&
        err.message === "comment trigger not enabled (commentPhrase is empty)",
    );
  });
});

// Regression test for the merge/review-event race documented in #132.
// A `pull_request_review.submitted` (or `@opencara fix` `issue_comment`)
// can land seconds after a merge; by then GitHub may have auto-deleted
// the head branch and the downstream worktree allocator would crash on
// the missing remote ref. The trigger must skip closed PRs cleanly.
const reviewTrigger: TriggerNode = {
  id: "t-review",
  kind: "github.pull_request_review",
  position: { x: 0, y: 0 },
  config: {
    reviewStates: ["commented", "changes_requested"],
    users: ["opencara[bot]"],
    commentPhrase: "@opencara fix",
  },
};

interface ReviewCtxOpts {
  prState?: "open" | "closed";
  /** When true, prContext is undefined and the trigger must fall back to
   *  the raw webhook payload's pr state. */
  withoutPrContext?: boolean;
}

function ctxForReviewSubmitted(opts: ReviewCtxOpts = {}): NodeRunCtx {
  const state = opts.prState ?? "open";
  const prObject = {
    number: 127,
    state,
    head: { sha: "deadbeef", ref: "opencara/issue-125" },
    base: { sha: "cafebabe" },
  };
  return {
    db: {} as never,
    pg: {} as never,
    app: {} as never,
    dispatcher: {} as never,
    flowId: "flow-1",
    flowRunId: "run-1",
    flowRunStepId: "step-1",
    projectId: "project-1",
    installation: { id: "installation-1", githubInstallationId: 1 },
    project: {
      owner: "octo-org",
      name: "octo-repo",
      githubRepoId: 1,
      defaultBranch: "main",
    },
    event: {
      id: "event-1",
      type: "pull_request_review",
      payload: {
        action: "submitted",
        pull_request: prObject,
        review: { state: "commented", user: { login: "opencara[bot]" } },
        repository: { full_name: "octo-org/octo-repo" },
      },
    },
    prContext: opts.withoutPrContext
      ? undefined
      : {
          envExtras: {},
          stdin: {
            pr: prObject,
            diff: "",
            review: { state: "commented", user: { login: "opencara[bot]" } },
          },
        },
    publicBaseUrl: "https://opencara.example",
  };
}

function ctxForFixComment(opts: ReviewCtxOpts = {}): NodeRunCtx {
  const state = opts.prState ?? "open";
  const prObject = {
    number: 127,
    state,
    head: { sha: "deadbeef", ref: "opencara/issue-125" },
    base: { sha: "cafebabe" },
  };
  return {
    db: {} as never,
    pg: {} as never,
    app: {} as never,
    dispatcher: {} as never,
    flowId: "flow-1",
    flowRunId: "run-1",
    flowRunStepId: "step-1",
    projectId: "project-1",
    installation: { id: "installation-1", githubInstallationId: 1 },
    project: {
      owner: "octo-org",
      name: "octo-repo",
      githubRepoId: 1,
      defaultBranch: "main",
    },
    event: {
      id: "event-1",
      type: "issue_comment",
      payload: {
        action: "created",
        issue: { number: 127, pull_request: {} },
        comment: { body: "@opencara fix this", user: { login: "operator" } },
      },
    },
    prContext: opts.withoutPrContext
      ? undefined
      : {
          envExtras: {},
          stdin: {
            pr: prObject,
            diff: "",
            comment: { body: "@opencara fix this", user: { login: "operator" } },
          },
        },
    publicBaseUrl: "https://opencara.example",
  };
}

describe("triggerRunner pull_request_review closed-PR skip", () => {
  it("dispatches on an open PR (review submitted)", async () => {
    const result = await triggerRunner(ctxForReviewSubmitted({ prState: "open" }), reviewTrigger);
    assert.deepEqual(result.output, {
      matched: true,
      reviewState: "commented",
      reviewer: "opencara[bot]",
    });
  });

  it("skips when the PR is already closed (review submitted)", async () => {
    await assert.rejects(
      triggerRunner(ctxForReviewSubmitted({ prState: "closed" }), reviewTrigger),
      (err) =>
        err instanceof SkipFlowError &&
        err.message === "PR is closed; skipping review-fix on stale event",
    );
  });

  it("skips when the PR is already closed (@opencara fix comment)", async () => {
    await assert.rejects(
      triggerRunner(ctxForFixComment({ prState: "closed" }), reviewTrigger),
      (err) =>
        err instanceof SkipFlowError &&
        err.message === "PR is closed; skipping review-fix on stale event",
    );
  });

  it("falls back to webhook payload pr.state when prContext is missing", async () => {
    await assert.rejects(
      triggerRunner(
        ctxForReviewSubmitted({ prState: "closed", withoutPrContext: true }),
        reviewTrigger,
      ),
      (err) =>
        err instanceof SkipFlowError &&
        err.message === "PR is closed; skipping review-fix on stale event",
    );
  });
});
