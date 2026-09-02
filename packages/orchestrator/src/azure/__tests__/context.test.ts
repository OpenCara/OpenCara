import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAzurePullRequestContext } from "../../flows/context.js";
import { normalizeAzureEvent } from "../events.js";

const project = { owner: "contoso/Team", name: "widgets" };

/** A realistic service hook body, run through the same normalizer the webhook uses. */
function normalizedPrPayload(overrides: Record<string, unknown> = {}) {
  const ev = normalizeAzureEvent({
    id: "delivery-1",
    eventType: "git.pullrequest.created",
    resource: {
      pullRequestId: 42,
      status: "active",
      title: "Add widget",
      sourceRefName: "refs/heads/feature/widget",
      targetRefName: "refs/heads/main",
      lastMergeSourceCommit: { commitId: "aaa111" },
      lastMergeTargetCommit: { commitId: "bbb222" },
      createdBy: { uniqueName: "ada@contoso.com" },
      repository: {
        id: "repo-guid",
        name: "widgets",
        project: { id: "proj-guid", name: "Team" },
      },
      ...overrides,
    },
  });
  assert.ok(ev);
  return ev.payload;
}

describe("buildAzurePullRequestContext", () => {
  // The whole point of reusing the GitHub variable names is that prompts,
  // flow templates and {{VAR}} substitutions stay portable across platforms.
  it("emits the same OPENCARA_PR_* variables as the GitHub path", async () => {
    const ctx = await buildAzurePullRequestContext(normalizedPrPayload(), project);
    assert.equal(ctx.envExtras["OPENCARA_PR_NUMBER"], "42");
    assert.equal(ctx.envExtras["OPENCARA_PR_HEAD_SHA"], "aaa111");
    assert.equal(ctx.envExtras["OPENCARA_PR_BASE_SHA"], "bbb222");
    assert.equal(ctx.envExtras["OPENCARA_PR_HEAD_REF"], "feature/widget");
    assert.equal(ctx.envExtras["OPENCARA_REPO"], "Team/widgets");
  });

  it("marks the platform so prompts can branch", async () => {
    const ctx = await buildAzurePullRequestContext(normalizedPrPayload(), project);
    assert.equal(ctx.envExtras["OPENCARA_PLATFORM"], "azure_devops");
  });

  // Azure DevOps has no single unified-diff endpoint, so the diff is not
  // inlined. Agents must read the worktree; this flag is how they know.
  it("signals that no diff is inlined rather than shipping a partial one", async () => {
    const ctx = await buildAzurePullRequestContext(normalizedPrPayload(), project);
    assert.equal(ctx.envExtras["OPENCARA_PR_DIFF_INLINE"], "0");
    assert.equal(ctx.stdin.diff, "");
  });

  it("exposes the base ref, which the GitHub path leaves implicit", async () => {
    const ctx = await buildAzurePullRequestContext(normalizedPrPayload(), project);
    assert.equal(ctx.envExtras["OPENCARA_PR_BASE_REF"], "main");
  });

  it("puts the PR object on stdin for downstream nodes", async () => {
    const ctx = await buildAzurePullRequestContext(normalizedPrPayload(), project);
    assert.equal((ctx.stdin.pr as { number: number }).number, 42);
  });

  it("falls back to the project's own owner/name when the payload has no repository", async () => {
    const ctx = await buildAzurePullRequestContext(
      { pull_request: { number: 7, head: { sha: "h" }, base: { sha: "b" } } },
      project,
    );
    assert.equal(ctx.envExtras["OPENCARA_REPO"], "contoso/Team/widgets");
  });

  it("throws rather than silently producing an empty context", async () => {
    await assert.rejects(
      buildAzurePullRequestContext({}, project),
      /no way to fetch one/,
    );
  });
});

describe("buildAzurePullRequestContext — comment path", () => {
  function commentPayload(body: string) {
    const ev = normalizeAzureEvent({
      eventType: "ms.vss-code.git-pullrequest-comment-event",
      resource: {
        comment: { id: 7, content: body, author: { uniqueName: "grace@contoso.com" } },
        pullRequest: {
          pullRequestId: 42,
          status: "active",
          sourceRefName: "refs/heads/feature/widget",
          targetRefName: "refs/heads/main",
          lastMergeSourceCommit: { commitId: "aaa111" },
          lastMergeTargetCommit: { commitId: "bbb222" },
          repository: {
            id: "repo-guid",
            name: "widgets",
            project: { id: "proj-guid", name: "Team" },
          },
        },
      },
    });
    assert.ok(ev);
    return ev.payload;
  }

  // On GitHub the comment path costs an API call, because issue_comment carries
  // no PR object. The normalizer supplies one, so this needs no fetch at all.
  it("builds full PR context from a comment event with no API call", async () => {
    const ctx = await buildAzurePullRequestContext(
      commentPayload("@opencara review") as never,
      project,
    );
    assert.equal(ctx.envExtras["OPENCARA_PR_NUMBER"], "42");
    assert.equal(ctx.envExtras["OPENCARA_PR_HEAD_SHA"], "aaa111");
  });

  it("surfaces the comment body and author to the agent", async () => {
    const ctx = await buildAzurePullRequestContext(
      commentPayload("@opencara review") as never,
      project,
    );
    assert.equal(ctx.envExtras["OPENCARA_COMMENT_BODY"], "@opencara review");
    assert.equal(ctx.envExtras["OPENCARA_COMMENT_AUTHOR"], "grace@contoso.com");
    assert.equal(ctx.envExtras["OPENCARA_COMMENT_ID"], "7");
  });

  it("omits comment variables entirely on a plain PR event", async () => {
    const ctx = await buildAzurePullRequestContext(normalizedPrPayload(), project);
    assert.equal(ctx.envExtras["OPENCARA_COMMENT_BODY"], undefined);
    assert.equal(ctx.stdin.comment, undefined);
  });
});
