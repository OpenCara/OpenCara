/**
 * Shared shape of a Review Map — the annotated dependency graph of a PR's
 * changed files that `scm.post_review` builds alongside the review and links
 * from the review body. Consumed by the orchestrator (builder + SVG renderer)
 * and the web app's interactive page, so it lives here rather than in either.
 */

export type ReviewMapFileStatus = "added" | "modified" | "removed" | "renamed";

export type ReviewMapSeverity = "high" | "medium" | "low" | "info";

export interface ReviewMapFinding {
  /** 1-based line in the file, when the review text pinned one. */
  line?: number;
  /** End of a referenced range (`:12-20`, `#L12-L20`). */
  endLine?: number;
  /** The review line that mentioned the file, lightly cleaned. */
  text: string;
  severity: ReviewMapSeverity;
}

export interface ReviewMapFile {
  /** Same as `path` — kept because graph tooling keys nodes by id. */
  id: string;
  path: string;
  /** For renamed files: the path before the rename. */
  previousPath?: string;
  /** Parent directory, "" for repo-root files. */
  dir: string;
  status: ReviewMapFileStatus;
  additions: number;
  deletions: number;
  /** Resolver id that parsed this file for dependencies, e.g. "ts". */
  language?: string;
  findings: ReviewMapFinding[];
  /** Deep link into the PR's file view. */
  diffUrl?: string;
  /** Absolute top-left canvas position assigned by the layout pass. */
  position: { x: number; y: number };
}

/** source depends on / imports target. */
export interface ReviewMapEdge {
  id: string;
  source: string;
  target: string;
}

export interface ReviewMapGroup {
  id: string;
  label: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
}

export interface ReviewMapGraph {
  version: 1;
  /** "owner/name". */
  repo: string;
  pr: { number: number; headSha: string; url?: string };
  verdict?: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  reviewer?: string;
  /** URL of the posted review; backfilled after posting. */
  reviewUrl?: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  totals: {
    files: number;
    additions: number;
    deletions: number;
    findings: number;
    filesWithFindings: number;
  };
  /** Set when the platform's file listing hit the fetch cap. */
  truncated?: { listedFiles: number };
  files: ReviewMapFile[];
  edges: ReviewMapEdge[];
  groups: ReviewMapGroup[];
  size: { width: number; height: number };
}

// Node geometry, shared so the SVG renderer, the layout pass, and the web
// canvas agree on how big a file node is.
export const FILE_NODE_WIDTH = 240;
export const FILE_NODE_HEIGHT = 44;
export const GROUP_PADDING = 12;
export const GROUP_HEADER_HEIGHT = 28;
export const FILE_GAP_Y = 24;
export const GROUP_GAP_Y = 24;
export const COLUMN_GAP_X = 80;

export type EdgeSide = "left" | "right";

/**
 * Which side of each node an edge should attach to, by the horizontal
 * relationship of the columns the nodes sit in: target to the right of
 * source → out the right side, into the left; same column → a loop out and
 * back into the right side; target to the left (backward edge) → out the
 * left, into the right. Shared by the SVG renderer and the web canvas so
 * both draw identical routing.
 */
export function edgeSides(
  source: { x: number },
  target: { x: number },
): { source: EdgeSide; target: EdgeSide } {
  const dx = target.x - source.x;
  if (dx > FILE_NODE_WIDTH / 2) return { source: "right", target: "left" };
  if (dx < -FILE_NODE_WIDTH / 2) return { source: "left", target: "right" };
  return { source: "right", target: "right" };
}
