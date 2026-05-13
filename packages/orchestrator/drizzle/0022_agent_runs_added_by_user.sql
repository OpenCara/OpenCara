-- Per-user fallback for agent_runs.project_id IS NULL rows. The
-- /api/agents/:id/test and /api/chat/messages flows produce runs with
-- no project (the agent dashboard's Test button and chat panels on
-- non-project pages); without an adder column the run-log gate falls
-- back to 404 and breaks both UIs. Backfill from the run's project
-- owner where we have one.
ALTER TABLE "agent_runs"
  ADD COLUMN "added_by_user_id" text
  REFERENCES "users"("id") ON DELETE SET NULL;

UPDATE "agent_runs" ar
SET "added_by_user_id" = (
  SELECT p."added_by_user_id"
  FROM "projects" p
  WHERE p."id" = ar."project_id"
)
WHERE ar."project_id" IS NOT NULL
  AND ar."added_by_user_id" IS NULL;

CREATE INDEX "agent_runs_added_by_user_id_idx"
  ON "agent_runs" ("added_by_user_id");
