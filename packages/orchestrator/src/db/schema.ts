import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
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

export const githubAccountTypeEnum = pgEnum("github_account_type", [
  "User",
  "Organization",
]);

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
    githubLogin: text("github_login").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    githubUserIdUq: uniqueIndex("users_github_user_id_uq").on(t.githubUserId),
    githubLoginIdx: index("users_github_login_idx").on(t.githubLogin),
  }),
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    githubAccessTokenEnc: text("github_access_token_enc").notNull(),
    githubRefreshTokenEnc: text("github_refresh_token_enc"),
    githubTokenExpiresAt: timestamp("github_token_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index("sessions_user_id_idx").on(t.userId),
    expiresAtIdx: index("sessions_expires_at_idx").on(t.expiresAt),
  }),
);

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: text("id").primaryKey(),
    githubInstallationId: bigint("github_installation_id", { mode: "number" }).notNull(),
    accountType: githubAccountTypeEnum("account_type").notNull(),
    accountLogin: text("account_login").notNull(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    targetType: text("target_type").notNull(),
    repositorySelection: text("repository_selection").notNull(),
    permissions: jsonb("permissions").$type<Record<string, string>>().notNull().default({}),
    events: jsonb("events").$type<string[]>().notNull().default([]),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    githubInstallationIdUq: uniqueIndex("github_installations_github_installation_id_uq").on(
      t.githubInstallationId,
    ),
    accountLoginIdx: index("github_installations_account_login_idx").on(t.accountLogin),
  }),
);

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    installationId: text("installation_id")
      .notNull()
      .references(() => githubInstallations.id, { onDelete: "cascade" }),
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch"),
    private: boolean("private").notNull().default(false),
    addedByUserId: text("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => ({
    githubRepoIdUq: uniqueIndex("projects_github_repo_id_uq").on(t.githubRepoId),
    ownerNameUq: uniqueIndex("projects_owner_name_uq").on(t.owner, t.name),
    installationIdIdx: index("projects_installation_id_idx").on(t.installationId),
  }),
);

export const platformEvents = pgTable(
  "platform_events",
  {
    id: text("id").primaryKey(),
    platform: platformEnum("platform").notNull(),
    type: text("type").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").notNull(),
    installationId: text("installation_id").references(() => githubInstallations.id, {
      onDelete: "set null",
    }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    githubRepoId: bigint("github_repo_id", { mode: "number" }),
    deliveryId: text("delivery_id"),
  },
  (t) => ({
    projectReceivedAtIdx: index("platform_events_project_id_received_at_idx").on(
      t.projectId,
      t.receivedAt.desc(),
    ),
    installationIdIdx: index("platform_events_installation_id_idx").on(t.installationId),
  }),
);

export const agentHosts = pgTable("agent_hosts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    spec: jsonb("spec").notNull(),
    triggerEventId: text("trigger_event_id").references(() => platformEvents.id),
    status: agentRunStatusEnum("status").notNull().default("queued"),
    hostId: text("host_id").references(() => agentHosts.id),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    exitCode: integer("exit_code"),
  },
  (t) => ({
    projectCreatedAtIdx: index("agent_runs_project_id_created_at_idx").on(
      t.projectId,
      t.createdAt.desc(),
    ),
  }),
);
