-- Composite index for webhook dedup: findActiveTaskForPR() queries by (owner, repo, pr_number, status)
CREATE INDEX IF NOT EXISTS idx_tasks_pr_lookup ON tasks(owner, repo, pr_number, status);
