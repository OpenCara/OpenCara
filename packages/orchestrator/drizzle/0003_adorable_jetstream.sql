CREATE TABLE "device_pairings" (
	"code" text PRIMARY KEY NOT NULL,
	"device_secret_hash" text NOT NULL,
	"status" text NOT NULL,
	"confirmed_by_user_id" text,
	"device_name" text,
	"agent_host_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"device_token_enc" text
);
--> statement-breakpoint
ALTER TABLE "agent_hosts" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "agent_hosts" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "agent_hosts" ADD COLUMN "last_connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_hosts" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "agent_hosts" ADD COLUMN "version" text;--> statement-breakpoint
ALTER TABLE "agent_hosts" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_agent_host_id_agent_hosts_id_fk" FOREIGN KEY ("agent_host_id") REFERENCES "public"."agent_hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_pairings_status_idx" ON "device_pairings" USING btree ("status","expires_at");--> statement-breakpoint
ALTER TABLE "agent_hosts" ADD CONSTRAINT "agent_hosts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_hosts_token_hash_uq" ON "agent_hosts" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "agent_hosts_user_id_idx" ON "agent_hosts" USING btree ("user_id");