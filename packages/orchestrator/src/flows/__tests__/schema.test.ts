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

describe("unified development-lifecycle built-in flow", () => {
  it("is the only auto-seeded built-in flow", () => {
    assert.deepEqual(Object.keys(builtinFlows), ["development-lifecycle"]);
  });

  it("parses against FlowDefinitionSchema", () => {
    assert.doesNotThrow(() => FlowDefinitionSchema.parse(developmentLifecycleFlow));
  });

  it("carries four trigger entry-points (two PR triggers: multi + single review)", () => {
    const triggers = developmentLifecycleFlow.nodes.filter((n) => isTriggerKind(n.kind));
    const kinds = triggers.map((t) => t.kind).sort();
    assert.deepEqual(kinds, [
      "scm.board_item",
      "scm.pull_request",
      "scm.pull_request",
      "scm.pull_request_review",
    ]);
  });

  it("splits the two PR review triggers by action + comment phrase (no double-post)", () => {
    const byId = (id: string) => developmentLifecycleFlow.nodes.find((n) => n.id === id);
    const multi = byId("review_trigger");
    const single = byId("single_review_trigger");
    assert.ok(multi?.kind === "scm.pull_request" && single?.kind === "scm.pull_request");
    // Multi: open/reopen (NOT synchronize) + "@opencara mreview".
    assert.equal(multi.config.actions.includes("synchronize" as never), false);
    assert.deepEqual([...multi.config.actions].sort(), ["commented", "opened", "reopened"]);
    assert.equal(multi.config.commentPhrase, "@opencara mreview");
    // Single: synchronize (NOT opened) + "@opencara review".
    assert.equal(single.config.actions.includes("opened" as never), false);
    assert.deepEqual([...single.config.actions].sort(), ["commented", "synchronize"]);
    assert.equal(single.config.commentPhrase, "@opencara review");
  });

  it("keeps the three stages as disconnected components (each trigger is a root)", () => {
    // No trigger has an incoming edge — i.e. the stages don't cross-link
    // in-graph; they're linked by GitHub webhook round-trips instead. (Within
    // a stage, fan-in is fine: the review synthesizer has three incoming edges.)
    const targets = new Set(developmentLifecycleFlow.edges.map((e) => e.target));
    for (const t of developmentLifecycleFlow.nodes.filter((n) => isTriggerKind(n.kind))) {
      assert.equal(targets.has(t.id), false, `${t.id} should be a root`);
    }
  });

  it("shares the implement branch template with the fix stage for worktree reuse", () => {
    const implement = developmentLifecycleFlow.nodes.find((n) => n.id === "implement");
    const fix = developmentLifecycleFlow.nodes.find((n) => n.id === "fix");
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

// Every `flows.graph_json` / `template_drafts.graph_json` row in production was
// written before node kinds were renamed `github.*` → `scm.*` for multi-platform
// support. Nothing rewrites those rows, so the schema MUST keep accepting the old
// spelling and canonicalize it on read — otherwise every existing project flow
// fails to parse on the deploy that ships the rename.
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
