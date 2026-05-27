-- Per-project agent instructions file. Path is relative to the repo root in
-- the worktree at dispatch time. The orchestrator resolves it, stat-checks
-- existence, and forwards the absolute path to claude-acp (via
-- AcpSpec.instructionsFile) so the agent system prompt comes from ONE
-- canonical file regardless of agent kind. See issue #130 for context.
--
-- Default 'AGENTS.md' picks the closest thing to a cross-tool convention
-- (codex's discovery default). Existing teams already on CLAUDE.md flip
-- this in the project settings page; the column is non-null with a
-- default so the column reads identically for every row, old or new.
ALTER TABLE projects
  ADD COLUMN instructions_file TEXT NOT NULL DEFAULT 'AGENTS.md';
