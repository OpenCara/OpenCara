-- Worktrees are allocated per agent attempt, not per (repo, branch).
--
-- Each attempt of an agent node gets its own checkout keyed by its
-- flow_run_steps id, so parallel pool slots never share a working tree. The
-- pin row therefore needs the on-device slug (`key`) to dispatch `worktree
-- remove` against, and (owner_repo, branch) stops being unique: PR-close
-- cleanup removes EVERY pin for the PR's head ref.
ALTER TABLE "worktree_pins" ADD COLUMN IF NOT EXISTS "key" text;
UPDATE "worktree_pins"
  SET "key" = "owner_repo" || '/branch-' || regexp_replace("branch", '[^A-Za-z0-9._-]', '_', 'g')
  WHERE "key" IS NULL;
ALTER TABLE "worktree_pins" ALTER COLUMN "key" SET NOT NULL;
-- Two legacy branches can sanitise to the same slug (feat/x vs feat_x); the
-- old uniqueness was on the raw branch, the new one is on the slug. Keep the
-- most recent pin per slug so the unique index below cannot abort the deploy.
DELETE FROM "worktree_pins" p
  USING "worktree_pins" q
  WHERE p."key" = q."key"
    AND (p."last_run_at" < q."last_run_at" OR (p."last_run_at" = q."last_run_at" AND p."id" < q."id"));
DROP INDEX IF EXISTS "worktree_pins_repo_branch_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "worktree_pins_key_uq" ON "worktree_pins" ("key");
CREATE INDEX IF NOT EXISTS "worktree_pins_repo_branch_idx" ON "worktree_pins" ("owner_repo", "branch");
