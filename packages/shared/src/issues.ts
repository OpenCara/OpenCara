import { z } from "zod";

export const IssueLabelSchema = z.object({
  name: z.string(),
  color: z.string(),
});
export type IssueLabel = z.infer<typeof IssueLabelSchema>;

export const IssueAssigneeSchema = z.object({
  login: z.string(),
  id: z.number(),
});
export type IssueAssignee = z.infer<typeof IssueAssigneeSchema>;

// Issues tab payload — body intentionally omitted (fetch on demand if a
// detail view is added later; not worth the bytes for a list view).
export const IssueSummarySchema = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  state: z.string(),
  stateReason: z.string().nullable(),
  labels: z.array(IssueLabelSchema),
  assignees: z.array(IssueAssigneeSchema),
  authorLogin: z.string().nullable(),
  htmlUrl: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
});
export type IssueSummary = z.infer<typeof IssueSummarySchema>;
