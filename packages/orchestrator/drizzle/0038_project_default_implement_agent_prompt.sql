-- Split the project-level implement-flow default into agent + prompt (#158).
-- Until now a project only pinned a default flow (default_implement_flow_id,
-- migration 0028). The kanban Start button picks the agent from an
-- `agent:<name>` issue label and the prompt from per-flow-node settings.
--
-- These two columns add project-wide defaults that pre-populate the Agent and
-- Prompt dropdowns on each issue card. Both are nullable FKs scoped to the
-- project owner's user-scoped agents / prompts; ON DELETE SET NULL so deleting
-- an agent or prompt simply clears the default rather than orphaning the row.
ALTER TABLE projects
  ADD COLUMN default_implement_agent_id TEXT
    REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE projects
  ADD COLUMN default_implement_prompt_id TEXT
    REFERENCES prompts(id) ON DELETE SET NULL;
