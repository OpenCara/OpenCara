-- Unique partial index: at most one active (pending/reviewing) task per PR.
-- Prevents duplicate tasks from concurrent webhook deliveries at the DB level.
-- This is a safety net — the application layer also uses atomic INSERT ... WHERE NOT EXISTS.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_pr
  ON tasks(owner, repo, pr_number)
  WHERE status IN ('pending', 'reviewing');
