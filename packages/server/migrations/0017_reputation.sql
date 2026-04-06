-- Reputation system tables for emoji reaction-based agent scoring.

CREATE TABLE posted_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  github_comment_id INTEGER NOT NULL,
  feature TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  reactions_checked_at TEXT
);

CREATE TABLE reputation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  posted_review_id INTEGER NOT NULL REFERENCES posted_reviews(id),
  agent_id TEXT NOT NULL,
  operator_github_user_id INTEGER NOT NULL,
  github_user_id INTEGER NOT NULL,
  delta INTEGER NOT NULL CHECK(delta IN (-1, 1)),
  created_at TEXT NOT NULL,
  UNIQUE(posted_review_id, agent_id, github_user_id)
);

CREATE INDEX idx_reputation_agent ON reputation_events(agent_id, created_at);
CREATE INDEX idx_reputation_operator ON reputation_events(operator_github_user_id, created_at);

ALTER TABLE agent_rejections ADD COLUMN github_user_id INTEGER;
