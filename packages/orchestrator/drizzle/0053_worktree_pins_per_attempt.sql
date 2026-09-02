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
DROP INDEX IF EXISTS "worktree_pins_repo_branch_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "worktree_pins_key_uq" ON "worktree_pins" ("key");
CREATE INDEX IF NOT EXISTS "worktree_pins_repo_branch_idx" ON "worktree_pins" ("owner_repo", "branch");
