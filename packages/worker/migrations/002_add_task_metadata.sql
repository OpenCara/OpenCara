-- Migration: 002_add_task_metadata
-- Add diff_content and config_json columns to review_tasks for pending task pickup

ALTER TABLE review_tasks ADD COLUMN diff_content TEXT;
ALTER TABLE review_tasks ADD COLUMN config_json JSONB;
