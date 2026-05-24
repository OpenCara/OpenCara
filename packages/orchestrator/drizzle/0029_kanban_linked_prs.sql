-- Add linked_prs to kanban items so issue cards can display associated PRs.
-- Populated from GitHub's timeline cross-referenced events during snapshot
-- fetch. Defaults to [] so existing rows work before their next refresh.

ALTER TABLE "project_v2_items"
  ADD COLUMN "linked_prs" jsonb NOT NULL DEFAULT '[]'::jsonb;
