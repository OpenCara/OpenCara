-- OpenCara D1 initial schema
-- Tables: tasks, claims, locks, agent_heartbeats, meta

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  pr_url TEXT NOT NULL,
  diff_url TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  review_count INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  timeout_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  queue TEXT NOT NULL DEFAULT 'review',
  github_installation_id INTEGER NOT NULL,
  private INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  review_claims INTEGER NOT NULL DEFAULT 0,
  completed_reviews INTEGER NOT NULL DEFAULT 0,
  reviews_completed_at INTEGER,
  summary_agent_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_timeout ON tasks(timeout_at);
CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(queue);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  model TEXT,
  tool TEXT,
  review_text TEXT,
  verdict TEXT,
  tokens_used INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, agent_id, role)
);

CREATE INDEX IF NOT EXISTS idx_claims_task ON claims(task_id);

CREATE TABLE IF NOT EXISTS locks (
  key TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_heartbeats (
  agent_id TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
