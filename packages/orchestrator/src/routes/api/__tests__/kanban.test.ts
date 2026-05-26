// Unit tests for the pure helpers behind the implement-status line on
// kanban cards. The DB-touching loadImplementStatuses is exercised
// end-to-end by manual smoke + the SSE stream — these tests just lock
// down the label mapping and the per-issue lookup tiebreak.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  labelForImplementStatus,
  pickImplementStatus,
  type ImplementStatus,
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
