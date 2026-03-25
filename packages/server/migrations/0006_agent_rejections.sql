-- Agent review_text rejection tracking for abuse prevention
CREATE TABLE IF NOT EXISTS agent_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_rejections_agent_time ON agent_rejections(agent_id, created_at);
