import { Hono } from "hono";
import type { ReviewMapGraph } from "@opencara/shared";
import type { Db } from "../db/client.js";
import { loadReviewMap } from "../reviewMaps/store.js";
import { renderReviewMapSvg } from "../reviewMaps/svg.js";

/**
 * Public, unauthenticated review-map endpoints. The map id is a 144-bit
 * random capability token embedded in the posted review body — possession is
 * the access grant (same model as GitHub gists/images). `noindex` keeps the
 * pages out of search results.
 */

// base64url ids are 24 chars; allow headroom for future token formats.
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export interface LoadedReviewMap {
  graph: ReviewMapGraph;
  reviewUrl: string | null;
}

export interface ReviewMapRouteDeps {
  /** Overridable for tests; defaults to the review_maps table lookup. */
  load?: (id: string) => Promise<LoadedReviewMap | null>;
}

export function reviewMapRoutes(deps: { db: Db } & ReviewMapRouteDeps): Hono {
  const load =
    deps.load ??
    (async (id: string) => {
      const row = await loadReviewMap(deps.db, id);
      return row ? { graph: row.graph, reviewUrl: row.reviewUrl } : null;
    });

  const app = new Hono();

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) return c.json({ error: "not found" }, 404);
    const map = await load(id);
    if (!map) return c.json({ error: "not found" }, 404);
    c.header("Cache-Control", "public, max-age=60");
    c.header("X-Robots-Tag", "noindex");
    const graph = { ...map.graph };
    if (map.reviewUrl) graph.reviewUrl = map.reviewUrl;
    return c.json(graph);
  });

  app.get("/:id/map.svg", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) return c.json({ error: "not found" }, 404);
    const map = await load(id);
    if (!map) return c.json({ error: "not found" }, 404);
    const graph = { ...map.graph };
    if (map.reviewUrl) graph.reviewUrl = map.reviewUrl;
    return c.body(renderReviewMapSvg(graph), 200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Robots-Tag": "noindex",
    });
  });

  return app;
}
