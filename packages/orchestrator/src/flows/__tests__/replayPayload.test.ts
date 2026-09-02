import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { replayPayload } from "../engine.js";

/**
 * Rerun ("Restart flow") rebuilds its event from `platform_events`, but that
 * column does not hold the same shape on every platform: GitHub stores what it
 * dispatched, Azure DevOps stores the RAW service hook body and dispatches a
 * translation. Replaying an Azure row verbatim therefore fed the engine a
 * payload with no `action` at all, and every trigger skipped with
 * "action '' not in trigger filter" — on runs that had worked when the webhook
 * first arrived.
 */

// A real `git.pullrequest.updated` body, trimmed to the load-bearing fields.
const rawAzurePr = {
  id: "9b717aca-fb33-40f4-aa6d-ca02eabd0152",
  eventType: "git.pullrequest.created",
  resource: {
    pullRequestId: 23,
    status: "active",
    title: "Add audio bank loader",
    sourceRefName: "refs/heads/feat/audio",
    targetRefName: "refs/heads/main",
    lastMergeSourceCommit: { commitId: "aaa111" },
    lastMergeTargetCommit: { commitId: "bbb222" },
    repository: {
      id: "71e0caba-ebd2-49bf-9591-37aaa7835422",
      name: "ShiningPie",
      project: { id: "5350e7b4", name: "ShiningPie" },
    },
  },
};

describe("replayPayload", () => {
  it("passes a GitHub payload through untouched", () => {
    const stored = { action: "opened", pull_request: { number: 7 } };
    assert.equal(replayPayload("github", "pull_request", stored), stored);
  });

  // The regression: without normalization the engine sees no `action`.
  it("normalizes a stored Azure body so triggers can match on replay", () => {
    const replayed = replayPayload("azure_devops", "pull_request", rawAzurePr) as {
      action?: unknown;
      pull_request?: { number?: unknown };
    };
    assert.equal(replayed.action, "opened");
    assert.equal(replayed.pull_request?.number, 23);
  });

  it("recovers an action from the raw body, which carries none", () => {
    assert.equal((rawAzurePr as { action?: unknown }).action, undefined);
    const replayed = replayPayload("azure_devops", "pull_request", rawAzurePr) as {
      action?: unknown;
    };
    assert.notEqual(replayed.action, undefined);
    assert.notEqual(replayed.action, "");
  });

  it("normalizes a stored Azure comment body, thread id included", () => {
    const rawComment = {
      id: "cdde3fdb",
      eventType: "ms.vss-code.git-pullrequest-comment-event",
      resource: {
        id: 1,
        content: "@opencara review",
        author: { uniqueName: "quabug@msn.com" },
        _links: {
          self: {
            href: "https://dev.azure.com/ShiningPie/_apis/git/repositories/71e0caba-ebd2-49bf-9591-37aaa7835422/pullRequests/23/threads/97/comments/1",
          },
          repository: {
            href: "https://dev.azure.com/ShiningPie/5350e7b4-75b9-4bfc-a2f4-75584cabdc95/_apis/git/repositories/71e0caba-ebd2-49bf-9591-37aaa7835422",
          },
        },
      },
    };
    const replayed = replayPayload("azure_devops", "issue_comment", rawComment) as {
      action?: unknown;
      comment?: { body?: unknown; thread_id?: unknown };
    };
    assert.equal(replayed.action, "created");
    assert.equal(replayed.comment?.body, "@opencara review");
    assert.equal(replayed.comment?.thread_id, 97);
  });

  // Fail-soft: an unmappable row must still replay as it did before, not throw
  // and take the whole rerun down.
  it("falls back to the stored payload when normalization fails", () => {
    const junk = { nothing: "useful" };
    assert.equal(replayPayload("azure_devops", "pull_request", junk), junk);
  });
});
