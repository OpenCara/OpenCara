// Unit tests for the pure helpers behind the implement-status line on
// kanban cards. The DB-touching loadImplementStatuses is exercised
// end-to-end by manual smoke + the SSE stream — these tests just lock
// down the label mapping and the per-issue lookup tiebreak.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  labelForImplementStatus,
  pickImplementStatus,
  prFlowLabel,
  prNumberFromPayload,
  pickPrFlowStatus,
  type ImplementStatus,
  type PrFlowStatus,
} from "../kanban.js";

describe("labelForImplementStatus", () => {
  it("maps terminal flow_run statuses to their user-facing copy", () => {
    assert.equal(labelForImplementStatus("pending", null), "Queued");
    assert.equal(labelForImplementStatus("failed", null), "Failed");
    assert.equal(labelForImplementStatus("cancelled", null), "Cancelled");
  });

  it("uses the running step's nodeKind to refine the running label", () => {
    assert.equal(labelForImplementStatus("running", "agent"), "Implementing…");
    assert.equal(
      labelForImplementStatus("running", "git.create_pr"),
      "Creating PR…",
    );
    assert.equal(
      labelForImplementStatus("running", "git.create_worktree"),
      "Preparing worktree…",
    );
    assert.equal(
      labelForImplementStatus("running", "github.post_review"),
      "Posting review…",
    );
  });

  it("falls back to generic copy for unknown / missing kinds", () => {
    // No step yet → "Starting…". Unknown kind → generic "Working…". This
    // lets future flows render *something* without a server change here.
    assert.equal(labelForImplementStatus("running", null), "Starting…");
    assert.equal(
      labelForImplementStatus("running", "unknown.kind"),
      "Working…",
    );
  });
});

describe("pickImplementStatus", () => {
  const entry: ImplementStatus = {
    state: "running",
    label: "Implementing…",
    flowRunId: "01J0RUN",
    nodeKind: "agent",
  };

  it("matches a kanban item by its GraphQL contentNodeId", () => {
    const byNodeId = new Map<string, ImplementStatus>([["I_abc", entry]]);
    const hit = pickImplementStatus({ contentNodeId: "I_abc" }, { byNodeId });
    assert.equal(hit, entry);
  });

  it("returns null when the node id is absent from the map", () => {
    const hit = pickImplementStatus(
      { contentNodeId: "I_unknown" },
      { byNodeId: new Map() },
    );
    assert.equal(hit, null);
  });

  it("returns null for items without a contentNodeId (e.g. drafts)", () => {
    // Cross-repo collision regression: keying purely on node id (resolved
    // from the project's own issues table for manual-Start runs) means a
    // foreign-repo board item with the same `contentNumber` as an own-repo
    // issue with a running run will not pick up that status — because their
    // `contentNodeId`s differ even when the numbers don't.
    const byNodeId = new Map<string, ImplementStatus>([["I_abc", entry]]);
    const hit = pickImplementStatus({ contentNodeId: null }, { byNodeId });
    assert.equal(hit, null);
  });
});

describe("prFlowLabel", () => {
  it("maps each PR-review flow slug to a card-friendly label", () => {
    assert.equal(prFlowLabel("pr-review"), "PR Review");
    assert.equal(prFlowLabel("pr-review-multi"), "PR Review (multi-agent)");
    assert.equal(prFlowLabel("pr-review-fix"), "PR Review → Fix");
  });

  it("falls back to a generic PR Review label for unknown slugs", () => {
    assert.equal(prFlowLabel("development-lifecycle"), "PR Review");
  });
});

describe("prNumberFromPayload", () => {
  it("reads the inline pull_request.number (pull_request / review events)", () => {
    assert.equal(prNumberFromPayload({ pull_request: { number: 42 } }), 42);
  });

  it("falls back to issue.number when the issue is a PR (issue_comment)", () => {
    // issue_comment-on-PR carries no `pull_request`; the `issue.pull_request`
    // URL-bag marks the issue as actually being a PR.
    assert.equal(
      prNumberFromPayload({
        issue: { number: 17, pull_request: { url: "…" } },
      }),
      17,
    );
  });

  it("ignores issue.number for a plain issue (no issue.pull_request)", () => {
    assert.equal(prNumberFromPayload({ issue: { number: 17 } }), null);
  });

  it("returns null for payloads with no resolvable PR number", () => {
    assert.equal(prNumberFromPayload(null), null);
    assert.equal(prNumberFromPayload({}), null);
    assert.equal(prNumberFromPayload({ pull_request: {} }), null);
  });
});

describe("pickPrFlowStatus", () => {
  const review: PrFlowStatus = {
    state: "running",
    label: "PR Review",
    flowRunId: "01J0PRRUN",
    slug: "pr-review",
    prNumber: 42,
  };

  it("matches an issue item via one of its linked PR numbers", () => {
    const byPrNumber = new Map<number, PrFlowStatus>([[42, review]]);
    const hit = pickPrFlowStatus(
      { linkedPrs: [{ number: 42 }] },
      { byPrNumber },
    );
    assert.equal(hit, review);
  });

  it("scans all linked PRs and returns the first active one", () => {
    const byPrNumber = new Map<number, PrFlowStatus>([[42, review]]);
    const hit = pickPrFlowStatus(
      { linkedPrs: [{ number: 7 }, { number: 42 }] },
      { byPrNumber },
    );
    assert.equal(hit, review);
  });

  it("returns null when no linked PR has an active run", () => {
    const byPrNumber = new Map<number, PrFlowStatus>([[42, review]]);
    const hit = pickPrFlowStatus(
      { linkedPrs: [{ number: 7 }] },
      { byPrNumber },
    );
    assert.equal(hit, null);
  });

  it("returns null for an issue with no linked PRs", () => {
    const byPrNumber = new Map<number, PrFlowStatus>([[42, review]]);
    const hit = pickPrFlowStatus({ linkedPrs: [] }, { byPrNumber });
    assert.equal(hit, null);
  });
});
