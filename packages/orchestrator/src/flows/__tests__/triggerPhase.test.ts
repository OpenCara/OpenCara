import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FlowNode } from "@opencara/flows";
import {
  runNotifiesBoard,
  selectTriggersToEvaluate,
  summarizeTriggerOutcomes,
  type TriggerOutcome,
} from "../engine.js";

// Minimal trigger node stubs — selectTriggersToEvaluate only reads `id`
// and `kind`, so the configs can be empty for this test.
const projectsTrigger = {
  id: "implement_trigger",
  kind: "github.projects_v2_item",
} as unknown as FlowNode;
const prTrigger = {
  id: "review_trigger",
  kind: "github.pull_request",
} as unknown as FlowNode;
const reviewTrigger = {
  id: "fix_trigger",
  kind: "github.pull_request_review",
} as unknown as FlowNode;
const allTriggers = [projectsTrigger, prTrigger, reviewTrigger];

const noneMatched = () => false;

describe("selectTriggersToEvaluate", () => {
  it("evaluates every not-yet-matched trigger for a webhook event", () => {
    const got = selectTriggersToEvaluate(allTriggers, {
      eventType: "pull_request",
      hasIssueContext: false,
      isAlreadyMatched: noneMatched,
    });
    assert.deepEqual(got.map((t) => t.id), [
      "implement_trigger",
      "review_trigger",
      "fix_trigger",
    ]);
  });

  it("narrows a manual + issue-context run to the projects_v2_item entry-point", () => {
    // The kanban dispatch path: only the implement stage should evaluate,
    // never the review / fix stages (which would run against a bare issue).
    const got = selectTriggersToEvaluate(allTriggers, {
      eventType: "manual",
      hasIssueContext: true,
      isAlreadyMatched: noneMatched,
    });
    assert.deepEqual(got.map((t) => t.id), ["implement_trigger"]);
  });

  it("lights up every entry-point for a manual run with no issue context", () => {
    const got = selectTriggersToEvaluate(allTriggers, {
      eventType: "manual",
      hasIssueContext: false,
      isAlreadyMatched: noneMatched,
    });
    assert.equal(got.length, 3);
  });

  it("drops triggers already matched (rerun-from-failed preload)", () => {
    const got = selectTriggersToEvaluate(allTriggers, {
      eventType: "pull_request",
      hasIssueContext: false,
      isAlreadyMatched: (id) => id === "review_trigger",
    });
    assert.deepEqual(got.map((t) => t.id), ["implement_trigger", "fix_trigger"]);
  });
});

describe("summarizeTriggerOutcomes", () => {
  it("collects matched ids and stays neither failed nor skipped", () => {
    const outcomes: TriggerOutcome[] = [
      { id: "a", status: "matched" },
      { id: "b", status: "skipped", skipReason: "not my event" },
    ];
    const s = summarizeTriggerOutcomes(outcomes);
    assert.deepEqual(s.matchedIds, ["a"]);
    assert.equal(s.failed, false);
    // A sibling's skip reason is captured but the caller must NOT surface it
    // as an error when something else matched.
    assert.equal(s.firstSkipReason, "not my event");
  });

  it("reports the first skip reason when every trigger skipped (→ trigger_skip)", () => {
    const outcomes: TriggerOutcome[] = [
      { id: "a", status: "skipped", skipReason: "first reason" },
      { id: "b", status: "skipped", skipReason: "second reason" },
    ];
    const s = summarizeTriggerOutcomes(outcomes);
    assert.deepEqual(s.matchedIds, []);
    assert.equal(s.failed, false);
    assert.equal(s.firstSkipReason, "first reason");
  });

  it("fails (with the first error) when any trigger hard-errors, even if a sibling matched", () => {
    const outcomes: TriggerOutcome[] = [
      { id: "a", status: "matched" },
      { id: "b", status: "failed", errorMessage: "boom" },
      { id: "c", status: "failed", errorMessage: "later boom" },
    ];
    const s = summarizeTriggerOutcomes(outcomes);
    assert.equal(s.failed, true);
    assert.equal(s.errorMessage, "boom");
    assert.deepEqual(s.matchedIds, ["a"]);
  });

  it("is empty/clean for no outcomes", () => {
    const s = summarizeTriggerOutcomes([]);
    assert.deepEqual(s, {
      matchedIds: [],
      failed: false,
      errorMessage: undefined,
      firstSkipReason: undefined,
    });
  });
});

describe("runNotifiesBoard", () => {
  // This is the firehose guard: a dispatched-then-rejected run (trigger_skip)
  // must NOT wake project boards, or every unrelated webhook rebuilds every
  // open kanban board and starves the DB pool (2026-06-24 auth-503 incident).
  it("does NOT notify a trigger_skip run (has triggers, none matched)", () => {
    assert.equal(
      runNotifiesBoard({ hasTriggers: true, matchedTriggerCount: 0 }),
      false,
    );
  });

  it("notifies when a trigger matched", () => {
    assert.equal(
      runNotifiesBoard({ hasTriggers: true, matchedTriggerCount: 1 }),
      true,
    );
  });

  it("notifies when several triggers matched", () => {
    assert.equal(
      runNotifiesBoard({ hasTriggers: true, matchedTriggerCount: 3 }),
      true,
    );
  });

  it("always notifies a defensive no-trigger flow (it runs every node)", () => {
    // hasTriggers === false ⇒ the graph has no trigger gates, so every node
    // executes; that run is real and the board should see it.
    assert.equal(
      runNotifiesBoard({ hasTriggers: false, matchedTriggerCount: 0 }),
      true,
    );
  });
});
