-- Per-(user, scope) chat session can now resume a real ACP session
-- across turns. `acp_session_id` is the UUID returned by the device's
-- `session/new` (claude-acp `--session-id`); subsequent turns pass it
-- as `priorSessionId` so the shim runs `--resume <uuid>` and replays
-- the prior conversation from its on-disk JSONL.
--
-- `acp_session_host_id` pins the next turn to the same device — the
-- JSONL lives under that device's `~/.claude/projects/<cwd>/` so
-- routing to a different device would surface as a `--resume` failure.
--
-- Both are cleared when the user switches the agent pick on this row:
-- the new agent's shim doesn't share the prior shim's session UUID.

ALTER TABLE "chat_sessions" ADD COLUMN "acp_session_id" text;
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "acp_session_host_id" text;
