import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FILE_NODE_HEIGHT,
  FILE_NODE_WIDTH,
} from "@opencara/shared";
import { layoutReviewMap, type LayoutFile } from "../layout.js";

function file(path: string): LayoutFile {
  const i = path.lastIndexOf("/");
  return {
    id: path,
    path,
    dir: i === -1 ? "" : path.slice(0, i),
    status: "modified",
    additions: 1,
    deletions: 1,
    findings: [],
  };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const FIXTURE_FILES = [
  "src/api/handler.ts",
  "src/api/router.ts",
  "src/api/middleware/auth.ts",
  "src/db/store.ts",
  "src/db/migrate.ts",
  "web/App.tsx",
  "web/main.tsx",
  "README.md",
].map(file);

const FIXTURE_EDGES = [
  { source: "src/api/handler.ts", target: "src/db/store.ts" },
  { source: "src/api/router.ts", target: "src/api/handler.ts" },
  { source: "web/App.tsx", target: "src/api/handler.ts" },
];

describe("layoutReviewMap", () => {
  it("is deterministic", () => {
    const a = layoutReviewMap(FIXTURE_FILES, FIXTURE_EDGES);
    const b = layoutReviewMap(FIXTURE_FILES, FIXTURE_EDGES);
    assert.deepEqual(a, b);
  });

  it("produces no overlapping rects", () => {
    const { files, groups } = layoutReviewMap(FIXTURE_FILES, FIXTURE_EDGES);
    // Files sit inside their group box, so compare like-with-like.
    const sets: Rect[][] = [
      files.map((f) => ({
        x: f.position.x,
        y: f.position.y,
        w: FILE_NODE_WIDTH,
        h: FILE_NODE_HEIGHT,
      })),
      groups.map((g) => ({
        x: g.position.x,
        y: g.position.y,
        w: g.size.width,
        h: g.size.height,
      })),
    ];
    for (const rects of sets) {
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          assert.equal(
            overlaps(rects[i]!, rects[j]!),
            false,
            `overlap between rects ${i} and ${j}`,
          );
        }
      }
    }
  });

  it("places every file inside its directory group", () => {
    const { files, groups } = layoutReviewMap(FIXTURE_FILES, FIXTURE_EDGES);
    const groupById = new Map(groups.map((g) => [g.id, g]));
    for (const f of files) {
      const g = groupById.get(`group:${f.dir || "(root)"}`)!;
      assert.ok(g, `no group for ${f.path}`);
      assert.ok(f.position.x >= g.position.x, `${f.path} left of group`);
      assert.ok(f.position.y >= g.position.y, `${f.path} above group`);
      assert.ok(
        f.position.x + FILE_NODE_WIDTH <= g.position.x + g.size.width,
        `${f.path} right of group`,
      );
      assert.ok(
        f.position.y + FILE_NODE_HEIGHT <= g.position.y + g.size.height,
        `${f.path} below group`,
      );
    }
  });

  it("orders dependency-connected groups left to right", () => {
    const { groups } = layoutReviewMap(FIXTURE_FILES, FIXTURE_EDGES);
    const xOf = (label: string) =>
      groups.find((g) => g.label === label)!.position.x;
    // web → src/api → src/db: each layer starts a new column.
    assert.ok(xOf("web") < xOf("src/api"));
    assert.ok(xOf("src/api") < xOf("src/db"));
  });

  it("keeps the canvas near widescreen for uniform isolated groups", () => {
    // 5 equal groups of 5 files: the naive sqrt heuristic packs one group per
    // column (≈4:1); the search should find the stacked packing instead.
    const files = Array.from({ length: 5 }, (_, d) =>
      Array.from({ length: 5 }, (_, i) => file(`dir${d}/f${i}.ts`)),
    ).flat();
    const { size } = layoutReviewMap(files, []);
    const aspect = size.width / size.height;
    assert.ok(aspect <= 2.2, `aspect ${aspect} too wide`);
    assert.ok(aspect >= 1, `aspect ${aspect} unexpectedly tall`);
  });

  it("labels the repo root and tolerates edge cycles", () => {
    const { groups } = layoutReviewMap(
      [file("a.ts"), file("dir/b.ts")],
      [
        { source: "a.ts", target: "dir/b.ts" },
        { source: "dir/b.ts", target: "a.ts" },
      ],
    );
    assert.ok(groups.some((g) => g.label === "(root)"));
    // Cyclic file edges still produce a finite, overlap-free layout.
    const a = layoutReviewMap([file("a.ts"), file("dir/b.ts")], []);
    assert.ok(a.size.width > 0);
  });
});
