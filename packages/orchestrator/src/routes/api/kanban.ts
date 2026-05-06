// Kanban tab API.
//
// Routes (all under /api):
//   GET    /projects/:id/kanban/projects                — discover boards on GitHub
//   GET    /projects/:id/kanban/link                    — current link for this opencara project
//   PUT    /projects/:id/kanban/link                    — link a Projects v2 board (triggers backfill)
//   DELETE /projects/:id/kanban/link                    — unlink (cascades to items)
//   GET    /projects/:id/kanban                         — read the local mirror, shaped for the UI
//   POST   /projects/:id/kanban/refresh                 — force a re-pull from GitHub
//   PATCH  /projects/:id/kanban/items/:itemNodeId       — set Status field on a board item
//   GET    /projects/:id/kanban/stream                  — SSE: snapshot + on-change pushes
//
// SSE wires through a dedicated `kanban_link` Postgres channel. After any
// route or webhook writes through to project_v2_links / project_v2_items,
// it calls `notifyKanbanLink(pg, linkId)`. The SSE handler LISTENs on the
// channel and re-snapshots when its link's id arrives.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ulid } from "ulid";
import { and, asc, eq } from "drizzle-orm";
import type { Sql } from "postgres";
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
  setItemStatus,
  upsertItem,
} from "../../github/projectsV2.js";

interface KanbanRoutesDeps {
  db: Db;
  pg: Sql;
  app?: GithubAppClient;
}

const KANBAN_NOTIFY_CHANNEL = "kanban_link";

/** Fire-and-forget pg notify for a board link. Errors logged, never thrown. */
export function notifyKanbanLink(pg: Sql, linkId: string): void {
  pg.notify(KANBAN_NOTIFY_CHANNEL, linkId).catch((err: unknown) => {
    console.error("[kanban] notify failed", { linkId, err });
  });
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

      notifyKanbanLink(deps.pg, linkId);
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
    const existing = await deps.db.query.projectV2Links.findFirst({
      where: eq(projectV2Links.projectId, id),
    });
    await deps.db
      .delete(projectV2Links)
      .where(eq(projectV2Links.projectId, id));
    if (existing) notifyKanbanLink(deps.pg, existing.id);
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

  // Phase 2: set the Status (single-select) field on a board item. The drag
  // handler in the UI fires this with optimistic update + rollback. Body:
  //   { statusOptionId: string | null }
  // null clears the field; non-null must be one of link.statusOptions[*].optionId.
  // Last-writer-wins: a webhook arriving after our update is authoritative,
  // so we don't bother locking the local row.
  r.patch("/projects/:id/kanban/items/:itemNodeId", auth, async (c) => {
    if (!deps.app) return c.json({ error: "github app not configured" }, 503);
    const id = c.req.param("id");
    const itemNodeId = c.req.param("itemNodeId");
    if (!itemNodeId) return c.json({ error: "itemNodeId required" }, 400);

    const body = (await c.req.json().catch(() => ({}))) as {
      statusOptionId?: unknown;
    };
    let statusOptionId: string | null;
    if (body.statusOptionId === null) {
      statusOptionId = null;
    } else if (typeof body.statusOptionId === "string" && body.statusOptionId) {
      statusOptionId = body.statusOptionId;
    } else {
      return c.json(
        { error: "statusOptionId (string or null) required" },
        400,
      );
    }

    const ctx = await loadProject(id);
    if (!ctx) return c.json({ error: "project not found" }, 404);
    const link = await deps.db.query.projectV2Links.findFirst({
      where: eq(projectV2Links.projectId, id),
    });
    if (!link) return c.json({ error: "not linked" }, 404);

    if (
      statusOptionId !== null &&
      !link.statusOptions.some((o) => o.optionId === statusOptionId)
    ) {
      return c.json(
        { error: "statusOptionId not in link.statusOptions" },
        400,
      );
    }

    // Verify the item belongs to this link before mutating GitHub. Stops the
    // PATCH route from being abused as a generic "set status on any node id"
    // proxy by an authenticated user — they can only target items their
    // project's mirror knows about.
    const itemRow = await deps.db.query.projectV2Items.findFirst({
      where: and(
        eq(projectV2Items.projectV2LinkId, link.id),
        eq(projectV2Items.githubItemNodeId, itemNodeId),
      ),
    });
    if (!itemRow) return c.json({ error: "item not in this board" }, 404);

    try {
      const octokit = await deps.app.forInstallation(
        ctx.installation.githubInstallationId,
      );
      await setItemStatus(
        octokit,
        {
          githubProjectNodeId: link.githubProjectNodeId,
          statusFieldNodeId: link.statusFieldNodeId,
        },
        itemNodeId,
        statusOptionId,
      );
    } catch (err) {
      console.error("[kanban] setItemStatus failed", {
        id,
        itemNodeId,
        statusOptionId,
        err,
      });
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        502,
      );
    }

    // Mutation succeeded on GitHub. Mirror the change locally so the UI
    // doesn't have to wait for the webhook round-trip — but treat GitHub's
    // success as the source of truth for this request. If the local DB
    // write fails, we log it and still return success: the user's drag
    // already took effect on GitHub, and the upcoming webhook (or a manual
    // Refresh) will reconcile the mirror. Returning 5xx here would tell
    // the client to roll back the optimistic move that's already
    // authoritative on GitHub.
    let fresh = itemRow;
    try {
      await deps.db
        .update(projectV2Items)
        .set({ statusOptionId, updatedAt: new Date() })
        .where(eq(projectV2Items.id, itemRow.id));
      const refreshed = await deps.db.query.projectV2Items.findFirst({
        where: eq(projectV2Items.id, itemRow.id),
      });
      if (refreshed) fresh = refreshed;
    } catch (err) {
      console.error("[kanban] mirror update failed after GitHub success", {
        id,
        itemNodeId,
        statusOptionId,
        err,
      });
      // Hand back the pre-update row with the new statusOptionId synthesised
      // in. The webhook will overwrite this once it lands.
      fresh = { ...itemRow, statusOptionId };
    }
    notifyKanbanLink(deps.pg, link.id);
    return c.json({ item: fresh });
  });

  // SSE: send the full board snapshot on connect, then a fresh snapshot
  // every time something pings the `kanban_link` Postgres channel for
  // this link id. The client just replaces its kanbanQuery cache with the
  // pushed payload — no extra refetch round-trip.
  r.get("/projects/:id/kanban/stream", auth, (c) => {
    const id = c.req.param("id");
    return streamSSE(c, async (sse) => {
      const loadSnapshot = async () => {
        const link = await deps.db.query.projectV2Links.findFirst({
          where: eq(projectV2Links.projectId, id),
        });
        if (!link) return { link: null, columns: [], items: [] } as const;
        const items = await deps.db
          .select()
          .from(projectV2Items)
          .where(eq(projectV2Items.projectV2LinkId, link.id))
          .orderBy(asc(projectV2Items.updatedAt));
        return { link, columns: link.statusOptions, items } as const;
      };

      const writeSnapshot = async () => {
        const snap = await loadSnapshot();
        await sse.writeSSE({
          event: "snapshot",
          data: JSON.stringify(snap),
        });
        return snap;
      };

      const initial = await writeSnapshot();
      // Track the active link id; it can change if the user re-links to a
      // different board mid-stream. We only re-snap on notifies that match
      // the current link OR when the link is null (so a brand-new link
      // surfaces here without the user having to reload).
      let currentLinkId: string | null = initial.link?.id ?? null;

      const onNotify = (payload: string) => {
        if (currentLinkId !== null && payload !== currentLinkId) return;
        writeSnapshot()
          .then((next) => {
            currentLinkId = next.link?.id ?? null;
          })
          .catch((err: unknown) => {
            console.error("[kanban-sse] snapshot failed", { id, err });
          });
      };
      const sub = await deps.pg.listen(KANBAN_NOTIFY_CHANNEL, onNotify);

      // When unlinked, also subscribe so we hear the next link's first notify.
      // pg.listen is for the channel as a whole; the filter above handles
      // the targeting.

      const heartbeat = setInterval(() => {
        sse.writeSSE({ event: "ping", data: "" }).catch(() => undefined);
      }, 15_000);

      sse.onAbort(async () => {
        clearInterval(heartbeat);
        await sub.unlisten();
      });
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
      notifyKanbanLink(deps.pg, link.id);
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
