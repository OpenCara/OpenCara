-- Follow-ups to 0016 from the PR #14 review:
--
--   1. project_v2_links.github_project_owner_type stores 'Organization' |
--      'User' so we can build the canonical board URL. The owner login
--      alone can't disambiguate (the two URL shapes are
--      /orgs/{owner}/projects/{n} vs /users/{owner}/projects/{n}).
--
--   2. project_v2_items.archived_at was a timestamp we synthesised from
--      updated_at when isArchived was true — but GitHub's GraphQL doesn't
--      expose a real archivedAt for ProjectV2Item, so the value was
--      misleading. Replace with a plain boolean is_archived.
--
-- The default on owner_type lets us avoid a backfill: existing rows on
-- this branch were all written from org-installations during dev. New
-- writes always set it explicitly.

ALTER TABLE "project_v2_links"
  ADD COLUMN "github_project_owner_type" text NOT NULL DEFAULT 'Organization';--> statement-breakpoint

ALTER TABLE "project_v2_items"
  ADD COLUMN "is_archived" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "project_v2_items"
  DROP COLUMN "archived_at";
