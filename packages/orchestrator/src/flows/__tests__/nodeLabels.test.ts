import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildNodeLabels } from "../engine.js";

const NODES = [
  { id: "pr", kind: "scm.pull_request" },
  { id: "reviewer_1", kind: "agent" },
  { id: "reviewer_2", kind: "agent" },
  { id: "synth", kind: "agent" },
  { id: "post", kind: "scm.post_review" },
];

const setting = (
  nodeId: string,
  over: { label?: string | null; agentId?: string | null } = {},
) => ({ nodeId, label: over.label ?? null, agentId: over.agentId ?? null });

const AGENT_NAMES = new Map([
  ["a_opus", "opus-reviewer"],
  ["a_codex", "codex-reviewer"],
]);

describe("buildNodeLabels", () => {
  it("names an agent node after its linked agent", () => {
    const labels = buildNodeLabels(
      NODES,
      [setting("reviewer_1", { agentId: "a_opus" })],
      AGENT_NAMES,
    );
    assert.equal(labels.get("reviewer_1"), "opus-reviewer");
  });

  it("prefers the linked agent over a per-node rename", () => {
    // The rename is what the add-reviewer route auto-writes ("Reviewer 2") —
    // useless as a synthesizer section heading next to the real agent name.
    const labels = buildNodeLabels(
      NODES,
      [setting("reviewer_2", { agentId: "a_codex", label: "Reviewer 2" })],
      AGENT_NAMES,
    );
    assert.equal(labels.get("reviewer_2"), "codex-reviewer");
  });

  it("falls back to the stored label when no agent is linked", () => {
    const labels = buildNodeLabels(
      NODES,
      [setting("reviewer_1", { label: "Correctness reviewer" })],
      AGENT_NAMES,
    );
    assert.equal(labels.get("reviewer_1"), "Correctness reviewer");
  });

  it("leaves non-agent nodes on their stored label even with an agentId set", () => {
    const labels = buildNodeLabels(
      NODES,
      [setting("post", { agentId: "a_opus", label: "Publish" })],
      AGENT_NAMES,
    );
    assert.equal(labels.get("post"), "Publish");
  });

  it("omits a node with neither a linked agent nor a label (buildFanInInput falls back to the id)", () => {
    const labels = buildNodeLabels(NODES, [setting("synth")], AGENT_NAMES);
    assert.equal(labels.has("synth"), false);
  });

  it("ignores a link to a deleted/unknown agent rather than blanking the heading", () => {
    const labels = buildNodeLabels(
      NODES,
      [setting("reviewer_1", { agentId: "a_gone", label: "Reviewer 1" })],
      AGENT_NAMES,
    );
    assert.equal(labels.get("reviewer_1"), "Reviewer 1");
  });

  it("skips settings whose node is no longer in the graph", () => {
    const labels = buildNodeLabels(
      NODES,
      [setting("removed_reviewer", { agentId: "a_opus" })],
      AGENT_NAMES,
    );
    assert.equal(labels.has("removed_reviewer"), false);
  });
});
