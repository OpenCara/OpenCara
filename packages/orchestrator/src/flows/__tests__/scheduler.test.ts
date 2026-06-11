import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FlowDefinitionSchema } from "@opencara/flows";
import {
  extractScheduleTriggers,
  computeNextFireAt,
  scheduleConfigChanged,
  scheduleDedupeKey,
} from "../scheduler.js";

function flow(nodes: unknown[]) {
  return FlowDefinitionSchema.parse({
    slug: "f",
    name: "F",
    description: "",
    nodes,
    edges: [],
  });
}

const agentNode = {
  id: "agent",
  kind: "agent",
  position: { x: 0, y: 0 },
  config: { label: "A", contextInjection: { env: [], stdinJson: true } },
};

function scheduleNode(id: string, cfg: Record<string, unknown>) {
  return { id, kind: "schedule.cron", position: { x: 0, y: 0 }, config: cfg };
}

describe("extractScheduleTriggers", () => {
  it("returns enabled schedule.cron triggers with their config", () => {
    const def = flow([
      scheduleNode("s1", { name: "Nightly", cron: "0 3 * * *", timezone: "UTC", enabled: true }),
      agentNode,
    ]);
    const out = extractScheduleTriggers(def);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], {
      nodeId: "s1",
      name: "Nightly",
      cron: "0 3 * * *",
      timezone: "UTC",
      enabled: true,
    });
  });

  it("drops disabled schedules", () => {
    const def = flow([
      scheduleNode("s1", { cron: "0 3 * * *", enabled: false }),
      agentNode,
    ]);
    assert.deepEqual(extractScheduleTriggers(def), []);
  });

  it("ignores non-schedule trigger kinds", () => {
    const def = flow([
      {
        id: "pr",
        kind: "github.pull_request",
        position: { x: 0, y: 0 },
        config: { actions: ["opened"] },
      },
      agentNode,
    ]);
    assert.deepEqual(extractScheduleTriggers(def), []);
  });
});

describe("computeNextFireAt", () => {
  it("computes the next occurrence in the given timezone", () => {
    const next = computeNextFireAt("0 9 * * *", "UTC", new Date("2026-01-01T10:00:00Z"));
    assert.equal(next?.toISOString(), "2026-01-02T09:00:00.000Z");
  });

  it("returns null for an invalid cron instead of throwing", () => {
    assert.equal(computeNextFireAt("not a cron", "UTC", new Date()), null);
  });

  it("returns null when no occurrence exists within a year", () => {
    assert.equal(
      computeNextFireAt("0 0 30 2 *", "UTC", new Date("2026-01-01T00:00:00Z")),
      null,
    );
  });
});

describe("scheduleConfigChanged", () => {
  const trigger = { nodeId: "s", name: "n", cron: "0 9 * * *", timezone: "UTC", enabled: true };

  it("is false when cron + timezone match", () => {
    assert.equal(
      scheduleConfigChanged({ cron: "0 9 * * *", timezone: "UTC", nextFireAt: null }, trigger),
      false,
    );
  });

  it("is true when the cron changed", () => {
    assert.equal(
      scheduleConfigChanged({ cron: "0 8 * * *", timezone: "UTC", nextFireAt: null }, trigger),
      true,
    );
  });

  it("is true when the timezone changed", () => {
    assert.equal(
      scheduleConfigChanged(
        { cron: "0 9 * * *", timezone: "America/New_York", nextFireAt: null },
        trigger,
      ),
      true,
    );
  });
});

describe("scheduleDedupeKey", () => {
  it("is stable per (flow, node, occurrence)", () => {
    const occ = new Date("2026-01-02T09:00:00Z");
    assert.equal(
      scheduleDedupeKey("flow1", "s1", occ),
      `schedule:flow1:s1:${occ.getTime()}`,
    );
  });

  it("differs across occurrences", () => {
    const a = scheduleDedupeKey("f", "s", new Date("2026-01-02T09:00:00Z"));
    const b = scheduleDedupeKey("f", "s", new Date("2026-01-03T09:00:00Z"));
    assert.notEqual(a, b);
  });
});
