import { ulid } from "ulid";
import { eq } from "drizzle-orm";
import type { Sql } from "postgres";
import type {
  ActionNode,
  AgentNode,
  FlowNode,
  TriggerNode,
} from "@openkira/flows";
import type { Db } from "../db/client.js";
import { agentRunLogs, agentRuns } from "../db/schema.js";
import type { AgentDispatcher, LogStream } from "../dispatch/dispatcher.js";
import type { GithubAppClient } from "../github/app.js";
import type { PullRequestContext } from "./context.js";

export class SkipFlowError extends Error {
  constructor(reason: string) {
    super(reason);
  }
}

export interface NodeRunCtx {
  db: Db;
  pg: Sql;
  app: GithubAppClient;
  dispatcher: AgentDispatcher;
  flowRunId: string;
  flowRunStepId: string;
  projectId: string;
  installation: { id: string; githubInstallationId: number };
  project: { owner: string; name: string };
  event: { id: string; type: string; payload: unknown };
  prContext?: PullRequestContext;
  previousOutput?: string;
}

export interface NodeRunResult {
  output?: unknown;
  /** stdout captured from an agent node, used as the next step's input. */
  stdoutCaptured?: string;
}

export type NodeRunner<N extends FlowNode = FlowNode> = (
  ctx: NodeRunCtx,
  node: N,
) => Promise<NodeRunResult>;

export const triggerRunner: NodeRunner<TriggerNode> = async (ctx, node) => {
  if (node.kind !== "github.pull_request") {
    throw new SkipFlowError(`unsupported trigger kind: ${node.kind as string}`);
  }
  if (ctx.event.type !== "pull_request") {
    throw new SkipFlowError("not a pull_request event");
  }
  const payload = ctx.event.payload as { action?: string };
  const action = payload.action ?? "";
  if (!node.config.actions.includes(action as never)) {
    throw new SkipFlowError(`pull_request action '${action}' not in trigger filter`);
  }
  return { output: { matched: true } };
};

export const agentRunner: NodeRunner<AgentNode> = async (ctx, node) => {
  const env: Record<string, string> = { ...node.config.spec.env };
  if (ctx.prContext) {
    for (const key of node.config.contextInjection.env) {
      const v = ctx.prContext.envExtras[key];
      if (v !== undefined) env[key] = v;
    }
  }

  const stdinJson = node.config.contextInjection.stdinJson
    ? { ...(ctx.prContext?.stdin ?? {}), previousOutput: ctx.previousOutput }
    : undefined;

  const agentRunId = ulid();
  await ctx.db.insert(agentRuns).values({
    id: agentRunId,
    spec: node.config.spec,
    triggerEventId: ctx.event.id,
    status: "running",
    projectId: ctx.projectId,
    flowRunStepId: ctx.flowRunStepId,
    startedAt: new Date(),
  });

  let seq = 0;
  const onLog = (stream: LogStream, chunk: string) => {
    const mySeq = seq++;
    void ctx.db
      .insert(agentRunLogs)
      .values({ agentRunId, seq: mySeq, stream, chunk })
      .then(() => ctx.pg.notify("agent_run_logs", agentRunId))
      .catch((err: unknown) => {
        console.error("[flows] log persist failed", err);
      });
  };

  try {
    const result = await ctx.dispatcher.run(
      { ...node.config.spec, env },
      { stdinJson, onLog, runOn: node.config.runOn },
    );
    await ctx.db
      .update(agentRuns)
      .set({
        status: result.exitCode === 0 ? "succeeded" : "failed",
        exitCode: result.exitCode,
        finishedAt: new Date(),
      })
      .where(eq(agentRuns.id, agentRunId));
    if (result.exitCode !== 0) {
      throw new Error(`agent exited with code ${result.exitCode}`);
    }
    return { output: { exitCode: result.exitCode }, stdoutCaptured: result.stdoutCaptured };
  } catch (err) {
    await ctx.db
      .update(agentRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(agentRuns.id, agentRunId));
    throw err;
  }
};

export const actionRunner: NodeRunner<ActionNode> = async (ctx, node) => {
  const oct = await ctx.app.forInstallation(ctx.installation.githubInstallationId);
  const owner = ctx.project.owner;
  const repo = ctx.project.name;
  const prPayload = ctx.event.payload as {
    pull_request?: { number: number; head: { sha: string } };
    issue?: { number: number };
  };
  const issueNumber = prPayload.pull_request?.number ?? prPayload.issue?.number;
  if (!issueNumber) throw new Error("action requires PR/issue number in event payload");

  const body = ctx.previousOutput?.trim() ?? "";

  switch (node.kind) {
    case "github.post_review": {
      if (!prPayload.pull_request) throw new Error("post_review requires a pull_request event");
      const res = await oct.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        {
          owner,
          repo,
          pull_number: issueNumber,
          body: body || "_(no review body)_",
          event: node.config.event,
          commit_id: prPayload.pull_request.head.sha,
        },
      );
      return { output: { reviewId: res.data.id, htmlUrl: res.data.html_url } };
    }
    case "github.add_comment": {
      const res = await oct.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { owner, repo, issue_number: issueNumber, body: body || "_(no body)_" },
      );
      return { output: { commentId: res.data.id, htmlUrl: res.data.html_url } };
    }
    case "github.add_label": {
      const labels = node.config.labels;
      const res = await oct.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
        { owner, repo, issue_number: issueNumber, labels },
      );
      return { output: { labels: res.data.map((l) => l.name) } };
    }
  }
};
