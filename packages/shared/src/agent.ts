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
 * One image attached to the current chat turn. The chat panel captures
 * these from clipboard paste / drag-and-drop, encodes the raw bytes as
 * base64 (NO `data:` URI prefix — just the payload), and tags the MIME
 * type so the ACP shim can rebuild a provider-native image block.
 *
 * Images ride the live `session/prompt` content on every turn (they are
 * NOT folded into the text-only `history` replay), so a resumed session
 * still receives them as first-class image blocks rather than alt-text.
 */
export const AcpImageInputSchema = z.object({
  /** Base64-encoded image bytes, without the `data:<mime>;base64,` prefix. */
  data: z.string(),
  /** IANA image MIME type, e.g. `image/png`, `image/jpeg`, `image/webp`. */
  mimeType: z.string(),
});
export type AcpImageInput = z.infer<typeof AcpImageInputSchema>;

/**
 * Permission modes accepted by the claude CLI (`--permission-mode`).
 * `plan` is the most useful from the chat panel — the agent drafts an
 * approach but refuses to mutate the workspace. `acceptEdits` /
 * `bypassPermissions` are progressively more permissive. `default`
 * mirrors omitting the flag entirely.
 *
 * Other ACP adapters (codex, opencode) ignore this field today. The
 * device runner logs a debug line on ignore rather than failing the
 * job so per-turn knobs in the panel never break with the wrong
 * adapter selected.
 */
export const AcpPermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);
export type AcpPermissionMode = z.infer<typeof AcpPermissionModeSchema>;

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
 *   agent doesn't support `session/load` — fallback path for shims
 *   without resume. The orchestrator sends history if non-empty.
 * - `pageContextJson` mirrors what the legacy path put on stdin — the
 *   agent uses it to ground its responses without re-fetching.
 * - `priorSessionId` (optional) tells the device to call `session/load`
 *   instead of `session/new`, passing this id to the ACP shim. The shim
 *   remaps it onto the underlying CLI's resume mechanism (e.g.
 *   claude-acp passes it as `--session-id <uuid>`). Unset → fresh
 *   session. Used by per-(repo, branch) flow loops to keep the agent's
 *   conversation across iterations.
 * - `permissionMode` (optional) is the per-turn `--permission-mode`
 *   value forwarded to claude-acp. The chat panel exposes this as a
 *   toolbar select + "Plan mode" toggle (which is just a shortcut for
 *   `permissionMode: "plan"`). Unset = the agent's baked-in default,
 *   preserving prior behaviour for flows that haven't opted in.
 * - `instructionsFile` (optional) is a repo-relative path to a
 *   project-level agent instructions file. The orchestrator validated
 *   the setting; the device-side adapter (e.g. claude-acp) resolves it
 *   against the session cwd, stat-checks the file, and either injects
 *   it as the project system prompt or skips silently if it's absent.
 *   When honoured, the adapter ALSO strips its per-kind auto-discovery
 *   (e.g. claude-acp drops `~/.claude/CLAUDE.md`) so one canonical file
 *   becomes the source of truth across agent kinds. Unset = adapter
 *   keeps native discovery (chat / test runs without a worktree, or
 *   projects opting out by clearing the setting). See #130.
 * - `images` (optional) are attachments for THIS turn — clipboard pastes
 *   or dropped files from the chat panel. The device runner appends them
 *   to the `session/prompt` content as image blocks; shims that advertise
 *   `promptCapabilities.image` (e.g. claude-acp) forward them to the
 *   underlying model, others ignore them. See #142.
 */
export const AcpSpecSchema = z.object({
  systemPromptMd: z.string(),
  userPromptMd: z.string(),
  history: z.array(AcpHistoryTurnSchema).default([]),
  pageContextJson: z.string().optional(),
  priorSessionId: z.string().optional(),
  permissionMode: AcpPermissionModeSchema.optional(),
  instructionsFile: z.string().optional(),
  images: z.array(AcpImageInputSchema).default([]),
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
