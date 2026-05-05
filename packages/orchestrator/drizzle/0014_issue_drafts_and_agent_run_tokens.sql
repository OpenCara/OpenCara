-- Issue body drafts: an in-app overlay over `bodyMd` so agent rewrites and
-- user edits live server-side without immediately publishing to GitHub. The
-- canvas page renders draft_body_md when set; the existing PATCH /body
-- route (Save to GitHub) reads the draft, pushes to GitHub, and clears it.
-- The webhook upsert preserves draft_body_md / leaves bodyMd alone while a
-- draft is set, so an external GitHub edit doesn't clobber unpublished work.
ALTER TABLE "issues" ADD COLUMN "draft_body_md" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "draft_updated_at" timestamp with time zone;--> statement-breakpoint

-- Per-run Bearer token so an agent subprocess can call back into
-- /api/agent/* while its run is live. SHA-256 hashed (mirrors
-- agent_hosts.token_hash); plaintext is only ever in the env/stdin we hand
-- to the dispatcher. Cleared at terminal status. Index lets the auth
-- middleware look up a run by token hash in O(log n).
ALTER TABLE "agent_runs" ADD COLUMN "api_token_hash" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "api_token_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_runs_api_token_hash_idx" ON "agent_runs" USING btree ("api_token_hash");
