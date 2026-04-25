import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";

export const platformEnum = pgEnum("platform", ["github"]);

export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "queued",
  "assigned",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const platformEvents = pgTable("platform_events", {
  id: text("id").primaryKey(),
  platform: platformEnum("platform").notNull(),
  type: text("type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb("payload").notNull(),
});

export const agentHosts = pgTable("agent_hosts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentRuns = pgTable("agent_runs", {
  id: text("id").primaryKey(),
  spec: jsonb("spec").notNull(),
  triggerEventId: text("trigger_event_id").references(() => platformEvents.id),
  status: agentRunStatusEnum("status").notNull().default("queued"),
  hostId: text("host_id").references(() => agentHosts.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  exitCode: integer("exit_code"),
});
