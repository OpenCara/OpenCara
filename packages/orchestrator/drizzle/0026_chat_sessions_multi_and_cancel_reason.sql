-- Multi-session chat: a (user, scope) tuple may now hold an unbounded list of
-- threads instead of a single "active" row. The active session is the
-- most-recent-non-archived row; "New chat" archives the current one and
-- inserts a fresh row. Threads carry an optional `title` (auto-derived from
-- the first user message) and an `archived_at` timestamp (NULL = active).
--
-- Schema delta: promote a per-row ULID `id` to the PK (backfilled from
-- thread_key, which is already unique) and demote the old composite to a
-- regular index so per-scope listings stay fast. The threadKey column
-- stays as-is so chat.ts's existing resume lookup (which keys on userId +
-- threadKey to find the row whose acpSessionId should drive --resume) keeps
-- working unchanged.
--
-- Also adds agent_runs.cancel_reason — needed for the new chat-cancel path
-- so we can tell "user hit Stop" runs apart from PM-wave cancellations
-- without having to dig into the dispatched spec.

ALTER TABLE "chat_sessions" ADD COLUMN "id" text;
--> statement-breakpoint
UPDATE "chat_sessions" SET "id" = "thread_key" WHERE "id" IS NULL;
--> statement-breakpoint
ALTER TABLE "chat_sessions" ALTER COLUMN "id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP CONSTRAINT "chat_sessions_pkey";
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id");
--> statement-breakpoint
CREATE INDEX "chat_sessions_user_scope_idx"
  ON "chat_sessions" ("user_id", "scope_kind", "scope_id", "updated_at" DESC);
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "title" text;
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "archived_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "cancel_reason" text;
