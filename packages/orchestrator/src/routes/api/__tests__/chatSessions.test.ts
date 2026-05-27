// Unit tests for the flow_run_step chat scope. The route handlers
// themselves wire these helpers up; we exercise them against a fake Db
// surface that mimics just the Drizzle query methods we hit.
//
// What's covered:
//   - scope kind is registered (so the route gate's parseScopeKind
//     accepts it).
//   - loadFlowRunStepProject walks step → run → project and only
//     returns the projectId when the user owns the project (cross-user
//     smuggling is rejected — see PR #133 review feedback that the
//     prior stub bypassed addedByUserId).
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
  /** seed step keyed by id so the find-by-eq emulation is exact. */
  steps: Record<
    string,
    {
      id: string;
      flowRunId: string;
      nodeId: string;
    }
  >;
  /** flow_runs keyed by id. */
  runs: Record<
    string,
    {
      id: string;
      flowId: string;
      projectId: string;
    }
  >;
  /** projects keyed by id; ownership tested via addedByUserId. */
  projects: Record<string, { id: string; addedByUserId: string }>;
  /** agent_runs grouped by flowRunStepId so the most-recent lookup is
   *  cheap and we can test multi-iteration cases. */
  agentRunsByStep: Record<
    string,
    Array<{
      id: string;
      flowRunStepId: string;
      hostId: string | null;
      createdAt: Date;
      spec: unknown;
    }>
  >;
  /** flow_node_settings keyed by `${flowId}:${nodeId}`. */
  flowNodeSettings: Record<
    string,
    {
      flowId: string;
      nodeId: string;
      agentId: string | null;
    }
  >;
}

// Drizzle's `findFirst({ where: eq(table.column, value), ... })` accepts
// a SQL-builder argument; replaying it would mean reimplementing
// drizzle here. Instead we walk the SQL object recursively and collect
// every `Param.value` we encounter. `eq(x, v)` produces one Param;
// `and(eq(x, v1), eq(y, v2))` nests both and we collect both. Direct
// inspection beats JSON.stringify (the SQL object has circular refs
// into the PgTable / PgColumn singletons).
function collectStringParams(
  op: unknown,
  seen: WeakSet<object> = new WeakSet(),
  out: string[] = [],
): string[] {
  if (!op || typeof op !== "object") return out;
  if (seen.has(op as object)) return out;
  seen.add(op as object);
  if (Array.isArray(op)) {
    for (const item of op) collectStringParams(item, seen, out);
    return out;
  }
  const o = op as { constructor?: { name?: string }; value?: unknown; queryChunks?: unknown };
  if (o.constructor?.name === "Param") {
    if (typeof o.value === "string") out.push(o.value);
    return out;
  }
  // Recurse into the structural fields a SQL builder exposes — chunks
  // for the top-level operator, value for nested params or builders.
  if (o.queryChunks !== undefined) collectStringParams(o.queryChunks, seen, out);
  if (o.value !== undefined && o.constructor?.name !== "Param") {
    collectStringParams(o.value, seen, out);
  }
  return out;
}

function makeFakeDb(rows: FakeRows): Db {
  const fake = {
    query: {
      flowRunSteps: {
        findFirst: ({ where: w }: { where: unknown }) => {
          const params = collectStringParams(w);
          for (const step of Object.values(rows.steps)) {
            if (params.includes(step.id)) return step;
          }
          return undefined;
        },
      },
      flowRuns: {
        findFirst: ({ where: w }: { where: unknown }) => {
          const params = collectStringParams(w);
          for (const run of Object.values(rows.runs)) {
            if (params.includes(run.id)) return run;
          }
          return undefined;
        },
      },
      projects: {
        // loadOwnedProject calls findFirst with and(eq(id, X), eq(addedByUserId, Y)).
        // The fake respects BOTH literals so a smuggled-project test
        // actually fails when the user id doesn't match.
        findFirst: ({ where: w }: { where: unknown }) => {
          const params = collectStringParams(w);
          for (const project of Object.values(rows.projects)) {
            if (
              params.includes(project.id) &&
              params.includes(project.addedByUserId)
            ) {
              return project;
            }
          }
          return undefined;
        },
      },
      agentRuns: {
        findFirst: ({ where: w }: { where: unknown }) => {
          const params = collectStringParams(w);
          for (const [stepId, list] of Object.entries(rows.agentRunsByStep)) {
            if (!params.includes(stepId)) continue;
            const sorted = [...list].sort(
              (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
            );
            return sorted[0];
          }
          return undefined;
        },
      },
      flowNodeSettings: {
        findFirst: ({ where: w }: { where: unknown }) => {
          const params = collectStringParams(w);
          for (const s of Object.values(rows.flowNodeSettings)) {
            if (params.includes(s.flowId) && params.includes(s.nodeId)) {
              return s;
            }
          }
          return undefined;
        },
      },
    },
  };
  return fake as unknown as Db;
}


function emptyFakeRows(): FakeRows {
  return {
    steps: {},
    runs: {},
    projects: {},
    agentRunsByStep: {},
    flowNodeSettings: {},
  };
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
    const seed = emptyFakeRows();
    seed.steps["step1"] = { id: "step1", flowRunId: "run1", nodeId: "agent-1" };
    seed.runs["run1"] = { id: "run1", flowId: "flow1", projectId: "proj1" };
    seed.projects["proj1"] = { id: "proj1", addedByUserId: "user1" };
    const got = await loadFlowRunStepProject(makeFakeDb(seed), "step1", "user1");
    assert.equal(got, "proj1");
  });

  it("returns undefined when the step doesn't exist", async () => {
    const got = await loadFlowRunStepProject(
      makeFakeDb(emptyFakeRows()),
      "nope",
      "user1",
    );
    assert.equal(got, undefined);
  });

  it("refuses cross-user smuggling — step+project exist but belong to another user", async () => {
    // The fake's projects.findFirst now respects BOTH the project id
    // and addedByUserId, so a curious user2 querying user1's step
    // gets undefined back rather than a sneak peek at proj1.
    const seed = emptyFakeRows();
    seed.steps["step1"] = { id: "step1", flowRunId: "run1", nodeId: "agent-1" };
    seed.runs["run1"] = { id: "run1", flowId: "flow1", projectId: "proj1" };
    seed.projects["proj1"] = { id: "proj1", addedByUserId: "user1" };
    const got = await loadFlowRunStepProject(makeFakeDb(seed), "step1", "user2");
    assert.equal(got, undefined);
  });
});

describe("hydrateFromFlowRunStep", () => {
  it("returns agentId from flow_node_settings + acpSessionId from spec (most-recent wins)", async () => {
    const seed = emptyFakeRows();
    seed.steps["step1"] = { id: "step1", flowRunId: "run1", nodeId: "agent-1" };
    seed.runs["run1"] = { id: "run1", flowId: "flow1", projectId: "proj1" };
    seed.agentRunsByStep["step1"] = [
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
    ];
    seed.flowNodeSettings["flow1:agent-1"] = {
      flowId: "flow1",
      nodeId: "agent-1",
      agentId: "agent-abc",
    };
    const got = await hydrateFromFlowRunStep(makeFakeDb(seed), "step1");
    assert.deepEqual(got, {
      agentId: "agent-abc",
      acpSessionId: "uuid-new",
      acpSessionHostId: "host-y",
    });
  });

  it("returns all-nulls when the step row is missing", async () => {
    const got = await hydrateFromFlowRunStep(makeFakeDb(emptyFakeRows()), "nope");
    assert.deepEqual(got, {
      agentId: null,
      acpSessionId: null,
      acpSessionHostId: null,
    });
  });

  it("returns nulls for fields the spec doesn't carry (pre-resume writeback)", async () => {
    // Reproduces the timing case the PR #133 review flagged: opening
    // the panel before the flow agent's first turn has written
    // spec.acp.priorSessionId back. Hydration must not fabricate an
    // id; chatSessions.ts will re-hydrate on the next GET.
    const seed = emptyFakeRows();
    seed.steps["step1"] = { id: "step1", flowRunId: "run1", nodeId: "agent-1" };
    seed.runs["run1"] = { id: "run1", flowId: "flow1", projectId: "proj1" };
    seed.agentRunsByStep["step1"] = [
      {
        id: "ar1",
        flowRunStepId: "step1",
        hostId: null,
        createdAt: new Date("2026-05-01T10:00:00Z"),
        spec: { kind: "claude", command: "claude-acp", args: [], env: {} },
      },
    ];
    const got = await hydrateFromFlowRunStep(makeFakeDb(seed), "step1");
    assert.deepEqual(got, {
      agentId: null,
      acpSessionId: null,
      acpSessionHostId: null,
    });
  });
});
