-- Per-project agent instructions file. Path is relative to the repo root in
-- the worktree at dispatch time. The orchestrator forwards the path to
-- claude-acp (via AcpSpec.instructionsFile) so the agent system prompt
-- comes from ONE canonical file regardless of agent kind. See issue #130.
--
-- Default '' (empty = injection disabled) on purpose. Defaulting to
-- 'AGENTS.md' would silently flip behaviour on the next dispatch for
-- any existing project that happens to have a committed AGENTS.md
-- AND relies on `claude auth login` keychain auth, since claude-acp
-- adds `--bare` whenever the file resolves (and `--bare` disables
-- keychain reads). Operators opt in from the project settings page
-- — typing 'AGENTS.md' (or 'CLAUDE.md', etc.) is one click.
ALTER TABLE projects
  ADD COLUMN instructions_file TEXT NOT NULL DEFAULT '';
