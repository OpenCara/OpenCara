-- Per-agent reasoning effort / thinking level.
--
-- Selected on the device over ACP `session/set_config_option` (category
-- `thought_level`): claude-acp maps it to `claude --effort`, codex-acp / pi /
-- omp expose their own reasoning levels. Free text because the vocabulary is
-- per adapter; the device matches against what the adapter advertises and
-- degrades to the adapter default on a miss. NULL = adapter default, so every
-- existing row keeps today's behaviour.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "thought_level" text;
