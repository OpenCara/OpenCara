import { z } from "zod";
import { AgentRunSchema, AgentSpecSchema } from "./agent.js";

export const HostRegisterRequestSchema = z.object({
  hostId: z.string(),
  hostName: z.string(),
  capabilities: z.array(z.string()).default([]),
  token: z.string(),
});
export type HostRegisterRequest = z.infer<typeof HostRegisterRequestSchema>;

export const HostRegisterResponseSchema = z.object({
  ok: z.literal(true),
  pollIntervalMs: z.number().int().positive(),
});
export type HostRegisterResponse = z.infer<typeof HostRegisterResponseSchema>;

export const JobAssignmentSchema = z.object({
  run: AgentRunSchema,
  spec: AgentSpecSchema,
});
export type JobAssignment = z.infer<typeof JobAssignmentSchema>;

export const RunUpdateSchema = z.object({
  runId: z.string(),
  status: z.enum(["running", "succeeded", "failed", "cancelled"]),
  exitCode: z.number().int().nullable().optional(),
  logChunk: z.string().optional(),
});
export type RunUpdate = z.infer<typeof RunUpdateSchema>;
