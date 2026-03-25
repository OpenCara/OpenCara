-- Add github_user_id to claims table for verified OAuth identity tracking
ALTER TABLE claims ADD COLUMN github_user_id INTEGER;
