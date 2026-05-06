import { ulid } from "ulid";
import { eq } from "drizzle-orm";
import type { Sql } from "postgres";
import type {
  ActionNode,
  AgentNode,
  FlowNode,
  TriggerNode,
} from "@opencara/flows";
import type { AgentSpec } from "@opencara/shared";
import { and } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  agentRunLogs,
  agentRuns,
  agents,
  flowNodeSettings,
  projects,
  prompts,
} from "../db/schema.js";
import type { AgentDispatcher, LogStream, RunResult } from "../dispatch/dispatcher.js";
import type { EphemeralToken, GithubAppClient } from "../github/app.js";
import type { IssueStatusContext, PullRequestContext } from "./context.js";
import { buildIssueCanvasEnvelope } from "./skills/issueCanvas.js";

export class SkipFlowError extends Error {
  constructor(reason: string) {
    super(reason);
  }
}

/**
 * Structured handle from a `git.create_worktree` node, threaded downstream
 * via the engine's nodeContexts channel. Downstream agent nodes inherit
 * the cwd + device pin; a downstream `github.create_pull_request` reads
 * `branch` as the PR head.
 */
export interface WorktreeHandle {
  kind: "worktree";
  workdir: string;
  branch: string;
  hostId: string;
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
  project: { owner: string; name: string; githubRepoId: number; defaultBranch: string | null };
  event: { id: string; type: string; payload: unknown };
  prContext?: PullRequestContext;
  issueContext?: IssueStatusContext;
  previousOutput?: string;
  /** Resolved by the engine before running each node — the nearest
   * worktree handle reachable upstream over the edge graph. Undefined
   * when the node has no worktree ancestor. */
  upstreamWorktree?: WorktreeHandle;
  /** Base URL for the per-run callback API, e.g. "https://opencara.com". */
  publicBaseUrl: string;
}

export interface NodeRunResult {
  output?: unknown;
  /** stdout captured from an agent node, used as the next step's input. */
  stdoutCaptured?: string;
  /** Structured handle this node emits for downstream consumption (today:
   * worktree handles from git.create_worktree). */
  nodeContext?: WorktreeHandle;
}

export type NodeRunner<N extends FlowNode = FlowNode> = (
  ctx: NodeRunCtx,
  node: N,
) => Promise<NodeRunResult>;

export const triggerRunner: NodeRunner<TriggerNode> = async (ctx, node) => {
  // Manual runs from the UI bypass all filters so users can inspect any flow
  // on demand. The trigger node still "matches" so the graph lights up.
  if (ctx.event.type === "manual") {
    return { output: { matched: true, manual: true } };
  }
  if (node.kind === "github.projects_v2_item") {
    return projectsV2ItemTrigger(ctx, node);
  }
  if (node.kind !== "github.pull_request") {
    throw new SkipFlowError(`unsupported trigger kind: ${(node as { kind: string }).kind}`);
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

  const action = payload.action ?? "";
  if (!node.config.actions.includes(action as never)) {
    throw new SkipFlowError(`pull_request action '${action}' not in trigger filter`);
  }

  const cfg = node.config;

  if (cfg.ignoreDrafts && payload.pull_request?.draft === true) {
    throw new SkipFlowError("PR is a draft");
  }

  const baseRef = payload.pull_request?.base?.ref ?? "";
  if (cfg.branchesIgnore.length > 0 && matchesAnyGlob(baseRef, cfg.branchesIgnore)) {
    throw new SkipFlowError(`base branch '${baseRef}' is in branches-ignore`);
  }
  if (cfg.branches.length > 0 && !matchesAnyGlob(baseRef, cfg.branches)) {
    throw new SkipFlowError(`base branch '${baseRef}' not in branches filter`);
  }

  // Labels are exact-match (matches GitHub Actions); no glob.
  if (cfg.labels.length > 0 || cfg.labelsIgnore.length > 0) {
    const prLabelNames = new Set(
      (payload.pull_request?.labels ?? [])
        .map((l) => l.name)
        .filter((n): n is string => typeof n === "string"),
    );
    if (cfg.labelsIgnore.length > 0) {
      const hit = cfg.labelsIgnore.find((l) => prLabelNames.has(l));
      if (hit) throw new SkipFlowError(`PR has labels-ignore '${hit}'`);
    }
    if (cfg.labels.length > 0) {
      if (!cfg.labels.some((l) => prLabelNames.has(l))) {
        throw new SkipFlowError(`PR labels missing one of ${cfg.labels.join(",")}`);
      }
    }
  }

  if (cfg.paths.length > 0 || cfg.pathsIgnore.length > 0) {
    const diff = ctx.prContext?.stdin.diff ?? "";
    const changed = parseChangedFiles(diff);
    // Fail closed when EITHER include or ignore filter is set but the diff
    // is unavailable — running anyway would let unscoped PRs through a
    // docs-only-skip just as easily as a src-only-include.
    if (changed.length === 0) {
      throw new SkipFlowError("path filter requested but PR diff is unavailable");
    } else {
      if (cfg.pathsIgnore.length > 0) {
        const allIgnored = changed.every((f) => matchesAnyGlob(f, cfg.pathsIgnore));
        if (allIgnored) {
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
  }

  return { output: { matched: true } };
};

// Match a Projects v2 status-field change. Webhook payload reference:
//   https://docs.github.com/en/webhooks/webhook-events-and-payloads#projects_v2_item
// We rely on the webhook delivering field_value.from.name / to.name for
// single-select fields — when GitHub omits the names (only `id`s present)
// we skip the option-name filters rather than blocking. projectNumber is not
// yet enforced because the webhook only carries `project_node_id`; resolving
// to a number would need GraphQL and isn't worth the complexity for MVP.
async function projectsV2ItemTrigger(
  ctx: NodeRunCtx,
  node: TriggerNode,
): Promise<NodeRunResult> {
  if (node.kind !== "github.projects_v2_item") {
    throw new SkipFlowError(`expected projects_v2_item trigger, got ${node.kind}`);
  }
  if (ctx.event.type !== "projects_v2_item") {
    throw new SkipFlowError("not a projects_v2_item event");
  }
  const payload = ctx.event.payload as {
    action?: string;
    changes?: {
      field_value?: {
        field_name?: string;
        field_type?: string;
        from?: { id?: string; name?: string } | null;
        to?: { id?: string; name?: string } | null;
      };
    };
    projects_v2_item?: {
      content_type?: string;
      content_node_id?: string;
      project_node_id?: string;
    };
  };

  if (payload.action !== "edited") {
    throw new SkipFlowError(`projects_v2_item action '${payload.action}' is not edited`);
  }
  const fv = payload.changes?.field_value;
  if (!fv) {
    throw new SkipFlowError("no field_value change on this event");
  }

  const cfg = node.config;

  const contentType = payload.projects_v2_item?.content_type ?? "";
  if (!cfg.contentTypes.includes(contentType as never)) {
    throw new SkipFlowError(
      `content type '${contentType}' not in trigger filter [${cfg.contentTypes.join(",")}]`,
    );
  }

  if (cfg.fieldName && fv.field_name && fv.field_name !== cfg.fieldName) {
    throw new SkipFlowError(
      `changed field '${fv.field_name}' is not '${cfg.fieldName}'`,
    );
  }

  const fromName = fv.from?.name ?? null;
  const toName = fv.to?.name ?? null;

  if (cfg.toOptions.length > 0) {
    if (!toName) {
      throw new SkipFlowError(
        "cannot enforce toOptions filter: webhook did not include the new option name",
      );
    }
    if (!cfg.toOptions.includes(toName)) {
      throw new SkipFlowError(
        `moved-to option '${toName}' not in toOptions filter [${cfg.toOptions.join(",")}]`,
      );
    }
  }
  if (cfg.fromOptions.length > 0) {
    if (!fromName) {
      throw new SkipFlowError(
        "cannot enforce fromOptions filter: webhook did not include the prior option name",
      );
    }
    if (!cfg.fromOptions.includes(fromName)) {
      throw new SkipFlowError(
        `moved-from option '${fromName}' not in fromOptions filter [${cfg.fromOptions.join(",")}]`,
      );
    }
  }

  return {
    output: {
      matched: true,
      contentType,
      fieldName: fv.field_name ?? null,
      statusFrom: fromName,
      statusTo: toName,
      contentNodeId: payload.projects_v2_item?.content_node_id ?? null,
    },
  };
}

// Non-greedy capture preserves filenames with spaces (`a/my file.ts b/my file.ts`).
function parseChangedFiles(diff: string): string[] {
  if (!diff) return [];
  const out = new Set<string>();
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
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

// `**` semantics match GitHub Actions: leading `**/`, trailing `/**`, and
// embedded `/**/` collapse zero-or-more path segments so `src/**/test.ts`
// matches `src/test.ts`. `*` matches within a segment, `?` is a single
// non-slash char.
function globToRegex(glob: string): RegExp {
  let normalized = glob;
  // Embedded /**/  → optional path segments. The two alternatives keep the
  // single `/` in place when there's nothing in between.
  normalized = normalized.replace(/\/\*\*\//g, " ANYPATH ");
  // Leading **/   → optional prefix.
  normalized = normalized.replace(/^\*\*\//, " ANYPREFIX ");
  // Trailing /**  → optional suffix.
  normalized = normalized.replace(/\/\*\*$/, " ANYSUFFIX ");

  let out = "";
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i]!;
    if (c === " ") {
      // Read marker.
      const end = normalized.indexOf(" ", i + 1);
      const tag = normalized.slice(i + 1, end);
      if (tag === "ANYPATH") out += "(?:/|/.+/)";
      else if (tag === "ANYPREFIX") out += "(?:|.+/)";
      else if (tag === "ANYSUFFIX") out += "(?:|/.+)";
      i = end;
    } else if (c === "*" && normalized[i + 1] === "*") {
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

  // Label-based agent routing: when the trigger event is an issue and the
  // issue has exactly one `agent:<name>` label, dispatch THAT agent
  // (project-owner-scoped) instead of the linked default. Lets a user pick a
  // dispatcher per-issue from GitHub without re-editing the flow. If the
  // label exists but no matching agent is found, surface an explicit error
  // — silently falling back would mask user typos.
  let agent: typeof agents.$inferSelect | null = await resolveLabelRoutedAgent(ctx);
  if (!agent) {
    if (!setting?.agentId) {
      throw new Error(
        `agent node '${node.id}' has no linked agent and no agent:<name> label on the issue — link a default from the flow detail page or label the issue`,
      );
    }
    agent =
      (await ctx.db.query.agents.findFirst({
        where: eq(agents.id, setting.agentId),
      })) ?? null;
    if (!agent) {
      throw new Error(`linked agent ${setting.agentId} not found (revoked or deleted)`);
    }
  }

  const env: Record<string, string> = { ...agent.env };
  if (ctx.prContext) {
    for (const key of node.config.contextInjection.env) {
      const v = ctx.prContext.envExtras[key];
      if (v !== undefined) env[key] = v;
    }
  }
  if (ctx.issueContext) {
    for (const key of node.config.contextInjection.env) {
      const v = ctx.issueContext.envExtras[key];
      if (v !== undefined) env[key] = v;
    }
  }

  // Look up linked prompt for this flow node, if any. (When the agent came
  // from a label and no flow_node_settings row exists, there's no linked
  // prompt either — that's fine, agent runs without OPENCARA_PROMPT.)
  const linkedPromptBody = setting?.promptId
    ? (await ctx.db.query.prompts.findFirst({ where: eq(prompts.id, setting.promptId) }))
        ?.body ?? null
    : null;
  if (linkedPromptBody !== null) {
    env["OPENCARA_PROMPT"] = linkedPromptBody;
  }

  const agentRunId = ulid();
  env["OPENCARA_AGENT_RUN_ID"] = agentRunId;

  // Upstream worktree override: when this agent node sits below a
  // git.create_worktree node, run inside that worktree on the same device.
  // Surface workdir + branch in env so the agent's own scripts can see
  // them without parsing nodeContext.
  if (ctx.upstreamWorktree) {
    env["OPENCARA_WORKTREE_DIR"] = ctx.upstreamWorktree.workdir;
    env["OPENCARA_WORKTREE_BRANCH"] = ctx.upstreamWorktree.branch;
  }

  // Inject the issue-edit skill if this run has issue context (Projects v2
  // status-change trigger). Other trigger types don't get the skill — body
  // editing only makes sense in an issue context.
  const skill =
    ctx.issueContext?.stdin.issue && ctx.issueContext.stdin.issue.number
      ? buildIssueCanvasEnvelope({
          baseUrl: ctx.publicBaseUrl,
          issueNumber: ctx.issueContext.stdin.issue.number,
          runId: agentRunId,
        })
      : null;

  const stdinJson = node.config.contextInjection.stdinJson
    ? {
        ...(ctx.prContext?.stdin ?? {}),
        ...(ctx.issueContext?.stdin ?? {}),
        previousOutput: ctx.previousOutput,
        prompt: linkedPromptBody ?? undefined,
        ...(skill ? { skill } : {}),
      }
    : undefined;

  const result = await dispatchAgentRun(ctx, {
    agentRunId,
    kind: agent.name,
    command: agent.command,
    args: agent.args,
    env,
    cwd: ctx.upstreamWorktree?.workdir ?? agent.cwd ?? undefined,
    stdinJson,
    hostId: ctx.upstreamWorktree?.hostId ?? agent.hostId ?? null,
    triggerEventId: ctx.event.id,
  });

  if (result.exitCode !== 0) {
    throw new Error(`agent exited with code ${result.exitCode}`);
  }
  return { output: { exitCode: result.exitCode }, stdoutCaptured: result.stdoutCaptured };
};

// Inspect the triggering issue's labels for an `agent:<name>` marker and
// look that agent up by (name, project_owner_user_id). Returns null when no
// such label exists (caller falls back to the linked agent). Throws a
// SkipFlowError when the label is present but malformed/duplicate, and a
// regular Error when the label points at an unknown agent (user error worth
// surfacing rather than swallowing).
async function resolveLabelRoutedAgent(
  ctx: NodeRunCtx,
): Promise<typeof agents.$inferSelect | null> {
  const labels = ctx.issueContext?.stdin.issue?.labels ?? [];
  const PREFIX = "agent:";
  const requested = labels
    .map((l) => l.name)
    .filter((n): n is string => typeof n === "string" && n.startsWith(PREFIX))
    .map((n) => n.slice(PREFIX.length).trim())
    .filter((n) => n.length > 0);
  if (requested.length === 0) return null;
  if (requested.length > 1) {
    throw new SkipFlowError(
      `multiple agent:<name> labels on issue (${requested.join(", ")}); pick one`,
    );
  }
  const name = requested[0]!;

  // Agents are user-scoped; resolve the project's owner so we look up THEIR
  // agent table. Fail explicitly if the project has no owner (legacy row) —
  // there's no sensible default here.
  const project = await ctx.db.query.projects.findFirst({
    where: eq(projects.id, ctx.projectId),
  });
  if (!project?.addedByUserId) {
    throw new Error(
      `cannot resolve agent:${name} — project ${ctx.projectId} has no addedByUserId`,
    );
  }
  const found = await ctx.db.query.agents.findFirst({
    where: and(eq(agents.userId, project.addedByUserId), eq(agents.name, name)),
  });
  if (!found) {
    throw new Error(
      `issue label requested agent:${name} but no agent named '${name}' exists for the project owner — create it on /agents or fix the label`,
    );
  }
  return found;
}

export const actionRunner: NodeRunner<ActionNode> = async (ctx, node) => {
  const oct = await ctx.app.forInstallation(ctx.installation.githubInstallationId);
  const owner = ctx.project.owner;
  const repo = ctx.project.name;
  const prPayload = ctx.event.payload as {
    pull_request?: { number: number; head: { sha: string } };
    issue?: { number: number };
  };
  const body = ctx.previousOutput?.trim() ?? "";

  // Most actions act on the existing PR/issue from the trigger event; only
  // github.create_pull_request opens a new one. Compute issueNumber lazily
  // inside the branches that need it.
  const issueNumber = prPayload.pull_request?.number ?? prPayload.issue?.number;
  const requireIssueNumber = (kind: string): number => {
    if (!issueNumber) throw new Error(`${kind} requires PR/issue number in event payload`);
    return issueNumber;
  };

  switch (node.kind) {
    case "github.post_review": {
      if (!prPayload.pull_request) throw new Error("post_review requires a pull_request event");
      const res = await oct.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        {
          owner,
          repo,
          pull_number: requireIssueNumber("post_review"),
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
        {
          owner,
          repo,
          issue_number: requireIssueNumber("add_comment"),
          body: body || "_(no body)_",
        },
      );
      return { output: { commentId: res.data.id, htmlUrl: res.data.html_url } };
    }
    case "github.add_label": {
      const labels = node.config.labels;
      const res = await oct.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
        { owner, repo, issue_number: requireIssueNumber("add_label"), labels },
      );
      return { output: { labels: res.data.map((l) => l.name) } };
    }
    case "git.create_worktree": {
      // The worktree node is structurally an "action" in the schema (no
      // upstream agent input, downstream-fanout-able), but its runtime is
      // an agent dispatch on a device. Delegate to the dedicated runner.
      return worktreeRunner(ctx, node);
    }
    case "github.create_pull_request": {
      if (!ctx.upstreamWorktree) {
        throw new Error(
          "github.create_pull_request requires an upstream git.create_worktree node — this is the only way it can know the head branch",
        );
      }
      const baseBranch =
        node.config.baseBranch && node.config.baseBranch.length > 0
          ? node.config.baseBranch
          : ctx.project.defaultBranch ?? null;
      if (!baseBranch) {
        throw new Error(
          `create_pull_request: no baseBranch configured and project ${owner}/${repo} has no default_branch on file — set config.baseBranch explicitly`,
        );
      }

      const tplVars = collectTemplateVars(ctx);
      const title = renderTemplate(node.config.title, tplVars);
      const renderedBody =
        node.config.body !== null && node.config.body !== undefined
          ? renderTemplate(node.config.body, tplVars)
          : body;

      const res = await oct.request("POST /repos/{owner}/{repo}/pulls", {
        owner,
        repo,
        title,
        body: renderedBody || "_(no body)_",
        head: ctx.upstreamWorktree.branch,
        base: baseBranch,
        draft: node.config.draft,
      });
      return {
        output: {
          number: res.data.number,
          htmlUrl: res.data.html_url,
          headBranch: ctx.upstreamWorktree.branch,
        },
      };
    }
  }
};

// Run a `git.create_worktree` node by dispatching the CLI's `opencara
// internal worktree create` subcommand on a device. The device clones
// the repo into a tmp dir, branches off the configured base, and emits
// `{"workdir":..., "branch":...}` on stdout. We parse that JSON, return
// it as the node's `nodeContext` for downstream nodes to inherit, and
// also surface it on `output` for visibility in the run UI.
async function worktreeRunner(
  ctx: NodeRunCtx,
  node: Extract<ActionNode, { kind: "git.create_worktree" }>,
): Promise<NodeRunResult> {
  const agentRunId = ulid();
  const tplVars = collectTemplateVars(ctx);
  // Pre-stamp OPENCARA_AGENT_RUN_ID so the branch template can reference
  // it before dispatchAgentRun touches the env.
  tplVars["OPENCARA_AGENT_RUN_ID"] = agentRunId;

  const branchName = renderTemplate(node.config.branchName, tplVars);
  if (branchName.length === 0) {
    throw new Error(
      `git.create_worktree: branchName template '${node.config.branchName}' rendered empty — fill in the template variables`,
    );
  }

  const fromBranch =
    node.config.fromBranch && node.config.fromBranch.length > 0
      ? node.config.fromBranch
      : ctx.project.defaultBranch ?? "";

  const env: Record<string, string> = {
    OPENCARA_AGENT_RUN_ID: agentRunId,
    OPENCARA_REPO: `${ctx.project.owner}/${ctx.project.name}`,
  };

  const result = await dispatchAgentRun(ctx, {
    agentRunId,
    kind: "git.create_worktree",
    command: "opencara",
    args: [
      "internal",
      "worktree",
      "create",
      "--repo",
      `${ctx.project.owner}/${ctx.project.name}`,
      "--branch",
      branchName,
      "--from-branch",
      fromBranch,
    ],
    env,
    hostId: node.config.hostId ?? null,
    triggerEventId: ctx.event.id,
  });

  if (result.exitCode !== 0) {
    throw new Error(`git.create_worktree exited with code ${result.exitCode}`);
  }

  // Parse the JSON line — the CLI emits exactly one. Be defensive: scan
  // last → first for the first parseable line, since the device's stdout
  // may include a trailing newline or auxiliary lines if a future
  // version adds progress output.
  const lines = result.stdoutCaptured.split("\n").filter((l) => l.trim().length > 0);
  let parsed: { workdir?: unknown; branch?: unknown } | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      parsed = JSON.parse(lines[i]!) as { workdir?: unknown; branch?: unknown };
      if (typeof parsed.workdir === "string" && typeof parsed.branch === "string") break;
      parsed = null;
    } catch {
      /* try previous line */
    }
  }
  if (!parsed || typeof parsed.workdir !== "string" || typeof parsed.branch !== "string") {
    throw new Error(
      "git.create_worktree: device did not emit a parseable {workdir,branch} JSON line — check the device's CLI version (opencara internal worktree create)",
    );
  }

  const handle: WorktreeHandle = {
    kind: "worktree",
    workdir: parsed.workdir,
    branch: parsed.branch,
    hostId: result.agentHostId,
  };

  return {
    output: { workdir: handle.workdir, branch: handle.branch, hostId: handle.hostId },
    nodeContext: handle,
    stdoutCaptured: result.stdoutCaptured,
  };
}

interface DispatchAgentRunOpts {
  agentRunId: string;
  kind: string;
  command: string;
  args: string[];
  /** Mutable env reference. The helper stamps redacted markers + ephemeral
   *  creds in place. The persisted `agent_runs.spec.env` snapshot freezes
   *  the redacted markers; the live env is later overwritten with the
   *  real token before dispatch. */
  env: Record<string, string>;
  cwd?: string;
  stdinJson?: unknown;
  hostId?: string | null;
  /** triggerEventId on the agent_runs row. Pass null for synthetic flow-
   *  cleanup runs that aren't tied to the originating event. */
  triggerEventId: string | null;
}

/**
 * Shared core: stamp ephemeral cred markers, persist agent_runs row,
 * mint + inject the real GH_TOKEN, dispatch via the device pool, stream
 * logs to agent_run_logs, update terminal status, revoke token in the
 * finally. Both `agentRunner` (user agent) and `worktreeRunner`
 * (synthetic CLI subcommand) flow through here so audit/trace/log
 * behaviour is identical.
 */
async function dispatchAgentRun(
  ctx: NodeRunCtx,
  opts: DispatchAgentRunOpts,
): Promise<RunResult> {
  // Token markers go into the persisted spec.env so the audit row shows
  // injection happened — the real token is overwritten onto the live env
  // AFTER insert (see below) and never reaches the DB. GIT_*_NAME/EMAIL
  // are pinned so a host that ever runs multiple orchestrators doesn't
  // leak its global ~/.gitconfig identity between concurrent runs.
  const tokenPlaceholder = "<ephemeral>";
  opts.env["GH_TOKEN"] = tokenPlaceholder;
  opts.env["GITHUB_TOKEN"] = tokenPlaceholder;
  opts.env["GIT_AUTHOR_NAME"] = "opencara[bot]";
  opts.env["GIT_AUTHOR_EMAIL"] = "opencara[bot]@users.noreply.github.com";
  opts.env["GIT_COMMITTER_NAME"] = "opencara[bot]";
  opts.env["GIT_COMMITTER_EMAIL"] = "opencara[bot]@users.noreply.github.com";

  const spec: AgentSpec = {
    kind: opts.kind,
    command: opts.command,
    args: opts.args,
    env: opts.env,
    cwd: opts.cwd,
  };

  await ctx.db.insert(agentRuns).values({
    id: opts.agentRunId,
    spec,
    triggerEventId: opts.triggerEventId,
    status: "running",
    projectId: ctx.projectId,
    flowRunStepId: ctx.flowRunStepId,
    startedAt: new Date(),
  });

  // Mint AFTER insert. The persisted spec.env snapshot still carries the
  // `<ephemeral>` markers; subsequent mutations of opts.env only affect
  // the dispatched copy. Mint failures are non-fatal — the agent runs
  // without GH_TOKEN, surfacing as 401s downstream rather than masking
  // as a generic flow failure.
  let mintedToken: EphemeralToken | null = null;
  try {
    mintedToken = await ctx.app.mintEphemeralToken({
      installationId: ctx.installation.githubInstallationId,
      repositoryIds: [ctx.project.githubRepoId],
      permissions: { contents: "write", issues: "write", pull_requests: "write" },
    });
    opts.env["GH_TOKEN"] = mintedToken.token;
    opts.env["GITHUB_TOKEN"] = mintedToken.token;
  } catch (err) {
    console.error(
      "[flows] mintEphemeralToken failed; agent runs without GH_TOKEN",
      err,
    );
    delete opts.env["GH_TOKEN"];
    delete opts.env["GITHUB_TOKEN"];
  }

  let seq = 0;
  const onLog = (stream: LogStream, chunk: string) => {
    const mySeq = seq++;
    void ctx.db
      .insert(agentRunLogs)
      .values({ agentRunId: opts.agentRunId, seq: mySeq, stream, chunk })
      .then(() => ctx.pg.notify("agent_run_logs", opts.agentRunId))
      .catch((err: unknown) => {
        console.error("[flows] log persist failed", err);
      });
  };

  try {
    const result = await ctx.dispatcher.run(spec, {
      stdinJson: opts.stdinJson,
      onLog,
      hostId: opts.hostId ?? undefined,
      projectId: ctx.projectId,
    });
    await ctx.db
      .update(agentRuns)
      .set({
        status: result.exitCode === 0 ? "succeeded" : "failed",
        exitCode: result.exitCode,
        finishedAt: new Date(),
      })
      .where(eq(agentRuns.id, opts.agentRunId));
    return result;
  } catch (err) {
    await ctx.db
      .update(agentRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(agentRuns.id, opts.agentRunId));
    throw err;
  } finally {
    if (mintedToken) {
      // Best-effort revoke. The token expires in ≤1h regardless, so a
      // network blip here is logged + swallowed.
      await ctx.app.revokeToken(mintedToken.token).catch((err: unknown) => {
        console.error("[flows] revokeToken failed", err);
      });
    }
  }
}

/**
 * Run a synthetic agent dispatch for a worktree-removal at end-of-run.
 * Does NOT mint a token (rm doesn't need GitHub auth) and does NOT bind
 * to a flow_run_step (cleanup is graph-orthogonal). Best-effort: any
 * error is swallowed by the caller in engine.ts.
 */
export async function runWorktreeRemove(
  ctx: NodeRunCtx,
  handle: WorktreeHandle,
): Promise<void> {
  const agentRunId = ulid();
  const env: Record<string, string> = {
    OPENCARA_AGENT_RUN_ID: agentRunId,
  };
  const spec: AgentSpec = {
    kind: "git.remove_worktree",
    command: "opencara",
    args: ["internal", "worktree", "remove", "--workdir", handle.workdir],
    env,
  };
  await ctx.db.insert(agentRuns).values({
    id: agentRunId,
    spec,
    status: "running",
    projectId: ctx.projectId,
    // No flow_run_step — cleanup is orthogonal to the graph.
    flowRunStepId: null,
    startedAt: new Date(),
  });

  let seq = 0;
  const onLog = (stream: LogStream, chunk: string) => {
    const mySeq = seq++;
    void ctx.db
      .insert(agentRunLogs)
      .values({ agentRunId, seq: mySeq, stream, chunk })
      .then(() => ctx.pg.notify("agent_run_logs", agentRunId))
      .catch(() => undefined);
  };

  try {
    const result = await ctx.dispatcher.run(spec, {
      onLog,
      hostId: handle.hostId,
      projectId: ctx.projectId,
    });
    await ctx.db
      .update(agentRuns)
      .set({
        status: result.exitCode === 0 ? "succeeded" : "failed",
        exitCode: result.exitCode,
        finishedAt: new Date(),
      })
      .where(eq(agentRuns.id, agentRunId));
  } catch (err) {
    await ctx.db
      .update(agentRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(agentRuns.id, agentRunId));
    throw err;
  }
}

// Pulls scalar env-style values from the run context for {{VAR}}
// substitution in node config templates. Mirrors the agent's own env
// view: prContext.envExtras / issueContext.envExtras / project basics.
function collectTemplateVars(ctx: NodeRunCtx): Record<string, string> {
  const vars: Record<string, string> = {
    OPENCARA_REPO: `${ctx.project.owner}/${ctx.project.name}`,
  };
  if (ctx.prContext) Object.assign(vars, ctx.prContext.envExtras);
  if (ctx.issueContext) Object.assign(vars, ctx.issueContext.envExtras);
  return vars;
}

function renderTemplate(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars[name] ?? "");
}
