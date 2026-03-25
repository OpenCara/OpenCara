-- Composite index for webhook dedup: createTaskIfNotExists() subquery checks (owner, repo, pr_number, status)
CREATE INDEX IF NOT EXISTS idx_tasks_pr_lookup ON tasks(owner, repo, pr_number, status);
