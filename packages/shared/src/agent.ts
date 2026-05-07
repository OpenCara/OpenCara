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

/**
 * One prior turn in a chat conversation. Replayed into the ACP prompt
 * when the agent doesn't support session resumption (or we haven't wired
 * persistence yet — see #29).
 */
export const AcpHistoryTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});
export type AcpHistoryTurn = z.infer<typeof AcpHistoryTurnSchema>;

/**
 * Optional ACP-mode portion of an AgentSpec. When present, the device
 * routes the job through the ACP+MCP path (`packages/cli/src/runner/
 * acpRunner.ts`) instead of the legacy stdin-JSON path. The orchestrator
 * builds this when the chat route's feature flag is on and the agent
 * kind is in the cutover allowlist (codex in #29; rest in #30).
 *
 * Why these fields and not a single `prompt`:
 * - `systemPromptMd` becomes the agent's system prompt — the page skill
 *   markdown that today is buried in the stdin envelope.
 * - `userPromptMd` becomes the `session/prompt` content — just the
 *   user's message for this turn.
 * - `history` (optional) lets the device replay prior turns when the
 *   agent doesn't support `session/load`. Resume is a follow-up; for
 *   now the orchestrator always sends history if non-empty.
 * - `pageContextJson` mirrors what the legacy path put on stdin — the
 *   agent uses it to ground its responses without re-fetching.
 */
export const AcpSpecSchema = z.object({
  systemPromptMd: z.string(),
  userPromptMd: z.string(),
  history: z.array(AcpHistoryTurnSchema).default([]),
  pageContextJson: z.string().optional(),
});
export type AcpSpec = z.infer<typeof AcpSpecSchema>;

export const AgentSpecSchema = z.object({
  kind: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  cwd: z.string().optional(),
  /**
   * Present iff this run goes through the ACP+MCP path. Mutually exclusive
   * with the legacy stdin-JSON envelope — when set, `JobAssignment.stdinJson`
   * is ignored by the device runner.
   */
  acp: AcpSpecSchema.optional(),
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
