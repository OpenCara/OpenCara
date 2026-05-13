-- Per-user ACL for installations: add added_by_user_id mirroring
-- projects.added_by_user_id. The list and per-installation routes filter
-- on this column so one user cannot see another user's installs or the
-- repos under them. Webhook upserts leave the column NULL; the first
-- authenticated /auth/github/setup round-trip or POST /api/installations/:id/projects
-- claims the row (see routes/api/installations.ts).
ALTER TABLE "github_installations"
  ADD COLUMN "added_by_user_id" text
  REFERENCES "users"("id") ON DELETE SET NULL;

-- Backfill from any project that already attributed itself. Picks an
-- arbitrary owner when multiple users have added projects under the same
-- installation — pre-fix data is unavoidably ambiguous; the first
-- attributor wins.
UPDATE "github_installations" gi
SET "added_by_user_id" = (
  SELECT p."added_by_user_id"
  FROM "projects" p
  WHERE p."installation_id" = gi."id"
    AND p."added_by_user_id" IS NOT NULL
  LIMIT 1
)
WHERE gi."added_by_user_id" IS NULL;

CREATE INDEX "github_installations_added_by_user_id_idx"
  ON "github_installations" ("added_by_user_id");
