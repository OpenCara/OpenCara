-- Activity feed: partial indexes for the per-arm "newest N visible rows per
-- project" candidate scans (routes/api/activity.ts). Both predicates mirror
-- the feed's WHERE clauses exactly so the planner can use them.
CREATE INDEX IF NOT EXISTS "agent_runs_feed_idx"
  ON "agent_runs" ("project_id", "created_at" DESC NULLS LAST)
  WHERE COALESCE(spec->>'kind', '') NOT LIKE 'internal:%';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flow_runs_feed_idx"
  ON "flow_runs" ("project_id", "created_at" DESC NULLS LAST)
  WHERE cancel_reason IS NULL OR cancel_reason <> 'trigger_skip';
