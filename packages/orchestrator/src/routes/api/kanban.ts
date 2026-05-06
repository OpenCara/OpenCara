// Phase 1 of the Kanban tab: read-side API.
//
// Routes (all under /api):
//   GET    /projects/:id/kanban/projects   — discover boards on GitHub
//   GET    /projects/:id/kanban/link       — current link for this opencara project
//   PUT    /projects/:id/kanban/link       — link a Projects v2 board (triggers backfill)
//   DELETE /projects/:id/kanban/link       — unlink (cascades to items)
//   GET    /projects/:id/kanban            — read the local mirror, shaped for the UI
//   POST   /projects/:id/kanban/refresh    — force a re-pull from GitHub
//
// The PATCH .../items/:itemNodeId mutation belongs to Phase 2.

import { Hono } from "hono";
import { ulid } from "ulid";
import { eq, asc } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  githubInstallations,
  projectV2Items,
  projectV2Links,
  projects,
} from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import type { GithubAppClient } from "../../github/app.js";
import {
  backfillBoard,
  fetchProjectSnapshot,
  listAvailableProjects,
  upsertItem,
} from "../../github/projectsV2.js";

interface KanbanRoutesDeps {
  db: Db;
  app?: GithubAppClient;
}

export function kanbanRoutes(deps: KanbanRoutesDeps) {
  const r = new Hono<AuthEnv>();
  const auth = requireUser();

  /**
   * Resolve a project + its installation by opencara project id, or return a
   * Hono error response. Centralised so each route stays short.
   */
  const loadProject = async (projectId: string) => {
    const row = await deps.db
      .select({
        project: projects,
        installation: githubInstallations,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .innerJoin(
        githubInstallations,
        eq(projects.installationId, githubInstallations.id),
      )
      .limit(1);
    if (row.length === 0) return null;
    return row[0]!;
  };

  r.get("/projects/:id/kanban/projects", auth, async (c) => {
    if (!deps.app) return c.json({ error: "github app not configured" }, 503);
    const id = c.req.param("id");
    const ctx = await loadProject(id);
    if (!ctx) return c.json({ error: "project not found" }, 404);
    try {
      const octokit = await deps.app.forInstallation(
        ctx.installation.githubInstallationId,
      );
      const list = await listAvailableProjects(
        octokit,
        ctx.project.owner,
        ctx.project.name,
      );
      return c.json({ projects: list });
    } catch (err) {
      console.error("[kanban] list projects failed", { id, err });
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  r.get("/projects/:id/kanban/link", auth, async (c) => {
    const id = c.req.param("id");
    const link = await deps.db.query.projectV2Links.findFirst({
      where: eq(projectV2Links.projectId, id),
    });
    if (!link) return c.json({ error: "not linked" }, 404);
    return c.json({ link });
  });

  r.put("/projects/:id/kanban/link", auth, async (c) => {
    if (!deps.app) return c.json({ error: "github app not configured" }, 503);
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      projectNodeId?: unknown;
    };
    const projectNodeId =
      typeof body.projectNodeId === "string" ? body.projectNodeId.trim() : "";
    if (!projectNodeId) {
      return c.json({ error: "projectNodeId required" }, 400);
    }
    const ctx = await loadProject(id);
    if (!ctx) return c.json({ error: "project not found" }, 404);

    try {
      const octokit = await deps.app.forInstallation(
        ctx.installation.githubInstallationId,
      );

      // Validate the new board BEFORE touching the existing link. If the
      // GraphQL fetch fails (board removed, no Status field, perms missing,
      // etc.), the user keeps whatever link they had — we do not strand
      // the project unlinked just because the new candidate didn't pan out.
      const snapshot = await fetchProjectSnapshot(octokit, projectNodeId);

      const linkId = ulid();
      // Replace + populate now that we trust the snapshot. If the DB ops
      // below fail mid-way, the user loses the old link — DB failures are
      // rare and a retry repairs state. The much more common failure mode
      // (bad node id, missing Status field) is already handled above.
      await deps.db
        .delete(projectV2Links)
        .where(eq(projectV2Links.projectId, id));
      await deps.db.insert(projectV2Links).values({
        id: linkId,
        projectId: id,
        githubProjectNodeId: snapshot.nodeId,
        githubProjectNumber: snapshot.number,
        githubProjectOwner: snapshot.ownerLogin,
        githubProjectOwnerType: snapshot.ownerType,
        githubProjectTitle: snapshot.title,
        statusFieldNodeId: snapshot.statusFieldNodeId,
        statusOptions: snapshot.statusOptions,
        lastSyncedAt: new Date(),
      });
      for (const it of snapshot.items) {
        await upsertItem(deps.db, linkId, it);
      }

      const fresh = await deps.db.query.projectV2Links.findFirst({
        where: eq(projectV2Links.id, linkId),
      });
      return c.json({ link: fresh });
    } catch (err) {
      console.error("[kanban] link failed", { id, projectNodeId, err });
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  r.delete("/projects/:id/kanban/link", auth, async (c) => {
    const id = c.req.param("id");
    await deps.db
      .delete(projectV2Links)
      .where(eq(projectV2Links.projectId, id));
    return c.body(null, 204);
  });

  r.get("/projects/:id/kanban", auth, async (c) => {
    const id = c.req.param("id");
    const link = await deps.db.query.projectV2Links.findFirst({
      where: eq(projectV2Links.projectId, id),
    });
    if (!link) return c.json({ link: null, columns: [], items: [] });

    const items = await deps.db
      .select()
      .from(projectV2Items)
      .where(eq(projectV2Items.projectV2LinkId, link.id))
      .orderBy(asc(projectV2Items.updatedAt));

    return c.json({
      link,
      columns: link.statusOptions,
      items,
    });
  });

  r.post("/projects/:id/kanban/refresh", auth, async (c) => {
    if (!deps.app) return c.json({ error: "github app not configured" }, 503);
    const id = c.req.param("id");
    const ctx = await loadProject(id);
    if (!ctx) return c.json({ error: "project not found" }, 404);
    const link = await deps.db.query.projectV2Links.findFirst({
      where: eq(projectV2Links.projectId, id),
    });
    if (!link) return c.json({ error: "not linked" }, 404);
    try {
      const octokit = await deps.app.forInstallation(
        ctx.installation.githubInstallationId,
      );
      const result = await backfillBoard(
        deps.db,
        { id: link.id, githubProjectNodeId: link.githubProjectNodeId },
        octokit,
      );
      const fresh = await deps.db.query.projectV2Links.findFirst({
        where: eq(projectV2Links.id, link.id),
      });
      return c.json({ link: fresh, itemCount: result.itemCount });
    } catch (err) {
      console.error("[kanban] refresh failed", { id, err });
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  return r;
}
