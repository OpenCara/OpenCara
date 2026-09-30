/**
 * Glue between the post_review action and the review-map machinery. Every
 * failure mode collapses to `null` plus a warning: a map must never delay or
 * fail the review it's attached to.
 */

import type { ScmProvider, ScmReviewEvent } from "../scm/types.js";
import type { Db } from "../db/client.js";
import { buildReviewMap } from "./build.js";
import { insertReviewMap } from "./store.js";

export interface AttachReviewMapOpts {
  db: Db;
  provider: ScmProvider;
  projectId: string;
  flowRunId: string;
  pr: { number: number; headSha: string };
  /** "owner/name". */
  repo: string;
  /** The review prose (verdict line stripped) — scanned for findings. */
  reviewMarkdown: string;
  verdict: ScmReviewEvent;
  reviewer?: string;
  publicBaseUrl: string;
  timeoutMs?: number;
}

export interface AttachedReviewMap {
  id: string;
  pageUrl: string;
  imageUrl: string;
  /** Markdown block to append to the review body. */
  markdown: string;
}

export async function attachReviewMap(
  opts: AttachReviewMapOpts,
): Promise<AttachedReviewMap | null> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A lost race doesn't cancel the build — the flag stops it from inserting
  // an orphan row nobody will ever link to.
  let aborted = false;
  try {
    const run = async (): Promise<AttachedReviewMap | null> => {
      const graph = await buildReviewMap({
        provider: opts.provider,
        pr: opts.pr,
        repo: opts.repo,
        reviewMarkdown: opts.reviewMarkdown,
        verdict: opts.verdict,
        reviewer: opts.reviewer,
      });
      if (!graph || aborted) return null;
      const id = await insertReviewMap(opts.db, {
        projectId: opts.projectId,
        flowRunId: opts.flowRunId,
        prNumber: opts.pr.number,
        headSha: opts.pr.headSha,
        graph,
      });
      const base = opts.publicBaseUrl.replace(/\/+$/, "");
      const pageUrl = `${base}/review-maps/${id}`;
      const imageUrl = `${base}/api/review-maps/${id}/map.svg`;
      const t = graph.totals;
      const markdown = [
        "---",
        "",
        `[![Review map: ${t.files} files, +${t.additions} −${t.deletions}](${imageUrl})](${pageUrl})`,
        "",
        `<sub>[Open the interactive review map](${pageUrl}) · ${t.files} files · +${t.additions} −${t.deletions} · ${t.findings} findings</sub>`,
      ].join("\n");
      return { id, pageUrl, imageUrl, markdown };
    };
    const timeout = new Promise<null>((_, reject) => {
      timer = setTimeout(() => {
        aborted = true;
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    return await Promise.race([run(), timeout]);
  } catch (err) {
    console.warn(
      `[review-map] skipped: ${String((err as Error).message ?? err)}`,
    );
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
