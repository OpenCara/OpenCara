// Regression pin for the flow-run cancel bug: dispatchAgentRun must hand
// the agent_runs row id to dispatcher.run as `runId`. WebSocketDispatcher
// keys its pending map (and the WS job frame) on that value, and
// `dispatcher.cancel(agentRunId)` resolves the device through the same
// map — so if the dispatch ever mints its own ULID instead, the cancel
// frame is never sent and the device-side agent keeps running after the
// flow row is marked cancelled.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentSpec } from "@opencara/shared";
import type {
  RunContext,
  RunResult,
} from "../../dispatch/dispatcher.js";
import { dispatchAgentRun, type NodeRunCtx } from "../nodeRunners.js";

interface CapturedDispatch {
  spec: AgentSpec;
  runCtx: RunContext;
}

function ctxForDispatch(): {
  ctx: NodeRunCtx;
  insertedIds: string[];
  dispatched: CapturedDispatch[];
} {
  const insertedIds: string[] = [];
  const dispatched: CapturedDispatch[] = [];
  const ctx = {
    db: {
      insert: () => ({
        values: async (values: { id?: string }) => {
          if (values.id) insertedIds.push(values.id);
        },
      }),
      update: () => ({ set: () => ({ where: async () => [] }) }),
    } as never,
    pg: { notify: async () => {} } as never,
    app: {
      mintEphemeralToken: async () => ({
        token: "ghs_test",
        expiresAt: "2030-01-01T00:00:00Z",
      }),
      revokeToken: async () => {},
    } as never,
    dispatcher: {
      run: async (spec: AgentSpec, runCtx: RunContext): Promise<RunResult> => {
        dispatched.push({ spec, runCtx });
        return {
          exitCode: 0,
          stdoutCaptured: "",
          agentHostId: "host-1",
          acpSessionId: null,
        };
      },
    } as never,
    flowId: "flow-1",
    flowRunId: "run-1",
    flowRunStepId: "step-1",
    projectId: "project-1",
    scm: {
      platform: "github" as const,
      installation: { id: "installation-1", githubInstallationId: 1 },
      githubRepoId: 1,
    },
    project: {
      owner: "octo-org",
      name: "octo-repo",
      defaultBranch: "main",
      instructionsFile: "",
    },
    event: { id: "event-1", type: "pull_request", payload: {} },
    publicBaseUrl: "https://opencara.example",
  } as NodeRunCtx;
  return { ctx, insertedIds, dispatched };
}

describe("dispatchAgentRun", () => {
  it("dispatches under the agent_runs row id so cancel() can find it", async () => {
    const { ctx, insertedIds, dispatched } = ctxForDispatch();
    const agentRunId = "01TESTAGENTRUNID00000000";

    const result = await dispatchAgentRun(ctx, {
      agentRunId,
      kind: "test-agent",
      command: "echo",
      args: [],
      env: {},
      triggerEventId: null,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(insertedIds.length, 1);
    assert.equal(insertedIds[0], agentRunId);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]!.runCtx.runId, agentRunId);
  });

  it("still resolves the wire runId when the token mint fails", async () => {
    const { ctx, insertedIds, dispatched } = ctxForDispatch();
    ctx.app = undefined;
    const agentRunId = "01TESTAGENTRUNID00000001";

    await dispatchAgentRun(ctx, {
      agentRunId,
      kind: "test-agent",
      command: "echo",
      args: [],
      env: {},
      triggerEventId: null,
    });

    assert.equal(insertedIds[0], agentRunId);
    assert.equal(dispatched[0]!.runCtx.runId, agentRunId);
  });
});
