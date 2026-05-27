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
      instructionsFile: "AGENTS.md",
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
