-- Phase 3 of the Kanban tab (#7): card details on the local mirror.
--
-- assignees + labels are pulled fresh from the GraphQL Issue/PullRequest
-- fragments on every backfill / single-item refresh. Defaults to [] so
-- existing rows don't break before they're refreshed; webhook-driven
-- updates fill them in. Drafts will keep [] forever (no GitHub-side
-- assignees/labels).

ALTER TABLE "project_v2_items"
  ADD COLUMN "assignees" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "project_v2_items"
  ADD COLUMN "labels" jsonb NOT NULL DEFAULT '[]'::jsonb;
