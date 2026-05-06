-- agent_kind enum + agents.kind: marks rows whose dispatch invocation
-- is built by a per-kind adapter (src/agents/kinds.ts) instead of being
-- the opaque command/args/cwd subprocess. 'custom' = legacy behaviour
-- and is the safe default for backfill — existing rows keep behaving
-- exactly as before. The four named kinds enable per-run conversation
-- resume (the agent's CLI session id is parsed from stdout and
-- persisted in a JSON file on the device next to the worktree).
CREATE TYPE "agent_kind" AS ENUM ('claude', 'codex', 'opencode', 'pi', 'custom');

ALTER TABLE "agents"
  ADD COLUMN "kind" "agent_kind" NOT NULL DEFAULT 'custom';

-- worktree_pins: sticks a (owner_repo, branch) pair to the agent host
-- that first ran a `git.create_worktree` for it, so subsequent flow
-- runs (e.g. a pr-review-fix iteration on the same PR head) can hit
-- the same device and read the agent-session.json file alongside that
-- worktree. The session id itself does NOT live in this table — only
-- the device-pinning info does. Reaper prunes rows older than 30 days.
CREATE TABLE "worktree_pins" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_repo" text NOT NULL,
  "branch" text NOT NULL,
  "host_id" text NOT NULL REFERENCES "agent_hosts"("id") ON DELETE CASCADE,
  "last_run_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "worktree_pins_repo_branch_uq"
  ON "worktree_pins" ("owner_repo", "branch");
CREATE INDEX "worktree_pins_last_run_at_idx"
  ON "worktree_pins" ("last_run_at");
