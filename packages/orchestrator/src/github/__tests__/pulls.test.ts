import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { autoMergePullRequest, linkPrToIssueAndCopyAgentLabel } from "../pulls.js";

// Hand-rolled octokit stub. We don't depend on @octokit/rest's runtime
// behavior — just on the `request(route, params)` shape — so a minimal
// fake keyed on route templates is enough.
type RouteResponder = (params: Record<string, unknown>) =>
  | { status: number; data: unknown }
  | Promise<{ status: number; data: unknown }>;

interface CallRecord {
  route: string;
  params: Record<string, unknown>;
}

function makeOctokit(routes: Record<string, RouteResponder>): {
  octokit: { request: (route: string, params: Record<string, unknown>) => Promise<{ data: unknown }> };
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  const octokit = {
    request: async (route: string, params: Record<string, unknown>) => {
      calls.push({ route, params });
      const responder = routes[route];
      if (!responder) {
        throw Object.assign(new Error(`unstubbed route: ${route}`), {
          status: 500,
        });
      }
      const res = await responder(params);
      if (res.status >= 400) {
        const err = Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
        throw err;
      }
      return { data: res.data };
    },
  };
  return { octokit, calls };
}

const baseArgs = {
  owner: "octo-org",
  repo: "octo-repo",
  branchName: "opencara/issue-42",
  issueNumber: 42,
};

describe("linkPrToIssueAndCopyAgentLabel", () => {
  it("appends Closes #N when PR body lacks the keyword and copies agent label", async () => {
    const { octokit, calls } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": () => ({
        status: 200,
        data: [{ number: 7, body: "Some PR description without a closing keyword." }],
      }),
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}": () => ({
        status: 200,
        data: {},
      }),
      "GET /repos/{owner}/{repo}/labels/{name}": () => ({ status: 200, data: {} }),
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels": () => ({
        status: 200,
        data: [],
      }),
    });

    await linkPrToIssueAndCopyAgentLabel({
      ...baseArgs,
      octokit: octokit as never,
      issueLabels: [{ name: "agent:claude-impl" }, { name: "bug" }],
    });

    const patch = calls.find((c) => c.route.startsWith("PATCH "));
    assert.ok(patch, "PATCH should have been issued");
    assert.equal(patch!.params.pull_number, 7);
    assert.equal(
      patch!.params.body,
      "Some PR description without a closing keyword.\n\nCloses #42",
    );

    const labelAdd = calls.find(
      (c) => c.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
    );
    assert.ok(labelAdd, "label POST should have been issued");
    assert.equal(labelAdd!.params.issue_number, 7);
    assert.deepEqual(labelAdd!.params.labels, ["agent:claude-impl"]);
  });

  it("skips PATCH when body already contains a closing keyword (case-insensitive, multiple variants)", async () => {
    for (const body of [
      "Closes #42",
      "fixes #42",
      "Resolved #42",
      "Closed #42",
      "Fixed #42",
      "Some preamble.\n\nCloses #42\n",
    ]) {
      const { octokit, calls } = makeOctokit({
        "GET /repos/{owner}/{repo}/pulls": () => ({
          status: 200,
          data: [{ number: 9, body }],
        }),
        "GET /repos/{owner}/{repo}/labels/{name}": () => ({ status: 200, data: {} }),
        "POST /repos/{owner}/{repo}/issues/{issue_number}/labels": () => ({
          status: 200,
          data: [],
        }),
      });

      await linkPrToIssueAndCopyAgentLabel({
        ...baseArgs,
        octokit: octokit as never,
        issueLabels: [{ name: "agent:codex" }],
      });

      const patched = calls.some((c) => c.route.startsWith("PATCH "));
      assert.equal(patched, false, `body \"${body}\" should not trigger a PATCH`);
    }
  });

  it("does not match #123 when the issue number is #12 (anchor on \\b)", async () => {
    const { octokit, calls } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": () => ({
        status: 200,
        data: [{ number: 5, body: "Closes #123" }],
      }),
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}": () => ({
        status: 200,
        data: {},
      }),
      "GET /repos/{owner}/{repo}/labels/{name}": () => ({ status: 200, data: {} }),
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels": () => ({
        status: 200,
        data: [],
      }),
    });

    await linkPrToIssueAndCopyAgentLabel({
      owner: "o",
      repo: "r",
      branchName: "b",
      issueNumber: 12,
      octokit: octokit as never,
      issueLabels: [],
    });

    const patch = calls.find((c) => c.route.startsWith("PATCH "));
    assert.ok(patch, "PATCH must run because #123 is not #12");
    assert.equal(patch!.params.body, "Closes #123\n\nCloses #12");
  });

  it("uses bare 'Closes #N' when PR body is null/empty", async () => {
    const { octokit, calls } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": () => ({
        status: 200,
        data: [{ number: 11, body: null }],
      }),
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}": () => ({
        status: 200,
        data: {},
      }),
    });

    await linkPrToIssueAndCopyAgentLabel({
      ...baseArgs,
      octokit: octokit as never,
      issueLabels: [],
    });

    const patch = calls.find((c) => c.route.startsWith("PATCH "));
    assert.equal(patch!.params.body, "Closes #42");
  });

  it("does not POST a label when the issue has no agent: label", async () => {
    const { octokit, calls } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": () => ({
        status: 200,
        data: [{ number: 3, body: "Closes #42" }],
      }),
    });

    await linkPrToIssueAndCopyAgentLabel({
      ...baseArgs,
      octokit: octokit as never,
      issueLabels: [{ name: "bug" }, { name: "priority:high" }],
    });

    const labelCalls = calls.filter((c) => c.route.includes("labels"));
    assert.equal(labelCalls.length, 0);
  });

  it("returns kind:'no-pr' when no open PR is found for the branch (no writes, no throw)", async () => {
    const { octokit, calls } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": () => ({ status: 200, data: [] }),
    });

    const result = await linkPrToIssueAndCopyAgentLabel({
      ...baseArgs,
      octokit: octokit as never,
      issueLabels: [{ name: "agent:claude-impl" }],
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.route, "GET /repos/{owner}/{repo}/pulls");
    assert.equal(result.kind, "no-pr");
  });

  it("auto-creates the agent: label when missing on the repo, then adds it to the PR", async () => {
    const created: Record<string, unknown>[] = [];
    const { octokit, calls } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": () => ({
        status: 200,
        data: [{ number: 8, body: "Closes #42" }],
      }),
      "GET /repos/{owner}/{repo}/labels/{name}": () => ({ status: 404, data: {} }),
      "POST /repos/{owner}/{repo}/labels": (params) => {
        created.push(params);
        return { status: 201, data: {} };
      },
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels": () => ({
        status: 200,
        data: [],
      }),
    });

    await linkPrToIssueAndCopyAgentLabel({
      ...baseArgs,
      octokit: octokit as never,
      issueLabels: [{ name: "agent:codex" }],
    });

    assert.equal(created.length, 1);
    assert.equal(created[0]!.name, "agent:codex");
    assert.equal(created[0]!.color, "5856d6");

    const labelAdd = calls.find(
      (c) => c.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
    );
    assert.ok(labelAdd, "label POST should still run after auto-create");
  });

  it("swallows 422 from the add-label POST (label already on PR)", async () => {
    const { octokit, calls } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": () => ({
        status: 200,
        data: [{ number: 4, body: "Closes #42" }],
      }),
      "GET /repos/{owner}/{repo}/labels/{name}": () => ({ status: 200, data: {} }),
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels": () => ({
        status: 422,
        data: {},
      }),
    });

    await assert.doesNotReject(
      linkPrToIssueAndCopyAgentLabel({
        ...baseArgs,
        octokit: octokit as never,
        issueLabels: [{ name: "agent:claude-impl" }],
      }),
    );
    assert.ok(
      calls.some(
        (c) => c.route === "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
      ),
    );
  });

  it("returns kind:'transient-failure' when the initial pulls list call fails (network error)", async () => {
    const { octokit, calls } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": () => ({ status: 503, data: {} }),
    });

    const result = await linkPrToIssueAndCopyAgentLabel({
      ...baseArgs,
      octokit: octokit as never,
      issueLabels: [{ name: "agent:codex" }],
    });
    assert.equal(calls.length, 1);
    assert.equal(result.kind, "transient-failure");
  });

  it("returns kind:'linked' with prNumber when the PR is found and linked", async () => {
    const { octokit } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": () => ({
        status: 200,
        data: [{ number: 17, body: "Closes #42" }],
      }),
    });

    const result = await linkPrToIssueAndCopyAgentLabel({
      ...baseArgs,
      octokit: octokit as never,
      issueLabels: [],
    });
    assert.equal(result.kind, "linked");
    assert.equal(
      (result as { kind: "linked"; prNumber: number }).prNumber,
      17,
    );
  });
});

describe("autoMergePullRequest", () => {
  const autoMergeArgs = {
    owner: "octo-org",
    repo: "octo-repo",
    pullNumber: 7,
    method: "squash" as const,
    requireChecks: true,
    requireApproval: false,
    maxMergeableAttempts: 1,
    mergeableDelayMs: 0,
    maxCheckAttempts: 1,
    checkDelayMs: 0,
  };

  it("merges when mergeable, checks pass, and no changes_requested review is outstanding", async () => {
    const { octokit, calls } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({
        status: 200,
        data: { number: 7, mergeable: true, mergeable_state: "clean", head: { sha: "b" } },
      }),
      "GET /repos/{owner}/{repo}/commits/{ref}/status": () => ({
        status: 200,
        data: { state: "success", statuses: [] },
      }),
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": () => ({
        status: 200,
        data: [{ state: "APPROVED", user: { login: "reviewer" } }],
      }),
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge": () => ({
        status: 200,
        data: { sha: "merge-sha", message: "merged" },
      }),
    });

    const result = await autoMergePullRequest({
      ...autoMergeArgs,
      octokit: octokit as never,
      priorHeadSha: "a",
    });

    assert.deepEqual(result, { kind: "merged", sha: "merge-sha", message: "merged" });
    const merge = calls.find(
      (c) => c.route === "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
    );
    assert.equal(merge?.params.merge_method, "squash");
    assert.equal(merge?.params.sha, "b");
  });

  it("skips while GitHub mergeability remains null", async () => {
    const { octokit } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({
        status: 200,
        data: { number: 7, mergeable: null, head: { sha: "b" } },
      }),
    });

    const result = await autoMergePullRequest({
      ...autoMergeArgs,
      octokit: octokit as never,
    });

    assert.equal(result.kind, "skipped");
    assert.match((result as { reason: string }).reason, /still computing mergeability/);
  });

  it("skips when the fix agent did not push a new head commit", async () => {
    const { octokit } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({
        status: 200,
        data: { number: 7, mergeable: true, mergeable_state: "clean", head: { sha: "same" } },
      }),
    });

    const result = await autoMergePullRequest({
      ...autoMergeArgs,
      octokit: octokit as never,
      priorHeadSha: "same",
    });

    assert.deepEqual(result, {
      kind: "skipped",
      reason: "fix agent did not push a new HEAD commit; skipping auto-merge",
    });
  });

  it("waits for pending required checks before merging", async () => {
    let statusCalls = 0;
    const { octokit } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({
        status: 200,
        data: { number: 7, mergeable: true, mergeable_state: "clean", head: { sha: "b" } },
      }),
      "GET /repos/{owner}/{repo}/commits/{ref}/status": () => {
        statusCalls++;
        return {
          status: 200,
          data: { state: statusCalls < 3 ? "pending" : "success", statuses: [] },
        };
      },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": () => ({
        status: 200,
        data: [],
      }),
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge": () => ({
        status: 200,
        data: { sha: "merge-sha", message: "merged" },
      }),
    });

    const result = await autoMergePullRequest({
      ...autoMergeArgs,
      octokit: octokit as never,
      priorHeadSha: "a",
      maxCheckAttempts: 3,
    });

    assert.equal(statusCalls, 3);
    assert.deepEqual(result, { kind: "merged", sha: "merge-sha", message: "merged" });
  });

  it("skips when required checks are still pending after the wait budget", async () => {
    const { octokit } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({
        status: 200,
        data: { number: 7, mergeable: true, mergeable_state: "clean", head: { sha: "b" } },
      }),
      "GET /repos/{owner}/{repo}/commits/{ref}/status": () => ({
        status: 200,
        data: { state: "pending", statuses: [] },
      }),
    });

    const result = await autoMergePullRequest({
      ...autoMergeArgs,
      octokit: octokit as never,
      priorHeadSha: "a",
    });

    assert.deepEqual(result, {
      kind: "skipped",
      reason: "required checks are pending after 1 attempts",
    });
  });

  it("skips on outstanding changes_requested reviews", async () => {
    const { octokit } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({
        status: 200,
        data: { number: 7, mergeable: true, mergeable_state: "clean", head: { sha: "b" } },
      }),
      "GET /repos/{owner}/{repo}/commits/{ref}/status": () => ({
        status: 200,
        data: { state: "success", statuses: [] },
      }),
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": () => ({
        status: 200,
        data: [{ state: "CHANGES_REQUESTED", user: { login: "reviewer" } }],
      }),
    });

    const result = await autoMergePullRequest({
      ...autoMergeArgs,
      octokit: octokit as never,
      priorHeadSha: "a",
    });

    assert.deepEqual(result, {
      kind: "skipped",
      reason: "PR has outstanding changes_requested reviews",
    });
  });

  it("skips with GitHub's merge API message on 405/409", async () => {
    const { octokit } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({
        status: 200,
        data: { number: 7, mergeable: true, mergeable_state: "clean", head: { sha: "b" } },
      }),
      "GET /repos/{owner}/{repo}/commits/{ref}/status": () => ({
        status: 200,
        data: { state: "success", statuses: [] },
      }),
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": () => ({
        status: 200,
        data: [],
      }),
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge": () => ({
        status: 409,
        data: {},
      }),
    });

    const result = await autoMergePullRequest({
      ...autoMergeArgs,
      octokit: octokit as never,
      priorHeadSha: "a",
    });

    assert.deepEqual(result, { kind: "skipped", reason: "HTTP 409" });
  });
});
