/**
 * Deterministic layout for a review map: files are grouped by directory,
 * groups are layered by their dependency DAG (source groups on the left) and
 * packed into columns sized for a roughly 16:9 canvas. Same input ⇒ same
 * output, so the SVG snapshot and the interactive page render identically.
 */

import {
  FILE_GAP_Y,
  FILE_NODE_HEIGHT,
  FILE_NODE_WIDTH,
  GROUP_GAP_Y,
  GROUP_HEADER_HEIGHT,
  GROUP_PADDING,
  COLUMN_GAP_X,
  type ReviewMapFile,
  type ReviewMapGroup,
} from "@opencara/shared";

export type LayoutFile = Omit<ReviewMapFile, "position">;
export interface LayoutEdge {
  source: string;
  target: string;
}

export interface LayoutResult {
  files: ReviewMapFile[];
  groups: ReviewMapGroup[];
  size: { width: number; height: number };
}

const GROUP_WIDTH = FILE_NODE_WIDTH + 2 * GROUP_PADDING;
const GROUP_LABEL_MAX = 40;

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function baseOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Truncate a long label in the middle so both ends stay readable. */
export function middleTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1; // "…"
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

function groupHeight(fileCount: number): number {
  return (
    GROUP_PADDING * 2 +
    GROUP_HEADER_HEIGHT +
    fileCount * FILE_NODE_HEIGHT +
    Math.max(0, fileCount - 1) * FILE_GAP_Y
  );
}

/** Drop DFS back-edges so the remaining group graph is a DAG. */
function breakCycles(nodes: string[], edges: LayoutEdge[]): LayoutEdge[] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
  }
  for (const list of adj.values()) list.sort();
  const color = new Map<string, "gray" | "black">();
  const kept: LayoutEdge[] = [];
  const visit = (u: string) => {
    color.set(u, "gray");
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === "gray") continue; // back edge — drop
      kept.push({ source: u, target: v });
      if (!color.has(v)) visit(v);
    }
    color.set(u, "black");
  };
  for (const n of nodes) {
    if (!color.has(n)) visit(n);
  }
  return kept;
}

export function layoutReviewMap(
  files: LayoutFile[],
  edges: LayoutEdge[],
): LayoutResult {
  // Bucket into directory groups, sorted for determinism.
  const byDir = new Map<string, LayoutFile[]>();
  for (const f of files) {
    const d = dirOf(f.path);
    (byDir.get(d) ?? byDir.set(d, []).get(d)!).push(f);
  }
  for (const list of byDir.values()) {
    list.sort((a, b) => {
      const c = baseOf(a.path).localeCompare(baseOf(b.path));
      return c !== 0 ? c : a.path.localeCompare(b.path);
    });
  }

  const fileGroup = new Map<string, string>();
  for (const [dir, list] of byDir) {
    for (const f of list) fileGroup.set(f.path, dir);
  }

  // Collapse file edges onto their directory groups.
  const seenGroupEdge = new Set<string>();
  const groupEdges: LayoutEdge[] = [];
  for (const e of edges) {
    const s = fileGroup.get(e.source);
    const t = fileGroup.get(e.target);
    if (s === undefined || t === undefined || s === t) continue;
    const key = `${s}→${t}`;
    if (seenGroupEdge.has(key)) continue;
    seenGroupEdge.add(key);
    groupEdges.push({ source: s, target: t });
  }

  const dirs = [...byDir.keys()].sort();
  const dag = breakCycles(dirs, groupEdges);

  // Layer = longest path from a source group in the DAG.
  const preds = new Map<string, string[]>();
  for (const e of dag) {
    (preds.get(e.target) ?? preds.set(e.target, []).get(e.target)!).push(e.source);
  }
  const layerMemo = new Map<string, number>();
  const layerOf = (g: string): number => {
    const memo = layerMemo.get(g);
    if (memo !== undefined) return memo;
    let layer = 0;
    for (const p of preds.get(g) ?? []) layer = Math.max(layer, layerOf(p) + 1);
    layerMemo.set(g, layer);
    return layer;
  };
  const connected = new Set<string>();
  for (const e of dag) {
    connected.add(e.source);
    connected.add(e.target);
  }
  let maxLayer = 0;
  for (const g of connected) maxLayer = Math.max(maxLayer, layerOf(g));
  // Unconnected groups carry no ordering signal — park them after the DAG.
  const isolatedLayer = connected.size > 0 ? maxLayer + 1 : 0;
  const ordered = dirs
    .map((dir) => ({
      dir,
      layer: connected.has(dir) ? layerOf(dir) : isolatedLayer,
      height: groupHeight(byDir.get(dir)!.length),
    }))
    .sort((a, b) => a.layer - b.layer || a.dir.localeCompare(b.dir));

  const hasGroupEdges = dag.length > 0;

  // Column packing for a given column-height cap. A new DAG layer always
  // starts a fresh column (dependency layers read left-to-right); otherwise a
  // group that would overflow the cap wraps to a new column.
  const pack = (targetH: number) => {
    const groups: ReviewMapGroup[] = [];
    const posByPath = new Map<string, { x: number; y: number }>();
    let x = 0;
    let y = 0;
    let curLayer = -1;
    let maxRight = 0;
    let maxBottom = 0;
    for (const { dir, layer, height: h } of ordered) {
      const list = byDir.get(dir)!;
      const newColumn =
        curLayer === -1 ||
        (hasGroupEdges && layer !== curLayer) ||
        (y > 0 && y + h > targetH);
      if (newColumn && curLayer !== -1) {
        x += GROUP_WIDTH + COLUMN_GAP_X;
        y = 0;
      }
      curLayer = layer;
      groups.push({
        id: `group:${dir || "(root)"}`,
        label: dir ? middleTruncate(dir, GROUP_LABEL_MAX) : "(root)",
        position: { x, y },
        size: { width: GROUP_WIDTH, height: h },
      });
      let fy = y + GROUP_PADDING + GROUP_HEADER_HEIGHT;
      for (const f of list) {
        posByPath.set(f.path, { x: x + GROUP_PADDING, y: fy });
        fy += FILE_NODE_HEIGHT + FILE_GAP_Y;
      }
      y += h + GROUP_GAP_Y;
      maxRight = Math.max(maxRight, x + GROUP_WIDTH);
      maxBottom = Math.max(maxBottom, y);
    }
    return { groups, posByPath, width: maxRight, height: maxBottom };
  };

  // A fixed "aim for 16:9" target height degenerates badly when groups are
  // uniform (one short column each). Instead, try every feasible cap — the
  // tallest group and each cumulative stack height — and keep the packing
  // whose bounding box lands closest to 16:9 in log space.
  const candidates = new Set<number>();
  let cumulative = 0;
  for (const g of ordered) {
    cumulative += g.height + GROUP_GAP_Y;
    candidates.add(cumulative - GROUP_GAP_Y);
    candidates.add(g.height);
  }
  const GOAL = Math.log(16 / 9);
  let best: ReturnType<typeof pack> | null = null;
  let bestScore = Infinity;
  for (const targetH of candidates) {
    const packed = pack(targetH);
    if (!packed.height) continue;
    const score = Math.abs(Math.log(packed.width / packed.height) - GOAL);
    if (score < bestScore) {
      best = packed;
      bestScore = score;
    }
  }
  const packed = best ?? pack(Number.POSITIVE_INFINITY);

  return {
    files: files.map((f) => ({ ...f, position: packed.posByPath.get(f.path)! })),
    groups: packed.groups,
    size: { width: packed.width, height: packed.height },
  };
}
