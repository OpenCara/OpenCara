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
  selectActiveChatThreadKeys,
  resolveAgentWriteTarget,
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
  /** agent_runs surfaced to the `findMany` fake used by
   *  selectActiveChatThreadKeys. Each carries a status + the chat session
   *  marker on spec.env. */
  activeRuns: Array<{
    status: string;
    spec: { env?: Record<string, string> } | unknown;
  }>;
  /** chat_sessions keyed by id — drives the findFirst fake used by
   *  resolveAgentWriteTarget (by-id lookup and active-row fallback). */
  chatSessions: Record<
    string,
    {
      id: string;
      userId: string;
      scopeKind: string;
      scopeId: string;
      archivedAt: Date | null;
      updatedAt: Date;
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
        // selectActiveChatThreadKeys filters by `and(inArray(status, [...]),
        // inArray(sql<sessionId>, threadKeys))`. collectStringParams only
        // surfaces the status literals (drizzle inlines the threadKey
        // values as raw strings, not Params), so the fake replays just the
        // status filter — the helper itself intersects the result with the
        // requested threadKey set, which is what the tests assert on.
        findMany: ({ where: w }: { where: unknown }) => {
          const params = collectStringParams(w);
          return rows.activeRuns.filter((run) =>
            params.includes(run.status),
          );
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
      chatSessions: {
        // Serves both shapes resolveAgentWriteTarget issues:
        //   by-id:  and(eq(id), eq(userId), eq(scopeKind), eq(scopeId))
        //   active: and(eq(userId), eq(scopeKind), eq(scopeId), isNull(archivedAt))
        //           orderBy desc(updatedAt)
        // collectStringParams yields the eq() literals (isNull adds none);
        // a row matches when userId + scopeKind + scopeId are all present.
        // If the query also pinned an id, only the row with that id matches;
        // otherwise we return the most-recent non-archived row.
        findFirst: ({ where: w }: { where: unknown }) => {
          const params = collectStringParams(w);
          const inScope = Object.values(rows.chatSessions).filter(
            (s) =>
              params.includes(s.userId) &&
              params.includes(s.scopeKind) &&
              params.includes(s.scopeId),
          );
          const byId = inScope.find((s) => params.includes(s.id));
          if (byId) return byId;
          // A row whose id is in params but scope/user mismatched means an
          // explicit by-id query that missed — return nothing rather than
          // falling back to an active row in the wrong scope.
          const idQueried = Object.values(rows.chatSessions).some((s) =>
            params.includes(s.id),
          );
          if (idQueried) return undefined;
          return [...inScope]
            .filter((s) => !s.archivedAt)
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
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
    activeRuns: [],
    chatSessions: {},
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

describe("selectActiveChatThreadKeys", () => {
  it("returns the empty set when given no threadKeys (no query issued)", async () => {
    const got = await selectActiveChatThreadKeys(
      makeFakeDb(emptyFakeRows()),
      [],
    );
    assert.equal(got.size, 0);
  });

  it("returns only the threadKeys with an in-flight agent run", async () => {
    const seed = emptyFakeRows();
    seed.activeRuns = [
      // running run on chat_a → a is running
      { status: "running", spec: { env: { OPENCARA_CHAT_SESSION_ID: "chat_a" } } },
      // queued run on chat_b → b is running
      { status: "queued", spec: { env: { OPENCARA_CHAT_SESSION_ID: "chat_b" } } },
    ];
    const got = await selectActiveChatThreadKeys(makeFakeDb(seed), [
      "chat_a",
      "chat_b",
      "chat_c",
    ]);
    assert.deepEqual([...got].sort(), ["chat_a", "chat_b"]);
  });

  it("ignores runs whose session id isn't in the requested set", async () => {
    const seed = emptyFakeRows();
    seed.activeRuns = [
      // active run, but for a thread not asked about
      { status: "running", spec: { env: { OPENCARA_CHAT_SESSION_ID: "chat_other" } } },
    ];
    const got = await selectActiveChatThreadKeys(makeFakeDb(seed), ["chat_a"]);
    assert.equal(got.size, 0);
  });
});

describe("resolveAgentWriteTarget", () => {
  it("targets the named session row, not the most-recent active one (#143)", async () => {
    // Two non-archived rows in the same scope — exactly the multi-active
    // state the session sidebar creates. The agent write must land on the
    // row the caller named (older `chat_a`), not the most-recent (`chat_b`).
    const seed = emptyFakeRows();
    seed.chatSessions["chat_a"] = {
      id: "chat_a",
      userId: "user1",
      scopeKind: "project",
      scopeId: "proj1",
      archivedAt: null,
      updatedAt: new Date("2026-05-01T10:00:00Z"),
    };
    seed.chatSessions["chat_b"] = {
      id: "chat_b",
      userId: "user1",
      scopeKind: "project",
      scopeId: "proj1",
      archivedAt: null,
      updatedAt: new Date("2026-05-02T10:00:00Z"),
    };
    const got = await resolveAgentWriteTarget(
      makeFakeDb(seed),
      "user1",
      "project",
      "proj1",
      "chat_a",
    );
    assert.equal(got.notFound, false);
    assert.equal(got.row?.id, "chat_a");
  });

  it("404s (notFound) a sessionId that belongs to another scope", async () => {
    // A smuggled id from proj2 must not resolve when the scope is proj1 —
    // and must NOT silently fall through to proj1's active row.
    const seed = emptyFakeRows();
    seed.chatSessions["chat_x"] = {
      id: "chat_x",
      userId: "user1",
      scopeKind: "project",
      scopeId: "proj2",
      archivedAt: null,
      updatedAt: new Date("2026-05-01T10:00:00Z"),
    };
    seed.chatSessions["chat_a"] = {
      id: "chat_a",
      userId: "user1",
      scopeKind: "project",
      scopeId: "proj1",
      archivedAt: null,
      updatedAt: new Date("2026-05-02T10:00:00Z"),
    };
    const got = await resolveAgentWriteTarget(
      makeFakeDb(seed),
      "user1",
      "project",
      "proj1",
      "chat_x",
    );
    assert.equal(got.notFound, true);
    assert.equal(got.row, undefined);
  });

  it("falls back to the most-recent active row when no sessionId is given", async () => {
    const seed = emptyFakeRows();
    seed.chatSessions["chat_a"] = {
      id: "chat_a",
      userId: "user1",
      scopeKind: "project",
      scopeId: "proj1",
      archivedAt: null,
      updatedAt: new Date("2026-05-01T10:00:00Z"),
    };
    seed.chatSessions["chat_b"] = {
      id: "chat_b",
      userId: "user1",
      scopeKind: "project",
      scopeId: "proj1",
      archivedAt: null,
      updatedAt: new Date("2026-05-03T10:00:00Z"),
    };
    const got = await resolveAgentWriteTarget(
      makeFakeDb(seed),
      "user1",
      "project",
      "proj1",
      null,
    );
    assert.equal(got.notFound, false);
    assert.equal(got.row?.id, "chat_b");
  });
});
