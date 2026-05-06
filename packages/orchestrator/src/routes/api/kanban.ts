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
// it calls `notifyKanbanLink(pg, projectId, linkId)`. The SSE handler
// LISTENs on the channel and re-snapshots when the payload's projectId
// matches its own — projectId is the stable identity across unlink/relink,
// linkId rotates.

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

/**
 * Notify payload shape on the `kanban_link` channel. We carry projectId so
 * SSE handlers can filter by *project* rather than by current link id —
 * filtering by link id misses unlink-then-relink races where the SSE handler
 * is still tracking the old link when the new one fires its first notify.
 * linkId is informational (null when the link was just deleted).
 */
export interface KanbanNotify {
  projectId: string;
  linkId: string | null;
}

/** Fire-and-forget pg notify for a board change. Errors logged, never thrown. */
export function notifyKanbanLink(
  pg: Sql,
  projectId: string,
  linkId: string | null,
): void {
  const payload: KanbanNotify = { projectId, linkId };
  pg.notify(KANBAN_NOTIFY_CHANNEL, JSON.stringify(payload)).catch(
    (err: unknown) => {
      console.error("[kanban] notify failed", { projectId, linkId, err });
    },
  );
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

      notifyKanbanLink(deps.pg, id, linkId);
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
    // Notify with linkId=null so subscribers know the project just lost its link.
    notifyKanbanLink(deps.pg, id, existing?.id ?? null);
    return c.body(null, 204);
  });

  r.get("/projects/:id/kanban", auth, async (c) => {
    const id = c.req.param("id");
    // Carry project repo identity so the UI can decide whether an item
    // (which on a multi-repo Projects v2 board can come from any repo)
    // belongs to *this* project's repo. Used to gate the in-app Edit
    // pencil — sending users to /projects/:id/issues/:n on a foreign
    // repo's issue would route to the wrong record.
    const project = await deps.db.query.projects.findFirst({
      where: eq(projects.id, id),
    });
    const projectRepo = project
      ? { owner: project.owner, name: project.name }
      : null;

    const link = await deps.db.query.projectV2Links.findFirst({
      where: eq(projectV2Links.projectId, id),
    });
    if (!link) {
      return c.json({ link: null, columns: [], items: [], projectRepo });
    }

    const items = await deps.db
      .select()
      .from(projectV2Items)
      .where(eq(projectV2Items.projectV2LinkId, link.id))
      .orderBy(asc(projectV2Items.updatedAt));

    return c.json({
      link,
      columns: link.statusOptions,
      items,
      projectRepo,
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
    notifyKanbanLink(deps.pg, id, link.id);
    return c.json({ item: fresh });
  });

  // SSE: send the full board snapshot on connect, then a fresh snapshot
  // every time something pings the `kanban_link` Postgres channel for
  // *this project*. The client just replaces its kanbanQuery cache with
  // the pushed payload — no extra refetch round-trip.
  //
  // Two correctness properties this handler guards:
  //
  //   1. Filter by projectId, not linkId. The link id rotates on
  //      unlink-then-relink, but the project id is stable for the life of
  //      this session. Filtering by linkId would race: if board A is
  //      unlinked and board B is linked before our previous snapshot
  //      finishes, the B notify fires while we still have A's id cached
  //      and gets dropped.
  //
  //   2. Serialize snapshot writes through one promise chain. Concurrent
  //      writeSnapshot() calls can finish out of order; the client just
  //      replaces cache with whichever lands last. The chain ensures
  //      arrival order on the wire matches notify order.
  r.get("/projects/:id/kanban/stream", auth, (c) => {
    const id = c.req.param("id");
    return streamSSE(c, async (sse) => {
      const loadSnapshot = async () => {
        const project = await deps.db.query.projects.findFirst({
          where: eq(projects.id, id),
        });
        const projectRepo = project
          ? { owner: project.owner, name: project.name }
          : null;

        const link = await deps.db.query.projectV2Links.findFirst({
          where: eq(projectV2Links.projectId, id),
        });
        if (!link) {
          return {
            link: null,
            columns: [],
            items: [],
            projectRepo,
          } as const;
        }
        const items = await deps.db
          .select()
          .from(projectV2Items)
          .where(eq(projectV2Items.projectV2LinkId, link.id))
          .orderBy(asc(projectV2Items.updatedAt));
        return {
          link,
          columns: link.statusOptions,
          items,
          projectRepo,
        } as const;
      };

      let writeChain: Promise<void> = Promise.resolve();
      const enqueueSnapshot = () => {
        writeChain = writeChain.then(async () => {
          try {
            const snap = await loadSnapshot();
            await sse.writeSSE({
              event: "snapshot",
              data: JSON.stringify(snap),
            });
          } catch (err) {
            console.error("[kanban-sse] snapshot failed", { id, err });
          }
        });
        return writeChain;
      };

      const onNotify = (raw: string) => {
        // Payload is JSON: { projectId, linkId }. Filter by projectId so
        // unrelated projects' notifies don't trigger a snapshot here.
        let payload: KanbanNotify | null = null;
        try {
          payload = JSON.parse(raw) as KanbanNotify;
        } catch {
          return;
        }
        if (!payload || payload.projectId !== id) return;
        void enqueueSnapshot();
      };

      const heartbeat = setInterval(() => {
        sse.writeSSE({ event: "ping", data: "" }).catch(() => undefined);
      }, 15_000);

      let sub: { unlisten: () => Promise<void> } | null = null;
      try {
        await enqueueSnapshot();
        sub = await deps.pg.listen(KANBAN_NOTIFY_CHANNEL, onNotify);
      } catch (err) {
        clearInterval(heartbeat);
        if (sub) await sub.unlisten().catch(() => undefined);
        throw err;
      }

      sse.onAbort(async () => {
        clearInterval(heartbeat);
        if (sub) await sub.unlisten().catch(() => undefined);
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
      notifyKanbanLink(deps.pg, id, link.id);
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
