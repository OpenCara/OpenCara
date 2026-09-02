// PR context: which GitHub fetches a flow needs, how a failed diff fetch
// degrades, and what a worktree agent gets in its page context.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPullRequestContext,
  prContextNeeds,
  type PullRequestContext,
} from "../context.js";
import { changedFilesFor, prStdinForNode } from "../nodeRunners.js";
import type { GithubAppClient } from "../../github/app.js";

const agent = (id: string, worktree: boolean) =>
  ({ id, kind: "agent", config: { worktree: worktree ? { fromBranch: null } : null } }) as never;
const prTrigger = (paths: string[] = [], pathsIgnore: string[] = []) =>
  ({ id: "t", kind: "scm.pull_request", config: { paths, pathsIgnore } }) as never;

describe("prContextNeeds", () => {
  it("needs nothing when every agent has a worktree and no trigger filters paths", () => {
    assert.deepEqual(prContextNeeds({ nodes: [prTrigger(), agent("a", true)] }), {
      diff: false,
      changedFiles: false,
    });
  });

  it("needs the diff for an agent without a worktree", () => {
    assert.equal(prContextNeeds({ nodes: [agent("a", true), agent("b", false)] }).diff, true);
  });

  it("needs the file list when a PR trigger filters on paths or pathsIgnore", () => {
    assert.equal(prContextNeeds({ nodes: [prTrigger(["src/**"])] }).changedFiles, true);
    assert.equal(prContextNeeds({ nodes: [prTrigger([], ["docs/**"])] }).changedFiles, true);
  });
});

function fakeApp(handlers: {
  request?: (route: string, params: Record<string, unknown>) => Promise<unknown>;
  paginate?: (route: string, params: Record<string, unknown>) => Promise<unknown[]>;
}): GithubAppClient {
  return {
    forInstallation: async () => ({
      request: handlers.request ?? (async () => ({ data: "" })),
      paginate: handlers.paginate ?? (async () => []),
    }),
  } as unknown as GithubAppClient;
}

const payload = {
  pull_request: { number: 22, head: { sha: "h", ref: "feat/x" }, base: { sha: "b" } },
  repository: { full_name: "o/r" },
} as never;
const installation = { githubInstallationId: 1 };
const project = { id: "p", owner: "o", name: "r" };

describe("buildPullRequestContext", () => {
  it("makes no GitHub calls when nothing is needed and still carries the head ref", async () => {
    const calls: string[] = [];
    const app = fakeApp({
      request: async (route) => {
        calls.push(route);
        return { data: "" };
      },
      paginate: async (route) => {
        calls.push(route);
        return [];
      },
    });
    const ctx = await buildPullRequestContext(app, installation, project, payload, {
      diff: false,
      changedFiles: false,
    });
    assert.deepEqual(calls, []);
    assert.equal(ctx.envExtras["OPENCARA_PR_HEAD_REF"], "feat/x");
    assert.equal(ctx.envExtras["OPENCARA_PR_DIFF_INLINE"], "0");
    assert.equal(ctx.stdin.diff, "");
    assert.equal(ctx.stdin.changedFiles, undefined);
  });

  it("survives a too_large diff: keeps the head ref, marks the diff as not inline", async () => {
    const app = fakeApp({
      request: async () => {
        throw new Error("Sorry, the diff exceeded the maximum number of lines (20000)");
      },
    });
    const ctx = await buildPullRequestContext(app, installation, project, payload, {
      diff: true,
      changedFiles: false,
    });
    assert.equal(ctx.envExtras["OPENCARA_PR_HEAD_REF"], "feat/x");
    assert.equal(ctx.envExtras["OPENCARA_PR_DIFF_INLINE"], "0");
    assert.equal(ctx.stdin.diff, "");
  });

  it("inlines the diff when fetched", async () => {
    const app = fakeApp({ request: async () => ({ data: "diff --git a/x b/x" }) });
    const ctx = await buildPullRequestContext(app, installation, project, payload, {
      diff: true,
      changedFiles: false,
    });
    assert.equal(ctx.envExtras["OPENCARA_PR_DIFF_INLINE"], "1");
    assert.equal(ctx.stdin.diff, "diff --git a/x b/x");
  });

  it("lists changed files from pulls/files, including rename sources", async () => {
    const app = fakeApp({
      paginate: async (route, params) => {
        assert.equal(route, "GET /repos/{owner}/{repo}/pulls/{pull_number}/files");
        assert.equal(params["pull_number"], 22);
        return [
          { filename: "src/a.ts" },
          { filename: "src/b.ts", previous_filename: "src/old.ts" },
        ];
      },
    });
    const ctx = await buildPullRequestContext(app, installation, project, payload, {
      diff: false,
      changedFiles: true,
    });
    assert.deepEqual(ctx.stdin.changedFiles, ["src/a.ts", "src/b.ts", "src/old.ts"]);
  });

  it("leaves changedFiles undefined when the file list fetch fails", async () => {
    const app = fakeApp({
      paginate: async () => {
        throw new Error("boom");
      },
    });
    const ctx = await buildPullRequestContext(app, installation, project, payload, {
      diff: false,
      changedFiles: true,
    });
    assert.equal(ctx.stdin.changedFiles, undefined);
  });
});

const baseCtx: PullRequestContext = {
  envExtras: {},
  stdin: { pr: { number: 1 }, diff: "diff --git a/x.ts b/x.ts\n", changedFiles: ["x.ts"] },
};

describe("changedFilesFor", () => {
  it("prefers the fetched file list", () => {
    assert.deepEqual(changedFilesFor(baseCtx), ["x.ts"]);
  });
  it("falls back to parsing the inline diff", () => {
    const { changedFiles: _c, ...stdin } = baseCtx.stdin;
    assert.deepEqual(changedFilesFor({ ...baseCtx, stdin }), ["x.ts"]);
  });
  it("is empty without a context", () => {
    assert.deepEqual(changedFilesFor(undefined), []);
  });
});

describe("prStdinForNode", () => {
  it("strips the diff and file list for a worktree node", () => {
    assert.deepEqual(prStdinForNode(baseCtx, true), { pr: { number: 1 }, diff: "" });
  });
  it("passes the context through for a node without a worktree", () => {
    assert.equal(prStdinForNode(baseCtx, false), baseCtx.stdin);
  });
});
