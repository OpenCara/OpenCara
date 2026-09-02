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

describe("schedule.cron trigger node", () => {
  const scheduleFlow = {
    slug: "nightly-audit",
    name: "Nightly audit",
    description: "",
    nodes: [
      {
        id: "schedule",
        kind: "schedule.cron",
        position: { x: 0, y: 0 },
        config: {
          name: "Nightly dependency audit",
          cron: "0 3 * * *",
          timezone: "America/New_York",
          enabled: true,
        },
      },
      {
        id: "agent",
        kind: "agent",
        position: { x: 320, y: 0 },
        config: { label: "Auditor", contextInjection: { env: [], stdinJson: true } },
      },
    ],
    edges: [{ id: "e1", source: "schedule", target: "agent" }],
  };

  it("is recognised as a trigger kind", () => {
    assert.equal(isTriggerKind("schedule.cron"), true);
  });

  it("round-trips cron/timezone/name/enabled", () => {
    const parsed = FlowDefinitionSchema.parse(scheduleFlow);
    const node = parsed.nodes.find((n) => n.kind === "schedule.cron");
    assert.ok(node && node.kind === "schedule.cron");
    assert.equal(node.config.cron, "0 3 * * *");
    assert.equal(node.config.timezone, "America/New_York");
    assert.equal(node.config.name, "Nightly dependency audit");
    assert.equal(node.config.enabled, true);
  });

  it("applies defaults for an empty schedule config", () => {
    const parsed = FlowDefinitionSchema.parse({
      ...scheduleFlow,
      nodes: [
        { ...scheduleFlow.nodes[0], config: {} },
        scheduleFlow.nodes[1],
      ],
    });
    const node = parsed.nodes.find((n) => n.kind === "schedule.cron");
    assert.ok(node && node.kind === "schedule.cron");
    assert.equal(node.config.cron, "0 9 * * *");
    assert.equal(node.config.timezone, "UTC");
    assert.equal(node.config.enabled, true);
  });
});

describe("legacy github.* node kinds", () => {
  const legacyFlow = {
    slug: "legacy-flow",
    name: "Legacy Flow",
    description: "Graph as stored before the scm.* rename",
    nodes: [
      {
        id: "t1",
        kind: "github.pull_request",
        position: { x: 0, y: 0 },
        config: { actions: ["opened"] },
      },
      {
        id: "a1",
        kind: "agent",
        position: { x: 320, y: 0 },
        config: { label: "Reviewer", contextInjection: { env: [], stdinJson: true } },
      },
      {
        id: "x1",
        kind: "github.post_review",
        position: { x: 640, y: 0 },
        config: { event: "COMMENT" },
      },
    ],
    edges: [
      { id: "e1", source: "t1", target: "a1" },
      { id: "e2", source: "a1", target: "x1" },
    ],
  };

  it("parses a stored pre-rename graph", () => {
    assert.doesNotThrow(() => FlowDefinitionSchema.parse(legacyFlow));
  });

  it("canonicalizes legacy kinds to their scm.* spelling on parse", () => {
    const parsed = FlowDefinitionSchema.parse(legacyFlow);
    assert.deepEqual(
      parsed.nodes.map((n) => n.kind),
      ["scm.pull_request", "agent", "scm.post_review"],
    );
  });

  it("preserves config through normalization", () => {
    const parsed = FlowDefinitionSchema.parse(legacyFlow);
    const action = parsed.nodes.find((n) => n.kind === "scm.post_review");
    assert.ok(action && action.kind === "scm.post_review");
    assert.equal(action.config.event, "COMMENT");
  });

  it("maps the projects_v2_item trigger onto the neutral board trigger", () => {
    const parsed = FlowDefinitionSchema.parse({
      ...legacyFlow,
      nodes: [
        { ...legacyFlow.nodes[0], kind: "github.projects_v2_item", config: {} },
        legacyFlow.nodes[1],
        legacyFlow.nodes[2],
      ],
    });
    const trigger = parsed.nodes.find((n) => n.kind === "scm.board_item");
    assert.ok(trigger && trigger.kind === "scm.board_item");
    // Defaults still apply after the kind rewrite.
    assert.equal(trigger.config.fieldName, "Status");
  });

  it("classifies both spellings as trigger kinds", () => {
    for (const kind of [
      "github.pull_request",
      "github.pull_request_review",
      "github.projects_v2_item",
      "scm.pull_request",
      "scm.pull_request_review",
      "scm.board_item",
      "schedule.cron",
    ]) {
      assert.equal(isTriggerKind(kind), true, kind);
    }
    assert.equal(isTriggerKind("agent"), false);
    assert.equal(isTriggerKind("scm.post_review"), false);
  });

  it("normalizeGraphKinds rewrites a raw graph in place", () => {
    const raw = {
      nodes: [{ kind: "github.add_label" }, { kind: "agent" }, { kind: "scm.add_comment" }],
    };
    normalizeGraphKinds(raw);
    assert.deepEqual(
      raw.nodes.map((n) => n.kind),
      ["scm.add_label", "agent", "scm.add_comment"],
    );
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

  it("runs the implement and fix stages in a worktree without a configured branch", () => {
    const implement = builtinFlows["issue-implement"]!.nodes.find((n) => n.id === "implement");
    const fix = builtinFlows["pr-review-fix"]!.nodes.find((n) => n.id === "fix");
    // The branch is derived from the trigger (issue → opencara/issue-<n>,
    // PR → head ref); nothing in the graph names it any more.
    for (const node of [implement, fix]) {
      assert.ok(node?.kind === "agent" && node.config.worktree, node?.id);
      assert.ok(!("branchName" in (node.config.worktree as object)));
    }
  });
});
