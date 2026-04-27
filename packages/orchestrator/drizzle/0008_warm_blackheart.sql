ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_host_id_agent_hosts_id_fk";
--> statement-breakpoint
ALTER TABLE "device_pairings" DROP CONSTRAINT "device_pairings_agent_host_id_agent_hosts_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_host_id_agent_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."agent_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_agent_host_id_agent_hosts_id_fk" FOREIGN KEY ("agent_host_id") REFERENCES "public"."agent_hosts"("id") ON DELETE set null ON UPDATE no action;