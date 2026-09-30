-- Review maps are linked from posted GitHub review bodies, so a row must
-- outlive the 7-day flow_runs retention window: flow_run_id deliberately has
-- NO foreign key, it's only a breadcrumb back to the producing run.
CREATE TABLE IF NOT EXISTS "review_maps" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "flow_run_id" text,
  "pr_number" integer NOT NULL,
  "head_sha" text NOT NULL,
  "graph" jsonb NOT NULL,
  "review_url" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_maps_project_pr_idx" ON "review_maps" ("project_id", "pr_number", "created_at" DESC);
