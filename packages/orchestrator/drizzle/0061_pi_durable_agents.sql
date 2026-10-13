-- Agents run in-process on pi-durable (host protocol 2). An agent is now a
-- pi model reference ("provider/modelId") plus thinking level, env,
-- capture_thinking, cwd and device pin; the ACP adapter kinds and their
-- argv columns are gone.
--
-- `model` is backfilled from the old adapter args (acp_args when set, else
-- args): the value after --model / -m (also --model=X, -m=X, and codex's
-- `-c model="X"`). An explicit --provider (pi) qualifies it the way pi does —
-- the id is taken within that provider, minus a repeated `provider/` prefix,
-- so `--provider openrouter --model anthropic/x` stays on openrouter. Without
-- one, ids that already contain a slash are pi references (omp, opencode)
-- and are kept; otherwise the old kind qualifies the id — claude → anthropic
-- (minus the claude-acp "[1m]" context suffix), codex → openai. Kinds no pi
-- provider covers (cursor, devin, agy, commandcode, custom) keep the kind as
-- the provider so the row still shows what it ran; the device rejects the
-- unknown provider until the agent is edited. No recoverable model id →
-- "<provider>/unset".

ALTER TABLE "agents" ADD COLUMN "model" text;
--> statement-breakpoint
CREATE FUNCTION pg_temp.opencara_flag_value(argv jsonb, names text[]) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN a.v = ANY (names) THEN argv ->> a.n::int ELSE substr(a.v, strpos(a.v, '=') + 1) END
  FROM jsonb_array_elements_text(argv) WITH ORDINALITY AS a(v, n)
  WHERE a.v = ANY (names) OR (split_part(a.v, '=', 1) = ANY (names) AND strpos(a.v, '=') > 0)
  ORDER BY a.n
  LIMIT 1
$$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.opencara_config_model(argv jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(substr(b.v, length('model=') + 1), '"''')
  FROM jsonb_array_elements_text(argv) WITH ORDINALITY AS a(v, n)
  JOIN jsonb_array_elements_text(argv) WITH ORDINALITY AS b(v, n) ON b.n = a.n + 1
  WHERE a.v = '-c' AND b.v LIKE 'model=%'
  ORDER BY a.n
  LIMIT 1
$$;
--> statement-breakpoint
UPDATE "agents" AS ag
SET "model" = CASE
    WHEN m.provider IS NOT NULL THEN m.provider || '/' || COALESCE(
        CASE WHEN lower(left(m.id, length(m.provider) + 1)) = lower(m.provider) || '/' THEN substr(m.id, length(m.provider) + 2) ELSE m.id END,
        'unset'
      )
    WHEN m.id LIKE '%/%' THEN m.id
    ELSE CASE ag."kind"::text WHEN 'claude' THEN 'anthropic' WHEN 'codex' THEN 'openai' ELSE ag."kind"::text END
      || '/' || COALESCE(
        CASE WHEN ag."kind"::text = 'claude' THEN regexp_replace(m.id, '\[[^]]*\]$', '') ELSE m.id END,
        'unset'
      )
  END
FROM "agents" AS src
CROSS JOIN LATERAL (
  SELECT
    COALESCE(pg_temp.opencara_flag_value(x.argv, ARRAY['--model', '-m']), pg_temp.opencara_config_model(x.argv)) AS id,
    pg_temp.opencara_flag_value(x.argv, ARRAY['--provider']) AS provider
  FROM (
    SELECT CASE
      WHEN jsonb_typeof(src."acp_args") = 'array' AND jsonb_array_length(src."acp_args") > 0 THEN src."acp_args"
      WHEN jsonb_typeof(src."args") = 'array' THEN src."args"
      ELSE '[]'::jsonb
    END AS argv
  ) AS x
) AS m
WHERE src."id" = ag."id";
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "model" SET NOT NULL;
--> statement-breakpoint
-- thought_level is a pi thinking level now; adapter-specific values that
-- aren't one fall back to the device's pi default.
UPDATE "agents" SET "thought_level" = NULL
WHERE "thought_level" IS NOT NULL
  AND "thought_level" NOT IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max');
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "kind";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "command";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "args";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "acp_args";
--> statement-breakpoint
DROP TYPE "agent_kind";
--> statement-breakpoint
-- Chat sessions resume durable conversations now. The stored ids are ACP
-- session ids (claude-acp / cursor on-disk sessions) that no durable
-- conversation answers to, so they're cleared along with the rename.
ALTER TABLE "chat_sessions" RENAME COLUMN "acp_session_id" TO "conversation_id";
--> statement-breakpoint
ALTER TABLE "chat_sessions" RENAME COLUMN "acp_session_host_id" TO "conversation_host_id";
--> statement-breakpoint
UPDATE "chat_sessions" SET "conversation_id" = NULL, "conversation_host_id" = NULL
WHERE "conversation_id" IS NOT NULL OR "conversation_host_id" IS NOT NULL;
--> statement-breakpoint
-- Persisted run specs: `acp` → `turn`. The chat history view reads
-- spec.turn.userPromptMd and the steering chat spec.turn.priorConversationId;
-- the old ACP session ids and claude permission modes are dropped with it.
UPDATE "agent_runs"
SET "spec" = ("spec" - 'acp') || jsonb_build_object('turn', ("spec" -> 'acp') - 'priorSessionId' - 'permissionMode')
WHERE "spec" ? 'acp';
