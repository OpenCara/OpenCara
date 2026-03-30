import { z } from 'zod';
import type { Context } from 'hono';
import { apiError } from './errors.js';

// ── Shared primitives ───────────────────────────────────────────

const agentIdSchema = z.string().min(1, 'agent_id must be a non-empty string');

const taskRoleSchema = z.enum([
  'review',
  'summary',
  'pr_dedup',
  'issue_dedup',
  'pr_triage',
  'issue_triage',
  'implement',
  'fix',
]);

/** @deprecated Use taskRoleSchema for new code. Kept for backward compat. */
const claimRoleSchema = taskRoleSchema;

const verdictValues = ['approve', 'request_changes', 'comment'] as const;

/** Accept verdicts case-insensitively — agents may send 'APPROVE' or 'Approve'. */
const reviewVerdictSchema = z
  .string()
  .transform((v) => v.toLowerCase())
  .pipe(z.enum(verdictValues));

const repoFilterModeSchema = z.enum(['public', 'private', 'whitelist', 'blacklist']);

const repoConfigSchema = z.object({
  mode: repoFilterModeSchema,
  list: z.array(z.string()).optional(),
});

// ── Request schemas ─────────────────────────────────────────────

export const PollRequestSchema = z.object({
  agent_id: agentIdSchema,
  roles: z.array(taskRoleSchema).optional(),
  review_only: z.boolean().optional(),
  repos: z.array(z.string()).optional(),
  synthesize_repos: repoConfigSchema.optional(),
  model: z.string().optional(),
  tool: z.string().optional(),
  thinking: z.string().max(256).optional(),
});

const batchPollAgentSchema = z.object({
  agent_name: z.string().min(1, 'agent_name must be a non-empty string'),
  roles: z.array(taskRoleSchema).min(1, 'roles must contain at least one role'),
  model: z.string().optional(),
  tool: z.string().optional(),
  thinking: z.string().max(256).optional(),
  repo_filters: z.array(repoConfigSchema).optional(),
});

export const BatchPollRequestSchema = z.object({
  agents: z
    .array(batchPollAgentSchema)
    .min(1, 'agents must contain at least one agent')
    .max(20, 'agents must not exceed 20 entries'),
});

export const ClaimRequestSchema = z.object({
  agent_id: agentIdSchema,
  role: claimRoleSchema,
  model: z.string().optional(),
  tool: z.string().optional(),
  thinking: z.string().max(256).optional(),
});

/** Minimum review_text length after trimming (rejects trivially short responses). */
export const REVIEW_TEXT_MIN_LENGTH = 10;

/** Maximum review_text length (rejects absurdly long responses — ~100KB). */
export const REVIEW_TEXT_MAX_LENGTH = 100_000;

// ── Report sub-schemas ─────────────────────────────────────────

const dedupMatchSchema = z.object({
  number: z.number().int(),
  similarity: z.enum(['exact', 'high', 'partial']),
  description: z.string(),
});

const dedupReportSchema = z.object({
  duplicates: z.array(dedupMatchSchema),
  index_entry: z.string(),
});

const triageReportSchema = z.object({
  category: z.enum(['bug', 'feature', 'improvement', 'question', 'docs', 'chore']),
  module: z.string().optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
  size: z.enum(['XS', 'S', 'M', 'L', 'XL']),
  labels: z.array(z.string()),
  summary: z.string().optional(),
  body: z.string().optional(),
  comment: z.string(),
});

const implementReportSchema = z.object({
  branch: z.string(),
  pr_number: z.number().int().optional(),
  pr_url: z.string().optional(),
  files_changed: z.number().int().nonnegative(),
  summary: z.string(),
});

const fixReportSchema = z.object({
  commit_sha: z.string().optional(),
  files_changed: z.number().int().nonnegative(),
  comments_addressed: z.number().int().nonnegative(),
  summary: z.string(),
});

export const ResultRequestSchema = z.object({
  agent_id: agentIdSchema,
  type: claimRoleSchema,
  review_text: z
    .string()
    .min(1, 'review_text must be a non-empty string')
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .min(
          REVIEW_TEXT_MIN_LENGTH,
          `review_text must be at least ${REVIEW_TEXT_MIN_LENGTH} characters after trimming`,
        )
        .max(
          REVIEW_TEXT_MAX_LENGTH,
          `review_text must not exceed ${REVIEW_TEXT_MAX_LENGTH} characters`,
        ),
    ),
  verdict: reviewVerdictSchema.optional(),
  tokens_used: z.number().int().nonnegative().finite().optional(),
  dedup_report: dedupReportSchema.optional(),
  triage_report: triageReportSchema.optional(),
  implement_report: implementReportSchema.optional(),
  fix_report: fixReportSchema.optional(),
});

export const RejectRequestSchema = z.object({
  agent_id: agentIdSchema,
  reason: z.string().min(1, 'reason must be a non-empty string'),
});

export const ErrorRequestSchema = z.object({
  agent_id: agentIdSchema,
  error: z.string().min(1, 'error must be a non-empty string'),
});

// ── Auth schemas ────────────────────────────────────────────────

export const DeviceFlowTokenRequestSchema = z.object({
  device_code: z.string().min(1, 'device_code must be a non-empty string'),
});

export const RefreshTokenRequestSchema = z.object({
  refresh_token: z.string().min(1, 'refresh_token must be a non-empty string'),
});

// ── Helper ──────────────────────────────────────────────────────

/**
 * Parse and validate a JSON request body against a Zod schema.
 * Returns the parsed data on success, or a 400 INVALID_REQUEST Response on failure.
 */
export async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T | Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return apiError(c, 400, 'INVALID_REQUEST', 'Malformed JSON body');
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : undefined;
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    return apiError(c, 400, 'INVALID_REQUEST', messages.join('; '));
  }

  return result.data;
}
