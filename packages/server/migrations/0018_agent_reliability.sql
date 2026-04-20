-- Agent reliability events — rolling window of success/error outcomes per agent.
-- Used to weight agents in the batch-poll dispatch shuffle so agents that have
-- been failing recently are less likely to be assigned new tasks. Events age out
-- after RELIABILITY_WINDOW_MS, so a broken agent recovers naturally once its
-- failures fall off the window.

CREATE TABLE agent_reliability_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success', 'error')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_reliability_agent_time
  ON agent_reliability_events(agent_id, created_at);
