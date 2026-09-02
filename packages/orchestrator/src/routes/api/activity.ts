import { Hono } from "hono";
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import {
  buildSubject,
  type ActivityProject,
  type ActivitySubject,
  type RawSubject,
} from "./activitySubject.js";

interface ActivityRouteDeps {
  db: Db;
}

interface ActivityRow extends Record<string, unknown> {
  kind: "event" | "run" | "flow_run";
  id: string;
  ts: string;
  type: string;
  project_id: string | null;
  payload: unknown;
  flow_run_id: string | null;
  flow_id: string | null;
  flow_slug: string | null;
  flow_name: string | null;
  node_id: string | null;
  agent_kind: string | null;
  subject_json: RawSubject | null;
}

interface ProjectRow extends Record<string, unknown> {
  id: string;
  owner: string;
  name: string;
  platform: "github" | "azure_devops";
  web_url: string | null;
}

interface TriggeredRunRow extends Record<string, unknown> {
  id: string;
  trigger_event_id: string;
  status: string;
  flow_id: string;
  flow_slug: string;
  flow_name: string;
}

export interface ActivityFlowRef {
  id: string;
  slug: string;
  name: string;
}

export interface ActivityTriggeredRun {
  id: string;
  status: string;
  flow: ActivityFlowRef;
}

/** One feed entry as returned to the web UI. */
export interface ActivityItemOut {
  /**
   * `event` = platform webhook, `run` = one agent run, `flow_run` = one
   * execution of a flow (what the project Activity tab lists as "Flow runs").
   */
  kind: "event" | "run" | "flow_run";
  id: string;
  ts: string;
  type: string;
  project_id: string | null;
  payload: unknown;
  project: ActivityProject | null;
  /** Runs: the flow the run belongs to (null for chat / test runs). */
  flow: ActivityFlowRef | null;
  /** Runs / flow runs: the flow run id, for the flow-run detail link. */
  flowRunId: string | null;
  /** Runs: graph node id the run executed. */
  nodeId: string | null;
  /** Runs: `spec.kind` — the agent adapter (claude, codex, …). */
  agentKind: string | null;
  /** PR / issue / work item / push the entry is about, when known. */
  subject: ActivitySubject | null;
  /** Events: flow runs this event dispatched (trigger-skips hidden). */
  triggeredRuns: ActivityTriggeredRun[];
}

/**
 * Extract the identifying slice of a webhook payload as jsonb, so agent-run
 * rows can carry their trigger's subject without shipping the whole payload.
 *
 * GitHub deliveries are stored as-is and keyed by `pull_request` / `issue` /
 * `push`. Azure DevOps deliveries are stored as the RAW service-hook envelope
 * (`{ eventType, resource }`) — normalisation to the engine's GitHub-like
 * shape happens in memory at dispatch time (azure/events.ts) and is never
 * written back — so the Azure branches below read the envelope directly:
 *
 * - `git.pullrequest.*`: `resource` is the PR (`pullRequestId`, `title`,
 *   `_links.web.href`).
 * - PR comment events: `resource` is the bare comment; the only route back to
 *   the PR is the `/pullRequests/{id}/` segment of `_links.self.href` (see
 *   idsFromCommentLink). No title is available.
 * - `workitem.*`: `resource.id` (create) or `resource.workItemId` (update);
 *   `System.Title` is a plain string on create and `{oldValue,newValue}` on
 *   update — buildSubject accepts both.
 */
function subjectJsonExpr(payload: SQL): SQL {
  const res = sql`${payload}->'resource'`;
  return sql`CASE
    WHEN ${payload} ? 'pull_request' THEN jsonb_build_object(
      'kind', 'pull_request',
      'number', ${payload}->'pull_request'->'number',
      'title', ${payload}->'pull_request'->>'title')
    WHEN ${payload} ? 'issue' THEN jsonb_build_object(
      'kind', 'issue',
      'number', ${payload}->'issue'->'number',
      'title', ${payload}->'issue'->>'title',
      'isPr', (${payload}->'issue') ? 'pull_request')
    WHEN ${payload} ? 'work_item' THEN jsonb_build_object(
      'kind', 'work_item',
      'number', ${payload}->'work_item'->'id',
      'title', ${payload}->'work_item'->'fields'->'System.Title')
    WHEN ${payload} ? 'ref' AND ${payload} ? 'commits' THEN jsonb_build_object(
      'kind', 'push',
      'ref', ${payload}->>'ref',
      'compare', ${payload}->>'compare')
    WHEN ${payload}->>'eventType' LIKE 'git.pullrequest.%' THEN jsonb_build_object(
      'kind', 'pull_request',
      'number', ${res}->'pullRequestId',
      'title', ${res}->>'title',
      'url', ${res}->'_links'->'web'->>'href')
    WHEN ${payload}->>'eventType' = 'ms.vss-code.git-pullrequest-comment-event' THEN jsonb_build_object(
      'kind', 'pull_request',
      'number', COALESCE(
        ${res}->'pullRequest'->'pullRequestId',
        to_jsonb(substring(${res}->'_links'->'self'->>'href' from '/pullRequests/(\\d+)')::int)),
      'title', ${res}->'pullRequest'->>'title')
    WHEN ${payload}->>'eventType' LIKE 'workitem.%' THEN jsonb_build_object(
      'kind', 'work_item',
      'number', COALESCE(${res}->'workItemId', ${res}->'id'),
      'title', COALESCE(${res}->'fields'->'System.Title', ${res}->'revision'->'fields'->'System.Title'))
    ELSE NULL
  END`;
}

export function activityRoutes(deps: ActivityRouteDeps) {
  const r = new Hono<AuthEnv>();
  r.use("*", requireUser());

  r.get("/", async (c) => {
    const user = c.get("user")!;
    const limit = clampLimit(c.req.query("limit"));
    const before = c.req.query("before");

    // Cursor: rows strictly older than `before` (epoch ms). Applied inside
    // each candidate arm so the per-arm LIMIT is taken from the right window.
    const beforeCond = (col: SQL): SQL =>
      before ? sql`AND ${col} < to_timestamp(${Number(before) / 1000})` : sql``;

    // Restrict every arm to projects owned by the caller. Rows with
    // project_id IS NULL (cron/system events) drop out intentionally — there
    // is no per-user trust model for them yet, so surfacing them in
    // everyone's feed would re-introduce the leak.
    //
    // Two phases, because the feed is a UNION over three tables ordered by
    // time: Postgres cannot push the final LIMIT through the UNION, so a
    // single-pass query materialises every row the user can see (tens of
    // thousands on a busy instance), detoasts each webhook payload / agent
    // spec to build the projection, and only then keeps the newest 50.
    //
    //   1. `cand`: per arm, the newest `limit` (kind, id, ts) triples via the
    //      (project_id, created_at) indexes — no jsonb touched — merged and
    //      cut to `limit` again.
    //   2. Join the heavy columns (payload, spec, flow / step / trigger event)
    //      for those rows only.
    //
    // Agent runs are joined back through their flow-run step to the flow and
    // the flow's trigger event, so each run can link to its flow, its flow
    // run, and the PR / issue it was working on. Housekeeping runs
    // (spec.kind 'internal:*', e.g. the worktree cleanup's
    // 'internal:worktree-remove') are plumbing, not user-visible work, and
    // trigger_skip flow-run cancellations are webhook fan-out noise; both
    // stay out, as on the project Activity tab. The two arm predicates are
    // mirrored by the partial indexes agent_runs_feed_idx / flow_runs_feed_idx.
    const rows = await deps.db.execute<ActivityRow>(sql`
      WITH mine AS (
        SELECT id FROM projects WHERE added_by_user_id = ${user.id}
      ),
      cand AS (
        SELECT kind, id, ts FROM (
          (SELECT 'event'::text as kind, e.id, e.received_at as ts
           FROM platform_events e
           WHERE e.project_id IN (SELECT id FROM mine) ${beforeCond(sql`e.received_at`)}
           ORDER BY e.received_at DESC LIMIT ${limit})
          UNION ALL
          (SELECT 'run'::text as kind, r.id, r.created_at as ts
           FROM agent_runs r
           WHERE r.project_id IN (SELECT id FROM mine)
             AND COALESCE(r.spec->>'kind', '') NOT LIKE 'internal:%'
             ${beforeCond(sql`r.created_at`)}
           ORDER BY r.created_at DESC LIMIT ${limit})
          UNION ALL
          (SELECT 'flow_run'::text as kind, fr.id, fr.created_at as ts
           FROM flow_runs fr
           WHERE fr.project_id IN (SELECT id FROM mine)
             AND (fr.cancel_reason IS NULL OR fr.cancel_reason <> 'trigger_skip')
             ${beforeCond(sql`fr.created_at`)}
           ORDER BY fr.created_at DESC LIMIT ${limit})
        ) c
        ORDER BY ts DESC
        LIMIT ${limit}
      )
      SELECT * FROM (
        SELECT c.kind, e.id, c.ts, e.type, e.project_id, e.payload,
               NULL::text as flow_run_id, NULL::text as flow_id, NULL::text as flow_slug,
               NULL::text as flow_name, NULL::text as node_id, NULL::text as agent_kind,
               ${subjectJsonExpr(sql`e.payload`)} as subject_json
        FROM cand c
        JOIN platform_events e ON e.id = c.id
        WHERE c.kind = 'event'
        UNION ALL
        SELECT c.kind, r.id, c.ts, r.status::text as type, r.project_id,
               jsonb_build_object(
                 'status', r.status::text, 'hostId', r.host_id, 'exitCode', r.exit_code,
                 'startedAt', r.started_at, 'finishedAt', r.finished_at,
                 'cancelReason', r.cancel_reason) as payload,
               fr.id as flow_run_id, f.id as flow_id, f.slug as flow_slug,
               f.name as flow_name, s.node_id as node_id, r.spec->>'kind' as agent_kind,
               ${subjectJsonExpr(sql`te.payload`)} as subject_json
        FROM cand c
        JOIN agent_runs r ON r.id = c.id
        LEFT JOIN flow_run_steps s ON s.id = r.flow_run_step_id
        LEFT JOIN flow_runs fr ON fr.id = s.flow_run_id
        LEFT JOIN flows f ON f.id = fr.flow_id
        LEFT JOIN platform_events te ON te.id = fr.trigger_event_id
        WHERE c.kind = 'run'
        UNION ALL
        -- Flow runs as first-class entries, with the same fields the project
        -- Activity tab's "Flow runs" table shows (trigger, status, duration,
        -- error) so the cross-project feed can link straight to the run.
        SELECT c.kind, fr.id, c.ts, fr.status::text as type, fr.project_id,
               jsonb_build_object(
                 'status', fr.status::text, 'startedAt', fr.started_at, 'finishedAt', fr.finished_at,
                 'error', fr.error, 'cancelReason', fr.cancel_reason, 'triggerType', te.type) as payload,
               fr.id as flow_run_id, f.id as flow_id, f.slug as flow_slug,
               f.name as flow_name, NULL::text as node_id, NULL::text as agent_kind,
               ${subjectJsonExpr(sql`te.payload`)} as subject_json
        FROM cand c
        JOIN flow_runs fr ON fr.id = c.id
        JOIN flows f ON f.id = fr.flow_id
        LEFT JOIN platform_events te ON te.id = fr.trigger_event_id
        WHERE c.kind = 'flow_run'
      ) u
      ORDER BY ts DESC
      -- cand already bounds the result (every phase-2 join is on a primary
      -- key); this is insurance against a future non-unique join.
      LIMIT ${limit}
    `);

    const projectIds = uniq(rows.map((row) => row.project_id));
    const eventIds = rows.filter((row) => row.kind === "event").map((row) => row.id);

    const [projectRows, triggeredRows] = await Promise.all([
      projectIds.length === 0
        ? Promise.resolve([] as ProjectRow[])
        : deps.db.execute<ProjectRow>(sql`
            SELECT id, owner, name, platform::text as platform, web_url
            FROM projects
            WHERE added_by_user_id = ${user.id}
              AND id IN ${sql`(${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})`}
          `),
      eventIds.length === 0
        ? Promise.resolve([] as TriggeredRunRow[])
        : deps.db.execute<TriggeredRunRow>(sql`
            SELECT fr.id, fr.trigger_event_id, fr.status::text as status,
                   f.id as flow_id, f.slug as flow_slug, f.name as flow_name
            FROM flow_runs fr
            JOIN flows f ON f.id = fr.flow_id
            WHERE fr.trigger_event_id IN ${sql`(${sql.join(eventIds.map((id) => sql`${id}`), sql`, `)})`}
              AND (fr.cancel_reason IS NULL OR fr.cancel_reason <> 'trigger_skip')
            ORDER BY fr.created_at ASC
          `),
    ]);

    const projects = new Map<string, ActivityProject>();
    for (const p of projectRows) {
      projects.set(p.id, {
        id: p.id,
        owner: p.owner,
        name: p.name,
        platform: p.platform,
        webUrl: p.web_url,
      });
    }
    const triggered = new Map<string, ActivityTriggeredRun[]>();
    for (const t of triggeredRows) {
      const list = triggered.get(t.trigger_event_id) ?? [];
      list.push({
        id: t.id,
        status: t.status,
        flow: { id: t.flow_id, slug: t.flow_slug, name: t.flow_name },
      });
      triggered.set(t.trigger_event_id, list);
    }

    const activity: ActivityItemOut[] = rows.map((row) => {
      const project = row.project_id ? (projects.get(row.project_id) ?? null) : null;
      return {
        kind: row.kind,
        id: row.id,
        ts: row.ts,
        type: row.type,
        project_id: row.project_id,
        payload: row.payload,
        project,
        flow:
          row.flow_id && row.flow_slug && row.flow_name
            ? { id: row.flow_id, slug: row.flow_slug, name: row.flow_name }
            : null,
        flowRunId: row.flow_run_id,
        nodeId: row.node_id,
        agentKind: row.agent_kind,
        subject: buildSubject(row.subject_json, project),
        triggeredRuns: row.kind === "event" ? (triggered.get(row.id) ?? []) : [],
      };
    });

    return c.json({ activity });
  });

  return r;
}

function clampLimit(v: string | undefined): number {
  const n = Number.parseInt(v ?? "50", 10);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(n, 1), 200);
}

function uniq(ids: (string | null)[]): string[] {
  return Array.from(new Set(ids.filter((id): id is string => typeof id === "string")));
}
