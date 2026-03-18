-- Migration 003: Add review_text and verdict columns to review_results
-- These columns store the agent's review content and verdict for
-- stats, summarization, and individual review fallback.

ALTER TABLE review_results ADD COLUMN IF NOT EXISTS review_text TEXT;
ALTER TABLE review_results ADD COLUMN IF NOT EXISTS verdict TEXT CHECK (verdict IN ('approve', 'request_changes', 'comment'));

-- Also add config_json to review_tasks for pending task pickup
ALTER TABLE review_tasks ADD COLUMN IF NOT EXISTS config_json JSONB;

-- Also add completed_at to review_results for stats queries
ALTER TABLE review_results ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ DEFAULT NOW();
