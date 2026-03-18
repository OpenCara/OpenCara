-- Migration 006: Anonymous agent support
-- Makes github_id nullable, adds is_anonymous column for synthetic users.

-- Add is_anonymous column to users
ALTER TABLE users ADD COLUMN is_anonymous BOOLEAN NOT NULL DEFAULT false;

-- Make github_id nullable (anonymous users have no GitHub account)
ALTER TABLE users ALTER COLUMN github_id DROP NOT NULL;

-- Drop existing unique constraint on github_id (column-level)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_github_id_key;

-- Add partial unique index: only one non-null github_id per user
CREATE UNIQUE INDEX idx_users_github_id_unique ON users(github_id) WHERE github_id IS NOT NULL;
