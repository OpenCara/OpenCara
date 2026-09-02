-- Add the `omp` (Oh My Pi) and `cursor` (Cursor CLI) ACP adapter kinds to the
-- `agent_kind` enum. Both CLIs speak ACP natively:
--   omp    → `npx --yes @oh-my-pi/pi-coding-agent@latest acp`
--   cursor → `cursor-agent acp`
--
-- ADD VALUE only: nothing in this deploy WRITES either literal, so the
-- "unsafe use of new value" trap documented in 0042 does not apply. Rows using
-- the new kinds are created by operators through the dashboard after this
-- migration has been applied, which is a later transaction by definition.
ALTER TYPE "agent_kind" ADD VALUE IF NOT EXISTS 'omp';--> statement-breakpoint
ALTER TYPE "agent_kind" ADD VALUE IF NOT EXISTS 'cursor';
