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

// Supported agent kinds. `custom` is the escape hatch for arbitrary
// Each kind maps to an ACP adapter in `src/agents/acp-gate.ts`. The
// `custom` value is retained in the Postgres enum for backward
// compatibility with rows from before the #30 cutover, but the
// TypeScript layer's `AgentKind` no longer includes it; any row with
// kind=custom will fail the `isAgentKind` validation at dispatch time
// with a clear conversion message. Operators should re-save those
// agents with a registered kind via the dashboard.
export const agentKindEnum = pgEnum("agent_kind", [
  "claude",
  "codex",
  "opencode",
  "pi",
  "custom",
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
    // Who first attributed this installation via /auth/github/setup or by
    // adding the first project under it. Used as the ACL key for listing
    // and per-installation routes — webhook upserts leave this NULL until
    // the next attribution event claims the row.
    addedByUserId: text("added_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    githubInstallationIdUq: uniqueIndex("github_installations_github_installation_id_uq").on(
      t.githubInstallationId,
    ),
    accountLoginIdx: index("github_installations_account_login_idx").on(t.accountLogin),
    addedByUserIdIdx: index("github_installations_added_by_user_id_idx").on(t.addedByUserId),
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
    // FK → flows.id (ON DELETE SET NULL) defined in migration 0028. Drizzle
    // .references() is omitted to avoid a circular type reference between
    // projects ↔ flows; the DB constraint handles referential integrity.
    defaultImplementFlowId: text("default_implement_flow_id"),
    // Project-wide defaults for the implement flow's agent + prompt (#158).
    // FKs → agents.id / prompts.id (ON DELETE SET NULL) are declared in
    // migration 0038; drizzle .references() is omitted to keep these columns
    // free of a forward type-reference to the user-scoped agents/prompts
    // tables (defined later in this file) — the DB constraint owns referential
    // integrity. These pre-populate the Agent/Prompt dropdowns on each kanban
    // issue card; a per-card `agent:<name>` / `prompt:<name>` label overrides
    // them at dispatch without mutating the project default.
    defaultImplementAgentId: text("default_implement_agent_id"),
    defaultImplementPromptId: text("default_implement_prompt_id"),
    // Repo-relative path of the canonical agent instructions file. The
    // orchestrator forwards it to the ACP adapter, which resolves +
    // stat-checks against the worktree and injects the content as the
    // system prompt regardless of agent kind (see #130).
    // Default '' = injection disabled. Defaulting to 'AGENTS.md' would
    // silently flip behaviour for existing projects that happen to have
    // a committed AGENTS.md AND rely on `claude auth login` keychain
    // auth (the adapter adds `--bare` whenever the file resolves, and
    // `--bare` disables keychain reads). Opt-in from project settings.
    instructionsFile: text("instructions_file").notNull().default(""),
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
    // In-progress local edit overlay. When non-null this is what the canvas
    // page renders; bodyMd stays as the last-known-good GitHub-mirrored
    // content. Cleared on successful PATCH /issues/:n/body (Save to GitHub).
    // upsertIssueFromWebhook preserves bodyMd untouched while a draft is
    // set, so an external GitHub edit doesn't clobber unpublished work.
    draftBodyMd: text("draft_body_md"),
    draftUpdatedAt: timestamp("draft_updated_at", { withTimezone: true }),
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
    // Why a 'cancelled' run ended up cancelled. 'trigger_skip' = trigger
    // node rejected the event (default-hidden noise from webhook fan-out);
    // 'abandoned' = reaper restored at boot. Null on non-cancelled runs
    // and pre-column rows.
    cancelReason: text("cancel_reason"),
    // Content-level idempotency key for webhook-driven dispatch. GitHub's
    // at-least-once delivery re-emits a slow-to-ACK delivery as a *fresh*
    // original (new x-github-delivery GUID, redelivery=false), which slips
    // past platform_events' GUID-only dedup and historically produced
    // duplicate flow runs + duplicate posted reviews (issue #147). The key
    // is derived from stable payload content (PR head SHA, review id, …),
    // not the GUID, so a re-delivered event collapses onto the first run via
    // the partial unique index below. NULL for manual triggers / reruns and
    // event types with no stable identity — those keep GUID-only behavior.
    dedupeKey: text("dedupe_key"),
  },
  (t) => ({
    projectCreatedAtIdx: index("flow_runs_project_created_at_idx").on(
      t.projectId,
      t.createdAt.desc(),
    ),
    // Serves the kanban implement-status query (loadImplementStatuses):
    // WHERE flow_id = ? AND status IN (...) AND created_at > ?. Without this
    // it falls back to the flow_id FK scan and reads every run for the flow —
    // and the implement flow accumulates thousands of cancelled trigger_skip
    // rows (OpenCara#146), making each kanban snapshot needlessly expensive.
    flowStatusCreatedAtIdx: index("flow_runs_flow_status_created_at_idx").on(
      t.flowId,
      t.status,
      t.createdAt.desc(),
    ),
    // Per-flow content idempotency. Partial (dedupe_key IS NOT NULL) so the
    // many runs that don't set a key — manual triggers, reruns, event types
    // without a stable identity — never collide with each other.
    flowDedupeUq: uniqueIndex("flow_runs_flow_dedupe_uq")
      .on(t.flowId, t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL`),
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
    // `kind != 'custom'` selects a per-kind adapter (src/agents/kinds.ts)
    // that builds the spec at dispatch time; for those rows, `command`/
    // `args`/`cwd` columns are ignored (operators may still set `args`
    // for kind-specific extras like `--model X --provider Y` that the
    // adapter passes through). `kind = 'custom'` keeps the legacy
    // opaque-subprocess behaviour and disables conversation resume.
    kind: agentKindEnum("kind").notNull().default("claude"),
    command: text("command").notNull(),
    args: jsonb("args").$type<string[]>().notNull().default([]),
    // Full ACP adapter args OVERRIDE. NULL = derive from kind: the adapter's
    // base args (`ACP_ADAPTERS`) plus the per-kind model translation of `args`
    // (see buildAcpSpec). When set, these are used verbatim as the adapter args
    // (the command still comes from `kind`), so operators can fix
    // adapter/version/model quirks themselves without a code change.
    acpArgs: jsonb("acp_args").$type<string[] | null>(),
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

// Sticks a (owner_repo, branch) to the agent host that first ran a
// worktree on it. The session-id file lives on that device under
// ~/.opencara/sessions/<...>/agent-session.json — without pinning the
// device we can't find the file on the next iteration, so the agent
// would always start a fresh conversation. Pin is upserted by the
// engine after every successful `git.create_worktree` dispatch and
// pruned by the reaper after 30 days of inactivity (PRs typically
// close before then).
export const worktreePins = pgTable(
  "worktree_pins",
  {
    id: text("id").primaryKey(),
    ownerRepo: text("owner_repo").notNull(),
    branch: text("branch").notNull(),
    hostId: text("host_id")
      .notNull()
      .references(() => agentHosts.id, { onDelete: "cascade" }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    repoBranchUq: uniqueIndex("worktree_pins_repo_branch_uq").on(t.ownerRepo, t.branch),
    lastRunAtIdx: index("worktree_pins_last_run_at_idx").on(t.lastRunAt),
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

// Firing bookkeeping for `schedule.cron` trigger nodes. One row per
// (flowId, nodeId). The scheduler scans flows for cron triggers, ensures a
// row exists (initialising nextFireAt to the next occurrence after "now" so a
// freshly-created schedule never backfills history), then on each tick fires
// every row whose nextFireAt has passed and advances it to the following
// occurrence. `cron`/`timezone` mirror the node config they were computed
// against so an edited expression triggers a recompute. Keeping this state in
// its own table (rather than re-deriving from flow_runs each tick) makes the
// hot path a single indexed `WHERE next_fire_at <= now` query, and the cron
// occurrence math runs only at init / after a fire.
export const flowScheduleState = pgTable(
  "flow_schedule_state",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id")
      .notNull()
      .references(() => flows.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    // Next time this schedule is due. NULL means "no upcoming occurrence
    // within a year" (e.g. an impossible date) — such rows are never due.
    nextFireAt: timestamp("next_fire_at", { withTimezone: true }),
    // The occurrence time we last dispatched a run for (NULL until first fire).
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    flowNodeUq: uniqueIndex("flow_schedule_state_flow_node_uq").on(t.flowId, t.nodeId),
    // Serves the scheduler tick: WHERE next_fire_at <= now ORDER BY next_fire_at.
    nextFireIdx: index("flow_schedule_state_next_fire_idx").on(t.nextFireAt),
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
    // Direct attribution for runs that aren't pinned to a project (agent
    // Test button, chat panels on non-project pages). The /api/runs/:id
    // gate authorises on this when projectId is null. Set on the
    // /api/agents/:id/test and /api/chat/messages inserts; flow-engine
    // runs leave it null and stay project-gated.
    addedByUserId: text("added_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    exitCode: integer("exit_code"),
    // Free-text reason set whenever status flips to 'cancelled'. Today's
    // writers: chat Stop button ("user_stopped"), PM-wave cancel
    // ("wave_cancelled"), reaper boot-time orphan cleanup ("reaper").
    cancelReason: text("cancel_reason"),
  },
  (t) => ({
    projectCreatedAtIdx: index("agent_runs_project_id_created_at_idx").on(
      t.projectId,
      t.createdAt.desc(),
    ),
    flowRunStepIdx: index("agent_runs_flow_run_step_id_idx").on(t.flowRunStepId),
    addedByUserIdIdx: index("agent_runs_added_by_user_id_idx").on(t.addedByUserId),
    // Chat thread lookups (chat.ts priorTurn probe, chatSessions.ts
    // history/hard-delete/active-keys) all filter on this JSONB
    // expression — without an index each one seq-scans a table that
    // grows with every agent run. Partial on IS NOT NULL keeps
    // flow-engine runs (no chat env key) out of the index entirely.
    chatSessionKeyIdx: index("agent_runs_chat_session_key_idx")
      .on(sql`(${t.spec}->'env'->>'OPENCARA_CHAT_SESSION_ID')`)
      .where(sql`(spec->'env'->>'OPENCARA_CHAT_SESSION_ID') IS NOT NULL`),
  }),
);

// One row per (opencara project) ↔ (Projects v2 board) link. v1 is one
// board per project — `unique(projectId)`. The Status field is a single
// single-select field on the board; we cache its option list as JSON so
// the UI can render columns without a second GraphQL hop.
export const projectV2Links = pgTable(
  "project_v2_links",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    githubProjectNodeId: text("github_project_node_id").notNull(),
    githubProjectNumber: integer("github_project_number").notNull(),
    githubProjectOwner: text("github_project_owner").notNull(),
    // 'Organization' | 'User'. Needed to construct the canonical board URL
    // (/orgs/{owner}/projects/{n} vs /users/{owner}/projects/{n}); the two
    // shapes can't be inferred from the login alone.
    githubProjectOwnerType: text("github_project_owner_type").notNull().default("Organization"),
    githubProjectTitle: text("github_project_title").notNull(),
    statusFieldNodeId: text("status_field_node_id").notNull(),
    statusOptions: jsonb("status_options")
      .$type<{ optionId: string; name: string; color: string; position: number }[]>()
      .notNull()
      .default([]),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdUq: uniqueIndex("project_v2_links_project_id_uq").on(t.projectId),
    githubProjectNodeIdIdx: index("project_v2_links_github_project_node_id_idx").on(
      t.githubProjectNodeId,
    ),
  }),
);

// Mirror of the items on the linked board. The `unique(linkId, githubItemNodeId)`
// makes webhook upserts idempotent. `statusOptionId` is the value of the Status
// single-select field — a string id from `project_v2_links.status_options`.
export const projectV2Items = pgTable(
  "project_v2_items",
  {
    id: text("id").primaryKey(),
    projectV2LinkId: text("project_v2_link_id")
      .notNull()
      .references(() => projectV2Links.id, { onDelete: "cascade" }),
    githubItemNodeId: text("github_item_node_id").notNull(),
    // 'issue' | 'pull_request' | 'draft'
    kind: text("kind").notNull(),
    contentNodeId: text("content_node_id"),
    contentNumber: integer("content_number"),
    contentTitle: text("content_title").notNull(),
    contentUrl: text("content_url"),
    // 'OPEN' | 'CLOSED' | 'MERGED' | null (drafts have no state)
    contentState: text("content_state"),
    statusOptionId: text("status_option_id"),
    // GitHub's ProjectV2Item GraphQL exposes only `isArchived: Boolean!` —
    // there's no archivedAt timestamp. Store the boolean to avoid implying
    // a real archive time we don't actually have.
    isArchived: boolean("is_archived").notNull().default(false),
    // Card detail caches (Phase 3). Issues/PRs only — drafts have neither.
    // Mirrors the shape used by `issues.assignees` / `issues.labels` so the
    // UI can share the rendering helpers.
    assignees: jsonb("assignees")
      .$type<{ login: string; id: number }[]>()
      .notNull()
      .default([]),
    labels: jsonb("labels")
      .$type<{ name: string; color: string }[]>()
      .notNull()
      .default([]),
    // Linked PRs for issue items. Populated from the Issue's timeline
    // cross-referenced events. PRs and drafts always have [].
    linkedPrs: jsonb("linked_prs")
      .$type<{ number: number; title: string; url: string; state: string }[]>()
      .notNull()
      .default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    linkItemUq: uniqueIndex("project_v2_items_link_item_uq").on(
      t.projectV2LinkId,
      t.githubItemNodeId,
    ),
    linkStatusIdx: index("project_v2_items_link_status_idx").on(
      t.projectV2LinkId,
      t.statusOptionId,
    ),
  }),
);

// ─── Chat sessions (per-user, per-scope) ─────────────────────────────────────

// Allowed values for `chat_sessions.scope_kind`. Stored as text rather than
// a pg enum so adding a new scope (e.g. 'flow' for per-flow threads) is a
// code-only change. Validated at the route boundary.
export const CHAT_SESSION_SCOPE_KINDS = [
  "project",
  "template",
  "user",
  // Steering chat anchored to a single flow_run_step. Lets the user
  // continue (or steer) the agent that ran that node by resuming its
  // ACP session. scope_id = flow_run_steps.id.
  "flow_run_step",
] as const;
export type ChatSessionScopeKind = (typeof CHAT_SESSION_SCOPE_KINDS)[number];

// N rows per (user, scope) — e.g. (alice, 'project', proj_123) may hold
// multiple chat threads, with the most-recent-non-archived row being the
// "active" one the panel resumes by default. "New chat" archives the
// current active row (sets `archived_at`) and inserts a fresh row; the
// History popover lists all rows in the scope so the user can switch
// back. scope_id='' is reserved for scope_kind='user' (user-global
// threads); other kinds carry a real id.
//
// Identity: a per-row ULID `id` is the PK. The composite
// (user_id, scope_kind, scope_id) was the PK in #0024 — that prevented
// having more than one thread per scope. It's now an index, used for the
// scope-listing query.
//
// `threadKey` stays as the stable agent-facing session id (used by
// chat.ts's resume lookup to find the row whose `acpSessionId` should be
// passed as `priorSessionId`). It remains unique-per-row; new rows get
// a fresh ULID for both `id` and `threadKey`.
//
// `acpSessionId` is the UUID the device's ACP shim minted on the first turn
// (`session/new` → claude-acp's `randomUUID()` → `claude --session-id <uuid>`).
// Subsequent turns pass it back as `priorSessionId`, the shim flips to
// `session/load`, and `claude --resume <uuid>` replays the on-disk JSONL.
// `acpSessionHostId` pins those subsequent turns to the same device — the
// JSONL lives under that machine's `~/.claude/projects/`, so routing
// elsewhere would surface as a `--resume` failure. Both are cleared the
// moment the user switches the agent pick on this row.
//
// `title` is the human-facing label for the History popover. Auto-set from
// the first user message (slice of 60 chars) on the first POST to /chat/
// messages for a session whose title is NULL. PATCH /chat/sessions/:id
// can override.
//
// `archivedAt` is the soft-delete / archive marker. The active session
// query filters on `archived_at IS NULL ORDER BY updated_at DESC LIMIT 1`.
export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull().default(""),
    threadKey: text("thread_key").notNull(),
    agentId: text("agent_id"),
    acpSessionId: text("acp_session_id"),
    acpSessionHostId: text("acp_session_host_id"),
    title: text("title"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userScopeIdx: index("chat_sessions_user_scope_idx").on(
      t.userId,
      t.scopeKind,
      t.scopeId,
      t.updatedAt.desc(),
    ),
  }),
);

// Batch dispatch records. One wave = one PM turn that dispatches N issues.
export const pmWaves = pgTable(
  "pm_waves",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    threadKey: text("thread_key").notNull(),     // which PM conversation
    flowSlug: text("flow_slug").notNull(),
    status: text("status").notNull(),            // running | done | cancelled
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    projectStatusIdx: index("pm_waves_project_status_idx").on(t.projectId, t.status),
  }),
);

// Individual issue dispatch items within a wave.
export const pmWaveItems = pgTable("pm_wave_items", {
  id: text("id").primaryKey(),
  waveId: text("wave_id").notNull()
    .references(() => pmWaves.id, { onDelete: "cascade" }),
  issueNumber: integer("issue_number").notNull(),
  flowRunId: text("flow_run_id"),              // null until triggered
  status: text("status").notNull(),            // pending|running|succeeded|failed|cancelled
});

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
