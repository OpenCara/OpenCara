import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ActionNode } from "@opencara/flows";
import {
  actionRunner,
  MIN_UNVERDICTED_REVIEW_BODY_CHARS,
  type NodeRunCtx,
} from "../nodeRunners.js";

const postReviewNode: ActionNode = {
  id: "x1",
  kind: "scm.post_review",
  position: { x: 0, y: 0 },
  config: { event: "COMMENT" },
} as ActionNode;

interface RecordedRequest {
  route: string;
  params: Record<string, unknown>;
}

function ctxForPostReview(
  previousOutput: string,
  previousAgentName?: string,
): {
  ctx: NodeRunCtx;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const oct = {
    request: async (route: string, params: Record<string, unknown>) => {
      requests.push({ route, params });
      return { data: { id: 42, html_url: "https://github.com/o/r/pull/25#r42" } };
    },
  };
  const ctx: NodeRunCtx = {
    db: {} as never,
    pg: {} as never,
    app: { forInstallation: async () => oct } as never,
    dispatcher: {} as never,
    flowId: "flow-1",
    flowRunId: "run-1",
    flowRunStepId: "step-1",
    projectId: "project-1",
    scm: {
      platform: "github" as const,
      installation: { id: "installation-1", githubInstallationId: 1 },
      githubRepoId: 1,
    },
    project: {
      owner: "octo-org",
      name: "octo-repo",
      defaultBranch: "main",
      instructionsFile: "",
    },
    event: {
      id: "event-1",
      type: "pull_request",
      payload: {
        action: "opened",
        pull_request: { number: 25, head: { sha: "abc123" } },
      },
    },
    previousOutput,
    previousAgentName,
    publicBaseUrl: "https://opencara.example",
    hasDownstreamPostReview: false,
    rerun: false,
  } as NodeRunCtx;
  return { ctx, requests };
}

describe("actionRunner scm.post_review stub guard", () => {
  it("refuses a verdict-less one-liner instead of publishing it", async () => {
    const { ctx, requests } = ctxForPostReview("I've completed my review of PR #25.");
    await assert.rejects(
      actionRunner(ctx, postReviewNode),
      /post_review refused: agent output has no verdict line/,
    );
    assert.equal(requests.length, 0);
  });

  it("posts a verdict-bearing review, stripping the verdict line and mapping the event", async () => {
    const { ctx, requests } = ctxForPostReview(
      "verdict: approve\n\nShip it — clean diff.",
    );
    const result = await actionRunner(ctx, postReviewNode);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.params.event, "APPROVE");
    assert.equal(requests[0]!.params.body, "Ship it — clean diff.");
    assert.deepEqual(result.output, {
      reviewId: 42,
      htmlUrl: "https://github.com/o/r/pull/25#r42",
    });
  });

  it("stamps the upstream agent's name on the posted body", async () => {
    const { ctx, requests } = ctxForPostReview(
      "verdict: approve\n\nShip it — clean diff.",
      "codex",
    );
    await actionRunner(ctx, postReviewNode);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.params.event, "APPROVE");
    assert.equal(
      requests[0]!.params.body,
      "_Reviewed by **codex**_\n\nShip it — clean diff.",
    );
  });

  it("posts only agy's final structured review, never its narration", async () => {
    const { ctx, requests } = ctxForPostReview(
      [
        "Let me inspect the diff.",
        "verdict: approve",
        "Now I will trace the implementation.",
        "## Summary",
        "Looks correct.",
        "## Findings",
        "None.",
      ].join("\n\n"),
      "agy opus 4.6",
    );
    await actionRunner(ctx, postReviewNode);
    assert.equal(
      requests[0]!.params.body,
      "_Reviewed by **agy opus 4.6**_\n\n## Summary\n\nLooks correct.\n\n## Findings\n\nNone.",
    );
  });

  it("refuses agy's unstructured narration", async () => {
    const { ctx, requests } = ctxForPostReview(
      "Let me inspect the diff.",
      "agy gemini-flash",
    );
    await assert.rejects(
      actionRunner(ctx, postReviewNode),
      /agy output has no final verdict-bearing review body/,
    );
    assert.equal(requests.length, 0);
  });

  it("posts agy's valid follow-up review format", async () => {
    const body = [
      "verdict: approve",
      "5 of 6 prior items resolved; 1 remains.",
      "### Prior Review Feedback Status",
      "- Fixed: disposal is idempotent.",
    ].join("\n\n");
    const { ctx, requests } = ctxForPostReview(body, "agy gemini-flash");
    await actionRunner(ctx, postReviewNode);
    assert.equal(
      requests[0]!.params.body,
      "_Reviewed by **agy gemini-flash**_\n\n" +
        "5 of 6 prior items resolved; 1 remains.\n\n" +
        "### Prior Review Feedback Status\n\n" +
        "- Fixed: disposal is idempotent.",
    );
  });

  it("still posts a substantial verdict-less body via the config-event fallback", async () => {
    const body = "x".repeat(MIN_UNVERDICTED_REVIEW_BODY_CHARS);
    const { ctx, requests } = ctxForPostReview(body);
    await actionRunner(ctx, postReviewNode);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.params.event, "COMMENT");
    assert.equal(requests[0]!.params.body, body);
  });
});

describe("actionRunner scm.post_review review map", () => {
  const map = {
    id: "map-id-1",
    pageUrl: "https://opencara.example/review-maps/map-id-1",
    imageUrl: "https://opencara.example/api/review-maps/map-id-1/map.svg",
    markdown: "---\n\n[![map](img)](page)",
  };

  it("appends the map markdown and reports reviewMapUrl when attach succeeds", async () => {
    const { ctx, requests } = ctxForPostReview(
      "verdict: approve\n\nShip it — clean diff.",
      "codex",
    );
    let sawOpts: unknown;
    ctx.reviewMaps = {
      attach: async (opts) => {
        sawOpts = opts;
        return map;
      },
    };
    const result = await actionRunner(ctx, postReviewNode);

    assert.equal(requests.length, 1);
    assert.equal(
      requests[0]!.params.body,
      `_Reviewed by **codex**_\n\nShip it — clean diff.\n\n${map.markdown}`,
    );
    assert.equal(
      (result.output as { reviewMapUrl?: string }).reviewMapUrl,
      map.pageUrl,
    );
    // The attach call is fed the review content (verdict stripped), not the
    // author-stamped body.
    const opts = sawOpts as { reviewMarkdown: string; verdict: string };
    assert.equal(opts.reviewMarkdown, "Ship it — clean diff.");
    assert.equal(opts.verdict, "APPROVE");
  });

  it("posts the body unchanged when attach returns null", async () => {
    const { ctx, requests } = ctxForPostReview(
      "verdict: approve\n\nShip it — clean diff.",
    );
    ctx.reviewMaps = { attach: async () => null };
    const result = await actionRunner(ctx, postReviewNode);
    assert.equal(requests[0]!.params.body, "Ship it — clean diff.");
    assert.equal(
      (result.output as { reviewMapUrl?: string }).reviewMapUrl,
      undefined,
    );
  });

  it("still posts when attach throws", async () => {
    const { ctx, requests } = ctxForPostReview(
      "verdict: approve\n\nShip it — clean diff.",
    );
    ctx.reviewMaps = {
      attach: async () => {
        throw new Error("db on fire");
      },
    };
    await actionRunner(ctx, postReviewNode);
    assert.equal(requests[0]!.params.body, "Ship it — clean diff.");
  });

  it("skips attach entirely when reviewMap is false", async () => {
    const { ctx, requests } = ctxForPostReview(
      "verdict: approve\n\nShip it — clean diff.",
    );
    let called = false;
    ctx.reviewMaps = {
      attach: async () => {
        called = true;
        return map;
      },
    };
    const node = {
      ...postReviewNode,
      config: { event: "COMMENT" as const, reviewMap: false },
    };
    await actionRunner(ctx, node as ActionNode);
    assert.equal(called, false);
    assert.equal(requests[0]!.params.body, "Ship it — clean diff.");
  });
});
