-- Add default_implement_flow_id to projects (nullable FK → flows.id, ON DELETE SET NULL).
-- Allows each project to designate a flow for the kanban Start button.
ALTER TABLE projects
  ADD COLUMN default_implement_flow_id TEXT
    REFERENCES flows(id) ON DELETE SET NULL;
