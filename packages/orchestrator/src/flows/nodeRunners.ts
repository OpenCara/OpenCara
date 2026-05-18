import { ulid } from "ulid";
import { eq, sql } from "drizzle-orm";
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
  flowRunSteps as flowRunStepsTable,
  projects,
  prompts,
} from "../db/schema.js";
import type { AgentDispatcher, LogStream, RunResult } from "../dispatch/dispatcher.js";
import type { EphemeralToken, GithubAppClient } from "../github/app.js";
import {
  autoMergePullRequest,
  linkPrToIssueAndCopyAgentLabel,
} from "../github/pulls.js";
import type { IssueStatusContext, PullRequestContext } from "./context.js";
import { buildIssueImplementContractSkill } from "./skills/issueImplementContract.js";
import { buildPrReviewVerdictSkill } from "./skills/prReviewVerdict.js";
import { markDraftPrReadyByHead } from "./draftPr.js";
import { parseReviewVerdict } from "../agents/verdict.js";
import { isSelfReviewError } from "../github/errors.js";
import type { AgentKind } from "../agents/kinds.js";
import { buildAcpSpec, checkAcpEligibility } from "../agents/acp-gate.js";
import { extractAgentResultText } from "../agents/output.js";
import { worktreePins } from "../db/schema.js";
import { cleanupClosedPrWorktree } from "../worktrees/cleanup.js";

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
  project: { owner: string; name: string; githubRepoId: number; defaultBranch: string | null };
  event: { id: string; type: string; payload: unknown };
  prContext?: PullRequestContext;
  issueContext?: IssueStatusContext;
  previousOutput?: string;
  /** Base URL for the per-run callback API, e.g. "https://opencara.com". */
  publicBaseUrl: string;
  /** True when this node's downstream graph contains a `github.post_review`
   *  action node. The agent runner uses this to auto-inject the verdict-line
   *  contract skill so the post-review parser can populate the GitHub
   *  review's `event` enum from the agent body. Computed by the engine via
   *  `computeDownstreamSet`. */
  hasDownstreamPostReview?: boolean;
  /** True for an operator-triggered rerun from the flow detail page. */
  rerun?: boolean;
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
  // Manual runs from the UI bypass all filters so users can inspect any flow
  // on demand. The trigger node still "matches" so the graph lights up.
  if (ctx.event.type === "manual") {
    return { output: { matched: true, manual: true } };
  }
  if (node.kind === "github.projects_v2_item") {
    return projectsV2ItemTrigger(ctx, node);
  }
  if (node.kind === "github.pull_request_review") {
    return pullRequestReviewTrigger(ctx, node);
  }
  if (node.kind !== "github.pull_request") {
    throw new SkipFlowError(`unsupported trigger kind: ${(node as { kind: string }).kind}`);
  }
  const cfg = node.config;

  // issue_comment.created on a PR — the "commented" virtual action.
  // Bypasses every PR-shape filter (branches/paths/labels/drafts); only
  // the phrase match gates it. Edits / deletes don't fire (matches the
  // pull_request_review "submitted-only" stance: re-firing on a typo
  // correction would surprise operators).
  if (ctx.event.type === "issue_comment") {
    if (!(cfg.actions as readonly string[]).includes("commented")) {
      throw new SkipFlowError("commented action not enabled on this trigger");
    }
    const commentPayload = ctx.event.payload as {
      action?: string;
      issue?: { pull_request?: unknown };
      comment?: { body?: string; user?: { login?: string } };
    };
    if (commentPayload.action !== "created") {
      throw new SkipFlowError(
        `issue_comment action '${commentPayload.action ?? ""}' is not 'created'`,
      );
    }
    if (!commentPayload.issue?.pull_request) {
      throw new SkipFlowError("issue_comment is on a plain issue, not a PR");
    }
    const body = commentPayload.comment?.body ?? "";
    const phrase = cfg.commentPhrase ?? "";
    if (phrase.length === 0) {
      throw new SkipFlowError("comment trigger not enabled (commentPhrase is empty)");
    }
    if (!body.toLowerCase().includes(phrase.toLowerCase())) {
      throw new SkipFlowError(`comment body does not contain '${phrase}'`);
    }
    return {
      output: {
        matched: true,
        comment: true,
        commenter: commentPayload.comment?.user?.login ?? null,
      },
    };
  }

  if (ctx.event.type !== "pull_request") {
    throw new SkipFlowError("not a pull_request or issue_comment event");
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
// Match a github.pull_request_review event. Only fires on
// `submitted` reviews (the "Submit review" button click); `edited` /
// `dismissed` aren't useful wake-up signals for the review-fix loop
// and would surprise operators by re-running the agent on a
// reviewer's typo fix. Filters by review state if configured.
async function pullRequestReviewTrigger(
  ctx: NodeRunCtx,
  node: TriggerNode,
): Promise<NodeRunResult> {
  if (node.kind !== "github.pull_request_review") {
    throw new SkipFlowError(`expected pull_request_review trigger, got ${node.kind}`);
  }

  // issue_comment.created on a PR — the comment-phrase opt-in path.
  // Bypasses the reviewStates / users filters (those gate reviews, not
  // comments). Edits / deletes don't fire (same "submitted-only"
  // stance as the review path: re-firing on a typo correction would
  // surprise operators).
  if (ctx.event.type === "issue_comment") {
    const phrase = node.config.commentPhrase ?? "";
    if (phrase.length === 0) {
      throw new SkipFlowError("comment trigger not enabled (commentPhrase is empty)");
    }
    const commentPayload = ctx.event.payload as {
      action?: string;
      issue?: { pull_request?: unknown };
      comment?: { body?: string; user?: { login?: string } };
    };
    if (commentPayload.action !== "created") {
      throw new SkipFlowError(
        `issue_comment action '${commentPayload.action ?? ""}' is not 'created'`,
      );
    }
    if (!commentPayload.issue?.pull_request) {
      throw new SkipFlowError("issue_comment is on a plain issue, not a PR");
    }
    const body = commentPayload.comment?.body ?? "";
    if (!body.toLowerCase().includes(phrase.toLowerCase())) {
      throw new SkipFlowError(`comment body does not contain '${phrase}'`);
    }
    return {
      output: {
        matched: true,
        comment: true,
        commenter: commentPayload.comment?.user?.login ?? null,
      },
    };
  }

  if (ctx.event.type !== "pull_request_review") {
    throw new SkipFlowError("not a pull_request_review or issue_comment event");
  }
  const payload = ctx.event.payload as {
    action?: string;
    review?: { state?: string; user?: { login?: string } };
  };
  if (payload.action !== "submitted") {
    throw new SkipFlowError(
      `pull_request_review action '${payload.action ?? ""}' is not 'submitted'`,
    );
  }
  // Prefer the verdict-resolved state from prContext over the raw GitHub
  // state. This lets operators filter on intent (`changes_requested`)
  // and still match reviews that post_review had to downgrade to a
  // COMMENT-typed review on a self-PR. See flows/context.ts
  // resolveReviewStateFromBody for the override path.
  const state =
    (ctx.prContext?.stdin.review as { state?: string } | undefined)?.state ??
    payload.review?.state ??
    "";
  if (
    node.config.reviewStates.length > 0 &&
    !(node.config.reviewStates as string[]).includes(state)
  ) {
    throw new SkipFlowError(`review state '${state}' not in reviewStates filter`);
  }
  // Whitelist of reviewer logins (glob: `*`, `opencara*`, …). Empty
  // = match any user. Default `["opencara[bot]"]` keeps pr-review-fix
  // wired to the bot's reviews from pr-review / pr-review-multi —
  // i.e. enables the closed-loop review→fix model on purpose;
  // breaking the loop is the operator's choice (cap iterations,
  // disable the flow, etc.).
  const reviewer = payload.review?.user?.login ?? "";
  if (node.config.users.length > 0 && !matchesAnyGlob(reviewer, node.config.users)) {
    throw new SkipFlowError(
      `reviewer '${reviewer}' not in users filter [${node.config.users.join(", ")}]`,
    );
  }
  return { output: { matched: true, reviewState: state, reviewer } };
}

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
  await enforceMaxIterations(ctx, node);

  // Resolve the linked agent — required because agent flow nodes carry
  // no in-graph subprocess spec. The dispatched AgentSpec (command,
  // args, env, cwd) is built from the linked agent's `kind` via
  // `buildAcpSpec` below.
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
        `agent node '${node.id}' has no linked agent and no agent:<name> label on the issue or PR — link a default from the flow detail page or label the issue/PR`,
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
  if (ctx.rerun) {
    env["OPENCARA_RERUN"] = "1";
  }
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

  // If the operator wired a worktree onto this agent node, allocate
  // (or reuse) the per-PR-branch checkout on a paired device BEFORE
  // dispatching the agent. The worktree persists across flow runs and
  // is removed by the `pull_request.closed` webhook handler — the
  // first iteration clones, every subsequent iteration on the same
  // (repo, branch) finds .git/ already present and just fetches +
  // checks out the branch. Pinning sticks the device that allocated
  // first so the agent-session.json file (used for conversation
  // resume) survives across iterations.
  let worktree: {
    workdir: string;
    branch: string;
    sessionDir: string | null;
    hostId: string;
    priorSession: { kind: AgentKind; id: string } | null;
  } | null = null;
  if (node.config.worktree) {
    const tplVars = collectTemplateVars(ctx);
    tplVars["OPENCARA_AGENT_RUN_ID"] = agentRunId;
    const branchName = renderTemplate(
      node.config.worktree.branchName,
      tplVars,
      "agent.worktree.branchName",
    );
    if (branchName.length === 0) {
      throw new Error(
        `agent.worktree.branchName template '${node.config.worktree.branchName}' rendered empty — fill in the template variables`,
      );
    }
    const fromBranchRaw =
      node.config.worktree.fromBranch && node.config.worktree.fromBranch.length > 0
        ? node.config.worktree.fromBranch
        : ctx.project.defaultBranch ?? "";
    // Render templates so flows like `pr-review-fix` can pin
    // `fromBranch: "{{OPENCARA_PR_HEAD_REF}}"`. The happy path
    // (existing checkout) ignores --from-branch, but a fresh-device /
    // fallback allocation passes it straight to `git clone --branch`,
    // where an unrendered `{{...}}` literal would fail.
    const fromBranch = renderTemplate(
      fromBranchRaw,
      tplVars,
      "agent.worktree.fromBranch",
    );
    const ownerRepo = `${ctx.project.owner}/${ctx.project.name}`;
    // Stable per-(repo, branch) slug. The implement flow's first run
    // and any later review-fix iteration on the same PR compute the
    // same slug → the second one finds the first's checkout +
    // session-id file on the same pinned device.
    const key = `${ownerRepo}/branch-${branchName.replace(/[^A-Za-z0-9._-]/g, "_")}`;

    // Pin lookup: prefer explicit operator pins (node-level first,
    // linked-agent second), then reuse the device that allocated the
    // worktree on a previous iteration of this branch. Fall back to
    // pickIdle() if no pin exists OR the pinned device is currently
    // disconnected (the dispatcher will throw "pinned device <id> is
    // not connected" otherwise; pickIdle gives a graceful degrade).
    let pinnedHostId: string | null = node.config.worktree.hostId ?? agent.hostId ?? null;
    if (!pinnedHostId) {
      const existing = await ctx.db.query.worktreePins.findFirst({
        where: and(eq(worktreePins.ownerRepo, ownerRepo), eq(worktreePins.branch, branchName)),
      });
      if (existing) pinnedHostId = existing.hostId;
    }
    // Graceful degrade: if the operator-pinned OR the per-(repo,branch)
    // pinned device is currently offline, fall back to pickIdle by
    // dropping the hostId. The agent will start a fresh conversation
    // in a fresh checkout on whichever device picks up the run, and
    // the upsert below will re-pin to that new device.
    if (pinnedHostId && !ctx.dispatcher.isConnected(pinnedHostId)) {
      console.warn(
        "[flows] worktree pinned host offline; falling back to pickIdle",
        { ownerRepo, branchName, pinnedHostId },
      );
      pinnedHostId = null;
    }

    // Sub-dispatch: opencara internal worktree create. Idempotent —
    // creates the dir + clone on first run, fetches + checkouts on
    // subsequent runs. Persisted as its own agent_runs row with
    // flowRunStepId=null so the engine's "find the agent_run for
    // this step" lookups still hit the primary agent run below.
    const allocateRunId = ulid();
    const allocateEnv: Record<string, string> = {
      OPENCARA_AGENT_RUN_ID: allocateRunId,
      OPENCARA_REPO: ownerRepo,
    };
    const allocateArgs = [
      "internal",
      "worktree",
      "create",
      "--repo",
      ownerRepo,
      "--branch",
      branchName,
      "--from-branch",
      fromBranch,
      "--key",
      key,
    ];
    const cacheRepo = node.config.worktree.cacheRepo;
    if (cacheRepo?.enabled) {
      allocateArgs.push("--cache-repo");
      if (cacheRepo.lfs) allocateArgs.push("--lfs");
    }
    const allocateResult = await dispatchAgentRun(ctx, {
      agentRunId: allocateRunId,
      kind: "internal:worktree-allocate",
      command: "opencara",
      args: allocateArgs,
      env: allocateEnv,
      hostId: pinnedHostId,
      triggerEventId: ctx.event.id,
      flowRunStepId: null,
    });
    if (allocateResult.exitCode !== 0) {
      // Surface the real cause into flow_run_steps.error so operators
      // don't have to drill into agent_run_logs for a one-line problem
      // like "git-lfs not installed" or "branch not found on origin".
      const tail = allocateResult.stderrTail.trim();
      const host = allocateResult.agentHostId;
      const detail = tail.length > 0 ? `: ${tail}` : "";
      throw new Error(
        `worktree allocation on host ${host} exited with code ${allocateResult.exitCode}${detail}`,
      );
    }

    // Parse {workdir, branch, sessionDir, priorSession} from the CLI's
    // single-line JSON. Defensive last→first scan in case future
    // versions interleave progress lines.
    const lines = allocateResult.stdoutCaptured
      .split("\n")
      .filter((l) => l.trim().length > 0);
    type DevicePayload = {
      workdir?: unknown;
      branch?: unknown;
      sessionDir?: unknown;
      priorSession?: unknown;
    };
    let parsed: DevicePayload | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        parsed = JSON.parse(lines[i]!) as DevicePayload;
        if (typeof parsed.workdir === "string" && typeof parsed.branch === "string") break;
        parsed = null;
      } catch {
        /* try previous line */
      }
    }
    if (!parsed || typeof parsed.workdir !== "string" || typeof parsed.branch !== "string") {
      throw new Error(
        "agent.worktree: device did not emit a parseable {workdir, branch} JSON line — check the CLI version (opencara internal worktree create)",
      );
    }

    const sessionDir = typeof parsed.sessionDir === "string" ? parsed.sessionDir : null;
    let priorSession: { kind: AgentKind; id: string } | null = null;
    if (parsed.priorSession && typeof parsed.priorSession === "object") {
      const ps = parsed.priorSession as { kind?: unknown; id?: unknown };
      const knownKinds: AgentKind[] = ["claude", "codex", "opencode", "pi"];
      if (
        typeof ps.kind === "string" &&
        typeof ps.id === "string" &&
        (knownKinds as string[]).includes(ps.kind)
      ) {
        priorSession = { kind: ps.kind as AgentKind, id: ps.id };
      }
    }

    // Upsert the pin so the next iteration on this branch hits the
    // same device. lastRunAt drives the reaper's pruning later.
    await ctx.db
      .insert(worktreePins)
      .values({
        id: ulid(),
        ownerRepo,
        branch: branchName,
        hostId: allocateResult.agentHostId,
        lastRunAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [worktreePins.ownerRepo, worktreePins.branch],
        set: { hostId: allocateResult.agentHostId, lastRunAt: new Date() },
      });

    worktree = {
      workdir: parsed.workdir,
      branch: parsed.branch,
      sessionDir,
      hostId: allocateResult.agentHostId,
      priorSession,
    };

    // Surface to the agent's env so its scripts can see them without
    // parsing the spec.
    env["OPENCARA_WORKTREE_DIR"] = worktree.workdir;
    env["OPENCARA_WORKTREE_BRANCH"] = worktree.branch;
    if (worktree.sessionDir) env["OPENCARA_SESSION_DIR"] = worktree.sessionDir;
  }
  const issueImplementRun = Boolean(
    worktree?.branch && ctx.issueContext?.stdin.issue?.number,
  );
  if (node.config.draftPr && issueImplementRun) {
    env["OPENCARA_PR_DRAFT"] = "1";
  }

  // Inject the issue-implement contract skill when this run is shaped
  // like one: a worktree was allocated AND the trigger carries issue
  // context. The skill tells the agent it must commit/push and run
  // `gh pr create` before exiting — the missing-PR mode this contract
  // closes was visible on flow run 01KRDW75RV2Y6YN9BSTPP2JVE5, where
  // the agent edited a file, ran typecheck, then stopped without
  // shipping anything. Other shapes (pr-review etc.) don't carry an
  // issue context so this short-circuits to null.
  //
  // Stamp OPENCARA_ISSUE_NUMBER here (in addition to whatever the
  // node's contextInjection.env lists) so the env var the skill names
  // is always present — otherwise an operator-customized flow that
  // dropped it from contextInjection.env would silently break the
  // shell snippets in the skill prose.
  const implementSkill =
    issueImplementRun && ctx.issueContext?.stdin.issue?.number && worktree?.branch
      ? buildIssueImplementContractSkill({
          baseUrl: ctx.publicBaseUrl,
          runId: agentRunId,
          branchName: worktree.branch,
          issueNumber: ctx.issueContext.stdin.issue.number,
          defaultBranch: ctx.project.defaultBranch ?? "main",
        })
      : null;
  if (implementSkill && ctx.issueContext?.stdin.issue?.number) {
    env["OPENCARA_ISSUE_NUMBER"] = String(ctx.issueContext.stdin.issue.number);
  }

  const stdinJson = node.config.contextInjection.stdinJson
    ? {
        ...(ctx.prContext?.stdin ?? {}),
        ...(ctx.issueContext?.stdin ?? {}),
        previousOutput: ctx.previousOutput,
        prompt: linkedPromptBody ?? undefined,
      }
    : undefined;

  // ACP cutover (#30): all flow-driven agent dispatch goes through the
  // device's `runAcpJob` path. The per-kind adapter machinery in the
  // legacy `kindsAdapter` (claude --resume, codex exec resume, etc.)
  // is gone; per-kind specifics now live inside the per-kind ACP
  // adapter binaries (claude-acp, codex-acp, opencode acp, pi-acp).
  //
  // Session resume across iterations is wired via ACP `session/load`:
  //   - `worktree-allocate` reads `<sessionDir>/agent-session.json`
  //     (if any) and emits `priorSession: {kind, id}`.
  //   - We forward that `id` as `acp.priorSessionId` only when the
  //     persisted `kind` matches the current agent's kind — operators
  //     can swap agents mid-PR via labels, and a Claude UUID must not
  //     leak into a Codex session.
  //   - After a successful run, we dispatch a best-effort `worktree
  //     write-session` on the same pinned device to persist the new
  //     session id for the next iteration. A failure logs and moves
  //     on — losing resume next iteration is preferable to failing
  //     this flow.
  //
  // What we keep:
  //   - Worktree allocation (the per-(repo, branch) checkout on a
  //     pinned device — the `dispatchAgentRun` for `worktree-allocate`
  //     above is unchanged; that's an internal CLI subcommand, not
  //     an ACP agent).
  //   - Linked-prompt + skill envelope; both fold into systemPromptMd.
  //   - Upstream `previousOutput` chaining; goes into userPromptMd.
  //   - PR / issue context-injection; surfaced via pageContextJson.
  const eligibility = checkAcpEligibility(agent.kind);
  if (eligibility.refuseReason) {
    throw new Error(eligibility.refuseReason);
  }

  const systemPromptParts: string[] = [];
  const injectedSkills: Array<{ name: string; instructions: string }> = [];
  if (linkedPromptBody && linkedPromptBody.trim().length > 0) {
    systemPromptParts.push(linkedPromptBody.trim());
  }
  if (implementSkill) {
    systemPromptParts.push(implementSkill.instructions);
    injectedSkills.push({
      name: implementSkill.name,
      instructions: implementSkill.instructions,
    });
  }
  // Auto-injected when this agent's downstream graph contains a
  // `github.post_review` node. Mandates the `verdict: <token>` first-line
  // contract that the post-review parser reads to populate GitHub's
  // review `event` enum. Active for both standalone reviewers
  // (pr-review) and every agent in fan-in chains (pr-review-multi
  // reviewers + synthesizer).
  if (ctx.hasDownstreamPostReview) {
    const verdictSkill = buildPrReviewVerdictSkill({
      baseUrl: ctx.publicBaseUrl,
      runId: agentRunId,
    });
    systemPromptParts.push(verdictSkill.instructions);
    injectedSkills.push({
      name: verdictSkill.name,
      instructions: verdictSkill.instructions,
    });
  }
  const systemPromptMd =
    systemPromptParts.length > 0
      ? systemPromptParts.join("\n\n---\n\n")
      : "You are an opencara flow agent. Process the input below.";

  // Persist the assembled system prompt + skill list to the step row
  // BEFORE dispatching, so the flow-run detail UI can show what the
  // agent actually saw while the run is in flight (and even when it
  // fails mid-run). Merge into the existing inputJson rather than
  // overwriting it — the engine wrote node config / previousOutput at
  // step creation. Best-effort: a write failure here just means the
  // UI loses the system-prompt panel; it must not break the run.
  try {
    const existing = await ctx.db.query.flowRunSteps.findFirst({
      where: eq(flowRunStepsTable.id, ctx.flowRunStepId),
    });
    const existingInput = (existing?.inputJson ?? {}) as Record<string, unknown>;
    await ctx.db
      .update(flowRunStepsTable)
      .set({
        inputJson: {
          ...existingInput,
          agentName: agent.name,
          agentKind: agent.kind,
          systemPromptMd,
          injectedSkills,
        },
      })
      .where(eq(flowRunStepsTable.id, ctx.flowRunStepId));
    await ctx.pg.notify("flow_run_steps", ctx.flowRunId);
  } catch (err) {
    console.error("[flows] failed to persist system prompt to step row", err);
  }

  // userPromptMd is the upstream node's stdoutCaptured (already cleaned
  // of agent-envelope/JSONL noise by `extractAgentResultText` in
  // engine.ts:outputs.set). Triggers / first-step agents have no
  // upstream output; surface a sentinel so ACP doesn't reject the
  // empty prompt.
  const upstream = ctx.previousOutput?.trim() ?? "";
  const userPromptMd =
    upstream.length > 0
      ? upstream
      : "(no upstream output — proceed using the system prompt and any page context above.)";

  // Flow-time pageContext = whatever stdin payloads the legacy path
  // would have stuffed into stdinJson. The agent gets the same data;
  // it just lives inside the prompt content block instead of an
  // out-of-band stdin envelope.
  const pageContext: Record<string, unknown> = {};
  if (ctx.prContext) Object.assign(pageContext, ctx.prContext.stdin);
  if (ctx.issueContext) Object.assign(pageContext, ctx.issueContext.stdin);

  // Kind guard: only resume when the persisted session was for this
  // agent kind. Two simultaneous reviews on the same branch can race
  // here — second writer wins on the agent-session.json file. Same
  // behavior as the pre-cutover path; the worktree pin serializes most
  // real-world traffic.
  const priorSessionId =
    worktree?.priorSession && worktree.priorSession.kind === agent.kind.toLowerCase()
      ? worktree.priorSession.id
      : undefined;

  const acpSpec = buildAcpSpec({
    agent: {
      kind: agent.kind,
      name: agent.name,
      cwd: worktree?.workdir ?? agent.cwd ?? null,
    },
    env,
    systemPromptMd,
    userPromptMd,
    pageContext,
    priorSessionId,
  });

  const result = await dispatchAgentRun(ctx, {
    agentRunId,
    kind: agent.name,
    command: acpSpec.command,
    args: [...acpSpec.args],
    env,
    cwd: acpSpec.cwd,
    acp: acpSpec.acp,
    hostId: worktree?.hostId ?? agent.hostId ?? null,
    triggerEventId: ctx.event.id,
  });

  if (result.exitCode !== 0) {
    throw new Error(`agent exited with code ${result.exitCode}`);
  }

  // Persist the session id for next iteration on this (repo, branch).
  // Runs on the same pinned device that just ran the agent, since the
  // sessionDir is local to it. Best-effort: a write-session failure
  // here disables resume for the NEXT run only — the parent flow's
  // result is already determined by the agent's exit code above.
  if (worktree?.sessionDir && result.acpSessionId) {
    const writeRunId = ulid();
    try {
      // dispatchAgentRun returns RunResult and only throws on transport
      // errors (device disconnect, mint-token failure, etc.) — a non-zero
      // exitCode from the CLI itself comes back via the returned value,
      // so we have to check it explicitly. Otherwise a failed
      // write-session (disk full, permissions on sessionDir) would
      // silently disable resume next iteration with no diagnostic.
      const writeResult = await dispatchAgentRun(ctx, {
        agentRunId: writeRunId,
        kind: "internal:worktree-write-session",
        command: "opencara",
        args: [
          "internal",
          "worktree",
          "write-session",
          "--session-dir",
          worktree.sessionDir,
          "--kind",
          agent.kind.toLowerCase(),
          "--id",
          result.acpSessionId,
        ],
        env: { OPENCARA_AGENT_RUN_ID: writeRunId },
        hostId: worktree.hostId,
        triggerEventId: ctx.event.id,
        flowRunStepId: null,
      });
      if (writeResult.exitCode !== 0) {
        console.error(
          `[flows] worktree write-session exited ${writeResult.exitCode} ` +
            `(resume disabled for next run on ${ctx.project.owner}/${ctx.project.name}@${worktree.branch})`,
        );
      }
    } catch (err) {
      console.error(
        "[flows] worktree write-session dispatch failed (resume disabled for next run)",
        err,
      );
    }
  }

  // Post-step: when an issue-implement-shaped run succeeds (issue
  // context present, worktree allocated), link the PR the agent just
  // opened back to its source issue (Closes #N in body → populates
  // GitHub's Development panel) and copy the issue's agent:<name>
  // label onto the PR so pr-review-fix's label-based agent routing
  // finds the same agent on the next iteration.
  //
  // Two failure modes are distinguished:
  //   - `no-pr` → the agent skipped `gh pr create`. This is the bug
  //     the implement-contract skill exists to prevent; surface it
  //     loudly so the flow run is marked failed instead of silently
  //     "succeeded".
  //   - `transient-failure` (network / 5xx on the list call) → log
  //     and continue; the agent's work is unaffected and the PR may
  //     well exist.
  if (issueImplementRun && ctx.issueContext?.stdin.issue?.number && worktree?.branch) {
    let linkResult: Awaited<ReturnType<typeof linkPrToIssueAndCopyAgentLabel>> | null = null;
    try {
      const octokit = await ctx.app.forInstallation(
        ctx.installation.githubInstallationId,
      );
      linkResult = await linkPrToIssueAndCopyAgentLabel({
        octokit,
        owner: ctx.project.owner,
        repo: ctx.project.name,
        branchName: worktree.branch,
        issueNumber: ctx.issueContext.stdin.issue.number,
        issueLabels: ctx.issueContext.stdin.issue.labels ?? [],
      });
    } catch (err) {
      console.error("[flows] link-pr-to-issue post-step failed", err);
    }
    if (linkResult?.kind === "no-pr") {
      throw new Error(
        `agent ran successfully but did not open a pull request on ${ctx.project.owner}/${ctx.project.name}@${worktree.branch}. ` +
          `The issue-implement flow requires the agent to commit, push the branch, and run \`gh pr create\` before exiting. ` +
          `Check the agent's logs above; the orchestrator now injects the opencara-issue-implement-contract skill to spell out this contract.`,
      );
    }
  }

  if (node.config.draftPr && issueImplementRun && worktree?.branch) {
    try {
      const octokit = await ctx.app.forInstallation(
        ctx.installation.githubInstallationId,
      );
      await markDraftPrReadyByHead({
        octokit,
        owner: ctx.project.owner,
        repo: ctx.project.name,
        headBranch: worktree.branch,
      });
    } catch (err) {
      console.error("[flows] mark-draft-pr-ready post-step failed", err);
    }
  }

  const autoMergeOutput = await maybeAutoMergeAfterFix(ctx, node);

  return {
    output: { exitCode: result.exitCode, ...(autoMergeOutput ? { autoMerge: autoMergeOutput } : {}) },
    stdoutCaptured: result.stdoutCaptured,
  };
};

async function enforceMaxIterations(ctx: NodeRunCtx, node: AgentNode): Promise<void> {
  const cfg = node.config.maxIterations;
  const limit = cfg?.limit ?? 0;
  if (!cfg?.enabled || limit <= 0) return;
  if (ctx.event.type === "manual" || ctx.rerun) return;
  if (!isPrReviewFixContext(ctx)) return;

  const prNumber = getPrNumber(ctx);
  const headRef = getPrHeadRef(ctx);
  if (!prNumber && !headRef) return;

  const completed = await countCompletedFixRuns(ctx, { prNumber, headRef });
  if (completed < limit) return;

  const reason = `opencara: reached maxIterations=${limit} on this PR; further @opencara fix / review comments will not dispatch until the count resets`;
  if (cfg.commentOnSkip && prNumber) {
    await postMaxIterationsCommentOnce(ctx, prNumber, reason);
  }
  throw new SkipFlowError(reason);
}

function isPrReviewFixContext(ctx: NodeRunCtx): boolean {
  return ctx.event.type === "pull_request_review" || ctx.event.type === "issue_comment";
}

function getPrNumber(ctx: NodeRunCtx): number | null {
  const payload = ctx.event.payload as {
    pull_request?: { number?: number };
    issue?: { number?: number };
  };
  const fromPayload = payload.pull_request?.number ?? payload.issue?.number;
  if (typeof fromPayload === "number") return fromPayload;
  const pr = ctx.prContext?.stdin.pr as { number?: unknown } | undefined;
  return typeof pr?.number === "number" ? pr.number : null;
}

function getPrHeadRef(ctx: NodeRunCtx): string | null {
  const payload = ctx.event.payload as {
    pull_request?: { head?: { ref?: string } };
  };
  const fromPayload = payload.pull_request?.head?.ref;
  if (fromPayload) return fromPayload;
  const pr = ctx.prContext?.stdin.pr as { head?: { ref?: unknown } } | undefined;
  return typeof pr?.head?.ref === "string" ? pr.head.ref : null;
}

function getPrHeadSha(ctx: NodeRunCtx): string | null {
  const payload = ctx.event.payload as {
    pull_request?: { head?: { sha?: string } };
  };
  const fromPayload = payload.pull_request?.head?.sha;
  if (fromPayload) return fromPayload;
  const pr = ctx.prContext?.stdin.pr as { head?: { sha?: unknown } } | undefined;
  return typeof pr?.head?.sha === "string" ? pr.head.sha : null;
}

async function countCompletedFixRuns(
  ctx: NodeRunCtx,
  pr: { prNumber: number | null; headRef: string | null },
): Promise<number> {
  const rows = await ctx.db.execute(sql`
    select count(*)::int as count
    from flow_runs fr
    join platform_events pe on pe.id = fr.trigger_event_id
    where fr.flow_id = ${ctx.flowId}
      and fr.status = 'succeeded'
      and (
        (
          ${pr.prNumber}::int is not null
          and (
          (pe.payload->'pull_request'->>'number')::int = ${pr.prNumber}
          or (pe.payload->'issue'->>'number')::int = ${pr.prNumber}
          )
        )
        or (
          ${pr.prNumber}::int is null
          and ${pr.headRef}::text is not null
          and pe.payload->'pull_request'->'head'->>'ref' = ${pr.headRef}
        )
      )
  `);
  const first = Array.isArray(rows) ? rows[0] : (rows as { rows?: unknown[] }).rows?.[0];
  const value = (first as { count?: unknown } | undefined)?.count;
  return typeof value === "number" ? value : Number(value ?? 0);
}

async function postMaxIterationsCommentOnce(
  ctx: NodeRunCtx,
  prNumber: number,
  body: string,
): Promise<void> {
  try {
    const octokit = await ctx.app.forInstallation(ctx.installation.githubInstallationId);
    const comments = await octokit.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner: ctx.project.owner,
        repo: ctx.project.name,
        issue_number: prNumber,
        per_page: 100,
      },
    );
    const alreadyPosted = (comments.data as Array<{ body?: string | null }>).some(
      (comment) => comment.body === body,
    );
    if (alreadyPosted) return;
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: ctx.project.owner,
      repo: ctx.project.name,
      issue_number: prNumber,
      body,
    });
  } catch (err) {
    console.error("[flows] maxIterations skip comment failed", err);
  }
}

async function maybeAutoMergeAfterFix(
  ctx: NodeRunCtx,
  node: AgentNode,
): Promise<Record<string, unknown> | null> {
  const cfg = node.config.autoMerge;
  if (!cfg?.enabled) return null;
  if (!isPrReviewFixContext(ctx)) return null;
  const prNumber = getPrNumber(ctx);
  if (!prNumber) {
    throw new Error("autoMerge enabled but PR number is unavailable");
  }

  const octokit = await ctx.app.forInstallation(ctx.installation.githubInstallationId);
  const result = await autoMergePullRequest({
    octokit,
    owner: ctx.project.owner,
    repo: ctx.project.name,
    pullNumber: prNumber,
    method: cfg.method,
    requireChecks: cfg.requireChecks,
    requireApproval: cfg.requireApproval,
    priorHeadSha: getPrHeadSha(ctx),
  });
  if (result.kind === "skipped") {
    console.warn(`[flows] autoMerge skipped: ${result.reason}`);
    return {
      merged: false,
      reason: result.reason,
    };
  }

  const headRef = getPrHeadRef(ctx);
  if (headRef) {
    await cleanupClosedPrWorktree(
      { db: ctx.db, pg: ctx.pg, dispatcher: ctx.dispatcher },
      `${ctx.project.owner}/${ctx.project.name}`,
      headRef,
      ctx.projectId,
    );
  }

  return {
    merged: true,
    method: cfg.method,
    sha: result.sha,
    message: result.message,
    cleanedUp: Boolean(headRef),
  };
}

// Inspect the triggering artifact's labels for an `agent:<name>` marker
// and look that agent up by (name, project_owner_user_id). Returns null
// when no such label exists (caller falls back to the linked agent).
// Throws a SkipFlowError when the label is present but malformed/
// duplicate, and a regular Error when the label points at an unknown
// agent (user error worth surfacing rather than swallowing).
//
// Sources walked:
//   - issueContext.stdin.issue.labels — the projects_v2_item path
//     (issue-implement flow): label set on the issue.
//   - prContext.stdin.pr.labels (only for pull_request_review events)
//     — the pr-review-fix path: label set on the PR. Operators can
//     change the agent mid-PR by relabeling.
//
// We deliberately do NOT walk PR labels for `pull_request` lifecycle
// events (opened/synchronize/...) because those flows (pr-review,
// pr-review-multi) use multi-agent fan-out via flow_node_settings;
// reading PR labels would silently route them away from the operator's
// linked reviewers.
async function resolveLabelRoutedAgent(
  ctx: NodeRunCtx,
): Promise<typeof agents.$inferSelect | null> {
  const sources: string[] = [];
  for (const l of ctx.issueContext?.stdin.issue?.labels ?? []) {
    if (typeof l.name === "string") sources.push(l.name);
  }
  if (ctx.event.type === "pull_request_review" && ctx.prContext?.stdin.pr) {
    const pr = ctx.prContext.stdin.pr as { labels?: Array<{ name?: unknown }> };
    for (const l of pr.labels ?? []) {
      if (typeof l.name === "string") sources.push(l.name);
    }
  }
  const PREFIX = "agent:";
  const requested = sources
    .filter((n) => n.startsWith(PREFIX))
    .map((n) => n.slice(PREFIX.length).trim())
    .filter((n) => n.length > 0);
  if (requested.length === 0) return null;
  if (requested.length > 1) {
    throw new SkipFlowError(
      `multiple agent:<name> labels on issue/PR (${requested.join(", ")}); pick one`,
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
      `label requested agent:${name} but no agent named '${name}' exists for the project owner — create it on /agents or fix the label`,
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
  // `previousOutput` is the upstream node's captured stdout. For agent nodes
  // run with `claude --output-format json` (see agents/kinds.ts), that
  // stdout is the Claude Code result envelope — a JSON document whose
  // human-readable markdown lives in `.result`. Posting the envelope as a
  // GitHub review body produces the bot-review-format-bug surfaced on
  // PR #33. `extractAgentResultText` parses the envelope; falls through
  // verbatim for plain-text outputs.
  const body = extractAgentResultText(ctx.previousOutput ?? "").trim();

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
      // PR object resolution: the lifecycle / pull_request_review webhooks
      // carry `pull_request` inline on the event payload, but the comment
      // path (issue_comment on a PR) doesn't — the orchestrator fetches
      // the PR object in `buildPullRequestContext` and parks it under
      // `ctx.prContext.stdin.pr`. Read both so a comment-triggered review
      // flow can still post its review.
      const pr =
        prPayload.pull_request ??
        (ctx.prContext?.stdin.pr as
          | { number: number; head: { sha: string } }
          | undefined);
      if (!pr) {
        throw new Error(
          "post_review requires a pull_request event or a comment-on-PR trigger",
        );
      }
      // Parse the agent-emitted `verdict: <token>` line off the top of
      // the body (contract enforced upstream by the verdict skill in
      // skills/prReviewVerdict.ts). When present, it drives GitHub's
      // review `event` enum and the line is stripped from the body so
      // it doesn't double-render alongside the colored badge. When
      // absent or malformed, fall back to `node.config.event` and
      // post the body verbatim — operator-visible signal that the
      // agent didn't honor the contract.
      const parsed = parseReviewVerdict(body);
      const event = parsed?.verdict ?? node.config.event;
      const reviewBody = parsed?.bodyWithoutVerdict ?? body;
      type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      const postReview = (postEvent: ReviewEvent, postBody: string) =>
        oct.request(
          "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
          {
            owner,
            repo,
            pull_number: pr.number,
            body: postBody || "_(no review body)_",
            event: postEvent,
            commit_id: pr.head.sha,
          },
        );

      let res;
      let downgradedFrom: string | null = null;
      try {
        res = await postReview(event, reviewBody);
      } catch (err) {
        // GitHub forbids APPROVE / REQUEST_CHANGES on a PR opened by the
        // same identity (HTTP 422). When the App installation backing
        // post_review also opened the PR — common in single-account
        // setups where opencara is both the implementer and the
        // reviewer — fall back to a COMMENT-typed review and embed the
        // original verdict line in the body so downstream pr-review-fix
        // can still read intent (see flows/context.ts
        // resolveReviewStateFromBody).
        if (!isSelfReviewError(err, event)) throw err;
        const verdictLabel =
          event === "REQUEST_CHANGES" ? "Request changes" : "Approve";
        const verdictToken =
          event === "REQUEST_CHANGES" ? "request_changes" : "approve";
        const downgradedBody = [
          `_Downgraded to "Commented" — GitHub forbids "${verdictLabel}" on a PR you opened. Verdict preserved below for review-fix flows._`,
          "",
          `verdict: ${verdictToken}`,
          "",
          reviewBody,
        ]
          .join("\n")
          .trim();
        try {
          res = await postReview("COMMENT", downgradedBody);
        } catch (retryErr) {
          // Surface both errors so operators don't lose the original
          // 422 context when the retry fails for an unrelated reason
          // (transient 5xx, PR closed mid-run, etc.).
          throw new Error(
            `post_review fallback to COMMENT failed after ${event} self-review 422: ${String(
              (retryErr as Error).message ?? retryErr,
            )} (original error: ${String((err as Error).message ?? err)})`,
            { cause: retryErr },
          );
        }
        downgradedFrom = event;
        console.warn(
          `[post_review] self-review on ${owner}/${repo}#${pr.number} downgraded ${event} -> COMMENT`,
        );
      }
      return {
        output: {
          reviewId: res.data.id,
          htmlUrl: res.data.html_url,
          ...(downgradedFrom ? { downgradedFrom } : {}),
        },
      };
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
  }
};

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
  /** When set, the dispatched spec carries an `acp` payload so the
   *  device's `runAcpJob` runner picks up the prompt/skill plumbing
   *  instead of the legacy stdin-JSON envelope. Required for agent
   *  nodes after the #30 cutover; left unset for internal CLI
   *  subcommands like worktree-allocate that aren't ACP agents. */
  acp?: import("@opencara/shared").AcpSpec;
  hostId?: string | null;
  /** triggerEventId on the agent_runs row. Pass null for synthetic flow-
   *  cleanup runs that aren't tied to the originating event. */
  triggerEventId: string | null;
  /** Override the agent_runs row's flowRunStepId. Defaults to
   *  `ctx.flowRunStepId`. Set to null for sub-runs that share a step
   *  with another agent dispatch (e.g. a worktree-allocate that
   *  precedes the agent's main dispatch in the same flow_run_step). */
  flowRunStepId?: string | null;
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
): Promise<RunResult & { stderrTail: string }> {
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
    ...(opts.acp ? { acp: opts.acp } : {}),
  };

  const stepId = opts.flowRunStepId === undefined ? ctx.flowRunStepId : opts.flowRunStepId;
  await ctx.db.insert(agentRuns).values({
    id: opts.agentRunId,
    spec,
    triggerEventId: opts.triggerEventId,
    status: "running",
    projectId: ctx.projectId,
    flowRunStepId: stepId,
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

  // Bounded stderr ring buffer so non-zero exits can carry the real
  // cause into the thrown Error / flow_run_steps.error column. The full
  // log is still in agent_run_logs; this is just what we surface up the
  // engine stack so operators don't have to dig.
  const STDERR_TAIL_BYTES = 4000;
  const stderrChunks: string[] = [];
  let stderrBytes = 0;
  let seq = 0;
  const onLog = (stream: LogStream, chunk: string) => {
    if (stream === "stderr") {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      while (stderrBytes > STDERR_TAIL_BYTES && stderrChunks.length > 1) {
        stderrBytes -= stderrChunks[0]!.length;
        stderrChunks.shift();
      }
    }
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
        hostId: result.agentHostId,
        exitCode: result.exitCode,
        finishedAt: new Date(),
      })
      .where(eq(agentRuns.id, opts.agentRunId));
    return { ...result, stderrTail: stderrChunks.join("") };
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

// Same shell-style tokenizer as routes/api/agents.ts (whitespace
// separates, single/double quotes group). Inlined here to avoid a
// cross-cutting import; if a third caller appears, lift to shared.
function tokenizeShellLike(input: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;
  const flush = () => {
    if (inToken) {
      tokens.push(buf);
      buf = "";
      inToken = false;
    }
  };
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else {
        buf += ch;
        inToken = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      flush();
      continue;
    }
    buf += ch;
    inToken = true;
  }
  flush();
  return tokens;
}

function renderTemplate(tmpl: string, vars: Record<string, string>, where: string): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!(name in vars)) {
      // Fail loud rather than silently producing "opencara/issue-" or
      // "WIP: implement issue #". Operators will see this in
      // flow_runs.error and know which env var is missing.
      throw new Error(
        `${where}: template variable {{${name}}} not in run env (available: ${
          Object.keys(vars).sort().join(", ") || "(none)"
        })`,
      );
    }
    return vars[name]!;
  });
}
