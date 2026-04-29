-- Hand-written (drizzle-kit's interactive diff fights with the prior
-- prompts schema reshuffle). Two related changes:
--
--  1. agents.host_id (nullable FK to agent_hosts) — pins an agent to a
--     specific device for both flow runs and one-off /api/agents/:id/test
--     invocations. ON DELETE SET NULL so revoking a device just
--     un-pins, doesn't break the agent definition.
--
--  2. Per-user unique device name, but only among LIVE devices: a
--     partial unique index lets a user re-pair a name after revoking
--     the old box. Confirm route also enforces this at write time
--     with a clearer 409.

ALTER TABLE "agents"
  ADD COLUMN "host_id" text;--> statement-breakpoint
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_host_id_agent_hosts_id_fk"
  FOREIGN KEY ("host_id") REFERENCES "public"."agent_hosts"("id") ON DELETE SET NULL ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "agent_hosts_user_name_uq"
  ON "agent_hosts" ("user_id", "name")
  WHERE "revoked_at" IS NULL;
