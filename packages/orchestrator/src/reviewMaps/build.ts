/**
 * Build a ReviewMapGraph from the platform's PR data: file listing, fetched
 * contents for dependency extraction, and the review prose for findings.
 */

import type { ReviewMapGraph } from "@opencara/shared";
import type { ScmProvider, ScmReviewEvent } from "../scm/types.js";
import {
  isParsable,
  languageForPath,
  resolveDependencies,
  type DependencyFile,
} from "./dependencies.js";
import { extractFindings } from "./findings.js";
import { layoutReviewMap, type LayoutFile } from "./layout.js";

export const MAX_MAP_FILES = 300;
export const MAX_CONTENT_FETCH = 150;
export const MAX_CONTENT_BYTES = 512 * 1024;
const CONTENT_CONCURRENCY = 8;

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Run `work` over `items` with a fixed-size worker pool. */
async function pooled<T>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++]!;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

export interface BuildReviewMapOpts {
  provider: ScmProvider;
  pr: { number: number; headSha: string };
  /** "owner/name". */
  repo: string;
  reviewMarkdown: string;
  verdict?: ScmReviewEvent;
  reviewer?: string;
  now?: Date;
}

/**
 * Returns null when the provider cannot list PR files — the feature simply
 * isn't available on that platform (Azure DevOps today). Individual content
 * fetches that fail are logged and skipped: a map without a few edges is
 * still worth posting.
 */
export async function buildReviewMap(
  opts: BuildReviewMapOpts,
): Promise<ReviewMapGraph | null> {
  const { provider, pr, repo } = opts;
  if (!provider.listPullRequestFiles) return null;

  const listing = await provider.listPullRequestFiles(pr, { maxFiles: MAX_MAP_FILES });
  if (listing.files.length === 0) return null;

  // Contents are only needed where a resolver can parse them; removed files
  // have nothing to read at the head ref.
  const fetchable = listing.files.filter(
    (f) => f.status !== "removed" && isParsable(f.path),
  );
  const contents = new Map<string, string>();
  const toFetch = fetchable.slice(0, MAX_CONTENT_FETCH);
  if (provider.readFileAtRef) {
    await pooled(toFetch, CONTENT_CONCURRENCY, async (f) => {
      try {
        const content = await provider.readFileAtRef!(f.path, pr.headSha);
        if (content !== null && content.length <= MAX_CONTENT_BYTES) {
          contents.set(f.path, content);
        }
      } catch (err) {
        console.warn(
          `[review-map] content fetch failed for ${f.path}: ${String((err as Error).message ?? err)}`,
        );
      }
    });
  }

  const changedPaths = listing.files.map((f) => f.path);
  const depFiles: DependencyFile[] = fetchable.map((f) => ({
    path: f.path,
    content: contents.get(f.path),
  }));
  const depEdges = resolveDependencies(depFiles, changedPaths);

  const findingsByPath = extractFindings(opts.reviewMarkdown, listing.files);

  const layoutFiles: LayoutFile[] = listing.files.map((f) => ({
    id: f.path,
    path: f.path,
    ...(f.previousPath ? { previousPath: f.previousPath } : {}),
    dir: dirOf(f.path),
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    ...(languageForPath(f.path) ? { language: languageForPath(f.path) } : {}),
    findings: findingsByPath.get(f.path) ?? [],
    ...(f.diffUrl ? { diffUrl: f.diffUrl } : {}),
  }));
  const laid = layoutReviewMap(layoutFiles, depEdges);

  let additions = 0;
  let deletions = 0;
  let findings = 0;
  let filesWithFindings = 0;
  for (const f of listing.files) {
    additions += f.additions;
    deletions += f.deletions;
    const fl = findingsByPath.get(f.path) ?? [];
    findings += fl.length;
    if (fl.length > 0) filesWithFindings++;
  }

  return {
    version: 1,
    repo,
    pr: { number: pr.number, headSha: pr.headSha, url: listing.prUrl },
    ...(opts.verdict ? { verdict: opts.verdict } : {}),
    ...(opts.reviewer ? { reviewer: opts.reviewer } : {}),
    createdAt: (opts.now ?? new Date()).toISOString(),
    totals: {
      files: listing.files.length,
      additions,
      deletions,
      findings,
      filesWithFindings,
    },
    ...(listing.truncated ? { truncated: { listedFiles: listing.files.length } } : {}),
    files: laid.files,
    edges: depEdges.map((e) => ({ id: `${e.source} -> ${e.target}`, ...e })),
    groups: laid.groups,
    size: laid.size,
  };
}
