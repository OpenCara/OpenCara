import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeEffectiveSettings } from "../nodeSettings.js";

const t = (nodeId: string, agentId: string | null, extra: Record<string, unknown> = {}) =>
  ({
    id: `t-${nodeId}`,
    userId: "u1",
    templateSlug: "development-lifecycle",
    nodeId,
    promptId: null,
    agentId,
    fallbackAgentIds: [] as string[],
    retrySame: 0,
    concurrency: 1,
    quorum: 1,
    label: null,
    updatedAt: new Date("2026-01-01"),
    ...extra,
  }) as never;

const p = (nodeId: string, agentId: string | null, extra: Record<string, unknown> = {}) =>
  ({
    id: `p-${nodeId}`,
    projectId: "proj",
    flowId: "flow",
    nodeId,
    promptId: null,
    agentId,
    fallbackAgentIds: [] as string[],
    retrySame: 0,
    concurrency: 1,
    quorum: 1,
    label: null,
    updatedAt: new Date("2026-02-01"),
    ...extra,
  }) as never;

describe("mergeEffectiveSettings", () => {
  it("template rows are the default, tagged as inherited", () => {
    const out = mergeEffectiveSettings(
      { flowId: "flow", projectId: "proj" },
      [t("reviewer", "sonnet", { concurrency: 2 })],
      [],
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.source, "template");
    assert.equal(out[0]!.id, null);
    assert.equal(out[0]!.agentId, "sonnet");
    assert.equal(out[0]!.concurrency, 2);
    assert.equal(out[0]!.flowId, "flow");
    assert.equal(out[0]!.projectId, "proj");
  });

  it("a project row replaces the template row for its node only", () => {
    const out = mergeEffectiveSettings(
      { flowId: "flow", projectId: "proj" },
      [t("reviewer", "sonnet"), t("fix", "opus")],
      [p("reviewer", "gemini", { fallbackAgentIds: ["kimi"], concurrency: 2 })],
    );
    const byNode = Object.fromEntries(out.map((s) => [s.nodeId, s]));
    assert.equal(byNode.reviewer!.source, "project");
    assert.equal(byNode.reviewer!.id, "p-reviewer");
    assert.equal(byNode.reviewer!.agentId, "gemini");
    assert.deepEqual(byNode.reviewer!.fallbackAgentIds, ["kimi"]);
    assert.equal(byNode.fix!.source, "template");
    assert.equal(byNode.fix!.agentId, "opus");
  });

  it("a project row for a node the template does not cover still applies", () => {
    const out = mergeEffectiveSettings(
      { flowId: "flow", projectId: "proj" },
      [],
      [p("implement", "codex")],
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.source, "project");
  });

  it("an all-null project row is still an override (it blanks the template default)", () => {
    const out = mergeEffectiveSettings(
      { flowId: "flow", projectId: "proj" },
      [t("reviewer", "sonnet")],
      [p("reviewer", null)],
    );
    assert.equal(out[0]!.source, "project");
    assert.equal(out[0]!.agentId, null);
  });
});
