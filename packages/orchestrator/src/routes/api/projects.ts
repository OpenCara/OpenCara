import { Hono } from "hono";
import { ulid } from "ulid";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  agentRuns,
  agents,
  flows,
  githubInstallations,
  issues,
  platformEvents,
  projects,
} from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import { loadOwnedProject } from "../../auth/ownership.js";
import type { GithubAppClient } from "../../github/app.js";
import {
  backfillIssues,
  pushIssueBodyToGithub,
  setIssueAgentLabel,
} from "../../github/issues.js";

interface ProjectRoutesDeps {
  db: Db;
  app?: GithubAppClient;
}

export function projectRoutes(deps: ProjectRoutesDeps) {
  const r = new Hono<AuthEnv>();
  r.use("*", requireUser());

  r.get("/", async (c) => {
    const user = c.get("user")!;
    const rows = await deps.db
      .select({
        id: projects.id,
        owner: projects.owner,
        name: projects.name,
        defaultBranch: projects.defaultBranch,
        private: projects.private,
        addedAt: projects.addedAt,
        removedAt: projects.removedAt,
        installationId: projects.installationId,
        installationAccountLogin: githubInstallations.accountLogin,
        installationAccountType: githubInstallations.accountType,
        installationSuspendedAt: githubInstallations.suspendedAt,
        lastEventAt: sql<Date | null>`(
          SELECT MAX(${platformEvents.receivedAt})
          FROM ${platformEvents}
          WHERE ${platformEvents.projectId} = ${projects.id}
        )`,
        recentRunsCount: sql<number>`(
          SELECT COUNT(*)::int FROM ${agentRuns}
          WHERE ${agentRuns.projectId} = ${projects.id}
            AND ${agentRuns.createdAt} > NOW() - INTERVAL '7 days'
        )`,
      })
      .from(projects)
      .innerJoin(
        githubInstallations,
        eq(projects.installationId, githubInstallations.id),
      )
      .where(and(eq(projects.addedByUserId, user.id), isNull(projects.removedAt)))
      .orderBy(desc(projects.addedAt));
    return c.json({ projects: rows });
  });

  r.post("/", async (c) => {
    const user = c.get("user")!;
    const body = (await c.req.json()) as { githubRepoId?: number };
    const repoId = body.githubRepoId;
    if (!repoId || typeof repoId !== "number") {
      return c.json({ error: "githubRepoId required" }, 400);
    }
    const existing = await deps.db.query.projects.findFirst({
      where: eq(projects.githubRepoId, repoId),
    });
    // Foreign-owned existing project: same 404 as "no row" — never confirm
    // that a repo is already attached to someone else's account.
    if (existing && existing.addedByUserId !== user.id) {
      return c.json(
        { error: "repository not found in any installation; install the App on its owner first" },
        404,
      );
    }
    if (existing && !existing.removedAt) {
      return c.json({ project: existing });
    }
    if (existing && existing.removedAt) {
      await deps.db
        .update(projects)
        .set({ removedAt: null })
        .where(eq(projects.id, existing.id));
      return c.json({ project: { ...existing, removedAt: null } });
    }
    return c.json(
      { error: "repository not found in any installation; install the App on its owner first" },
      404,
    );
  });

  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user")!;
    const project = await loadOwnedProject(deps.db, id, user.id);
    if (!project) return c.json({ error: "not found" }, 404);
    const installation = await deps.db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.id, project.installationId),
    });
    return c.json({ project, installation });
  });

  r.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user")!;
    const owned = await loadOwnedProject(deps.db, id, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);
    // Hard delete: FK cascade drops issues, flows, flow runs, flow node
    // settings, and projectV2 links; platform_events and agent_runs are
    // ON DELETE SET NULL, so their rows survive as an orphaned audit
    // trail without the project link.
    await deps.db.delete(projects).where(eq(projects.id, id));
    return c.body(null, 204);
  });

  // Update project settings. Currently supports:
  //   { defaultImplementFlowId: string | null }
  // The flow must belong to the project and be enabled; null clears the setting.
  r.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user")!;
    const owned = await loadOwnedProject(deps.db, id, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    if (!("defaultImplementFlowId" in body)) {
      return c.json({ error: "defaultImplementFlowId required" }, 400);
    }
    const flowId = body.defaultImplementFlowId;
    if (flowId !== null && typeof flowId !== "string") {
      return c.json({ error: "defaultImplementFlowId must be a string or null" }, 400);
    }

    if (typeof flowId === "string") {
      const flow = await deps.db.query.flows.findFirst({
        where: and(eq(flows.id, flowId), eq(flows.projectId, id)),
      });
      if (!flow) return c.json({ error: "flow not found in this project" }, 404);
      if (!flow.enabled) return c.json({ error: "flow is disabled" }, 400);
    }

    await deps.db
      .update(projects)
      .set({ defaultImplementFlowId: flowId })
      .where(eq(projects.id, id));

    const project = await loadOwnedProject(deps.db, id, user.id);
    const installation = await deps.db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.id, project!.installationId),
    });
    return c.json({ project, installation });
  });

  r.get("/:id/events", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user")!;
    const owned = await loadOwnedProject(deps.db, id, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);
    const limit = clampLimit(c.req.query("limit"));
    const before = c.req.query("before");
    const where = before
      ? and(eq(platformEvents.projectId, id), lt(platformEvents.id, before))
      : eq(platformEvents.projectId, id);
    const rows = await deps.db
      .select({
        id: platformEvents.id,
        type: platformEvents.type,
        receivedAt: platformEvents.receivedAt,
        deliveryId: platformEvents.deliveryId,
        payload: platformEvents.payload,
      })
      .from(platformEvents)
      .where(where)
      .orderBy(desc(platformEvents.receivedAt))
      .limit(limit);
    return c.json({ events: rows });
  });

  r.get("/:id/issues", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user")!;
    const owned = await loadOwnedProject(deps.db, id, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);
    const limit = clampLimit(c.req.query("limit"));
    const before = c.req.query("before");
    const stateFilter = c.req.query("state"); // "open" | "closed" | undefined (all)
    const labelFilter = c.req.query("label"); // single label name, optional
    const conds = [eq(issues.projectId, id), isNull(issues.removedAt)];
    if (stateFilter === "open" || stateFilter === "closed") {
      conds.push(eq(issues.state, stateFilter));
    }
    if (before) conds.push(lt(issues.id, before));
    if (labelFilter) {
      // Match against the labels jsonb array using a Postgres jsonb @> containment query.
      conds.push(sql`${issues.labels} @> ${JSON.stringify([{ name: labelFilter }])}::jsonb`);
    }
    const rows = await deps.db
      .select({
        id: issues.id,
        number: issues.number,
        title: issues.title,
        state: issues.state,
        stateReason: issues.stateReason,
        labels: issues.labels,
        assignees: issues.assignees,
        authorLogin: issues.authorLogin,
        htmlUrl: issues.htmlUrl,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        closedAt: issues.closedAt,
      })
      .from(issues)
      .where(and(...conds))
      // Order by id (ULID, monotonic with insert time) so the `before=<id>`
      // cursor is well-defined. updatedAt would be a nicer sort key but it
      // changes on every webhook upsert, which would let pages skip or
      // duplicate rows — composite cursor not worth the complexity for an
      // Issues tab whose most-common query fits in one page.
      .orderBy(desc(issues.id))
      .limit(limit);
    return c.json({ issues: rows });
  });

  // Detail view including bodyMd. The list endpoint omits the body to keep
  // table payloads lean; the detail endpoint is what the issue canvas page
  // reads.
  r.get("/:id/issues/:number", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user")!;
    const number = Number.parseInt(c.req.param("number"), 10);
    if (!Number.isFinite(number)) {
      return c.json({ error: "invalid issue number" }, 400);
    }
    const owned = await loadOwnedProject(deps.db, id, user.id);
    if (!owned) return c.json({ error: "issue not found" }, 404);
    const row = await deps.db.query.issues.findFirst({
      where: (i, { and, eq, isNull }) =>
        and(eq(i.projectId, id), eq(i.number, number), isNull(i.removedAt)),
    });
    if (!row) return c.json({ error: "issue not found" }, 404);
    return c.json({ issue: row });
  });

  // Push the in-app body to GitHub. The body may come from:
  //   - explicit request body (frontend may pass a snapshot for safety), or
  //   - the issue's draftBodyMd column (preferred — what the canvas user
  //     was looking at when they clicked Save).
  // Last-writer-wins; we don't yet check GitHub's updated_at against ours —
  // see plan's out-of-scope notes.
  r.patch("/:id/issues/:number/body", async (c) => {
    if (!deps.app) return c.json({ error: "github app not configured" }, 503);
    const id = c.req.param("id");
    const user = c.get("user")!;
    const number = Number.parseInt(c.req.param("number"), 10);
    if (!Number.isFinite(number)) {
      return c.json({ error: "invalid issue number" }, 400);
    }
    const reqBody = (await c.req.json().catch(() => null)) as { bodyMd?: unknown } | null;

    const project = await loadOwnedProject(deps.db, id, user.id);
    if (!project) return c.json({ error: "project not found" }, 404);

    // Resolve the body to push: explicit request body wins (caller guards
    // against races), else fall back to the saved draft, else error.
    let bodyMd: string | null = null;
    if (reqBody && typeof reqBody.bodyMd === "string") {
      bodyMd = reqBody.bodyMd;
    } else {
      const issueRow = await deps.db.query.issues.findFirst({
        where: (i, { and, eq, isNull }) =>
          and(eq(i.projectId, id), eq(i.number, number), isNull(i.removedAt)),
      });
      if (issueRow?.draftBodyMd != null) bodyMd = issueRow.draftBodyMd;
    }
    if (bodyMd === null) {
      return c.json(
        { error: "bodyMd not provided and no draft is set" },
        400,
      );
    }

    try {
      const refreshed = await pushIssueBodyToGithub(
        deps.app,
        {
          id: project.id,
          owner: project.owner,
          name: project.name,
          installationId: project.installationId,
        },
        number,
        bodyMd,
        deps.db,
      );
      return c.json({ issue: refreshed });
    } catch (err) {
      console.error("[projects] push issue body failed", {
        projectId: id,
        number,
        err,
      });
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  // Set / clear the in-app body draft from the user side (textarea edit
  // mode). Same column as the agent API writes to — the agent uses Bearer
  // auth at /api/agent/..., the user uses cookie auth here. Pass
  // bodyMd: null to discard the draft.
  r.patch("/:id/issues/:number/draft", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user")!;
    const number = Number.parseInt(c.req.param("number"), 10);
    if (!Number.isFinite(number)) {
      return c.json({ error: "invalid issue number" }, 400);
    }
    const reqBody = (await c.req.json().catch(() => null)) as { bodyMd?: unknown } | null;
    if (
      !reqBody ||
      (typeof reqBody.bodyMd !== "string" && reqBody.bodyMd !== null)
    ) {
      return c.json({ error: "bodyMd (string or null) required" }, 400);
    }
    const owned = await loadOwnedProject(deps.db, id, user.id);
    if (!owned) return c.json({ error: "issue not found" }, 404);
    const existing = await deps.db.query.issues.findFirst({
      where: (i, { and, eq, isNull }) =>
        and(eq(i.projectId, id), eq(i.number, number), isNull(i.removedAt)),
    });
    if (!existing) return c.json({ error: "issue not found" }, 404);

    await deps.db
      .update(issues)
      .set({
        draftBodyMd: reqBody.bodyMd as string | null,
        draftUpdatedAt: reqBody.bodyMd === null ? null : new Date(),
      })
      .where(and(eq(issues.projectId, id), eq(issues.number, number)));

    const refreshed = await deps.db.query.issues.findFirst({
      where: (i, { and, eq }) => and(eq(i.projectId, id), eq(i.number, number)),
    });
    return c.json({ issue: refreshed });
  });

  // Set or clear the implementation-agent label on an issue. Body:
  //   { agentId: string | null }
  // null clears all agent:* labels; non-null must reference an agent owned
  // by the current user (mirrors the user-scoped agents table). Resolves to
  // the agent's name and writes label `agent:<name>` on GitHub. Auto-creates
  // the label on the repo if it doesn't exist (color #5856d6). The existing
  // issue-implement flow already routes to this label convention when its
  // trigger fires — no flow changes needed.
  r.patch("/:id/issues/:number/agent", async (c) => {
    if (!deps.app) return c.json({ error: "github app not configured" }, 503);
    const user = c.get("user")!;
    const id = c.req.param("id");
    const number = Number.parseInt(c.req.param("number"), 10);
    if (!Number.isFinite(number)) {
      return c.json({ error: "invalid issue number" }, 400);
    }
    const reqBody = (await c.req.json().catch(() => null)) as {
      agentId?: unknown;
    } | null;
    if (!reqBody || (reqBody.agentId !== null && typeof reqBody.agentId !== "string")) {
      return c.json({ error: "agentId (string or null) required" }, 400);
    }
    const agentIdRaw = reqBody.agentId;

    const project = await loadOwnedProject(deps.db, id, user.id);
    // 404 hides existence — both "no row" and "not yours" funnel to the
    // same response so a curious client cannot probe for project ids.
    if (!project) {
      return c.json({ error: "project not found" }, 404);
    }

    let agentName: string | null = null;
    if (typeof agentIdRaw === "string" && agentIdRaw) {
      const agent = await deps.db.query.agents.findFirst({
        where: and(eq(agents.id, agentIdRaw), eq(agents.userId, user.id)),
      });
      if (!agent) return c.json({ error: "agent not found or not yours" }, 404);
      agentName = agent.name;
    }

    try {
      const refreshed = await setIssueAgentLabel(
        deps.app,
        {
          id: project.id,
          owner: project.owner,
          name: project.name,
          installationId: project.installationId,
        },
        number,
        agentName,
        deps.db,
      );
      return c.json({ issue: refreshed });
    } catch (err) {
      console.error("[projects] set agent label failed", {
        projectId: id,
        number,
        agentName,
        err,
      });
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  // Manual one-shot backfill for a project that pre-dates the issues feature
  // (auto-backfill only fires on project add). Idempotent — re-running just
  // updates rows. 503 if the GitHub app isn't configured.
  r.post("/:id/issues/sync", async (c) => {
    if (!deps.app) return c.json({ error: "github app not configured" }, 503);
    const id = c.req.param("id");
    const user = c.get("user")!;
    const project = await loadOwnedProject(deps.db, id, user.id);
    if (!project) return c.json({ error: "project not found" }, 404);
    try {
      const stats = await backfillIssues(
        deps.app,
        {
          id: project.id,
          owner: project.owner,
          name: project.name,
          installationId: project.installationId,
        },
        deps.db,
      );
      return c.json({ ok: true, ...stats });
    } catch (err) {
      console.error("[projects] manual issue backfill failed", {
        projectId: id,
        owner: project.owner,
        name: project.name,
        err,
      });
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  r.get("/:id/runs", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user")!;
    const owned = await loadOwnedProject(deps.db, id, user.id);
    if (!owned) return c.json({ error: "not found" }, 404);
    const limit = clampLimit(c.req.query("limit"));
    const before = c.req.query("before");
    const where = before
      ? and(eq(agentRuns.projectId, id), lt(agentRuns.id, before))
      : eq(agentRuns.projectId, id);
    const rows = await deps.db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        hostId: agentRuns.hostId,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
        finishedAt: agentRuns.finishedAt,
        exitCode: agentRuns.exitCode,
      })
      .from(agentRuns)
      .where(where)
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit);
    return c.json({ runs: rows });
  });

  void ulid;
  void isNull;
  return r;
}

function clampLimit(v: string | undefined): number {
  const n = Number.parseInt(v ?? "50", 10);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(n, 1), 200);
}
