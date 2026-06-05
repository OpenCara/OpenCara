import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { developmentLifecycleFlow, type FlowDefinition } from "@opencara/flows";
import { computeActiveSubgraph } from "../engine.js";

// A compact two-trigger graph: trigger A → agent a1, trigger B → agent b1.
// The two subgraphs are disconnected components, exactly like the unified
// lifecycle flow's stages.
const twoTriggerFlow: FlowDefinition = {
  slug: "two-trigger",
  name: "Two trigger",
  description: "test",
  nodes: [
    {
      id: "tA",
      kind: "github.projects_v2_item",
      position: { x: 0, y: 0 },
      config: {
        projectNumber: null,
        fieldName: "Status",
        toOptions: ["Ready"],
        fromOptions: [],
        contentTypes: ["Issue"],
      },
    },
    {
      id: "a1",
      kind: "agent",
      position: { x: 200, y: 0 },
      config: {
        label: "A",
        draftPr: false,
        contextInjection: { env: [], stdinJson: true },
      },
    },
    {
      id: "tB",
      kind: "github.pull_request",
      position: { x: 0, y: 200 },
      config: {
        actions: ["opened"],
        branches: [],
        branchesIgnore: [],
        paths: [],
        pathsIgnore: [],
        labels: [],
        labelsIgnore: [],
        ignoreDrafts: false,
        commentPhrase: "",
      },
    },
    {
      id: "b1",
      kind: "agent",
      position: { x: 200, y: 200 },
      config: {
        label: "B",
        draftPr: false,
        contextInjection: { env: [], stdinJson: true },
      },
    },
  ],
  edges: [
    { id: "eA", source: "tA", target: "a1" },
    { id: "eB", source: "tB", target: "b1" },
  ],
};

describe("computeActiveSubgraph", () => {
  it("activates only the subgraph rooted at the matched trigger", () => {
    const active = computeActiveSubgraph(twoTriggerFlow, ["tA"]);
    assert.deepEqual([...active].sort(), ["a1", "tA"]);
    assert.equal(active.has("tB"), false);
    assert.equal(active.has("b1"), false);
  });

  it("activates the other subgraph when the other trigger matches", () => {
    const active = computeActiveSubgraph(twoTriggerFlow, ["tB"]);
    assert.deepEqual([...active].sort(), ["b1", "tB"]);
  });

  it("returns an empty set when no trigger matched", () => {
    const active = computeActiveSubgraph(twoTriggerFlow, []);
    assert.equal(active.size, 0);
  });

  it("unions the reachable nodes when several triggers match", () => {
    const active = computeActiveSubgraph(twoTriggerFlow, ["tA", "tB"]);
    assert.deepEqual([...active].sort(), ["a1", "b1", "tA", "tB"]);
  });
});

describe("computeActiveSubgraph on the unified development-lifecycle flow", () => {
  it("routes a projects_v2_item match to the implement stage only", () => {
    const active = computeActiveSubgraph(developmentLifecycleFlow, ["implement_trigger"]);
    assert.deepEqual([...active].sort(), ["implement", "implement_trigger"]);
  });

  it("routes a pull_request match to the review stage only", () => {
    const active = computeActiveSubgraph(developmentLifecycleFlow, ["review_trigger"]);
    assert.deepEqual(
      [...active].sort(),
      [
        "post_review",
        "review_synthesizer",
        "review_trigger",
        "reviewer_correctness",
        "reviewer_performance",
        "reviewer_style",
      ],
    );
  });

  it("routes a pull_request_review match to the fix stage only", () => {
    const active = computeActiveSubgraph(developmentLifecycleFlow, ["fix_trigger"]);
    assert.deepEqual([...active].sort(), ["fix", "fix_trigger"]);
  });
});
