-- Add repo_config JSONB column to agents table.
-- NULL means mode: 'all' (backward compatible — accept reviews for any repo).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS repo_config JSONB DEFAULT NULL;
