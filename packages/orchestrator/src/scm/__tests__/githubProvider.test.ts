import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Octokit } from "@octokit/rest";
import { createGithubProvider } from "../github/provider.js";

interface RecordedRequest {
  route: string;
  params: Record<string, unknown>;
}

/**
 * Minimal Octokit stand-in. `responder` returns the payload for each call, or
 * throws to simulate an API error; every call is recorded so a test can assert
 * on the retry sequence rather than just the final result.
 */
function fakeOctokit(
  responder: (call: RecordedRequest, index: number) => unknown,
): { octokit: Octokit; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const octokit = {
    request: async (route: string, params: Record<string, unknown>) => {
      const call = { route, params };
      requests.push(call);
      return responder(call, requests.length - 1);
    },
  } as unknown as Octokit;
  return { octokit, requests };
}

/** The 422 GitHub returns when the reviewing identity also opened the PR. */
function selfReviewError(): Error & { status: number } {
  const err = new Error("Can not approve your own pull request") as Error & {
    status: number;
  };
  err.status = 422;
  return err;
}

const PR = { number: 25, headSha: "abc123" };

describe("github provider postReview", () => {
  it("submits the review against the PR head sha", async () => {
    const { octokit, requests } = fakeOctokit(() => ({
      data: { id: 42, html_url: "https://github.com/o/r/pull/25#r42" },
    }));
    const provider = createGithubProvider({ octokit, owner: "o", repo: "r" });

    const res = await provider.postReview(PR, "APPROVE", "Ship it.");

    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.params.event, "APPROVE");
    assert.equal(requests[0]!.params.commit_id, "abc123");
    assert.equal(requests[0]!.params.pull_number, 25);
    assert.deepEqual(res, { reviewId: 42, htmlUrl: "https://github.com/o/r/pull/25#r42" });
  });

  it("substitutes a placeholder for an empty body", async () => {
    const { octokit, requests } = fakeOctokit(() => ({
      data: { id: 1, html_url: "u" },
    }));
    const provider = createGithubProvider({ octokit, owner: "o", repo: "r" });

    await provider.postReview(PR, "COMMENT", "");

    assert.equal(requests[0]!.params.body, "_(no review body)_");
  });

  // Single-account setups where OpenCara both opens and reviews the PR depend
  // on this: without the downgrade the review is simply lost, and the
  // downstream review-fix flow never sees a verdict.
  it("downgrades a self-review 422 to a COMMENT and preserves the verdict", async () => {
    const { octokit, requests } = fakeOctokit((_call, i) => {
      if (i === 0) throw selfReviewError();
      return { data: { id: 7, html_url: "https://github.com/o/r/pull/25#r7" } };
    });
    const provider = createGithubProvider({ octokit, owner: "o", repo: "r" });

    const res = await provider.postReview(PR, "APPROVE", "Looks good.");

    assert.equal(requests.length, 2);
    assert.equal(requests[1]!.params.event, "COMMENT");
    // The verdict line must survive into the body — flows/context.ts
    // resolveReviewStateFromBody parses it back out for review-fix flows.
    assert.match(String(requests[1]!.params.body), /^verdict: approve$/m);
    assert.match(String(requests[1]!.params.body), /Looks good\./);
    assert.equal(res.downgradedFrom, "APPROVE");
    assert.equal(res.reviewId, 7);
  });

  it("maps REQUEST_CHANGES onto the matching verdict token when downgrading", async () => {
    const { octokit, requests } = fakeOctokit((_call, i) => {
      if (i === 0) {
        const err = new Error(
          "Can not request changes on your own pull request",
        ) as Error & { status: number };
        err.status = 422;
        throw err;
      }
      return { data: { id: 8, html_url: "u" } };
    });
    const provider = createGithubProvider({ octokit, owner: "o", repo: "r" });

    const res = await provider.postReview(PR, "REQUEST_CHANGES", "Needs work.");

    assert.match(String(requests[1]!.params.body), /^verdict: request_changes$/m);
    assert.equal(res.downgradedFrom, "REQUEST_CHANGES");
  });

  it("propagates a non-self-review error without retrying", async () => {
    const { octokit, requests } = fakeOctokit(() => {
      const err = new Error("Server Error") as Error & { status: number };
      err.status = 500;
      throw err;
    });
    const provider = createGithubProvider({ octokit, owner: "o", repo: "r" });

    await assert.rejects(provider.postReview(PR, "APPROVE", "body"), /Server Error/);
    assert.equal(requests.length, 1);
  });

  it("reports both errors when the downgrade retry also fails", async () => {
    const { octokit } = fakeOctokit((_call, i) => {
      if (i === 0) throw selfReviewError();
      throw new Error("PR closed mid-run");
    });
    const provider = createGithubProvider({ octokit, owner: "o", repo: "r" });

    await assert.rejects(
      provider.postReview(PR, "APPROVE", "body"),
      (err: Error) =>
        /fallback to COMMENT failed/.test(err.message) &&
        /PR closed mid-run/.test(err.message) &&
        /Can not approve your own pull request/.test(err.message),
    );
  });
});

describe("github provider addComment / addLabel", () => {
  it("comments on the given issue number", async () => {
    const { octokit, requests } = fakeOctokit(() => ({
      data: { id: 99, html_url: "https://github.com/o/r/issues/3#c99" },
    }));
    const provider = createGithubProvider({ octokit, owner: "o", repo: "r" });

    const res = await provider.addComment(3, "hello");

    assert.equal(requests[0]!.params.issue_number, 3);
    assert.equal(requests[0]!.params.body, "hello");
    assert.deepEqual(res, {
      commentId: 99,
      htmlUrl: "https://github.com/o/r/issues/3#c99",
    });
  });

  it("substitutes a placeholder for an empty comment body", async () => {
    const { octokit, requests } = fakeOctokit(() => ({ data: { id: 1, html_url: "u" } }));
    const provider = createGithubProvider({ octokit, owner: "o", repo: "r" });

    await provider.addComment(3, "");

    assert.equal(requests[0]!.params.body, "_(no body)_");
  });

  it("returns the label set as GitHub reports it after the add", async () => {
    const { octokit, requests } = fakeOctokit(() => ({
      data: [{ name: "agent:claude" }, { name: "prompt:review" }],
    }));
    const provider = createGithubProvider({ octokit, owner: "o", repo: "r" });

    const res = await provider.addLabel(3, ["agent:claude"]);

    assert.deepEqual(requests[0]!.params.labels, ["agent:claude"]);
    assert.deepEqual(res.labels, ["agent:claude", "prompt:review"]);
  });
});

describe("github provider getPullRequestState", () => {
  it("reads state, merged and label names off GET /pulls/{n}", async () => {
    const { octokit, requests } = fakeOctokit(() => ({
      data: { state: "closed", merged: true, labels: [{ name: "no-review" }, { name: "bug" }] },
    }));
    const provider = createGithubProvider({ octokit, owner: "o", repo: "r" });
    const state = await provider.getPullRequestState(42);
    assert.deepEqual(state, { state: "closed", merged: true, labels: ["no-review", "bug"] });
    assert.equal(requests[0]!.route, "GET /repos/{owner}/{repo}/pulls/{pull_number}");
    assert.equal(requests[0]!.params.pull_number, 42);
  });

  it("an open PR without labels is open / not merged / []", async () => {
    const { octokit } = fakeOctokit(() => ({ data: { state: "open", merged: false, labels: [] } }));
    const provider = createGithubProvider({ octokit, owner: "o", repo: "r" });
    assert.deepEqual(await provider.getPullRequestState(7), { state: "open", merged: false, labels: [] });
  });
});

describe("github provider listPullRequestFiles", () => {
  /** Octokit stand-in whose `paginate` walks canned pages through mapFn. */
  function fakePaginatingOctokit(
    pages: { data: Record<string, unknown>[]; headers?: Record<string, string> }[],
  ): {
    octokit: Octokit;
    pageRoutes: string[];
  } {
    const pageRoutes: string[] = [];
    const octokit = {
      paginate: async (
        route: string,
        params: Record<string, unknown>,
        mapFn: (
          res: { data: unknown; headers?: Record<string, string> },
          done: () => void,
        ) => unknown[],
      ) => {
        let finished = false;
        const out: unknown[] = [];
        for (const page of pages) {
          if (finished) break;
          pageRoutes.push(route);
          const mapped = mapFn(page, () => {
            finished = true;
          });
          out.push(...mapped);
        }
        return out;
      },
    } as unknown as Octokit;
    return { octokit, pageRoutes };
  }

  const fileEntry = (filename: string, extra: Record<string, unknown> = {}) => ({
    filename,
    status: "modified",
    additions: 3,
    deletions: 1,
    ...extra,
  });

  it("maps file fields and derives diff anchors", async () => {
    const { octokit } = fakePaginatingOctokit([
      {
        data: [
          fileEntry("src/a.ts", { status: "added" }),
          fileEntry("src/b.ts", {
            status: "renamed",
            previous_filename: "src/old-b.ts",
          }),
          fileEntry("src/c.py", { status: "copied" }),
          fileEntry("src/d.ts", { status: "changed" }),
        ],
      },
    ]);
    const provider = createGithubProvider({ octokit, owner: "o", repo: "r" });
    const listing = await provider.listPullRequestFiles!(PR, { maxFiles: 100 });

    assert.equal(listing.prUrl, "https://github.com/o/r/pull/25");
    assert.equal(listing.truncated, false);
    assert.equal(listing.files.length, 4);
    assert.equal(listing.files[0]!.status, "added");
    assert.equal(listing.files[1]!.status, "renamed");
    assert.equal(listing.files[1]!.previousPath, "src/old-b.ts");
    assert.equal(listing.files[2]!.status, "added"); // copied → added
    assert.equal(listing.files[3]!.status, "modified"); // unknown → modified
    assert.match(
      listing.files[0]!.diffUrl!,
      /^https:\/\/github\.com\/o\/r\/pull\/25\/files#diff-[0-9a-f]{64}$/,
    );
  });

  it("stops paginating at maxFiles and flags truncation", async () => {
    const { octokit, pageRoutes } = fakePaginatingOctokit([
      { data: Array.from({ length: 3 }, (_, i) => fileEntry(`f${i}.ts`)) },
      { data: [fileEntry("f3.ts")] },
    ]);
    const provider = createGithubProvider({ octokit, owner: "o", repo: "r" });
    const listing = await provider.listPullRequestFiles!(PR, { maxFiles: 2 });

    assert.equal(listing.files.length, 2);
    assert.equal(listing.truncated, true);
    assert.equal(pageRoutes.length, 1); // second page never fetched
  });

  it("is not truncated when the file count lands exactly on the cap", async () => {
    const { octokit } = fakePaginatingOctokit([
      { data: [fileEntry("a.ts"), fileEntry("b.ts")] },
    ]);
    const provider = createGithubProvider({ octokit, owner: "o", repo: "r" });
    const listing = await provider.listPullRequestFiles!(PR, { maxFiles: 2 });

    assert.equal(listing.files.length, 2);
    assert.equal(listing.truncated, false);
  });

  it("flags truncation at the cap when a rel=next link remains", async () => {
    const { octokit } = fakePaginatingOctokit([
      {
        data: [fileEntry("a.ts"), fileEntry("b.ts")],
        headers: { link: '<https://api.github.com/x?page=2>; rel="next"' },
      },
    ]);
    const provider = createGithubProvider({ octokit, owner: "o", repo: "r" });
    const listing = await provider.listPullRequestFiles!(PR, { maxFiles: 2 });

    assert.equal(listing.files.length, 2);
    assert.equal(listing.truncated, true);
  });
});

describe("github provider readFileAtRef", () => {
  it("reads raw contents at the requested ref", async () => {
    const { octokit, requests } = fakeOctokit(() => ({ data: "file body" }));
    const provider = createGithubProvider({ octokit, owner: "o", repo: "r" });
    const out = await provider.readFileAtRef!("src/a.ts", "sha9");

    assert.equal(out, "file body");
    assert.equal(
      requests[0]!.route,
      "GET /repos/{owner}/{repo}/contents/{path}",
    );
    assert.equal(requests[0]!.params.path, "src/a.ts");
    assert.equal(requests[0]!.params.ref, "sha9");
    assert.deepEqual(requests[0]!.params.mediaType, { format: "raw" });
  });

  it("returns null on 404 and rethrows other errors", async () => {
    const notFound = Object.assign(new Error("Not found"), { status: 404 });
    const { octokit } = fakeOctokit(() => {
      throw notFound;
    });
    const provider = createGithubProvider({ octokit, owner: "o", repo: "r" });
    assert.equal(await provider.readFileAtRef!("gone.ts", "sha"), null);

    const boom = Object.assign(new Error("boom"), { status: 500 });
    const { octokit: oct2 } = fakeOctokit(() => {
      throw boom;
    });
    const provider2 = createGithubProvider({ octokit: oct2, owner: "o", repo: "r" });
    await assert.rejects(provider2.readFileAtRef!("x.ts", "sha"), /boom/);
  });
});
