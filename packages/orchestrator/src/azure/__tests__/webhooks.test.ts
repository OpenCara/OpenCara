import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBasicAuthPassword, secretMatches } from "../webhookAuth.js";
import { normalizeAzureEvent } from "../events.js";
import { AZDO_EVENT_TYPES, deleteSubscriptions } from "../hooks.js";
import type { AzureDevopsClient } from "../client.js";

const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

describe("parseBasicAuthPassword", () => {
  it("extracts the password half", () => {
    assert.equal(parseBasicAuthPassword(basic("opencara", "s3cret")), "s3cret");
  });

  it("accepts a colon inside the password", () => {
    // Azure DevOps lets an operator set any password; splitting on the LAST
    // colon instead of the first would silently truncate these.
    assert.equal(parseBasicAuthPassword(basic("u", "a:b:c")), "a:b:c");
  });

  it("accepts an empty username", () => {
    assert.equal(parseBasicAuthPassword(basic("", "only-pass")), "only-pass");
  });

  it("is case-insensitive on the scheme", () => {
    const header = basic("u", "p").replace("Basic", "basic");
    assert.equal(parseBasicAuthPassword(header), "p");
  });

  it("returns null for a missing header", () => {
    assert.equal(parseBasicAuthPassword(undefined), null);
  });

  it("returns null for a non-Basic scheme", () => {
    assert.equal(parseBasicAuthPassword("Bearer abc.def.ghi"), null);
  });

  it("returns null when the decoded value has no colon", () => {
    const header = `Basic ${Buffer.from("nocolon").toString("base64")}`;
    assert.equal(parseBasicAuthPassword(header), null);
  });
});

describe("secretMatches", () => {
  it("accepts the exact secret", () => {
    assert.equal(secretMatches("correct-horse", "correct-horse"), true);
  });

  it("rejects a wrong secret of the same length", () => {
    assert.equal(secretMatches("correct-horsE", "correct-horse"), false);
  });

  it("rejects a wrong secret of a different length", () => {
    // timingSafeEqual throws on length mismatch; this must not surface as an
    // exception (which would 500 instead of 401).
    assert.doesNotThrow(() => secretMatches("short", "much-longer-secret"));
    assert.equal(secretMatches("short", "much-longer-secret"), false);
  });

  it("rejects a null (absent header) without throwing", () => {
    assert.equal(secretMatches(null, "expected"), false);
  });

  it("rejects the empty string", () => {
    assert.equal(secretMatches("", "expected"), false);
  });

  it("rejects a prefix of the real secret", () => {
    assert.equal(secretMatches("correct", "correct-horse"), false);
  });
});

describe("AZDO_EVENT_TYPES", () => {
  it("does not subscribe to both updated and merged", () => {
    // The merge outcome arrives on git.pullrequest.updated; subscribing to
    // git.pullrequest.merged as well doubles every delivery.
    assert.ok(AZDO_EVENT_TYPES.includes("git.pullrequest.updated"));
    assert.ok(!(AZDO_EVENT_TYPES as readonly string[]).includes("git.pullrequest.merged"));
  });
});

const prResource = {
  pullRequestId: 42,
  status: "active",
  title: "Add widget",
  description: "body text",
  sourceRefName: "refs/heads/feature/widget",
  targetRefName: "refs/heads/main",
  isDraft: false,
  lastMergeSourceCommit: { commitId: "aaa111" },
  lastMergeTargetCommit: { commitId: "bbb222" },
  createdBy: { displayName: "Ada", uniqueName: "ada@contoso.com" },
  repository: {
    id: "repo-guid",
    name: "widgets",
    project: { id: "proj-guid", name: "Team" },
  },
};

describe("normalizeAzureEvent — pull requests", () => {
  it("maps a created PR to the opened action", () => {
    const ev = normalizeAzureEvent({
      id: "delivery-1",
      eventType: "git.pullrequest.created",
      resource: prResource,
    });
    assert.ok(ev);
    assert.equal(ev.type, "pull_request");
    assert.equal(ev.deliveryId, "delivery-1");
    assert.equal(ev.repositoryId, "repo-guid");
    assert.equal(ev.projectId, "proj-guid");
    assert.equal((ev.payload as { action: string }).action, "opened");
  });

  // Azure DevOps has no distinct "new commits pushed" event — a push arrives as
  // `updated`, and mapping it to synchronize is what re-runs a review when the
  // author pushes a fix.
  it("maps an updated active PR to synchronize", () => {
    const ev = normalizeAzureEvent({
      eventType: "git.pullrequest.updated",
      resource: prResource,
    });
    assert.equal((ev!.payload as { action: string }).action, "synchronize");
  });

  it("maps a completed PR to closed", () => {
    const ev = normalizeAzureEvent({
      eventType: "git.pullrequest.updated",
      resource: { ...prResource, status: "completed" },
    });
    assert.equal((ev!.payload as { action: string }).action, "closed");
  });

  it("maps an abandoned PR to closed", () => {
    const ev = normalizeAzureEvent({
      eventType: "git.pullrequest.updated",
      resource: { ...prResource, status: "abandoned" },
    });
    assert.equal((ev!.payload as { action: string }).action, "closed");
  });

  it("shortens ref names the way the worktree code expects", () => {
    const ev = normalizeAzureEvent({
      eventType: "git.pullrequest.created",
      resource: prResource,
    });
    const pr = (ev!.payload as { pull_request: { head: { ref: string; sha: string }; base: { ref: string } } })
      .pull_request;
    assert.equal(pr.head.ref, "feature/widget");
    assert.equal(pr.base.ref, "main");
    assert.equal(pr.head.sha, "aaa111");
  });

  it("exposes the PR number where the engine looks for it", () => {
    const ev = normalizeAzureEvent({
      eventType: "git.pullrequest.created",
      resource: prResource,
    });
    assert.equal((ev!.payload as { pull_request: { number: number } }).pull_request.number, 42);
  });

  it("builds a project-qualified repository full_name", () => {
    const ev = normalizeAzureEvent({
      eventType: "git.pullrequest.created",
      resource: prResource,
    });
    assert.equal(
      (ev!.payload as { repository: { full_name: string } }).repository.full_name,
      "Team/widgets",
    );
  });

  it("tolerates a PR with no merge commits yet", () => {
    const ev = normalizeAzureEvent({
      eventType: "git.pullrequest.created",
      resource: {
        ...prResource,
        lastMergeSourceCommit: undefined,
        lastMergeTargetCommit: undefined,
      },
    });
    assert.ok(ev);
    assert.equal(
      (ev.payload as { pull_request: { head: { sha: string } } }).pull_request.head.sha,
      "",
    );
  });
});

describe("normalizeAzureEvent — PR comments", () => {
  const commentResource = {
    comment: {
      id: 7,
      content: "@opencara review",
      author: { uniqueName: "grace@contoso.com" },
    },
    pullRequest: prResource,
  };

  it("maps to issue_comment so the comment-phrase trigger path applies", () => {
    const ev = normalizeAzureEvent({
      eventType: "ms.vss-code.git-pullrequest-comment-event",
      resource: commentResource,
    });
    assert.ok(ev);
    assert.equal(ev.type, "issue_comment");
    assert.equal((ev.payload as { action: string }).action, "created");
  });

  // The engine skips comments unless issue.pull_request is set — without this
  // marker every comment trigger would be dropped as "on a plain issue".
  it("marks the issue as a pull request", () => {
    const ev = normalizeAzureEvent({
      eventType: "ms.vss-code.git-pullrequest-comment-event",
      resource: commentResource,
    });
    const issue = (ev!.payload as { issue: { number: number; pull_request: unknown } }).issue;
    assert.equal(issue.number, 42);
    assert.ok(issue.pull_request);
  });

  it("carries the comment body for phrase matching", () => {
    const ev = normalizeAzureEvent({
      eventType: "ms.vss-code.git-pullrequest-comment-event",
      resource: commentResource,
    });
    assert.equal((ev!.payload as { comment: { body: string } }).comment.body, "@opencara review");
  });

  it("also carries the pull_request object so post_review can resolve it", () => {
    const ev = normalizeAzureEvent({
      eventType: "ms.vss-code.git-pullrequest-comment-event",
      resource: commentResource,
    });
    assert.ok((ev!.payload as { pull_request?: unknown }).pull_request);
  });
});

describe("normalizeAzureEvent — work items", () => {
  it("maps a work item update and keeps the raw field map", () => {
    const ev = normalizeAzureEvent({
      eventType: "workitem.updated",
      resource: {
        workItemId: 314,
        fields: {
          "System.BoardColumn": { oldValue: "Backlog", newValue: "Ready" },
          "System.TeamProject": "proj-guid",
        },
      },
    });
    assert.ok(ev);
    assert.equal(ev.type, "work_item");
    assert.equal(ev.projectId, "proj-guid");
    const wi = (ev.payload as { work_item: { id: number; fields: Record<string, unknown> } })
      .work_item;
    assert.equal(wi.id, 314);
    assert.deepEqual(wi.fields["System.BoardColumn"], {
      oldValue: "Backlog",
      newValue: "Ready",
    });
  });

  it("reads the project from a newValue-shaped field on an update", () => {
    const ev = normalizeAzureEvent({
      eventType: "workitem.updated",
      resource: {
        id: 1,
        fields: { "System.TeamProject": { oldValue: "old", newValue: "proj-2" } },
      },
    });
    assert.equal(ev!.projectId, "proj-2");
  });

  it("returns a null projectId rather than guessing when the field is absent", () => {
    const ev = normalizeAzureEvent({
      eventType: "workitem.created",
      resource: { id: 5, fields: {} },
    });
    assert.equal(ev!.projectId, null);
  });
});

describe("normalizeAzureEvent — rejections", () => {
  it("returns null for an unsubscribed event type", () => {
    assert.equal(
      normalizeAzureEvent({ eventType: "build.complete", resource: {} }),
      null,
    );
  });

  it("returns null for a payload with no eventType", () => {
    assert.equal(normalizeAzureEvent({ resource: {} }), null);
  });

  it("returns null for a PR event whose resource is malformed", () => {
    assert.equal(
      normalizeAzureEvent({ eventType: "git.pullrequest.created", resource: { nope: 1 } }),
      null,
    );
  });

  it("returns null for a non-object payload", () => {
    assert.equal(normalizeAzureEvent("nope"), null);
    assert.equal(normalizeAzureEvent(null), null);
  });
});

// Subscriptions live in the CUSTOMER's Azure DevOps organization, so removing
// a project must delete them there — dropping our row does nothing. Left
// behind they are permanent: the webhook handler answers 200 for an unmatched
// repo (so Azure never auto-disables them), and they keep firing forever.
describe("deleteSubscriptions", () => {
  function fakeClient(responder: (id: string) => void = () => {}) {
    const deleted: { path: string; method: string }[] = [];
    const client = {
      orgRequest: async (path: string, init: { method?: string } = {}) => {
        deleted.push({ path, method: init.method ?? "GET" });
        responder(path);
        return {};
      },
    } as unknown as AzureDevopsClient;
    return { client, deleted };
  }

  it("issues one DELETE per subscription id", async () => {
    const { client, deleted } = fakeClient();
    await deleteSubscriptions(client, ["sub-1", "sub-2", "sub-3"]);

    assert.equal(deleted.length, 3);
    assert.ok(deleted.every((d) => d.method === "DELETE"));
    assert.ok(deleted[0]!.path.endsWith("/hooks/subscriptions/sub-1"));
    assert.ok(deleted[2]!.path.endsWith("/hooks/subscriptions/sub-3"));
  });

  // One dead subscription must not strand the rest — a partial teardown leaves
  // exactly the silent leak this exists to prevent.
  it("continues past a failing delete instead of aborting the rest", async () => {
    const { client, deleted } = fakeClient((path) => {
      if (path.includes("sub-2")) throw new Error("VS404: subscription not found");
    });
    await assert.doesNotReject(deleteSubscriptions(client, ["sub-1", "sub-2", "sub-3"]));
    assert.equal(deleted.length, 3);
  });

  it("url-encodes ids rather than interpolating them raw", async () => {
    const { client, deleted } = fakeClient();
    await deleteSubscriptions(client, ["a/b c"]);
    assert.ok(deleted[0]!.path.endsWith("/hooks/subscriptions/a%2Fb%20c"));
  });

  it("does nothing for an empty list", async () => {
    const { client, deleted } = fakeClient();
    await deleteSubscriptions(client, []);
    assert.equal(deleted.length, 0);
  });
});
