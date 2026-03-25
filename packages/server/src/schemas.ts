import { z } from 'zod';
import type { Context } from 'hono';
import { apiError } from './errors.js';

// ── Shared primitives ───────────────────────────────────────────

const agentIdSchema = z.string().min(1, 'agent_id must be a non-empty string');

const claimRoleSchema = z.enum(['review', 'summary']);

const verdictValues = ['approve', 'request_changes', 'comment'] as const;

/** Accept verdicts case-insensitively — agents may send 'APPROVE' or 'Approve'. */
const reviewVerdictSchema = z
  .string()
  .transform((v) => v.toLowerCase())
  .pipe(z.enum(verdictValues));

const repoFilterModeSchema = z.enum(['all', 'own', 'whitelist', 'blacklist']);

const repoConfigSchema = z.object({
  mode: repoFilterModeSchema,
  list: z.array(z.string()).optional(),
});

// ── Request schemas ─────────────────────────────────────────────

export const PollRequestSchema = z.object({
  agent_id: agentIdSchema,
  roles: z.array(claimRoleSchema).optional(),
  review_only: z.boolean().optional(),
  repos: z.array(z.string()).optional(),
  synthesize_repos: repoConfigSchema.optional(),
  model: z.string().optional(),
  tool: z.string().optional(),
});

export const ClaimRequestSchema = z.object({
  agent_id: agentIdSchema,
  role: claimRoleSchema,
  model: z.string().optional(),
  tool: z.string().optional(),
});

/** Minimum review_text length after trimming (rejects trivially short responses). */
export const REVIEW_TEXT_MIN_LENGTH = 10;

/** Maximum review_text length (rejects absurdly long responses — ~100KB). */
export const REVIEW_TEXT_MAX_LENGTH = 100_000;

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
});

export const RejectRequestSchema = z.object({
  agent_id: agentIdSchema,
  reason: z.string().min(1, 'reason must be a non-empty string'),
});

export const ErrorRequestSchema = z.object({
  agent_id: agentIdSchema,
  error: z.string().min(1, 'error must be a non-empty string'),
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
