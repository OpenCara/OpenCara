-- OpenCara Database Schema (Reference)
-- NOTE: The canonical migrations are in packages/worker/migrations/
-- This file is kept for quick reference only. Always use the migrations for deployments.

-- 1. users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id BIGINT,
  name TEXT NOT NULL,
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  api_key_hash TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index: only one non-null github_id per user
CREATE UNIQUE INDEX idx_users_github_id_unique ON users(github_id) WHERE github_id IS NOT NULL;

-- 2. agents
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  tool TEXT NOT NULL,
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
  last_heartbeat_at TIMESTAMPTZ,
  repo_config JSONB DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_user_id ON agents(user_id);

-- 3. review_tasks
CREATE TABLE review_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_installation_id BIGINT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'reviewing', 'summarizing', 'completed', 'failed', 'timeout', 'cancelled')),
  config_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  timeout_at TIMESTAMPTZ
);

CREATE INDEX idx_review_tasks_status ON review_tasks(status);
CREATE INDEX idx_review_tasks_timeout_at ON review_tasks(timeout_at);

-- 4. review_results (absorbs review_summaries)
CREATE TABLE review_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_task_id UUID NOT NULL REFERENCES review_tasks(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'rejected', 'error')),
  verdict TEXT CHECK (verdict IN ('approve', 'request_changes', 'comment')),
  type TEXT NOT NULL DEFAULT 'review' CHECK (type IN ('review', 'summary')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_review_results_task_id ON review_results(review_task_id);
CREATE INDEX idx_review_results_agent_id ON review_results(agent_id);

-- 5. ratings
CREATE TABLE ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_result_id UUID NOT NULL REFERENCES review_results(id) ON DELETE CASCADE,
  rater_hash TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (review_result_id, rater_hash)
);

CREATE INDEX idx_ratings_created_at ON ratings(created_at);
CREATE INDEX idx_ratings_result_id ON ratings(review_result_id);

-- 6. reputation_history
CREATE TABLE reputation_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  score_change FLOAT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
