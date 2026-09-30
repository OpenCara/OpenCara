import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AzureDevopsApiError,
  AzureDevopsAuthError,
  type AzureDevopsClient,
} from "../../azure/client.js";
import { createAzureProvider, voteForReviewEvent, AZDO_VOTE } from "../azure/provider.js";

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Stand-in for AzureDevopsClient. `responder` may throw to simulate an API
 * refusal; every call is recorded so tests can assert on ordering, which is
 * load-bearing for postReview.
 */
function fakeClient(
  responder: (call: Recorded, index: number) => unknown = () => ({ id: 1 }),
): { client: AzureDevopsClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const client = {
    orgUrl: "https://dev.azure.com/contoso",
    request: async (url: string, init: { method?: string; body?: unknown } = {}) => {
      const call = { url, method: init.method ?? "GET", body: init.body };
      calls.push(call);
      return responder(call, calls.length - 1);
    },
    orgRequest: async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const call = {
        url: `https://dev.azure.com/contoso/${path}`,
        method: init.method ?? "GET",
        body: init.body,
      };
      calls.push(call);
      return responder(call, calls.length - 1);
    },
  } as unknown as AzureDevopsClient;
  return { client, calls };
}

function providerWith(
  responder?: (call: Recorded, index: number) => unknown,
): { provider: ReturnType<typeof createAzureProvider>; calls: Recorded[] } {
  const { client, calls } = fakeClient(responder);
  return {
    provider: createAzureProvider({
      client,
      projectName: "Team",
      repositoryId: "repo-guid",
      repositoryName: "widgets",
    }),
    calls,
  };
}

/** Default happy path: thread create → connectionData → vote PUT. */
function happyResponder(call: Recorded): unknown {
  if (call.url.endsWith("/threads")) return { id: 55 };
  if (call.url.includes("_apis/connectionData")) {
    return { authenticatedUser: { id: "identity-1" } };
  }
  return {};
}

const PR = { number: 42, headSha: "abc" };

describe("voteForReviewEvent", () => {
  it("maps APPROVE to the approved vote", () => {
    assert.equal(voteForReviewEvent("APPROVE"), AZDO_VOTE.approved);
    assert.equal(voteForReviewEvent("APPROVE"), 10);
  });

  it("maps REQUEST_CHANGES to rejected", () => {
    assert.equal(voteForReviewEvent("REQUEST_CHANGES"), AZDO_VOTE.rejected);
    assert.equal(voteForReviewEvent("REQUEST_CHANGES"), -10);
  });

  // 0 is a real statement ("no vote"), and it also clears a stale approval from
  // an earlier run — not the same as skipping the call.
  it("maps COMMENT to an explicit no-vote", () => {
    assert.equal(voteForReviewEvent("COMMENT"), AZDO_VOTE.noVote);
    assert.equal(voteForReviewEvent("COMMENT"), 0);
  });
});

describe("azure provider postReview", () => {
  it("posts the body as an active thread on the pull request", async () => {
    const { provider, calls } = providerWith(happyResponder);
    await provider.postReview(PR, "COMMENT", "Looks fine.");

    const thread = calls[0]!;
    assert.equal(thread.method, "POST");
    assert.ok(thread.url.includes("/pullRequests/42/threads"));
    const body = thread.body as { comments: { content: string }[]; status: string };
    assert.equal(body.comments[0]!.content, "Looks fine.");
    assert.equal(body.status, "active");
  });

  it("sets the reviewer vote after the thread, not before", async () => {
    // Ordering matters: if the vote were first and the thread failed, the PR
    // would carry a verdict with no explanation.
    const { provider, calls } = providerWith(happyResponder);
    await provider.postReview(PR, "APPROVE", "Ship it.");

    assert.ok(calls[0]!.url.endsWith("/threads"));
    const vote = calls.find((c) => c.method === "PUT");
    assert.ok(vote, "expected a vote PUT");
    assert.ok(vote.url.includes("/reviewers/identity-1"));
    assert.deepEqual(vote.body, { vote: 10 });
  });

  it("sends the rejected vote for REQUEST_CHANGES", async () => {
    const { provider, calls } = providerWith(happyResponder);
    await provider.postReview(PR, "REQUEST_CHANGES", "Needs work.");
    assert.deepEqual(calls.find((c) => c.method === "PUT")?.body, { vote: -10 });
  });

  // A COMMENT must still write vote 0. Skipping it would leave a prior
  // approval standing, and a branch policy could honour that stale approval to
  // merge a PR whose latest review raised a concern.
  it("clears a prior vote by writing 0 for a plain comment", async () => {
    const { provider, calls } = providerWith(happyResponder);
    await provider.postReview(PR, "COMMENT", "Just a note.");
    const vote = calls.find((c) => c.method === "PUT");
    assert.ok(vote, "expected a vote PUT even for a comment-only review");
    assert.deepEqual(vote.body, { vote: 0 });
  });

  it("resolves our identity once even across several reviews", async () => {
    // The vote now happens on every review, so an un-memoized connectionData
    // lookup would repeat per call.
    const { provider, calls } = providerWith(happyResponder);
    await provider.postReview(PR, "COMMENT", "one");
    await provider.postReview(PR, "APPROVE", "two");
    assert.equal(calls.filter((c) => c.url.includes("connectionData")).length, 1);
  });

  // Failing to clear is worth a log, not a status change: there was no verdict
  // being asserted, and the common benign case is "we were never a reviewer".
  it("does not report a downgrade when only the vote-clear fails", async () => {
    const { provider } = providerWith((call) => {
      if (call.url.endsWith("/threads")) return { id: 55 };
      if (call.url.includes("connectionData")) {
        return { authenticatedUser: { id: "identity-1" } };
      }
      throw Object.assign(new Error("not a reviewer"), { status: 404 });
    });
    const res = await provider.postReview(PR, "COMMENT", "note");
    assert.equal(res.downgradedFrom, undefined);
    assert.equal(res.reviewId, 55);
  });

  it("returns the thread id and a browsable url", async () => {
    const { provider } = providerWith(happyResponder);
    const res = await provider.postReview(PR, "COMMENT", "note");
    assert.equal(res.reviewId, 55);
    assert.match(String(res.htmlUrl), /pullrequest\/42\?discussionId=55/);
    // Browsable URLs use the repo NAME; the GUID is only for REST paths.
    assert.match(String(res.htmlUrl), /_git\/widgets\//);
    assert.doesNotMatch(String(res.htmlUrl), /_git\/repo-guid/);
  });

  it("substitutes a placeholder for an empty review body", async () => {
    const { provider, calls } = providerWith(happyResponder);
    await provider.postReview(PR, "COMMENT", "");
    const body = calls[0]!.body as { comments: { content: string }[] };
    assert.equal(body.comments[0]!.content, "_(no review body)_");
  });

  // The review prose is the expensive part (an agent produced it). A branch
  // policy refusing the vote must not discard it.
  it("keeps the posted review when the vote is refused, flagging the downgrade", async () => {
    const { provider, calls } = providerWith((call) => {
      if (call.url.endsWith("/threads")) return { id: 77 };
      if (call.url.includes("connectionData")) {
        return { authenticatedUser: { id: "identity-1" } };
      }
      throw new Error("VS403463: policy forbids self-approval");
    });

    const res = await provider.postReview(PR, "APPROVE", "Ship it.");

    assert.equal(res.reviewId, 77);
    assert.equal(res.downgradedFrom, "APPROVE");
    assert.ok(calls.some((c) => c.url.endsWith("/threads")));
  });

  it("propagates a failure to post the thread itself", async () => {
    // Nothing was published, so the step should fail and stay rerunnable.
    const { provider } = providerWith(() => {
      throw new Error("PR not found");
    });
    await assert.rejects(provider.postReview(PR, "COMMENT", "body"), /PR not found/);
  });

  it("rejects a thread response with no id rather than reporting a bogus review", async () => {
    const { provider } = providerWith(() => ({ nope: true }));
    await assert.rejects(provider.postReview(PR, "COMMENT", "body"), /no id/);
  });
});

describe("azure provider addComment / addLabel", () => {
  it("comments by opening a thread on the pull request", async () => {
    const { provider, calls } = providerWith(happyResponder);
    const res = await provider.addComment(42, "hello");

    assert.ok(calls[0]!.url.includes("/pullRequests/42/threads"));
    assert.equal(res.commentId, 55);
  });

  it("substitutes a placeholder for an empty comment", async () => {
    const { provider, calls } = providerWith(happyResponder);
    await provider.addComment(42, "");
    const body = calls[0]!.body as { comments: { content: string }[] };
    assert.equal(body.comments[0]!.content, "_(no body)_");
  });

  // Azure DevOps takes one label per request, unlike GitHub's array form.
  it("issues one request per label", async () => {
    const { provider, calls } = providerWith((call) =>
      call.url.endsWith("/labels") ? { name: (call.body as { name: string }).name } : {},
    );
    const res = await provider.addLabel(42, ["agent:claude", "prompt:review"]);

    const labelCalls = calls.filter((c) => c.url.endsWith("/labels"));
    assert.equal(labelCalls.length, 2);
    assert.deepEqual(labelCalls[0]!.body, { name: "agent:claude" });
    assert.deepEqual(res.labels, ["agent:claude", "prompt:review"]);
  });

  it("falls back to the requested name when the response omits it", async () => {
    const { provider } = providerWith(() => ({}));
    const res = await provider.addLabel(42, ["needs-review"]);
    assert.deepEqual(res.labels, ["needs-review"]);
  });
});

// The downgrade-to-comment path must stay narrow. A dead connection or a
// transient outage swallowed as "downgraded" makes every later review report
// success while the org actually needs reconnecting — an alert nobody gets.
describe("azure provider postReview — which vote failures degrade", () => {
  function voteFails(err: unknown) {
    return providerWith((call, i) => {
      if (call.url.endsWith("/threads")) return { id: 91 };
      if (call.url.includes("connectionData")) {
        return { authenticatedUser: { id: "identity-1" } };
      }
      void i;
      throw err;
    });
  }

  it("degrades on a policy refusal (4xx), keeping the posted review", async () => {
    const err = Object.assign(new Error("VS403463: self-approval forbidden"), {
      status: 403,
    });
    const { provider } = voteFails(err);
    const res = await provider.postReview(PR, "APPROVE", "Ship it.");
    assert.equal(res.downgradedFrom, "APPROVE");
  });

  it("fails the step on a dead connection instead of degrading forever", async () => {
    const { provider } = voteFails(
      new AzureDevopsAuthError("refresh token rejected — reconnect", "conn-1"),
    );
    await assert.rejects(provider.postReview(PR, "APPROVE", "Ship it."), /reconnect/);
  });

  it("fails the step on a transient 5xx so the run can be retried", async () => {
    const err = Object.assign(new Error("Service Unavailable"), { status: 503 });
    const { provider } = voteFails(err);
    await assert.rejects(provider.postReview(PR, "APPROVE", "Ship it."), /Service Unavailable/);
  });

  it("fails the step on a 429 rather than silently dropping the verdict", async () => {
    const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
    const { provider } = voteFails(err);
    await assert.rejects(provider.postReview(PR, "APPROVE", "Ship it."), /Too Many Requests/);
  });
});

describe("azure provider getPullRequestState", () => {
  it("maps completed → merged/closed and reads the labels list", async () => {
    const { provider, calls } = providerWith((call) => {
      if (call.url.endsWith("/labels")) return { value: [{ name: "no-review" }] };
      return { status: "completed" };
    });
    const state = await provider.getPullRequestState(42);
    assert.deepEqual(state, { state: "closed", merged: true, labels: ["no-review"] });
    const urls = calls.map((c) => c.url);
    assert.ok(urls.some((u) => u.endsWith("/pullRequests/42")));
    assert.ok(urls.some((u) => u.endsWith("/pullRequests/42/labels")));
    assert.ok(calls.every((c) => c.method === "GET"));
  });

  it("active → open; abandoned → closed but not merged", async () => {
    const open = providerWith((call) =>
      call.url.endsWith("/labels") ? { value: [] } : { status: "active" },
    );
    assert.deepEqual(await open.provider.getPullRequestState(1), { state: "open", merged: false, labels: [] });
    const abandoned = providerWith((call) =>
      call.url.endsWith("/labels") ? { value: [] } : { status: "abandoned" },
    );
    assert.deepEqual(await abandoned.provider.getPullRequestState(1), { state: "closed", merged: false, labels: [] });
  });
});

describe("azure provider listPullRequestFiles", () => {
  /**
   * Iterations deliberately arrive out of order: the current iteration is the
   * MAX id, not whatever the API happens to return last.
   */
  const changesResponder = (call: Recorded) => {
    if (call.url.endsWith("/iterations")) {
      return { value: [{ id: 3 }, { id: 7 }, { id: 5 }] };
    }
    if (call.url.includes("/iterations/7/changes")) {
      return {
        changeEntries: [
          { changeId: 1, changeType: "add", item: { objectId: "o1", path: "/src/new.ts" } },
          { changeId: 2, changeType: "edit", item: { objectId: "o2", path: "/src/edited.ts" } },
          { changeId: 3, changeType: "delete", item: { objectId: "o3", path: "/src/gone.ts" } },
          {
            changeId: 4,
            // The API may combine flags: a renamed file that was also edited.
            changeType: "rename,edit",
            sourceServerItem: "/src/oldname.ts",
            item: { objectId: "o4", path: "/src/newname.ts" },
          },
          // Directory entries appear in the change list and must be skipped.
          { changeId: 5, changeType: "add", item: { path: "/src/dir", isFolder: true } },
        ],
      };
    }
    throw new Error(`unexpected call ${call.url}`);
  };

  it("maps change types, strips the leading slash, and skips folders", async () => {
    const { provider } = providerWith(changesResponder);
    const listing = await provider.listPullRequestFiles!(PR, { maxFiles: 100 });

    assert.deepEqual(
      listing.files.map((f) => [f.path, f.status]),
      [
        ["src/new.ts", "added"],
        ["src/edited.ts", "modified"],
        ["src/gone.ts", "removed"],
        ["src/newname.ts", "renamed"],
      ],
    );
    // Rename carries the OLD path from sourceServerItem, slash stripped.
    assert.equal(listing.files[3]!.previousPath, "src/oldname.ts");
    // Azure reports no per-file line counts.
    assert.ok(listing.files.every((f) => f.additions === 0 && f.deletions === 0));
    assert.equal(listing.truncated, false);
  });

  it("queries the last (highest) iteration and overfetches $top by one", async () => {
    const { provider, calls } = providerWith(changesResponder);
    await provider.listPullRequestFiles!(PR, { maxFiles: 2 });

    const changes = calls.find((c) => c.url.includes("/changes"));
    assert.ok(changes, "expected a changes call");
    assert.ok(changes.url.includes("/iterations/7/changes"));
    assert.ok(changes.url.includes("$top=3"));
  });

  it("marks the listing truncated and trims when more files exist than maxFiles", async () => {
    const { provider } = providerWith(changesResponder);
    const listing = await provider.listPullRequestFiles!(PR, { maxFiles: 2 });

    assert.equal(listing.truncated, true);
    assert.equal(listing.files.length, 2);
  });

  it("also reports truncated when the response carries hasMore", async () => {
    const { provider } = providerWith((call) => {
      if (call.url.endsWith("/iterations")) return { value: [{ id: 1 }] };
      return {
        changeEntries: [
          { changeType: "edit", item: { path: "/a.ts" } },
          { changeType: "edit", item: { path: "/b.ts" } },
        ],
        hasMore: true,
      };
    });
    const listing = await provider.listPullRequestFiles!(PR, { maxFiles: 2 });
    assert.equal(listing.truncated, true);
    assert.equal(listing.files.length, 2);
  });

  it("builds a browsable prUrl from the repo NAME, not the guid", async () => {
    const { provider } = providerWith(changesResponder);
    const listing = await provider.listPullRequestFiles!(PR, { maxFiles: 100 });
    assert.equal(
      listing.prUrl,
      "https://dev.azure.com/contoso/Team/_git/widgets/pullrequest/42",
    );
  });

  it("uses originalPath as the rename fallback when sourceServerItem is absent", async () => {
    const { provider } = providerWith((call) => {
      if (call.url.endsWith("/iterations")) return { value: [{ id: 1 }] };
      return {
        changeEntries: [
          { changeType: "rename", originalPath: "/lib/before.ts", item: { path: "/lib/after.ts" } },
        ],
      };
    });
    const listing = await provider.listPullRequestFiles!(PR, { maxFiles: 100 });
    assert.deepEqual(listing.files[0], {
      path: "lib/after.ts",
      previousPath: "lib/before.ts",
      status: "renamed",
      additions: 0,
      deletions: 0,
    });
  });

  // "undelete" contains "delete" as a substring — the mapping must split on
  // commas and match tokens, or a restore would read as a removal.
  it("does not mistake an undelete change for a removal", async () => {
    const { provider } = providerWith((call) => {
      if (call.url.endsWith("/iterations")) return { value: [{ id: 1 }] };
      return {
        changeEntries: [{ changeType: "undelete", item: { path: "/src/restored.ts" } }],
      };
    });
    const listing = await provider.listPullRequestFiles!(PR, { maxFiles: 100 });
    assert.equal(listing.files[0]!.status, "modified");
  });

  it("fails when the pull request has no iterations", async () => {
    const { provider } = providerWith(() => ({ value: [] }));
    await assert.rejects(provider.listPullRequestFiles!(PR, { maxFiles: 10 }), /no iterations/);
  });

  it("propagates the API error when the PR is missing", async () => {
    const { provider } = providerWith(() => {
      throw new AzureDevopsApiError("PR not found", 404, "https://dev.azure.com/x");
    });
    await assert.rejects(provider.listPullRequestFiles!(PR, { maxFiles: 10 }), /PR not found/);
  });
});

describe("azure provider readFileAtRef", () => {
  it("returns the file content at the given commit", async () => {
    const { provider, calls } = providerWith(() => ({ content: "export const x = 1;" }));
    const out = await provider.readFileAtRef!("src/a.ts", "sha9");

    assert.equal(out, "export const x = 1;");
    const url = calls[0]!.url;
    assert.ok(url.includes("/_apis/git/repositories/repo-guid/items"));
    // The path arrives without a leading slash; the API wants "/src/a.ts"
    // encoded in the query string.
    assert.ok(url.includes(`path=${encodeURIComponent("/src/a.ts")}`));
    assert.ok(url.includes("versionDescriptor.version=sha9"));
    assert.ok(url.includes("versionDescriptor.versionType=commit"));
    assert.ok(url.includes("includeContent=true"));
  });

  it("returns null on a 404 instead of throwing", async () => {
    const { provider } = providerWith(() => {
      throw new AzureDevopsApiError("not found", 404, "https://dev.azure.com/x");
    });
    assert.equal(await provider.readFileAtRef!("gone.ts", "sha"), null);
  });

  it("returns null when the response carries no content (folder, binary)", async () => {
    const { provider } = providerWith(() => ({ objectId: "abc" }));
    assert.equal(await provider.readFileAtRef!("src", "sha"), null);
  });

  it("propagates non-404 errors", async () => {
    const { provider } = providerWith(() => {
      throw new AzureDevopsApiError("boom", 500, "https://dev.azure.com/x");
    });
    await assert.rejects(provider.readFileAtRef!("x.ts", "sha"), /boom/);
  });
});
