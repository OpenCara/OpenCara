import { ulid } from "ulid";
import { eq } from "drizzle-orm";
import type { Sql } from "postgres";
import type {
  ActionNode,
  AgentNode,
  FlowNode,
  TriggerNode,
} from "@openkira/flows";
import { and } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentRunLogs, agentRuns, agents, flowNodeSettings, prompts } from "../db/schema.js";
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
  flowId: string;
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
  // Manual runs from the UI bypass all filters so users can inspect any flow
  // on demand. The trigger node still "matches" so the graph lights up.
  if (ctx.event.type === "manual") {
    return { output: { matched: true, manual: true } };
  }
  if (ctx.event.type !== "pull_request") {
    throw new SkipFlowError("not a pull_request event");
  }
  const payload = ctx.event.payload as {
    action?: string;
    pull_request?: {
      base?: { ref?: string };
      labels?: Array<{ name?: string }>;
      draft?: boolean;
    };
  };

  // 1. Action types — opened / synchronize / reopened / ready_for_review.
  const action = payload.action ?? "";
  if (!node.config.actions.includes(action as never)) {
    throw new SkipFlowError(`pull_request action '${action}' not in trigger filter`);
  }

  const cfg = node.config;

  // 2a. Drafts — opt-in skip when the PR is marked as draft.
  if (cfg.ignoreDrafts && payload.pull_request?.draft === true) {
    throw new SkipFlowError("PR is a draft");
  }

  // 2. Base branch include/ignore (e.g. only PRs targeting `main` or
  //    `release/*`). Empty include list means "any branch".
  const baseRef = payload.pull_request?.base?.ref ?? "";
  if (cfg.branchesIgnore.length > 0 && matchesAnyGlob(baseRef, cfg.branchesIgnore)) {
    throw new SkipFlowError(`base branch '${baseRef}' is in branches-ignore`);
  }
  if (cfg.branches.length > 0 && !matchesAnyGlob(baseRef, cfg.branches)) {
    throw new SkipFlowError(`base branch '${baseRef}' not in branches filter`);
  }

  // 3. PR labels — labelsIgnore short-circuits if PR has any of them; labels
  //    requires at least one match. Both are independent so users can do
  //    "exclude wip but include security".
  if (cfg.labels.length > 0 || cfg.labelsIgnore.length > 0) {
    const have = new Set(
      (payload.pull_request?.labels ?? [])
        .map((l) => l.name)
        .filter((n): n is string => typeof n === "string"),
    );
    if (cfg.labelsIgnore.length > 0) {
      const hit = cfg.labelsIgnore.find((l) => have.has(l));
      if (hit) throw new SkipFlowError(`PR has labels-ignore '${hit}'`);
    }
    if (cfg.labels.length > 0) {
      if (!cfg.labels.some((l) => have.has(l))) {
        throw new SkipFlowError(`PR labels missing one of ${cfg.labels.join(",")}`);
      }
    }
  }

  // 4. Paths — at least one changed file must match `paths` and none may
  //    match `pathsIgnore`. Skip the whole check if both lists are empty,
  //    so we don't pay the diff-parse cost for unfiltered triggers.
  if (cfg.paths.length > 0 || cfg.pathsIgnore.length > 0) {
    const diff = ctx.prContext?.stdin.diff ?? "";
    const changed = parseChangedFiles(diff);
    if (cfg.pathsIgnore.length > 0) {
      const allIgnored = changed.every((f) => matchesAnyGlob(f, cfg.pathsIgnore));
      if (changed.length > 0 && allIgnored) {
        throw new SkipFlowError("all changed files match paths-ignore");
      }
    }
    if (cfg.paths.length > 0) {
      const anyMatched = changed.some((f) => matchesAnyGlob(f, cfg.paths));
      if (!anyMatched) {
        throw new SkipFlowError("no changed file matches paths filter");
      }
    }
  }

  return { output: { matched: true } };
};

/**
 * Extract changed file paths from a unified-diff blob by reading the
 * `diff --git a/X b/Y` headers GitHub returns. Both sides are added to the
 * set so renames still match either name. Empty diff (event arrived before
 * we could fetch context) yields an empty list — paths filter then can't
 * narrow further and the flow proceeds.
 */
function parseChangedFiles(diff: string): string[] {
  if (!diff) return [];
  const out = new Set<string>();
  const re = /^diff --git a\/(\S+) b\/(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    out.add(m[1]!);
    out.add(m[2]!);
  }
  return [...out];
}

function matchesAnyGlob(value: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (globToRegex(p).test(value)) return true;
  }
  return false;
}

/**
 * Minimal glob → RegExp.
 *   `**`  → any chars including `/`
 *   `*`   → any chars within one path segment (no `/`)
 *   `?`   → single non-slash char
 *   `\`-prefixed regex metachars are escaped literally.
 * Anchored, so the whole string must match (not just a substring).
 */
function globToRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (".+^$()|[]{}\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

export const agentRunner: NodeRunner<AgentNode> = async (ctx, node) => {
  // Resolve the linked agent — required since the flow's in-graph spec is
  // ignored in favour of the user's per-node agent linkage.
  const setting = await ctx.db.query.flowNodeSettings.findFirst({
    where: and(
      eq(flowNodeSettings.flowId, ctx.flowId),
      eq(flowNodeSettings.nodeId, node.id),
    ),
  });
  if (!setting?.agentId) {
    throw new Error(
      `agent node '${node.id}' has no linked agent — link one from the flow detail page`,
    );
  }
  const agent = await ctx.db.query.agents.findFirst({
    where: eq(agents.id, setting.agentId),
  });
  if (!agent) {
    throw new Error(`linked agent ${setting.agentId} not found (revoked or deleted)`);
  }

  const env: Record<string, string> = { ...agent.env };
  if (ctx.prContext) {
    for (const key of node.config.contextInjection.env) {
      const v = ctx.prContext.envExtras[key];
      if (v !== undefined) env[key] = v;
    }
  }

  // Look up linked prompt for this flow node, if any.
  const linkedPromptBody = setting.promptId
    ? (await ctx.db.query.prompts.findFirst({ where: eq(prompts.id, setting.promptId) }))
        ?.body ?? null
    : null;
  if (linkedPromptBody !== null) {
    env["OPENKIRA_PROMPT"] = linkedPromptBody;
  }

  const stdinJson = node.config.contextInjection.stdinJson
    ? {
        ...(ctx.prContext?.stdin ?? {}),
        previousOutput: ctx.previousOutput,
        prompt: linkedPromptBody ?? undefined,
      }
    : undefined;

  const spec = {
    kind: agent.name,
    command: agent.command,
    args: agent.args,
    env,
    cwd: agent.cwd ?? undefined,
  };
  const runOn = (agent.runOn as "any" | "local" | "device") ?? node.config.runOn;

  const agentRunId = ulid();
  await ctx.db.insert(agentRuns).values({
    id: agentRunId,
    spec,
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
    const result = await ctx.dispatcher.run(spec, { stdinJson, onLog, runOn });
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

// loadLinkedPrompt was inlined into agentRunner since it now also needs the
// linked agent and the lookup logic is the same.
