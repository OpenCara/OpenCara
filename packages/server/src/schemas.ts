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
  github_username: z.string().optional(),
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
  github_username: z.string().optional(),
  model: z.string().optional(),
  tool: z.string().optional(),
});

export const ResultRequestSchema = z.object({
  agent_id: agentIdSchema,
  type: claimRoleSchema,
  review_text: z.string().min(1, 'review_text must be a non-empty string'),
  verdict: reviewVerdictSchema.optional(),
  tokens_used: z.number().int().nonnegative().optional(),
});

export const RejectRequestSchema = z.object({
  agent_id: agentIdSchema,
  reason: z.string(),
});

export const ErrorRequestSchema = z.object({
  agent_id: agentIdSchema,
  error: z.string(),
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
