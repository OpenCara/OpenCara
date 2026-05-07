import { z } from "zod";
import { AgentSpecSchema } from "@opencara/shared";

const Position = z.object({ x: z.number(), y: z.number() });

// Mirrors GitHub Actions' on.pull_request filter set. PR-review
// events are a SEPARATE trigger kind (see
// GithubPullRequestReviewTriggerSchema) — splitting them keeps the
// pull_request trigger's filters (branches/paths/labels/drafts)
// from leaking into the review-fix flow's narrower config surface.
export const GithubPullRequestTriggerSchema = z.object({
  id: z.string(),
  kind: z.literal("github.pull_request"),
  position: Position,
  config: z.object({
    actions: z
      .array(z.enum(["opened", "synchronize", "reopened", "ready_for_review"]))
      .min(1),
    branches: z.array(z.string()).default([]),
    branchesIgnore: z.array(z.string()).default([]),
    paths: z.array(z.string()).default([]),
    pathsIgnore: z.array(z.string()).default([]),
    labels: z.array(z.string()).default([]),
    labelsIgnore: z.array(z.string()).default([]),
    ignoreDrafts: z.boolean().default(false),
  }),
});
export type GithubPullRequestTrigger = z.infer<typeof GithubPullRequestTriggerSchema>;

// Fires on the GitHub `pull_request_review` event (a reviewer hitting
// "Submit review" or its API equivalent). The orchestrator surfaces the
// review state + body via OPENCARA_REVIEW_* env vars, and the agent's
// label routing reads the *PR's* labels (not the closing issue's),
// so an operator can move the loop to a different agent mid-PR by
// labeling the PR `agent:<name>`.
export const GithubPullRequestReviewTriggerSchema = z.object({
  id: z.string(),
  kind: z.literal("github.pull_request_review"),
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
  }),
});
export type GithubPullRequestReviewTrigger = z.infer<
  typeof GithubPullRequestReviewTriggerSchema
>;

// GitHub Projects v2 item status-change trigger. Fires when a project board
// status (or any single-select field) of a linked Issue/PR/DraftIssue changes
// to one of the listed option names.
export const GithubProjectsV2ItemTriggerSchema = z.object({
  id: z.string(),
  kind: z.literal("github.projects_v2_item"),
  position: Position,
  config: z.object({
    // Filter to a specific Projects v2 board number on the org/user. null = any.
    projectNumber: z.number().int().nullable().default(null),
    // Single-select field whose option-change should fire the trigger.
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
export type GithubProjectsV2ItemTrigger = z.infer<typeof GithubProjectsV2ItemTriggerSchema>;

export const TriggerNodeSchema = z.discriminatedUnion("kind", [
  GithubPullRequestTriggerSchema,
  GithubPullRequestReviewTriggerSchema,
  GithubProjectsV2ItemTriggerSchema,
]);
export type TriggerNode = z.infer<typeof TriggerNodeSchema>;

export const TRIGGER_KINDS = [
  "github.pull_request",
  "github.pull_request_review",
  "github.projects_v2_item",
] as const;
export function isTriggerKind(kind: string): boolean {
  return (TRIGGER_KINDS as readonly string[]).includes(kind);
}

export const AgentNodeSchema = z.object({
  id: z.string(),
  kind: z.literal("agent"),
  position: Position,
  config: z.object({
    label: z.string(),
    spec: AgentSpecSchema,
    contextInjection: z.object({
      env: z.array(z.string()).default([]),
      stdinJson: z.boolean().default(true),
    }),
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
      })
      .optional(),
  }),
});
export type AgentNode = z.infer<typeof AgentNodeSchema>;

// Worktree allocation + PR creation are no longer dedicated action
// nodes. A worktree is now an option on the agent node itself
// (`agent.config.worktree`) and PR creation is the agent's
// responsibility — the agent has GH_TOKEN injected (PR #22) and uses
// `gh pr create` from inside its worktree. This keeps the engine's
// surface to "trigger → agent → optional GitHub side-effect actions".
export const ActionNodeSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("github.post_review"),
    position: Position,
    config: z.object({
      event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]).default("COMMENT"),
    }),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("github.add_comment"),
    position: Position,
    config: z.object({}).optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("github.add_label"),
    position: Position,
    config: z.object({ labels: z.array(z.string()).min(1) }),
  }),
]);
export type ActionNode = z.infer<typeof ActionNodeSchema>;

export const FlowNodeSchema = z.union([TriggerNodeSchema, AgentNodeSchema, ActionNodeSchema]);
export type FlowNode = z.infer<typeof FlowNodeSchema>;

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
