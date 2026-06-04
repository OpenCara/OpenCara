import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FlowDefinitionSchema,
  builtinFlows,
  isTriggerKind,
  issueLifecycleFlow,
} from "@opencara/flows";

const baseFlow = {
  slug: "test-flow",
  name: "Test Flow",
  description: "Test flow",
  nodes: [
    {
      id: "t1",
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
      position: { x: 320, y: 0 },
      config: {
        label: "Implement agent",
        contextInjection: { env: [], stdinJson: true },
      },
    },
  ],
  edges: [{ id: "e1", source: "t1", target: "a1" }],
};

describe("FlowDefinitionSchema agent draftPr", () => {
  it("round-trips draftPr true", () => {
    const parsed = FlowDefinitionSchema.parse({
      ...baseFlow,
      nodes: [
        baseFlow.nodes[0],
        {
          ...baseFlow.nodes[1],
          config: {
            ...baseFlow.nodes[1]!.config,
            draftPr: true,
          },
        },
      ],
    });
    const agent = parsed.nodes.find((node) => node.kind === "agent");
    assert.equal(agent?.config.draftPr, true);
  });

  it("defaults draftPr to false when omitted", () => {
    const parsed = FlowDefinitionSchema.parse(baseFlow);
    const agent = parsed.nodes.find((node) => node.kind === "agent");
    assert.equal(agent?.config.draftPr, false);
  });
});

describe("FlowDefinitionSchema agent review-fix options", () => {
  it("round-trips autoMerge and maxIterations config", () => {
    const parsed = FlowDefinitionSchema.parse({
      ...baseFlow,
      nodes: [
        baseFlow.nodes[0],
        {
          ...baseFlow.nodes[1],
          config: {
            ...baseFlow.nodes[1]!.config,
            autoMerge: {
              enabled: true,
              method: "rebase",
              requireChecks: false,
              requireApproval: true,
              mergeWithoutChanges: true,
            },
            maxIterations: {
              enabled: true,
              limit: 5,
              commentOnSkip: true,
            },
          },
        },
      ],
    });
    const agent = parsed.nodes.find((node) => node.kind === "agent");
    assert.deepEqual(agent?.config.autoMerge, {
      enabled: true,
      method: "rebase",
      requireChecks: false,
      requireApproval: true,
      mergeWithoutChanges: true,
    });
    assert.deepEqual(agent?.config.maxIterations, {
      enabled: true,
      limit: 5,
      commentOnSkip: true,
    });
  });

  it("leaves autoMerge and maxIterations absent by default", () => {
    const parsed = FlowDefinitionSchema.parse(baseFlow);
    const agent = parsed.nodes.find((node) => node.kind === "agent");
    assert.equal(agent?.config.autoMerge, undefined);
    assert.equal(agent?.config.maxIterations, undefined);
  });
});

describe("unified issue-lifecycle built-in flow", () => {
  it("is the only auto-seeded built-in flow", () => {
    assert.deepEqual(Object.keys(builtinFlows), ["issue-lifecycle"]);
  });

  it("parses against FlowDefinitionSchema", () => {
    assert.doesNotThrow(() => FlowDefinitionSchema.parse(issueLifecycleFlow));
  });

  it("carries three distinct trigger entry-points", () => {
    const triggers = issueLifecycleFlow.nodes.filter((n) => isTriggerKind(n.kind));
    const kinds = triggers.map((t) => t.kind).sort();
    assert.deepEqual(kinds, [
      "github.projects_v2_item",
      "github.pull_request",
      "github.pull_request_review",
    ]);
  });

  it("keeps the three stages as disconnected components (each trigger is a root)", () => {
    // Every edge's target has exactly one incoming edge and no trigger has
    // an incoming edge — i.e. the stages don't cross-link in-graph; they're
    // linked by GitHub webhook round-trips instead.
    const targets = new Set(issueLifecycleFlow.edges.map((e) => e.target));
    for (const t of issueLifecycleFlow.nodes.filter((n) => isTriggerKind(n.kind))) {
      assert.equal(targets.has(t.id), false, `${t.id} should be a root`);
    }
  });

  it("shares the implement branch template with the fix stage for worktree reuse", () => {
    const implement = issueLifecycleFlow.nodes.find((n) => n.id === "implement");
    const fix = issueLifecycleFlow.nodes.find((n) => n.id === "fix");
    assert.equal(
      implement?.kind === "agent" && implement.config.worktree?.branchName,
      "opencara/issue-{{OPENCARA_ISSUE_NUMBER}}",
    );
    // The fix stage's PR head ref IS `opencara/issue-<n>`, so its branch
    // template resolves to the same per-(repo, branch) worktree slug.
    assert.equal(
      fix?.kind === "agent" && fix.config.worktree?.branchName,
      "{{OPENCARA_PR_HEAD_REF}}",
    );
  });
});
