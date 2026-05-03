import { Hono } from "hono";
import { ulid } from "ulid";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  agentRuns,
  githubInstallations,
  issues,
  platformEvents,
  projects,
} from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import type { GithubAppClient } from "../../github/app.js";
import { backfillIssues } from "../../github/issues.js";

interface ProjectRoutesDeps {
  db: Db;
  app?: GithubAppClient;
}

export function projectRoutes(deps: ProjectRoutesDeps) {
  const r = new Hono<AuthEnv>();
  r.use("*", requireUser());

  r.get("/", async (c) => {
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
      .orderBy(desc(projects.addedAt));
    return c.json({ projects: rows });
  });

  r.post("/", async (c) => {
    const body = (await c.req.json()) as { githubRepoId?: number };
    const repoId = body.githubRepoId;
    if (!repoId || typeof repoId !== "number") {
      return c.json({ error: "githubRepoId required" }, 400);
    }
    const existing = await deps.db.query.projects.findFirst({
      where: eq(projects.githubRepoId, repoId),
    });
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
    const row = await deps.db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .innerJoin(
        githubInstallations,
        eq(projects.installationId, githubInstallations.id),
      )
      .limit(1);
    if (row.length === 0) return c.json({ error: "not found" }, 404);
    return c.json({ project: row[0]!.projects, installation: row[0]!.github_installations });
  });

  r.delete("/:id", async (c) => {
    const id = c.req.param("id");
    await deps.db.update(projects).set({ removedAt: new Date() }).where(eq(projects.id, id));
    return c.body(null, 204);
  });

  r.get("/:id/events", async (c) => {
    const id = c.req.param("id");
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

  // Manual one-shot backfill for a project that pre-dates the issues feature
  // (auto-backfill only fires on project add). Idempotent — re-running just
  // updates rows. 503 if the GitHub app isn't configured.
  r.post("/:id/issues/sync", async (c) => {
    if (!deps.app) return c.json({ error: "github app not configured" }, 503);
    const id = c.req.param("id");
    const project = await deps.db.query.projects.findFirst({
      where: eq(projects.id, id),
    });
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
