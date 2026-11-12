import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

// What the previous OpenCara review on a pull request covered, so the next
// review can look at what changed since and not repeat what it already said.
//
// The source is our own record, not the platform: every successful
// `scm.post_review` step stores the PR number, the head commit it reviewed,
// its verdict and the posted body in its `output_json` (nodeRunners.ts). That
// works the same for GitHub and Azure DevOps and costs no API call. Reviews
// posted before this was recorded have no `headSha` and are ignored; the
// first review after the deploy starts the chain.

/** Cap on the stored body: enough for any real review, bounded row size. */
export const PRIOR_REVIEW_BODY_MAX_CHARS = 12_000;

export interface PriorReview {
  /** Head commit the review was posted against. Hex only (validated). */
  headSha: string;
  verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" | null;
  /** The review content as posted, without the verdict line. */
  body: string;
  htmlUrl: string | null;
}

// The sha reaches the agent's instructions inside a `git diff <sha>..HEAD`
// command, so anything but a plain hex object id is refused.
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const VERDICTS = new Set(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);

export function truncateReviewBody(body: string): string {
  if (body.length <= PRIOR_REVIEW_BODY_MAX_CHARS) return body;
  return `${body.slice(0, PRIOR_REVIEW_BODY_MAX_CHARS)}\n\n… (truncated)`;
}

/** Read a `scm.post_review` step's output_json back into a PriorReview. */
export function priorReviewFromStepOutput(output: unknown): PriorReview | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (typeof o.headSha !== "string" || !SHA_RE.test(o.headSha)) return null;
  const verdict =
    typeof o.verdict === "string" && VERDICTS.has(o.verdict)
      ? (o.verdict as PriorReview["verdict"])
      : null;
  return {
    headSha: o.headSha,
    verdict,
    body: typeof o.reviewBody === "string" ? truncateReviewBody(o.reviewBody) : "",
    htmlUrl: typeof o.htmlUrl === "string" ? o.htmlUrl : null,
  };
}

/**
 * The latest review OpenCara posted on this PR, from any flow of the
 * project. Best-effort: a failed lookup means a full first-pass review,
 * never a failed run.
 */
export async function loadPriorReview(
  db: Db,
  projectId: string,
  prNumber: number,
): Promise<PriorReview | null> {
  try {
    const rows = await db.execute(sql`
      select s.output_json as output
      from flow_run_steps s
      join flow_runs fr on fr.id = s.flow_run_id
      where fr.project_id = ${projectId}
        and s.node_kind in ('scm.post_review', 'github.post_review')
        and s.status = 'succeeded'
        and s.output_json->>'prNumber' = ${String(prNumber)}
        and s.output_json->>'headSha' is not null
      order by s.finished_at desc nulls last
      limit 1
    `);
    const first = Array.isArray(rows) ? rows[0] : (rows as { rows?: unknown[] }).rows?.[0];
    return priorReviewFromStepOutput((first as { output?: unknown } | undefined)?.output);
  } catch (err) {
    console.warn("[flows] prior review lookup failed; reviewing from scratch", {
      projectId,
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
