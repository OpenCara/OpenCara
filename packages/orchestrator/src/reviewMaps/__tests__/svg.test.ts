import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ReviewMapGraph } from "@opencara/shared";
import { layoutReviewMap, type LayoutFile } from "../layout.js";
import { renderReviewMapSvg } from "../svg.js";

function makeGraph(
  paths: { path: string; status?: LayoutFile["status"]; findings?: LayoutFile["findings"] }[],
  edges: { source: string; target: string }[] = [],
): ReviewMapGraph {
  const layoutFiles: LayoutFile[] = paths.map((p) => {
    const i = p.path.lastIndexOf("/");
    return {
      id: p.path,
      path: p.path,
      dir: i === -1 ? "" : p.path.slice(0, i),
      status: p.status ?? "modified",
      additions: 10,
      deletions: 2,
      findings: p.findings ?? [],
    };
  });
  const laid = layoutReviewMap(layoutFiles, edges);
  const findings = paths.reduce((n, p) => n + (p.findings?.length ?? 0), 0);
  return {
    version: 1,
    repo: "octo/repo",
    pr: { number: 25, headSha: "abc123" },
    verdict: "REQUEST_CHANGES",
    reviewer: "agy <test>",
    createdAt: "2026-01-01T00:00:00.000Z",
    totals: {
      files: paths.length,
      additions: paths.length * 10,
      deletions: paths.length * 2,
      findings,
      filesWithFindings: paths.filter((p) => (p.findings?.length ?? 0) > 0).length,
    },
    files: laid.files,
    edges: edges.map((e) => ({ id: `${e.source}->${e.target}`, ...e })),
    groups: laid.groups,
    size: laid.size,
  };
}

describe("renderReviewMapSvg", () => {
  it("renders a standalone svg document", () => {
    const graph = makeGraph([
      { path: "src/a.ts" },
      { path: "src/b.ts", status: "added" },
      { path: "lib/c.ts", status: "removed" },
    ]);
    const svg = renderReviewMapSvg(graph);
    assert.ok(svg.startsWith("<svg"));
    assert.ok(svg.endsWith("</svg>"));
    assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.ok(svg.includes("octo/repo #25"));
    assert.ok(svg.includes("Changes requested"));
    assert.ok(!svg.includes("<script"));
  });

  it("xml-escapes hostile text in paths and reviewer names", () => {
    const graph = makeGraph([
      { path: 'src/<script>alert(1)</script>.ts' },
      { path: "src/ok.ts" },
    ]);
    const svg = renderReviewMapSvg(graph);
    assert.ok(!svg.includes("<script>alert"));
    assert.ok(svg.includes("&lt;script&gt;"));
    assert.ok(svg.includes("agy &lt;test&gt;"));
  });

  it("caps the render and reports hidden files", () => {
    const paths = Array.from({ length: 45 }, (_, i) => ({
      path: `dir${i % 5}/f${i}.ts`,
    }));
    const graph = makeGraph(paths);
    const svg = renderReviewMapSvg(graph, { maxFiles: 40 });
    assert.ok(svg.includes("+5 more files"));
    // 40 file nodes = 40 <g> node wrappers.
    const nodeCount = svg.match(/<g>/g)?.length ?? 0;
    assert.equal(nodeCount, 40);
  });
});
