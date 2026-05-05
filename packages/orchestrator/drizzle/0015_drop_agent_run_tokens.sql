-- Drop the per-run agent callback token columns added in 0014. The
-- replacement design has the agent emit fenced ```opencara-call``` blocks
-- on stdout; the CLI proxies the call back over its already-authed
-- WebSocket connection using its device token. The agent never sees a
-- token of its own, so there's nothing to mint/clear and these columns +
-- the index on the hash become dead weight.
DROP INDEX IF EXISTS "agent_runs_api_token_hash_idx";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "api_token_hash";--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "api_token_expires_at";
