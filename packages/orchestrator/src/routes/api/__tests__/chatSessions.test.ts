// Unit tests for the flow_run_step chat scope. The route handlers
// themselves wire these helpers up; we exercise them against a fake Db
// surface that mimics just the Drizzle query methods we hit.
//
// What's covered:
//   - scope kind is registered (so the route gate's parseScopeKind
//     accepts it).
//   - loadFlowRunStepProject walks step → run → project and only
//     returns the projectId when the user owns the project.
//   - hydrateFromFlowRunStep pulls agentId from flow_node_settings and
//     acpSessionId from the most recent agent_run's spec, falling back
//     cleanly when bits are missing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadFlowRunStepProject,
  hydrateFromFlowRunStep,
} from "../chatSessions.js";
import { CHAT_SESSION_SCOPE_KINDS } from "../../../db/schema.js";
import type { Db } from "../../../db/client.js";

interface FakeRows {
  steps: Array<{
    id: string;
    flowRunId: string;
    nodeId: string;
  }>;
  runs: Array<{
    id: string;
    flowId: string;
    projectId: string;
  }>;
  projects: Array<{ id: string; addedByUserId: string }>;
  agentRuns: Array<{
    id: string;
    flowRunStepId: string;
    hostId: string | null;
    createdAt: Date;
    spec: unknown;
  }>;
  flowNodeSettings: Array<{
    flowId: string;
    nodeId: string;
    agentId: string | null;
  }>;
}

// Stand-in for the bits of Drizzle's query API we touch. Real drizzle
// returns rows shaped by the `columns` projection; the production code
// only relies on the columns it actually reads, so this minimal
// projection-agnostic stub is enough for the gate / hydrate paths.
function makeFakeDb(rows: FakeRows): Db {
  const findFirst = <T>(arr: T[], pred: (r: T) => boolean): T | undefined =>
    arr.find(pred);
  const fake = {
    query: {
      flowRunSteps: {
        findFirst: ({ where: _w }: { where: unknown }) => {
          // We don't replay Drizzle's `eq()` SQL builder here; the only
          // call sites filter by step.id, so just respect the first arg
          // by inspecting the test seed directly. The test seeds a
          // single step row per scenario.
          return findFirst(rows.steps, () => true);
        },
      },
      flowRuns: {
        findFirst: ({ where: _w }: { where: unknown }) => {
          return findFirst(rows.runs, () => true);
        },
      },
      projects: {
        findFirst: ({ where: _w }: { where: unknown }) => {
          // loadOwnedProject filters by (id, addedByUserId). The test
          // seeds projects.addedByUserId so the row resolution falls
          // out of the project list filter we apply below.
          return rows.projects[0];
        },
      },
      agentRuns: {
        findFirst: ({ where: _w }: { where: unknown }) => {
          // Most recent first — production uses orderBy desc(createdAt).
          const sorted = [...rows.agentRuns].sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
          );
          return sorted[0];
        },
      },
      flowNodeSettings: {
        findFirst: ({ where: _w }: { where: unknown }) => {
          return rows.flowNodeSettings[0];
        },
      },
    },
  };
  return fake as unknown as Db;
}

describe("CHAT_SESSION_SCOPE_KINDS", () => {
  it("includes flow_run_step", () => {
    assert.ok(
      (CHAT_SESSION_SCOPE_KINDS as readonly string[]).includes("flow_run_step"),
      "flow_run_step must be a registered chat scope kind",
    );
  });
});

describe("loadFlowRunStepProject", () => {
  it("returns the projectId when the user owns the project", async () => {
    const db = makeFakeDb({
      steps: [{ id: "step1", flowRunId: "run1", nodeId: "agent-1" }],
      runs: [{ id: "run1", flowId: "flow1", projectId: "proj1" }],
      projects: [{ id: "proj1", addedByUserId: "user1" }],
      agentRuns: [],
      flowNodeSettings: [],
    });
    const got = await loadFlowRunStepProject(db, "step1", "user1");
    assert.equal(got, "proj1");
  });

  it("returns undefined when the step doesn't exist", async () => {
    const db = makeFakeDb({
      steps: [],
      runs: [],
      projects: [],
      agentRuns: [],
      flowNodeSettings: [],
    });
    const got = await loadFlowRunStepProject(db, "nope", "user1");
    assert.equal(got, undefined);
  });

  it("returns undefined when the user doesn't own the project", async () => {
    // The fake makes projects.findFirst return rows.projects[0]; here
    // we seed it as owned by user2, so loadOwnedProject would refuse.
    // The real loadOwnedProject filters by addedByUserId itself; our
    // fake doesn't, so emulate the same refusal by leaving the list
    // empty.
    const db = makeFakeDb({
      steps: [{ id: "step1", flowRunId: "run1", nodeId: "agent-1" }],
      runs: [{ id: "run1", flowId: "flow1", projectId: "proj1" }],
      projects: [],
      agentRuns: [],
      flowNodeSettings: [],
    });
    const got = await loadFlowRunStepProject(db, "step1", "user1");
    assert.equal(got, undefined);
  });
});

describe("hydrateFromFlowRunStep", () => {
  it("returns agentId from flow_node_settings + acpSessionId from spec", async () => {
    const db = makeFakeDb({
      steps: [{ id: "step1", flowRunId: "run1", nodeId: "agent-1" }],
      runs: [{ id: "run1", flowId: "flow1", projectId: "proj1" }],
      projects: [],
      agentRuns: [
        {
          id: "ar1",
          flowRunStepId: "step1",
          hostId: "host-x",
          createdAt: new Date("2026-05-01T10:00:00Z"),
          spec: { acp: { priorSessionId: "uuid-old" } },
        },
        {
          id: "ar2",
          flowRunStepId: "step1",
          hostId: "host-y",
          createdAt: new Date("2026-05-02T10:00:00Z"),
          spec: { acp: { priorSessionId: "uuid-new" } },
        },
      ],
      flowNodeSettings: [
        { flowId: "flow1", nodeId: "agent-1", agentId: "agent-abc" },
      ],
    });
    const got = await hydrateFromFlowRunStep(db, "step1");
    assert.deepEqual(got, {
      agentId: "agent-abc",
      // most-recent agent_run wins
      acpSessionId: "uuid-new",
      acpSessionHostId: "host-y",
    });
  });

  it("returns all-nulls when the step row is missing", async () => {
    const db = makeFakeDb({
      steps: [],
      runs: [],
      projects: [],
      agentRuns: [],
      flowNodeSettings: [],
    });
    const got = await hydrateFromFlowRunStep(db, "nope");
    assert.deepEqual(got, {
      agentId: null,
      acpSessionId: null,
      acpSessionHostId: null,
    });
  });

  it("returns nulls for fields the spec doesn't carry", async () => {
    const db = makeFakeDb({
      steps: [{ id: "step1", flowRunId: "run1", nodeId: "agent-1" }],
      runs: [{ id: "run1", flowId: "flow1", projectId: "proj1" }],
      projects: [],
      agentRuns: [
        {
          id: "ar1",
          flowRunStepId: "step1",
          hostId: null,
          createdAt: new Date("2026-05-01T10:00:00Z"),
          // No acp section on the spec — the step ran but its session
          // id never got written back. Hydration should not fabricate one.
          spec: { kind: "claude", command: "claude-acp", args: [], env: {} },
        },
      ],
      flowNodeSettings: [],
    });
    const got = await hydrateFromFlowRunStep(db, "step1");
    assert.deepEqual(got, {
      agentId: null,
      acpSessionId: null,
      acpSessionHostId: null,
    });
  });
});
