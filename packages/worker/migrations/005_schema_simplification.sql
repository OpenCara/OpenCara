-- Migration 005: Schema simplification
-- Principle: store as little data as possible for privacy

BEGIN;

-- 1. users: drop avatar, updated_at, reputation_score
ALTER TABLE users DROP COLUMN IF EXISTS avatar;
ALTER TABLE users DROP COLUMN IF EXISTS updated_at;
ALTER TABLE users DROP COLUMN IF EXISTS reputation_score;

-- 2. agents: drop reputation_score
ALTER TABLE agents DROP COLUMN IF EXISTS reputation_score;

-- 3. review_tasks: inline project fields, drop project_id and pr_url
--    First, migrate data from projects into review_tasks
ALTER TABLE review_tasks ADD COLUMN IF NOT EXISTS github_installation_id BIGINT;
ALTER TABLE review_tasks ADD COLUMN IF NOT EXISTS owner TEXT;
ALTER TABLE review_tasks ADD COLUMN IF NOT EXISTS repo TEXT;

UPDATE review_tasks rt
SET github_installation_id = p.github_installation_id,
    owner = p.owner,
    repo = p.repo
FROM projects p
WHERE rt.project_id = p.id;

-- Make new columns NOT NULL after backfill
ALTER TABLE review_tasks ALTER COLUMN github_installation_id SET NOT NULL;
ALTER TABLE review_tasks ALTER COLUMN owner SET NOT NULL;
ALTER TABLE review_tasks ALTER COLUMN repo SET NOT NULL;

-- Drop old columns
ALTER TABLE review_tasks DROP COLUMN IF EXISTS project_id;
ALTER TABLE review_tasks DROP COLUMN IF EXISTS pr_url;

-- Drop projects table (after FK removed)
DROP TABLE IF EXISTS projects;

-- Drop now-invalid index
DROP INDEX IF EXISTS idx_review_tasks_project_id;

-- 4. review_results: add type column, drop review_text, comment_url, completed_at
ALTER TABLE review_results ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'review'
  CHECK (type IN ('review', 'summary'));

-- Migrate review_summaries into review_results before dropping
INSERT INTO review_results (id, review_task_id, agent_id, status, comment_url, created_at, type)
SELECT id, review_task_id, agent_id, 'completed', comment_url, created_at, 'summary'
FROM review_summaries;

-- Now drop columns from review_results
ALTER TABLE review_results DROP COLUMN IF EXISTS review_text;
ALTER TABLE review_results DROP COLUMN IF EXISTS comment_url;
ALTER TABLE review_results DROP COLUMN IF EXISTS completed_at;

-- Drop review_summaries table
DROP TABLE IF EXISTS review_summaries;

-- 5. ratings: replace rater_github_id with rater_hash
ALTER TABLE ratings ADD COLUMN IF NOT EXISTS rater_hash TEXT;

-- Backfill: hash(review_result_id || github_id) using SHA-256
UPDATE ratings
SET rater_hash = encode(
  sha256((review_result_id::text || rater_github_id::text)::bytea),
  'hex'
);

ALTER TABLE ratings ALTER COLUMN rater_hash SET NOT NULL;

-- Drop old column and constraint, add new unique constraint
ALTER TABLE ratings DROP CONSTRAINT IF EXISTS ratings_review_result_id_rater_github_id_key;
ALTER TABLE ratings DROP COLUMN IF EXISTS rater_github_id;
ALTER TABLE ratings ADD CONSTRAINT ratings_review_result_id_rater_hash_key
  UNIQUE (review_result_id, rater_hash);

-- 6. reputation_history: drop user_id
ALTER TABLE reputation_history DROP COLUMN IF EXISTS user_id;

-- 7. Drop consumption_logs table
DROP TABLE IF EXISTS consumption_logs;
DROP INDEX IF EXISTS idx_consumption_logs_agent_id;

COMMIT;
