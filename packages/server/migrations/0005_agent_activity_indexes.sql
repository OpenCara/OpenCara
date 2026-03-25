-- Indexes for agent activity endpoint (GET /api/agents)
CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_last_seen ON agent_heartbeats(last_seen);
CREATE INDEX IF NOT EXISTS idx_claims_agent_status ON claims(agent_id, status);
