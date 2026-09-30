import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { ReviewMapGraph } from "@opencara/shared";
import type { Db } from "../db/client.js";
import { reviewMaps } from "../db/schema.js";

export interface ReviewMapRow {
  id: string;
  projectId: string;
  flowRunId: string | null;
  prNumber: number;
  headSha: string;
  graph: ReviewMapGraph;
  reviewUrl: string | null;
  createdAt: Date;
}

export interface InsertReviewMapOpts {
  projectId: string;
  flowRunId: string;
  prNumber: number;
  headSha: string;
  graph: ReviewMapGraph;
}

/**
 * The id doubles as the access token for the public map endpoints — the links
 * go into GitHub review bodies, so there's no session to check — therefore it
 * is a 144-bit random capability, not a sequential/ulid id.
 */
export async function insertReviewMap(
  db: Db,
  opts: InsertReviewMapOpts,
): Promise<string> {
  const id = randomBytes(18).toString("base64url");
  await db.insert(reviewMaps).values({
    id,
    projectId: opts.projectId,
    flowRunId: opts.flowRunId,
    prNumber: opts.prNumber,
    headSha: opts.headSha,
    graph: opts.graph,
  });
  return id;
}

/** Backfill the posted-review URL once postReview returns. */
export async function setReviewMapReviewUrl(
  db: Db,
  id: string,
  url: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE review_maps
    SET review_url = ${url},
        graph = jsonb_set(graph, '{reviewUrl}', to_jsonb(${url}::text), true)
    WHERE id = ${id}
  `);
}

export async function loadReviewMap(
  db: Db,
  id: string,
): Promise<ReviewMapRow | null> {
  const row = await db.query.reviewMaps.findFirst({
    where: eq(reviewMaps.id, id),
  });
  return row ?? null;
}
