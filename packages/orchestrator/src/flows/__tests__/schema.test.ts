import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FlowDefinitionSchema,
  builtinFlows,
  isTriggerKind,
  normalizeGraphKinds,
  developmentLifecycleFlow,
} from "@opencara/flows";

const baseFlow = {
  slug: "test-flow",
  name: "Test Flow",
  description: "Test flow",
  nodes: [
    {
      id: "t1",
      kind: "scm.board_item",
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

describe("the four stage built-in flows", () => {
  it("are exactly the auto-seeded built-ins, in lifecycle order", () => {
    assert.deepEqual(Object.keys(builtinFlows), [
      "issue-implement",
      "pr-review-multi",
      "pr-review",
      "pr-review-fix",
    ]);
  });

  it("each parses against FlowDefinitionSchema and has exactly one trigger root", () => {
    for (const def of Object.values(builtinFlows)) {
      assert.doesNotThrow(() => FlowDefinitionSchema.parse(def), def.slug);
      const triggers = def.nodes.filter((n) => isTriggerKind(n.kind));
      assert.equal(triggers.length, 1, `${def.slug} should have one trigger`);
      const targets = new Set(def.edges.map((e) => e.target));
      assert.equal(targets.has(triggers[0]!.id), false, `${def.slug} trigger should be a root`);
    }
  });

  it("splits the two PR review triggers by action + comment phrase (no double-post)", () => {
    const multi = builtinFlows["pr-review-multi"]!.nodes.find((n) => n.id === "review_trigger");
    const single = builtinFlows["pr-review"]!.nodes.find((n) => n.id === "single_review_trigger");
    assert.ok(multi?.kind === "scm.pull_request" && single?.kind === "scm.pull_request");
    assert.equal(multi.config.actions.includes("synchronize" as never), false);
    assert.deepEqual([...multi.config.actions].sort(), ["commented", "opened", "reopened"]);
    assert.equal(multi.config.commentPhrase, "@opencara mreview");
    assert.equal(single.config.actions.includes("opened" as never), false);
    assert.deepEqual([...single.config.actions].sort(), ["commented", "synchronize"]);
    assert.equal(single.config.commentPhrase, "@opencara review");
  });

  it("reuse the legacy unified graph's node ids so settings carry over by node id", () => {
    const legacyIds = new Set(developmentLifecycleFlow.nodes.map((n) => n.id));
    for (const def of Object.values(builtinFlows)) {
      for (const n of def.nodes) assert.ok(legacyIds.has(n.id), `${def.slug}/${n.id}`);
    }
  });

  it("shares the implement branch template with the fix stage for worktree reuse", () => {
    const implement = builtinFlows["issue-implement"]!.nodes.find((n) => n.id === "implement");
    const fix = builtinFlows["pr-review-fix"]!.nodes.find((n) => n.id === "fix");
    assert.equal(
      implement?.kind === "agent" && implement.config.worktree?.branchName,
      "opencara/issue-{{OPENCARA_ISSUE_NUMBER}}",
    );
    // The fix stage's PR head ref IS `opencara/issue-<n>`, so its branch
    // template resolves to the same per-(repo, branch) worktree slug.
    assert.equal(fix?.kind === "agent" && fix.config.worktree?.branchName, "{{OPENCARA_PR_HEAD_REF}}");
  });
});
