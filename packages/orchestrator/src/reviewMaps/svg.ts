/**
 * Render a review map as a standalone SVG. This is embedded as an <img> in
 * the posted review (GitHub sanitizes inline SVG out of markdown), so it must
 * be self-contained: inline attributes only, no scripts, no external refs.
 */

import {
  edgeSides,
  FILE_NODE_HEIGHT,
  FILE_NODE_WIDTH,
  type ReviewMapFile,
  type ReviewMapGraph,
  type ReviewMapSeverity,
} from "@opencara/shared";
import { layoutReviewMap, type LayoutFile } from "./layout.js";

const MARGIN = 24;
const HEADER_H = 64;
const FOOTER_H = 44;
const MIN_WIDTH = 720;
const MAX_BASENAME = 26;

const STATUS_COLOR: Record<ReviewMapFile["status"], string> = {
  added: "#1a7f37",
  modified: "#0969da",
  removed: "#cf222e",
  renamed: "#8250df",
};

const SEVERITY_COLOR: Record<ReviewMapSeverity, string> = {
  high: "#cf222e",
  medium: "#bc4c00",
  low: "#bf8700",
  info: "#57606a",
};

const SEVERITY_RANK: Record<ReviewMapSeverity, number> = {
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

const VERDICT_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  APPROVE: { bg: "#dafbe1", fg: "#1a7f37", label: "Approved" },
  REQUEST_CHANGES: { bg: "#ffebe9", fg: "#cf222e", label: "Changes requested" },
  COMMENT: { bg: "#eaeef2", fg: "#57606a", label: "Commented" },
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function baseOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function maxSeverity(f: ReviewMapFile): ReviewMapSeverity | null {
  let best: ReviewMapSeverity | null = null;
  for (const fnd of f.findings) {
    if (!best || SEVERITY_RANK[fnd.severity] > SEVERITY_RANK[best]) {
      best = fnd.severity;
    }
  }
  return best;
}

/**
 * When the map exceeds `maxFiles`, keep the most review-relevant files
 * (findings first, then severity, then churn) and re-run the layout — reusing
 * the full-graph positions would leave holes where dropped nodes sat.
 */
function subsetForRender(
  graph: ReviewMapGraph,
  maxFiles: number,
): {
  files: ReviewMapFile[];
  edges: ReviewMapGraph["edges"];
  groups: ReviewMapGraph["groups"];
  hidden: number;
} {
  if (graph.files.length <= maxFiles) {
    return { files: graph.files, edges: graph.edges, groups: graph.groups, hidden: 0 };
  }
  const ranked = [...graph.files].sort((a, b) => {
    const fa = a.findings.length > 0 ? 1 : 0;
    const fb = b.findings.length > 0 ? 1 : 0;
    if (fa !== fb) return fb - fa;
    const sa = SEVERITY_RANK[maxSeverity(a) ?? "info"];
    const sb = SEVERITY_RANK[maxSeverity(b) ?? "info"];
    if (sa !== sb) return sb - sa;
    const ca = a.additions + a.deletions;
    const cb = b.additions + b.deletions;
    if (ca !== cb) return cb - ca;
    return a.path.localeCompare(b.path);
  });
  const keep = new Set(ranked.slice(0, maxFiles).map((f) => f.path));
  const layoutFiles: LayoutFile[] = ranked
    .slice(0, maxFiles)
    .map(({ position: _position, ...rest }) => rest);
  const keptEdges = graph.edges.filter(
    (e) => keep.has(e.source) && keep.has(e.target),
  );
  const relaid = layoutReviewMap(layoutFiles, keptEdges);
  return {
    files: relaid.files,
    edges: keptEdges,
    groups: relaid.groups,
    hidden: graph.files.length - relaid.files.length,
  };
}

export function renderReviewMapSvg(
  graph: ReviewMapGraph,
  opts: { maxFiles?: number } = {},
): string {
  const maxFiles = opts.maxFiles ?? 40;
  const { files, edges, groups, hidden } = subsetForRender(graph, maxFiles);
  const posByPath = new Map(files.map((f) => [f.path, f.position]));

  const contentW = groups.reduce((m, g) => Math.max(m, g.position.x + g.size.width), 0);
  const contentH = groups.reduce((m, g) => Math.max(m, g.position.y + g.size.height), 0);
  const width = Math.max(MIN_WIDTH, contentW + MARGIN * 2);
  const height = HEADER_H + contentH + FOOTER_H + MARGIN * 2;
  const offY = HEADER_H + MARGIN;

  const maxChurn = Math.max(
    1,
    ...files.map((f) => f.additions + f.deletions),
  );

  const parts: string[] = [];
  const font = `font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"`;

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ${font}>`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<defs><marker id="arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="#8c959f"/></marker></defs>`,
  );

  // Header: title, verdict pill, stats.
  const t = graph.totals;
  const title = `Review map · ${graph.repo} #${graph.pr.number}`;
  parts.push(
    `<text x="${MARGIN}" y="${MARGIN + 4}" font-size="16" font-weight="600" fill="#1f2328">${esc(title)}</text>`,
  );
  let pillX = MARGIN;
  const pillY = MARGIN + 14;
  if (graph.verdict) {
    const v = VERDICT_STYLE[graph.verdict] ?? VERDICT_STYLE.COMMENT!;
    const pillW = v.label.length * 7 + 18;
    parts.push(
      `<rect x="${pillX}" y="${pillY}" width="${pillW}" height="20" rx="10" fill="${v.bg}"/>`,
      `<text x="${pillX + pillW / 2}" y="${pillY + 14}" font-size="11" font-weight="600" text-anchor="middle" fill="${v.fg}">${esc(v.label)}</text>`,
    );
    pillX += pillW + 12;
  }
  const stats =
    `${t.files} files · +${t.additions} −${t.deletions} · ${t.findings} findings` +
    (graph.reviewer ? ` · ${graph.reviewer}` : "");
  parts.push(
    `<text x="${pillX}" y="${pillY + 14}" font-size="12" fill="#57606a">${esc(stats)}</text>`,
  );

  // Group boxes first — edges and file nodes paint over them so same-
  // directory dependencies stay visible instead of hiding under the box.
  for (const g of groups) {
    const gx = g.position.x + MARGIN;
    const gy = g.position.y + offY;
    parts.push(
      `<rect x="${gx}" y="${gy}" width="${g.size.width}" height="${g.size.height}" rx="8" fill="#f6f8fa" stroke="#d0d7de"/>`,
      `<text x="${gx + 10}" y="${gy + 18}" font-size="11" font-weight="600" fill="#57606a">${esc(g.label)}</text>`,
    );
  }

  // Edges between groups and files.
  for (const e of edges) {
    const s = posByPath.get(e.source);
    const tt = posByPath.get(e.target);
    if (!s || !tt) continue;
    const sides = edgeSides(s, tt);
    const sy = s.y + offY + FILE_NODE_HEIGHT / 2;
    const ty = tt.y + offY + FILE_NODE_HEIGHT / 2;
    let d: string;
    if (sides.source === "right" && sides.target === "left") {
      // Forward: source right edge → target left edge, easing halfway.
      const sx = s.x + MARGIN + FILE_NODE_WIDTH;
      const tx = tt.x + MARGIN;
      const bow = Math.max(30, (tx - sx) / 2);
      d = `M${sx} ${sy} C${sx + bow} ${sy}, ${tx - bow} ${ty}, ${tx - 4} ${ty}`;
    } else if (sides.source === "right" && sides.target === "right") {
      // Same column: bow out to the right of the nodes, re-enter the
      // target's right edge with the arrowhead pointing left.
      const sx = s.x + MARGIN + FILE_NODE_WIDTH;
      const tx = tt.x + MARGIN + FILE_NODE_WIDTH;
      const bow = 36 + Math.min(40, Math.abs(ty - sy) / 6);
      d = `M${sx} ${sy} C${sx + bow} ${sy}, ${tx + bow} ${ty}, ${tx} ${ty}`;
    } else {
      // Backward: out the source's left edge, into the target's right edge.
      const sx = s.x + MARGIN;
      const tx = tt.x + MARGIN + FILE_NODE_WIDTH;
      const bow = Math.max(30, (sx - tx) / 2);
      d = `M${sx} ${sy} C${sx - bow} ${sy}, ${tx + bow} ${ty}, ${tx} ${ty}`;
    }
    parts.push(
      `<path d="${d}" fill="none" stroke="#8c959f" stroke-width="1.25" marker-end="url(#arrow)" opacity="0.8"/>`,
    );
  }

  // File nodes.
  for (const f of files) {
    const x = f.position.x + MARGIN;
    const y = f.position.y + offY;
    const dim = f.status === "removed" ? ' opacity="0.55"' : "";
    const stripe = STATUS_COLOR[f.status];
    const sev = maxSeverity(f);
    parts.push(`<g${dim}>`);
    parts.push(
      `<rect x="${x}" y="${y}" width="${FILE_NODE_WIDTH}" height="${FILE_NODE_HEIGHT}" rx="6" fill="#ffffff" stroke="#d0d7de"/>`,
      `<rect x="${x + 1}" y="${y + 1}" width="4" height="${FILE_NODE_HEIGHT - 2}" rx="2" fill="${stripe}"/>`,
      `<text x="${x + 14}" y="${y + 18}" font-size="12" font-weight="500" fill="#1f2328">${esc(truncate(baseOf(f.path), MAX_BASENAME))}</text>`,
      `<text x="${x + 14}" y="${y + 33}" font-size="10" fill="#57606a">+${f.additions} −${f.deletions}</text>`,
    );
    // Churn bar: additions in green, deletions in red, scaled to the largest
    // file on the map so bars are comparable across nodes.
    const barX = x + 66;
    const barW = FILE_NODE_WIDTH - 66 - 12;
    const churnFrac = Math.min(1, (f.additions + f.deletions) / maxChurn);
    const aFrac = f.additions + f.deletions > 0 ? f.additions / (f.additions + f.deletions) : 0;
    parts.push(
      `<rect x="${barX}" y="${y + 28}" width="${barW}" height="4" rx="2" fill="#eaeef2"/>`,
    );
    if (churnFrac > 0) {
      const w = barW * churnFrac;
      parts.push(`<rect x="${barX}" y="${y + 28}" width="${Math.max(2, w * aFrac)}" height="4" rx="2" fill="#1a7f37"/>`);
      if (aFrac < 1) {
        parts.push(`<rect x="${barX + w * aFrac}" y="${y + 28}" width="${Math.max(2, w * (1 - aFrac))}" height="4" rx="2" fill="#cf222e"/>`);
      }
    }
    if (sev) {
      const bx = x + FILE_NODE_WIDTH - 22;
      const label = String(f.findings.length);
      parts.push(
        `<rect x="${bx}" y="${y + 7}" width="20" height="16" rx="8" fill="${SEVERITY_COLOR[sev]}"/>`,
        `<text x="${bx + 10}" y="${y + 19}" font-size="10" font-weight="700" text-anchor="middle" fill="#ffffff">${esc(label)}</text>`,
      );
    }
    parts.push(`</g>`);
  }

  // Footer: status legend, severity legend, subset notice.
  const fy = height - MARGIN - 8;
  let lx = MARGIN;
  const legend = (color: string, label: string) => {
    parts.push(
      `<rect x="${lx}" y="${fy - 9}" width="10" height="10" rx="2" fill="${color}"/>`,
      `<text x="${lx + 14}" y="${fy}" font-size="10" fill="#57606a">${esc(label)}</text>`,
    );
    lx += 14 + label.length * 5.5 + 14;
  };
  legend(STATUS_COLOR.added, "added");
  legend(STATUS_COLOR.modified, "modified");
  legend(STATUS_COLOR.removed, "removed");
  legend(STATUS_COLOR.renamed, "renamed");
  lx += 8;
  legend(SEVERITY_COLOR.high, "high");
  legend(SEVERITY_COLOR.medium, "medium");
  legend(SEVERITY_COLOR.low, "low");
  if (hidden > 0) {
    parts.push(
      `<text x="${width - MARGIN}" y="${fy}" font-size="11" text-anchor="end" fill="#0969da">+${hidden} more files — open the interactive map</text>`,
    );
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}
