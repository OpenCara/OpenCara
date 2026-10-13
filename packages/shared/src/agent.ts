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
 * One prior turn of a chat conversation. The device replays these into the
 * opening message only when it has to start a NEW conversation for a chat
 * that already had turns (its durable conversation lives on another device,
 * or was pruned); a resumed conversation already holds them.
 */
export const HistoryTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});
export type HistoryTurn = z.infer<typeof HistoryTurnSchema>;

/**
 * One image attached to the current chat turn. The chat panel captures
 * these from clipboard paste / drag-and-drop, encodes the raw bytes as
 * base64 (NO `data:` URI prefix — just the payload), and tags the MIME
 * type. The device hands them to the model as image content of this
 * turn's message (never folded into the text-only `history` replay).
 */
export const ImageInputSchema = z.object({
  /** Base64-encoded image bytes, without the `data:<mime>;base64,` prefix. */
  data: z.string(),
  /** IANA image MIME type, e.g. `image/png`, `image/jpeg`, `image/webp`. */
  mimeType: z.string(),
});
export type ImageInput = z.infer<typeof ImageInputSchema>;

/**
 * Reasoning levels an agent can run at — pi-ai's `ModelThinkingLevel`. The
 * device clamps the chosen level to what the selected model supports, so a
 * level a model lacks degrades instead of failing the run.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Split an agent's model reference, `<provider>/<modelId>`, at the FIRST
 * slash: `anthropic/claude-sonnet-5-5` → anthropic + claude-sonnet-5-5,
 * `openrouter/anthropic/claude-sonnet-5-5` → openrouter + anthropic/…
 * Provider ids are pi's: the built-in pi-ai providers plus whatever the
 * device's `~/.pi/agent/models.json` defines. Null when either side is
 * empty or the reference contains whitespace.
 */
export function parseModelRef(ref: string): { provider: string; modelId: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1 || /\s/.test(ref)) return null;
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

/**
 * The agent turn a job runs on the device (in-process pi-durable runner,
 * `packages/cli/src/runner/durableRunner.ts`).
 *
 * - `model` / `thoughtLevel` / `captureThinking` come from the agent row.
 *   `captureThinking: false` drops reasoning at the source (no `[think]`
 *   block reaches the log); absent = capture.
 * - `systemPromptMd` becomes the conversation's instructions for this turn
 *   (page skill, flow node prompt, injected contracts).
 * - `userPromptMd` is this turn's message; `pageContextJson` is prepended to
 *   it as a fenced JSON block, and `images` ride along as image content.
 * - `priorConversationId` resumes that durable conversation. Conversations
 *   are stored on the device that ran them, so callers pin the job there.
 *   Absent, or unknown to the device → a new conversation seeded with
 *   `history`.
 * - `instructionsFile` is a repo-relative project instructions file the
 *   orchestrator validated; the device reads it from the job's cwd and
 *   appends it to the instructions, skipping it when absent.
 */
export const TurnSpecSchema = z.object({
  model: z.string(),
  thoughtLevel: z.enum(THINKING_LEVELS).optional(),
  captureThinking: z.boolean().optional(),
  systemPromptMd: z.string(),
  userPromptMd: z.string(),
  history: z.array(HistoryTurnSchema).default([]),
  pageContextJson: z.string().optional(),
  priorConversationId: z.string().optional(),
  instructionsFile: z.string().optional(),
  images: z.array(ImageInputSchema).default([]),
});
export type TurnSpec = z.infer<typeof TurnSpecSchema>;

export const AgentSpecSchema = z.object({
  /** Run label: the agent's name for agent turns, `internal:<op>` for
   *  device plumbing jobs (worktree allocate/remove). */
  kind: z.string(),
  /** Plumbing jobs only: the program and argv (`opencara internal …`). */
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  /** Agent turns: provider credentials and run context, also exported to
   *  the agent's shell commands. Plumbing jobs: the process env overlay. */
  env: z.record(z.string()).default({}),
  cwd: z.string().optional(),
  /** Present iff this job is an agent turn. */
  turn: TurnSpecSchema.optional(),
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
