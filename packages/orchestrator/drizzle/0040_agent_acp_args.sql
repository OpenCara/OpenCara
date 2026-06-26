-- Per-agent ACP adapter args override.
--
-- The adapter command + base args are chosen by `agents.kind` via the
-- ACP_ADAPTERS map (src/agents/acp-gate.ts), and the operator-configured
-- `args` are appended (with per-kind model translation) at dispatch. That
-- left no way to fix adapter/version/model quirks a kind's hardcoded args
-- can't express -- e.g. codex-acp rejects `--model` (it wants `-c model="…"`)
-- and opencode's `acp` subcommand has no model flag at all.
--
-- `acp_args` is a nullable full override of the adapter args. NULL keeps the
-- kind-derived default (existing rows are untouched). When set, it is used
-- verbatim as the adapter args; the command still comes from `kind`.
ALTER TABLE agents
  ADD COLUMN acp_args JSONB;
