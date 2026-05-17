-- Generalize per-page chat persistence: replace pm_sessions with a
-- (user_id, scope_kind, scope_id)-keyed chat_sessions table. The kanban
-- PM thread becomes one of N scopes (project | template | user); other
-- pages now persist too.

CREATE TABLE "chat_sessions" (
  "user_id" text NOT NULL,
  "scope_kind" text NOT NULL,
  "scope_id" text DEFAULT '' NOT NULL,
  "thread_key" text NOT NULL,
  "agent_id" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("user_id","scope_kind","scope_id")
);
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- Backfill from pm_sessions. The project's "added_by" user is the owner;
-- the kanban thread becomes scope_kind='project'. thread_key is preserved
-- verbatim so pm_waves.thread_key (denormalized, no FK) keeps resolving
-- to the same session row. Projects whose owner was deleted
-- (projects.added_by_user_id ON DELETE SET NULL) get dropped from the
-- backfill — those rows have no owner to attribute the thread to.
INSERT INTO "chat_sessions" ("user_id","scope_kind","scope_id","thread_key","agent_id","updated_at")
SELECT p."added_by_user_id", 'project', s."project_id", s."thread_key", s."agent_id", s."updated_at"
FROM "pm_sessions" s
JOIN "projects" p ON p."id" = s."project_id"
WHERE p."added_by_user_id" IS NOT NULL;
--> statement-breakpoint

DROP TABLE "pm_sessions";
