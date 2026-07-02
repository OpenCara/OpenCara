-- Expression index for chat thread lookups on agent_runs.
--
-- Every chat turn (chat.ts priorTurn probe), history load, hard-delete
-- guard, and sessions-list "running" flag (chatSessions.ts
-- selectActiveChatThreadKeys) filters on
--   spec->'env'->>'OPENCARA_CHAT_SESSION_ID' = <threadKey>
-- which without an index is a sequential scan over a table that grows
-- with every agent run, chat or not.
--
-- Partial on IS NOT NULL: flow-engine runs carry no chat env key, so
-- they stay out of the index entirely and the index stays proportional
-- to chat activity only.
CREATE INDEX IF NOT EXISTS "agent_runs_chat_session_key_idx"
  ON "agent_runs" ((spec->'env'->>'OPENCARA_CHAT_SESSION_ID'))
  WHERE (spec->'env'->>'OPENCARA_CHAT_SESSION_ID') IS NOT NULL;
