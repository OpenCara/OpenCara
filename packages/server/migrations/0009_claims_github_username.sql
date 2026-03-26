-- Add github_username to claims for contributor attribution in review comments
ALTER TABLE claims ADD COLUMN github_username TEXT;
