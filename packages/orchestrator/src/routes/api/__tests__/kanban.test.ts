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

  it("prefers a match on contentNumber (manual Start payload)", () => {
    const byNumber = new Map<number, ImplementStatus>([[42, entry]]);
    const byNodeId = new Map<string, ImplementStatus>();
    const hit = pickImplementStatus(
      { contentNumber: 42, contentNodeId: null },
      { byNumber, byNodeId },
    );
    assert.equal(hit, entry);
  });

  it("falls back to contentNodeId (webhook projects_v2_item payload)", () => {
    const byNumber = new Map<number, ImplementStatus>();
    const byNodeId = new Map<string, ImplementStatus>([["I_abc", entry]]);
    const hit = pickImplementStatus(
      { contentNumber: 99, contentNodeId: "I_abc" },
      { byNumber, byNodeId },
    );
    // The number missing forces the node-id fallback to engage.
    assert.equal(hit, entry);
  });

  it("returns null when no map carries the item", () => {
    const hit = pickImplementStatus(
      { contentNumber: 7, contentNodeId: "I_z" },
      {
        byNumber: new Map(),
        byNodeId: new Map(),
      },
    );
    assert.equal(hit, null);
  });

  it("returns null when both keys are absent on the item (e.g. drafts)", () => {
    const byNumber = new Map<number, ImplementStatus>([[42, entry]]);
    const byNodeId = new Map<string, ImplementStatus>([["I_abc", entry]]);
    const hit = pickImplementStatus(
      { contentNumber: null, contentNodeId: null },
      { byNumber, byNodeId },
    );
    assert.equal(hit, null);
  });
});
