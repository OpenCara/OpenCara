import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFanInInput } from "../engine.js";
import type { FlowNode, NodeOutput } from "../engine.js";

const REVIEW = "verdict: comment\n\nSolid, well-scoped diff.";

function agentNode(id = "synth"): FlowNode {
  return { id, kind: "agent", position: { x: 0, y: 0 }, config: {} } as FlowNode;
}

function actionNode(id = "post"): FlowNode {
  return {
    id,
    kind: "scm.post_review",
    position: { x: 0, y: 0 },
    config: { event: "COMMENT" },
  } as FlowNode;
}

const edge = (source: string, target: string, id = `${source}->${target}`) => ({
  id,
  source,
  target,
});

describe("buildFanInInput", () => {
  it("returns undefined for a node with no incoming edges", () => {
    const out = buildFanInInput(agentNode(), [], new Map(), new Map());
    assert.equal(out, undefined);
  });

  it("passes a single upstream verbatim into an action node (post_review body must stay clean)", () => {
    const out = buildFanInInput(
      actionNode(),
      [edge("synth", "post")],
      new Map([["synth", REVIEW]]),
      new Map(),
    );
    assert.equal(out, REVIEW);
  });

  it("labels a single upstream into an agent node so a pasted review can't read as the agent's own turn", () => {
    const out = buildFanInInput(
      agentNode(),
      [edge("reviewer_correctness", "synth")],
      new Map([["reviewer_correctness", REVIEW]]),
      new Map(),
    );
    assert.equal(out, `## From reviewer_correctness\n\n${REVIEW}`);
  });

  it("prefers the operator-set label over the node id for the section heading", () => {
    const out = buildFanInInput(
      agentNode(),
      [edge("reviewer_correctness", "synth")],
      new Map([["reviewer_correctness", REVIEW]]),
      new Map([["reviewer_correctness", "Correctness reviewer"]]),
    );
    assert.equal(out, `## From Correctness reviewer\n\n${REVIEW}`);
  });

  it("keeps undefined/empty single upstream untouched so the no-upstream sentinel still fires", () => {
    // Trigger nodes capture no stdout; the agent runner substitutes its
    // "(no upstream output …)" sentinel only when previousOutput is empty.
    const fromTrigger = buildFanInInput(
      agentNode(),
      [edge("t1", "synth")],
      new Map([["t1", undefined]]),
      new Map(),
    );
    assert.equal(fromTrigger, undefined);

    const fromBlank = buildFanInInput(
      agentNode(),
      [edge("t1", "synth")],
      new Map([["t1", "  \n"]]),
      new Map(),
    );
    assert.equal(fromBlank, "  \n");
  });

  it("disambiguates colliding headings with the node id (two reviewers, one agent)", () => {
    const out = buildFanInInput(
      agentNode(),
      [edge("r1", "synth"), edge("r2", "synth"), edge("r3", "synth")],
      new Map([
        ["r1", "first review"],
        ["r2", "second review"],
        ["r3", "third review"],
      ]),
      new Map([
        ["r1", "Claude Opus"],
        ["r2", "Claude Opus"],
        ["r3", "Codex GPT"],
      ]),
    );
    assert.equal(
      out,
      "## From Claude Opus (r1)\n\nfirst review\n\n---\n\n" +
        "## From Claude Opus (r2)\n\nsecond review\n\n---\n\n" +
        "## From Codex GPT\n\nthird review",
    );
  });

  it("joins 2+ upstreams as labeled markdown sections", () => {
    const out = buildFanInInput(
      agentNode(),
      [edge("r1", "synth"), edge("r2", "synth")],
      new Map([
        ["r1", "first review"],
        ["r2", "second review"],
      ]),
      new Map([["r1", "Correctness reviewer"]]),
    );
    assert.equal(
      out,
      "## From Correctness reviewer\n\nfirst review\n\n---\n\n## From r2\n\nsecond review",
    );
  });

  it("expands a pool node's several successes into one section per agent", () => {
    const out = buildFanInInput(
      agentNode(),
      [edge("reviewer", "synth")],
      new Map<string, NodeOutput>([
        [
          "reviewer",
          [
            { agentName: "Claude Opus", text: "first review" },
            { agentName: "omp gemini", text: "second review" },
          ],
        ],
      ]),
      new Map([["reviewer", "Claude Opus"]]),
    );
    assert.equal(
      out,
      "## From Claude Opus\n\nfirst review\n\n---\n\n## From omp gemini\n\nsecond review",
    );
  });

  it("mixes pool parts with sibling nodes and suffixes colliding agent names", () => {
    const out = buildFanInInput(
      agentNode(),
      [edge("reviewer", "synth"), edge("extra", "synth")],
      new Map<string, NodeOutput>([
        ["reviewer", [{ agentName: "Claude Opus", text: "pool review" }]],
        ["extra", "extra review"],
      ]),
      new Map([["extra", "Claude Opus"]]),
    );
    assert.equal(
      out,
      "## From Claude Opus (reviewer)\n\npool review\n\n---\n\n" +
        "## From Claude Opus (extra)\n\nextra review",
    );
  });
});
