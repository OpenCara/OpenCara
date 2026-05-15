import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markDraftPrReadyByHead } from "../draftPr.js";

type RouteResponder = (params: Record<string, unknown>) =>
  | { status: number; data: unknown }
  | Promise<{ status: number; data: unknown }>;

interface CallRecord {
  route: string;
  params: Record<string, unknown>;
}

function makeOctokit(routes: Record<string, RouteResponder>): {
  octokit: {
    request: (route: string, params: Record<string, unknown>) => Promise<{ data: unknown }>;
    graphql: (query: string, params: Record<string, unknown>) => Promise<unknown>;
  };
  calls: CallRecord[];
  graphqlCalls: Array<{ query: string; params: Record<string, unknown> }>;
} {
  const calls: CallRecord[] = [];
  const graphqlCalls: Array<{ query: string; params: Record<string, unknown> }> = [];
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
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
      }
      return { data: res.data };
    },
    graphql: async (query: string, params: Record<string, unknown>) => {
      graphqlCalls.push({ query, params });
      return {};
    },
  };
  return { octokit, calls, graphqlCalls };
}

const baseArgs = {
  owner: "octo-org",
  repo: "octo-repo",
  headBranch: "opencara/issue-44",
};

describe("markDraftPrReadyByHead", () => {
  it("marks a draft PR ready by node id", async () => {
    const { octokit, calls, graphqlCalls } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": () => ({
        status: 200,
        data: [{ number: 12, node_id: "PR_kwDO123", draft: true }],
      }),
    });

    const result = await markDraftPrReadyByHead({
      ...baseArgs,
      octokit: octokit as never,
    });

    assert.equal(result.kind, "marked-ready");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.params.head, "octo-org:opencara/issue-44");
    assert.equal(calls[0]!.params.state, "open");
    assert.equal(graphqlCalls.length, 1);
    assert.match(graphqlCalls[0]!.query, /markPullRequestReadyForReview/);
    assert.equal(graphqlCalls[0]!.params.pullRequestId, "PR_kwDO123");
  });

  it("no-ops when the PR is already ready", async () => {
    const { octokit, graphqlCalls } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": () => ({
        status: 200,
        data: [{ number: 12, node_id: "PR_kwDO123", draft: false }],
      }),
    });

    const result = await markDraftPrReadyByHead({
      ...baseArgs,
      octokit: octokit as never,
    });

    assert.deepEqual(result, { kind: "already-ready", prNumber: 12 });
    assert.equal(graphqlCalls.length, 0);
  });

  it("no-ops when no open PR exists for the head branch", async () => {
    const { octokit, graphqlCalls } = makeOctokit({
      "GET /repos/{owner}/{repo}/pulls": () => ({ status: 200, data: [] }),
    });

    const result = await markDraftPrReadyByHead({
      ...baseArgs,
      octokit: octokit as never,
    });

    assert.deepEqual(result, { kind: "no-pr" });
    assert.equal(graphqlCalls.length, 0);
  });
});
