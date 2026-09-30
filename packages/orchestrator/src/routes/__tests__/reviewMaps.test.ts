import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ReviewMapGraph } from "@opencara/shared";
import { reviewMapRoutes } from "../reviewMaps.js";

const ID = "a".repeat(24);

function fixture(): ReviewMapGraph {
  return {
    version: 1,
    repo: "o/r",
    pr: { number: 1, headSha: "sha" },
    createdAt: "2026-01-01T00:00:00.000Z",
    totals: { files: 1, additions: 2, deletions: 1, findings: 0, filesWithFindings: 0 },
    files: [
      {
        id: "a.ts",
        path: "a.ts",
        dir: "",
        status: "modified",
        additions: 2,
        deletions: 1,
        findings: [],
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    groups: [
      {
        id: "group:(root)",
        label: "(root)",
        position: { x: 0, y: 0 },
        size: { width: 264, height: 96 },
      },
    ],
    size: { width: 264, height: 96 },
  };
}

function appFor(load: (id: string) => Promise<{ graph: ReviewMapGraph; reviewUrl: string | null } | null>) {
  return reviewMapRoutes({ db: {} as never, load });
}

describe("reviewMapRoutes", () => {
  it("serves the stored graph as JSON", async () => {
    const app = appFor(async (id) =>
      id === ID ? { graph: fixture(), reviewUrl: "https://gh/r" } : null,
    );
    const res = await app.request(`/${ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=60");
    assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
    const body = (await res.json()) as ReviewMapGraph;
    assert.equal(body.repo, "o/r");
    assert.equal(body.reviewUrl, "https://gh/r");
  });

  it("serves the svg with defensive headers", async () => {
    const app = appFor(async () => ({ graph: fixture(), reviewUrl: null }));
    const res = await app.request(`/${ID}/map.svg`);
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("Content-Type"),
      "image/svg+xml; charset=utf-8",
    );
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=86400");
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(
      res.headers.get("Content-Security-Policy"),
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    const text = await res.text();
    assert.ok(text.startsWith("<svg"));
  });

  it("404s unknown ids and malformed ids", async () => {
    const app = appFor(async () => null);
    assert.equal((await app.request(`/${ID}`)).status, 404);
    assert.equal((await app.request(`/${ID}/map.svg`)).status, 404);
    // Malformed ids are rejected before the loader runs.
    const bad = await app.request("/not-a-valid-id!!");
    assert.equal(bad.status, 404);
    const res2 = await app.request("/short");
    assert.equal(res2.status, 404);
  });
});
