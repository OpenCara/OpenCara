import { z } from "zod";
import { AgentSpecSchema } from "@opencara/shared";

const Position = z.object({ x: z.number(), y: z.number() });

// Mirrors GitHub Actions' on.pull_request filter set.
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
  GithubProjectsV2ItemTriggerSchema,
]);
export type TriggerNode = z.infer<typeof TriggerNodeSchema>;

export const TRIGGER_KINDS = [
  "github.pull_request",
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
  }),
});
export type AgentNode = z.infer<typeof AgentNodeSchema>;

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
