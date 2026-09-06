import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  foldLegacyReviewerSettings,
  graphHasPoolReviewer,
  isLegacyReviewerNodeId,
} from "../legacyReviewerPool.js";

const row = (
  id: string,
  nodeId: string,
  agentId: string | null,
  promptId: string | null = null,
  fallbackAgentIds: string[] = [],
) => ({ id, nodeId, agentId, promptId, fallbackAgentIds });

describe("isLegacyReviewerNodeId", () => {
  it("matches the fixed and operator-added reviewer ids, not the pool node", () => {
    assert.equal(isLegacyReviewerNodeId("reviewer_correctness"), true);
    assert.equal(isLegacyReviewerNodeId("reviewer_9e3fhd8s"), true);
    assert.equal(isLegacyReviewerNodeId("reviewer"), false);
    assert.equal(isLegacyReviewerNodeId("review_synthesizer"), false);
    assert.equal(isLegacyReviewerNodeId("single_reviewer"), false);
  });
});

describe("graphHasPoolReviewer", () => {
  it("requires an agent node with the pool id", () => {
    assert.equal(graphHasPoolReviewer([{ id: "reviewer", kind: "agent" }]), true);
    assert.equal(graphHasPoolReviewer([{ id: "reviewer", kind: "scm.add_label" }]), false);
    assert.equal(graphHasPoolReviewer([{ id: "reviewer_correctness", kind: "agent" }]), false);
  });
});

describe("foldLegacyReviewerSettings", () => {
  it("returns null when no legacy row carries an agent", () => {
    assert.equal(foldLegacyReviewerSettings([]), null);
    assert.equal(foldLegacyReviewerSettings([row("1", "reviewer_correctness", null, "p")]), null);
    assert.equal(foldLegacyReviewerSettings([row("1", "review_synthesizer", "a")]), null);
  });

  it("fixed ids come first in template order, then added reviewers by row id", () => {
    const folded = foldLegacyReviewerSettings([
      row("03", "reviewer_x1", "gemini"),
      row("01", "reviewer_style", "sonnet"),
      row("02", "reviewer_x0", "kimi"),
      row("04", "reviewer_correctness", "opus", "general"),
    ]);
    assert.deepEqual(folded, {
      agentId: "opus",
      fallbackAgentIds: ["sonnet", "kimi", "gemini"],
      promptId: "general",
      concurrency: 4,
      preferred: null,
      quorum: 1,
      sourceNodeIds: ["reviewer_correctness", "reviewer_style", "reviewer_x0", "reviewer_x1"],
    });
  });

  it("dedupes agents, skips agentless rows for concurrency, takes the first prompt", () => {
    const folded = foldLegacyReviewerSettings([
      row("1", "reviewer_correctness", "sonnet", "general", ["opus"]),
      row("2", "reviewer_performance", null, "other"),
      row("3", "reviewer_style", "opus", "style"),
    ]);
    assert.deepEqual(folded, {
      agentId: "sonnet",
      fallbackAgentIds: ["opus"],
      promptId: "general",
      concurrency: 2,
      preferred: null,
      quorum: 1,
      sourceNodeIds: ["reviewer_correctness", "reviewer_performance", "reviewer_style"],
    });
  });

  it("a single legacy reviewer becomes a plain one-agent pool", () => {
    const folded = foldLegacyReviewerSettings([row("1", "reviewer_correctness", "sonnet", "general")]);
    assert.equal(folded?.agentId, "sonnet");
    assert.deepEqual(folded?.fallbackAgentIds, []);
    assert.equal(folded?.concurrency, 1);
  });
});
