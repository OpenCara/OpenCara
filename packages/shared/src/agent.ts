import { z } from "zod";

export const AgentRunStatusSchema = z.enum([
  "queued",
  "assigned",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const AgentSpecSchema = z.object({
  kind: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  cwd: z.string().optional(),
});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export const AgentRunSchema = z.object({
  id: z.string(),
  spec: AgentSpecSchema,
  triggerEventId: z.string().optional(),
  status: AgentRunStatusSchema,
  hostId: z.string().nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  exitCode: z.number().int().nullable(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;
