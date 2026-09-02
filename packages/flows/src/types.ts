import { z } from "zod";

const Position = z.object({ x: z.number(), y: z.number() });

// ---------------------------------------------------------------------------
// Platform-neutral node kinds
// ---------------------------------------------------------------------------
// Node kinds used to be spelled `github.*`. They are now `scm.*` so a single
// flow graph runs against whichever platform the *project* is on (GitHub or
// Azure DevOps) — the engine resolves the concrete provider at run time from
// `projects.platform`, so built-in flows do not need a per-platform variant.
//
// The old spellings are still accepted and normalized to the new ones by
// `FlowNodeSchema`'s preprocess below. That matters: every `flows.graph_json`
// and `template_drafts.graph_json` row in production still holds `github.*`,
// and rewriting them would collide with the template-draft shadowing behaviour
// documented in .claude/lessons.md. Normalizing on read means **no data
// migration and no reseed** — old rows keep working and are upgraded in place
// the next time the graph is saved.
export const LEGACY_NODE_KIND_ALIASES: Readonly<Record<string, string>> = {
  "github.pull_request": "scm.pull_request",
  "github.pull_request_review": "scm.pull_request_review",
  "github.projects_v2_item": "scm.board_item",
  "github.post_review": "scm.post_review",
  "github.add_comment": "scm.add_comment",
  "github.add_label": "scm.add_label",
};

/**
 * Map a possibly-legacy node kind to its canonical `scm.*` spelling. Unknown
 * and already-canonical kinds pass through untouched, so this is safe to apply
 * to any node kind — including `agent` and `schedule.cron`.
 *
 * Callers that compare a *persisted* kind string (e.g. `flow_run_steps.nodeKind`
 * on a historical row) should run it through here first rather than adding a
 * second case to a switch.
 */
export function normalizeNodeKind(kind: string): string {
  return LEGACY_NODE_KIND_ALIASES[kind] ?? kind;
}

/**
 * Deep-clone a stored graph and canonicalize its node kinds in one step.
 *
 * This is the shape every non-zod read path wants: the four `parseGraph` /
 * `currentGraph` helpers in the orchestrator all need a mutable copy (drizzle
 * hands back a cached row reference) AND the `github.*` → `scm.*` rewrite. Doing
 * it in one exported call is what stops a fifth read path from being added with
 * the clone but without the normalization — the exact failure mode recorded in
 * .claude/lessons.md, where the zod-level normalization silently didn't apply to
 * these paths.
 */
export function cloneAndNormalizeGraph<T extends { nodes?: unknown }>(graph: T): T {
  return normalizeGraphKinds(JSON.parse(JSON.stringify(graph)) as T);
}

/**
 * In-place canonicalization of every node kind in a loosely-typed graph object.
 *
 * `FlowDefinitionSchema` normalizes on parse, but several read paths
 * deliberately skip zod and shallow-cast the stored JSON instead (the
 * `parseGraph` helpers in routes/api/flows.ts and agent-calls/*, and the
 * template-draft readers). Those paths feed the web canvas directly, so they
 * need the same treatment or the UI sees pre-rename kinds and falls through to
 * its default node rendering.
 *
 * Returns the same object it was handed, for convenient chaining.
 */
export function normalizeGraphKinds<T extends { nodes?: unknown }>(graph: T): T {
  if (Array.isArray(graph.nodes)) {
    for (const node of graph.nodes) {
      if (node && typeof node === "object") {
        const n = node as { kind?: unknown };
        if (typeof n.kind === "string") n.kind = normalizeNodeKind(n.kind);
      }
    }
  }
  return graph;
}

// Mirrors GitHub Actions' on.pull_request filter set, plus a fifth
// "commented" action that wakes the flow on an `issue_comment.created`
// webhook when the comment body contains `commentPhrase` (default
// `@opencara review`). The comment path bypasses branches/paths/labels/
// drafts filters — only the phrase match gates it. PR-review events
// remain a SEPARATE trigger kind (see ScmPullRequestReviewTriggerSchema).
//
// On Azure DevOps the equivalent events are `git.pullrequest.created` /
// `git.pullrequest.updated` and a PR thread comment; the filters carry the
// same meaning.
export const ScmPullRequestTriggerSchema = z.object({
  id: z.string(),
  kind: z.literal("scm.pull_request"),
  position: Position,
  config: z.object({
    actions: z
      .array(
        z.enum(["opened", "synchronize", "reopened", "ready_for_review", "commented"]),
      )
      .min(1),
    branches: z.array(z.string()).default([]),
    branchesIgnore: z.array(z.string()).default([]),
    paths: z.array(z.string()).default([]),
    pathsIgnore: z.array(z.string()).default([]),
    labels: z.array(z.string()).default([]),
    labelsIgnore: z.array(z.string()).default([]),
    ignoreDrafts: z.boolean().default(false),
    // Substring (case-insensitive) matched against `issue_comment.created`
    // comment.body when "commented" is in actions. Empty string disables
    // comment-triggering.
    commentPhrase: z.string().default("@opencara review"),
    // Grace period before the review actually starts. When > 0 the trigger
    // holds the run for this long after matching a `pull_request` event,
    // then re-reads the PR and cancels the review if it was merged/closed
    // meanwhile or picked up one of `labelsIgnore`. Lets a quick follow-up
    // push, a self-merge or a `no-review` label pre-empt a wasted review.
    // Not applied to the `commented` path (an explicit ask runs at once).
    delaySeconds: z.number().int().min(0).max(86400).default(0),
  }),
});
export type ScmPullRequestTrigger = z.infer<typeof ScmPullRequestTriggerSchema>;

// Fires on the GitHub `pull_request_review` event (a reviewer hitting
// "Submit review" or its API equivalent), or on Azure DevOps' equivalent
// reviewer-vote change. The orchestrator surfaces the review state + body
// via OPENCARA_REVIEW_* env vars, and the agent's label routing reads the
// *PR's* labels (not the closing issue's), so an operator can move the loop
// to a different agent mid-PR by labeling the PR `agent:<name>`.
export const ScmPullRequestReviewTriggerSchema = z.object({
  id: z.string(),
  kind: z.literal("scm.pull_request_review"),
  position: Position,
  config: z.object({
    // Empty = match any state. Default fires on the two states that
    // mean "the reviewer wants something changed". Approved /
    // dismissed reviews don't need a fix iteration; ignoring them by
    // default keeps the loop quiet.
    reviewStates: z
      .array(z.enum(["approved", "changes_requested", "commented", "dismissed"]))
      .default(["commented", "changes_requested"]),
    // Whitelist of reviewer logins (glob-matched: `*` is "any
    // username", `opencara*` matches `opencara[bot]` etc.). Empty
    // array = match any user. The default `opencara[bot]` lets
    // pr-review-fix run as the second half of an automated
    // review→fix loop together with `pr-review` / `pr-review-multi`
    // (which post reviews as the App's bot identity); add human
    // logins here to opt them in too.
    users: z.array(z.string()).default(["opencara[bot]"]),
    // Substring (case-insensitive) matched against an
    // `issue_comment.created` comment.body when present and non-empty.
    // Empty string = comment-trigger disabled (preserves the original
    // "only fire on pull_request_review submissions" behavior). When
    // non-empty, a matching comment fires the flow and bypasses the
    // reviewStates / users filters (those gate reviews, not comments).
    commentPhrase: z.string().default(""),
  }),
});
export type ScmPullRequestReviewTrigger = z.infer<
  typeof ScmPullRequestReviewTriggerSchema
>;

// Board item status-change trigger. Fires when a board status (GitHub Projects
// v2 single-select field, or an Azure DevOps work item's board column / state)
// of a linked issue/PR/work item changes to one of the listed option names.
export const ScmBoardItemTriggerSchema = z.object({
  id: z.string(),
  kind: z.literal("scm.board_item"),
  position: Position,
  config: z.object({
    // Filter to a specific Projects v2 board number on the org/user. null = any.
    // GitHub-only; ignored for Azure DevOps, where the board is implied by the
    // project the repo lives in.
    projectNumber: z.number().int().nullable().default(null),
    // Single-select field whose option-change should fire the trigger. On
    // Azure DevOps this names the work item field watched for a change —
    // "Status" is mapped to `System.BoardColumn`.
    fieldName: z.string().default("Status"),
    // Option names that satisfy "moved to". Empty = match any.
    toOptions: z.array(z.string()).default([]),
    // Option names the item must have moved FROM. Empty = no constraint.
    fromOptions: z.array(z.string()).default([]),
    // Restrict to certain content types. Defaults to issues only.
    contentTypes: z
      .array(z.enum(["Issue", "PullRequest", "DraftIssue"]))
      .default(["Issue"]),
  }),
});
export type ScmBoardItemTrigger = z.infer<typeof ScmBoardItemTriggerSchema>;

// Time-based trigger. Unlike the GitHub trigger kinds, this one is not woken
// by a webhook — the orchestrator's scheduler loop scans flows for these
// nodes, computes each one's next fire time from `cron` (evaluated in
// `timezone`), and dispatches a synthetic `schedule` platform event when a
// fire is due. The subgraph downstream of a matched schedule trigger runs
// exactly as it would for any other trigger, with schedule metadata surfaced
// to agents via OPENCARA_SCHEDULE_* env vars + stdin. `enabled` lets an
// operator pause one schedule without deleting the node (or the flow).
export const ScheduleCronTriggerSchema = z.object({
  id: z.string(),
  kind: z.literal("schedule.cron"),
  position: Position,
  config: z.object({
    // Human label for the schedule (shown in the management UI and passed to
    // the agent as OPENCARA_SCHEDULE_NAME).
    name: z.string().default("Scheduled task"),
    // Standard 5-field cron (minute hour day-of-month month day-of-week).
    // Validated by @opencara/shared's parseCron at edit time and at fire time.
    cron: z.string().default("0 9 * * *"),
    // IANA timezone the cron is evaluated in (e.g. "America/New_York").
    // Defaults to UTC so a bare expression behaves predictably on the server.
    timezone: z.string().default("UTC"),
    // Pause switch. A disabled schedule is skipped by the scheduler but keeps
    // its config so it can be re-enabled later.
    enabled: z.boolean().default(true),
  }),
});
export type ScheduleCronTrigger = z.infer<typeof ScheduleCronTriggerSchema>;

export const TriggerNodeSchema = z.discriminatedUnion("kind", [
  ScmPullRequestTriggerSchema,
  ScmPullRequestReviewTriggerSchema,
  ScmBoardItemTriggerSchema,
  ScheduleCronTriggerSchema,
]);
export type TriggerNode = z.infer<typeof TriggerNodeSchema>;

export const TRIGGER_KINDS = [
  "scm.pull_request",
  "scm.pull_request_review",
  "scm.board_item",
  "schedule.cron",
] as const;

/**
 * True for both the canonical `scm.*` spelling and the legacy `github.*` one,
 * so callers that see a raw (unparsed) kind off an old graph_json row still
 * classify it correctly.
 */
export function isTriggerKind(kind: string): boolean {
  return (TRIGGER_KINDS as readonly string[]).includes(normalizeNodeKind(kind));
}

// Agent flow nodes carry no in-graph subprocess `spec` — the dispatched
// AgentSpec (command/args/env/cwd) is built at dispatch time from the
// linked agent's `kind` via `buildAcpSpec` (orchestrator's
// `agents/acp-gate.ts`). Per-node knobs that DO affect dispatch live on
// `config` directly: `contextInjection` (which env keys + stdin payload
// reach the agent), `draftPr` (agent opens a draft PR that the engine
// marks ready after success), and optional `worktree` (per-PR-branch
// checkout).
export const AgentNodeSchema = z.object({
  id: z.string(),
  kind: z.literal("agent"),
  position: Position,
  config: z.object({
    label: z.string(),
    contextInjection: z.object({
      env: z.array(z.string()).default([]),
      stdinJson: z.boolean().default(true),
    }),
    draftPr: z.boolean().default(false),
    autoMerge: z
      .object({
        enabled: z.boolean().default(false),
        method: z.enum(["squash", "merge", "rebase"]).default("squash"),
        requireChecks: z.boolean().default(true),
        requireApproval: z.boolean().default(false),
        mergeWithoutChanges: z.boolean().default(false),
      })
      .optional(),
    maxIterations: z
      .object({
        enabled: z.boolean().default(false),
        limit: z.number().int().nonnegative().nullable().default(null),
        commentOnSkip: z.boolean().default(false),
      })
      .optional(),
    // When set, the engine allocates (or reuses) a stable per-PR-branch
    // worktree on a paired device before dispatching the agent. The
    // worktree persists across flow runs (so a review-fix iteration
    // reuses the implementer's checkout) and is removed when the PR
    // closes — see `pull_request.closed` handler in routes/webhooks.ts.
    // Pinned to the device that first allocated it via `worktree_pins`
    // (owner_repo, branch) → host_id; the agent's session id file
    // (`agent-session.json`) lives in a sibling sessions/ dir on the
    // same device, which is how conversation resume works without a
    // shared filesystem.
    worktree: z
      .object({
        // null = repo's default branch
        fromBranch: z.string().nullable().default(null),
        // Template; supports {{ENV_VAR}} substitution against the
        // run env. Must render to a non-empty string at dispatch.
        // Same template across implement / review-fix flows is what
        // makes the second one find the first one's checkout.
        branchName: z.string(),
        // Optional pin. null = let worktree_pins / pickIdle decide.
        hostId: z.string().nullable().default(null),
        // Opt-in shared object cache. When enabled, the device keeps a
        // single full clone at ~/.opencara/cache/<owner>/<repo>/ and
        // every per-PR-branch checkout is cloned with `--reference`
        // against it, sharing pack files. `lfs` controls whether LFS
        // blobs are fetched into the cache (and shared into checkouts
        // via a symlink) or skipped entirely (GIT_LFS_SKIP_SMUDGE=1).
        cacheRepo: z
          .object({
            enabled: z.boolean().default(false),
            lfs: z.boolean().default(false),
          })
          .optional(),
      })
      .optional(),
  }),
});
export type AgentNode = z.infer<typeof AgentNodeSchema>;

// Worktree allocation + PR creation are no longer dedicated action
// nodes. A worktree is now an option on the agent node itself
// (`agent.config.worktree`) and PR creation is the agent's
// responsibility — the agent has a platform token injected (PR #22) and
// opens the PR from inside its worktree. When `agent.config.draftPr`
// is true, the agent opens the PR as a draft and the engine marks it
// ready after the successful agent step. This keeps the engine's
// surface to "trigger → agent → optional platform side-effect actions".
export const ActionNodeSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("scm.post_review"),
    position: Position,
    config: z.object({
      // GitHub's review event enum is the canonical spelling. Azure DevOps
      // has no review-event concept: the provider maps APPROVE →
      // reviewer vote 10, REQUEST_CHANGES → -10, COMMENT → thread only.
      event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]).default("COMMENT"),
    }),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("scm.add_comment"),
    position: Position,
    config: z.object({}).optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("scm.add_label"),
    position: Position,
    config: z.object({ labels: z.array(z.string()).min(1) }),
  }),
]);
export type ActionNode = z.infer<typeof ActionNodeSchema>;

export const ACTION_KINDS = [
  "scm.post_review",
  "scm.add_comment",
  "scm.add_label",
] as const;

/** Companion to `isTriggerKind`; legacy-tolerant in the same way. */
export function isActionKind(kind: string): boolean {
  return (ACTION_KINDS as readonly string[]).includes(normalizeNodeKind(kind));
}

const RawFlowNodeSchema = z.union([TriggerNodeSchema, AgentNodeSchema, ActionNodeSchema]);

/**
 * Every graph read in the system funnels through `FlowDefinitionSchema`, which
 * means this preprocess is the single choke point where a legacy `github.*`
 * kind becomes its canonical `scm.*` form. Parsed graphs therefore only ever
 * contain canonical kinds — downstream code (engine, node runners, the web
 * canvas) never needs to match both spellings.
 */
export const FlowNodeSchema = z.preprocess((raw) => {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const kind = (raw as { kind?: unknown }).kind;
    if (typeof kind === "string") {
      const canonical = normalizeNodeKind(kind);
      if (canonical !== kind) return { ...(raw as object), kind: canonical };
    }
  }
  return raw;
}, RawFlowNodeSchema);
export type FlowNode = z.infer<typeof RawFlowNodeSchema>;

export const FlowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
});
export type FlowEdge = z.infer<typeof FlowEdgeSchema>;

export const FlowDefinitionSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string(),
  description: z.string(),
  nodes: z.array(FlowNodeSchema).min(2),
  edges: z.array(FlowEdgeSchema),
});
export type FlowDefinition = z.infer<typeof FlowDefinitionSchema>;
