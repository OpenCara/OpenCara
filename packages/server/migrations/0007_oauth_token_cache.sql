-- OAuth token verification cache
-- Stores SHA-256 hashed tokens → verified GitHub identity with TTL

CREATE TABLE IF NOT EXISTS oauth_token_cache (
  token_hash TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL,
  github_username TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_cache_expires ON oauth_token_cache(expires_at);
