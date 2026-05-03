import { sql } from "drizzle-orm";
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

export const flowRunStatusEnum = pgEnum("flow_run_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const flowStepStatusEnum = pgEnum("flow_step_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
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

export const issues = pgTable(
  "issues",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    githubIssueId: bigint("github_issue_id", { mode: "number" }).notNull(),
    // GraphQL node id. Needed to cross-reference projects_v2_item.content_node_id
    // when a Projects v2 status change webhook fires — that payload identifies
    // the issue by node id, not REST id.
    githubNodeId: text("github_node_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    bodyMd: text("body_md"),
    // "open" | "closed". GitHub's REST issue states.
    state: text("state").notNull(),
    // "completed" | "not_planned" | "reopened" | null.
    stateReason: text("state_reason"),
    labels: jsonb("labels")
      .$type<{ name: string; color: string }[]>()
      .notNull()
      .default([]),
    assignees: jsonb("assignees")
      .$type<{ login: string; id: number }[]>()
      .notNull()
      .default([]),
    authorLogin: text("author_login"),
    htmlUrl: text("html_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // Soft-delete: GitHub `issues.deleted` / `issues.transferred` actions.
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => ({
    projectNumberUq: uniqueIndex("issues_project_id_number_uq").on(t.projectId, t.number),
    projectStateIdx: index("issues_project_id_state_idx").on(t.projectId, t.state),
    nodeIdIdx: index("issues_github_node_id_idx").on(t.githubNodeId),
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

export const agentHosts = pgTable(
  "agent_hosts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash"),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    platform: text("platform"),
    version: text("version"),
    systemInfo: jsonb("system_info"),
    systemInfoUpdatedAt: timestamp("system_info_updated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    tokenHashUq: uniqueIndex("agent_hosts_token_hash_uq").on(t.tokenHash),
    userIdIdx: index("agent_hosts_user_id_idx").on(t.userId),
    // Per-user unique device name, but only among LIVE devices: revoking
    // a device frees the name for re-pairing. Confirm route enforces this
    // at write time too (with a clearer 409 error).
    userNameUq: uniqueIndex("agent_hosts_user_name_uq")
      .on(t.userId, t.name)
      .where(sql`revoked_at IS NULL`),
  }),
);

export const devicePairings = pgTable(
  "device_pairings",
  {
    code: text("code").primaryKey(),
    deviceSecretHash: text("device_secret_hash").notNull(),
    status: text("status").notNull(),
    confirmedByUserId: text("confirmed_by_user_id").references(() => users.id),
    deviceName: text("device_name"),
    agentHostId: text("agent_host_id").references(() => agentHosts.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deviceTokenEnc: text("device_token_enc"),
  },
  (t) => ({
    statusExpiresIdx: index("device_pairings_status_idx").on(t.status, t.expiresAt),
  }),
);

export const flows = pgTable(
  "flows",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    graphJson: jsonb("graph_json").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    customizedAt: timestamp("customized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectSlugUq: uniqueIndex("flows_project_slug_uq").on(t.projectId, t.slug),
  }),
);

export const flowRuns = pgTable(
  "flow_runs",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    triggerEventId: text("trigger_event_id").references(() => platformEvents.id),
    status: flowRunStatusEnum("status").notNull().default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    error: text("error"),
  },
  (t) => ({
    projectCreatedAtIdx: index("flow_runs_project_created_at_idx").on(
      t.projectId,
      t.createdAt.desc(),
    ),
  }),
);

export const prompts = pgTable(
  "prompts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    body: text("body").notNull(),
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userNameUq: uniqueIndex("prompts_user_name_uq").on(t.userId, t.name),
    userIdx: index("prompts_user_id_idx").on(t.userId),
  }),
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    command: text("command").notNull(),
    args: jsonb("args").$type<string[]>().notNull().default([]),
    env: jsonb("env").$type<Record<string, string>>().notNull().default({}),
    cwd: text("cwd"),
    // Optional pin to a specific agent host. NULL = "any idle device".
    // ON DELETE SET NULL so revoking a device doesn't break the agent —
    // it just falls back to "any device" until the user picks a new one.
    hostId: text("host_id").references(() => agentHosts.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userNameUq: uniqueIndex("agents_user_name_uq").on(t.userId, t.name),
    userIdx: index("agents_user_id_idx").on(t.userId),
  }),
);

export const flowNodeSettings = pgTable(
  "flow_node_settings",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    promptId: text("prompt_id").references(() => prompts.id, { onDelete: "set null" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    label: text("label"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    flowNodeUq: uniqueIndex("flow_node_settings_flow_node_uq").on(t.flowId, t.nodeId),
  }),
);

// Per-user editable overlay over a builtin flow template's graphJson. Created
// lazily on first edit; absence means "use the code template as-is". Acts as
// the seed for a new project flow owned by this user.
export const templateDrafts = pgTable(
  "template_drafts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    templateSlug: text("template_slug").notNull(),
    graphJson: jsonb("graph_json").notNull(),
    customizedAt: timestamp("customized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userSlugUq: uniqueIndex("template_drafts_user_slug_uq").on(t.userId, t.templateSlug),
  }),
);

// Per-user, per-template-node settings (linked agent / prompt / label
// override). Parallel to flow_node_settings but keyed by (userId,
// templateSlug, nodeId). Copied into flow_node_settings when a project flow
// is seeded for this user.
export const templateNodeSettings = pgTable(
  "template_node_settings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    templateSlug: text("template_slug").notNull(),
    nodeId: text("node_id").notNull(),
    promptId: text("prompt_id").references(() => prompts.id, { onDelete: "set null" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    label: text("label"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userSlugNodeUq: uniqueIndex("template_node_settings_user_slug_node_uq").on(
      t.userId,
      t.templateSlug,
      t.nodeId,
    ),
  }),
);

export const flowRunSteps = pgTable(
  "flow_run_steps",
  {
    id: text("id").primaryKey(),
    flowRunId: text("flow_run_id")
      .notNull()
      .references(() => flowRuns.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    nodeKind: text("node_kind").notNull(),
    idx: integer("idx").notNull(),
    status: flowStepStatusEnum("status").notNull().default("pending"),
    inputJson: jsonb("input_json"),
    outputJson: jsonb("output_json"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => ({
    runIdxIdx: index("flow_run_steps_run_idx").on(t.flowRunId, t.idx),
  }),
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    spec: jsonb("spec").notNull(),
    triggerEventId: text("trigger_event_id").references(() => platformEvents.id),
    status: agentRunStatusEnum("status").notNull().default("queued"),
    hostId: text("host_id").references(() => agentHosts.id, { onDelete: "set null" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    flowRunStepId: text("flow_run_step_id").references(() => flowRunSteps.id, {
      onDelete: "set null",
    }),
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
    flowRunStepIdx: index("agent_runs_flow_run_step_id_idx").on(t.flowRunStepId),
  }),
);

export const agentRunLogs = pgTable(
  "agent_run_logs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    agentRunId: text("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    stream: text("stream").notNull(),
    chunk: text("chunk").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runSeqUq: uniqueIndex("agent_run_logs_run_seq_uq").on(t.agentRunId, t.seq),
  }),
);
