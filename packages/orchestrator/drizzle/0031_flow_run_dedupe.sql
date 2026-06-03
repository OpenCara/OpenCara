-- Content-level idempotency for webhook-driven flow dispatch (issue #147).
--
-- GitHub delivers webhooks at-least-once. When our endpoint is slow to ACK
-- (it timed out on every delivery before the fast-ACK fix in this change),
-- GitHub re-emits the SAME logical event as a *fresh* original — a new
-- x-github-delivery GUID with redelivery=false — not a flagged retry.
-- platform_events dedups on that GUID (PK + ON CONFLICT DO NOTHING), so two
-- GUIDs for one push become two rows → two dispatchEvent calls → two flow
-- runs → two posted reviews (observed on PR #144).
--
-- dedupe_key is derived from stable payload content (PR head SHA, review id,
-- comment id) rather than the GUID, so a re-delivered event maps to the same
-- key and the second dispatch hits the partial unique index and is dropped.
-- NULL on manual triggers / reruns and event types without a stable identity;
-- the partial predicate keeps those un-deduped (today's behavior).
ALTER TABLE "flow_runs" ADD COLUMN "dedupe_key" text;

CREATE UNIQUE INDEX "flow_runs_flow_dedupe_uq"
  ON "flow_runs" ("flow_id", "dedupe_key")
  WHERE "dedupe_key" IS NOT NULL;
