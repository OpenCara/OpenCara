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
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { Octokit } from "@octokit/rest";
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
import { getFreshUserToken, type TokenCipher } from "../../auth/session.js";
import type { GithubOAuth } from "../../github/oauth.js";
import {
  backfillBoard,
  fetchProjectSnapshot,
  listAvailableProjects,
  setItemStatus,
  upsertItem,
} from "../../github/projectsV2.js";
import {
  INSTALLATION_GONE_BODY,
  isInstallationGoneError,
} from "../../github/errors.js";

interface KanbanRoutesDeps {
  db: Db;
  pg: Sql;
  app?: GithubAppClient;
  cipher?: TokenCipher;
  oauth?: GithubOAuth;
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
   * Resolve a project + its installation, gated by ownership. Returns null
   * for both "no row" and "not yours" so callers respond with the same 404.
   */
  const loadProject = async (projectId: string, userId: string) => {
    const row = await deps.db
      .select({
        project: projects,
        installation: githubInstallations,
      })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.addedByUserId, userId),
        ),
      )
      .innerJoin(
        githubInstallations,
        eq(projects.installationId, githubInstallations.id),
      )
      .limit(1);
    if (row.length === 0) return null;
    return row[0]!;
  };

  /**
   * Build an Octokit authed as the *requesting user*, not the App installation.
   * Needed because GitHub App installation tokens cannot read user-owned
   * Projects v2 boards (no "Account permissions → Projects" exists on App
   * registrations); the user-to-server OAuth token already issued at login
   * does see them. Refresh-on-expiry is handled inside getFreshUserToken.
   *
   * Returns null when the session is missing, has no refresh token, or
   * refresh fails — callers respond 401 so the user re-logs in rather than
   * silently falling back to a token that can't see the board.
   */
  const userOctokit = async (
    c: Context<AuthEnv>,
  ): Promise<Octokit | null> => {
    if (!deps.cipher || !deps.oauth) return null;
    const session = c.get("session");
    if (!session) return null;
    try {
      const token = await getFreshUserToken(
        deps.db,
        deps.cipher,
        deps.oauth,
        session.id,
      );
      if (!token) return null;
      return new Octokit({ auth: token });
    } catch (err) {
      console.error("[kanban] user oauth refresh failed", {
        sessionId: session.id,
        err,
      });
      return null;
    }
  };

  /**
   * Fetch a board snapshot with a user-token-first, installation-token-fallback
   * strategy. The user token sees both user-owned boards and boards in orgs
   * the user belongs to; falling back covers org boards in installations the
   * user has but isn't a member of (rare but real). Throws if neither path
   * works; caller maps to 5xx.
   *
   * **Consistency guard for Org-owned boards:** every subsequent Refresh /
   * Drag call dispatches Organization-owned boards through the installation
   * token (see octokitForBoard). If we accept a user-token snapshot for an
   * Org board and the installation cannot actually reach it, the link
   * persists but every future write 5xxs. So when the user-token snapshot
   * says "Organization," we re-fetch via the installation as the
   * authoritative path before returning. Either both can read the board
   * (consistent) or the link is refused at create-time (no stranded row).
   * User-owned boards skip this — installation tokens are blind to them
   * by design, and User-owned writes go through the user token anyway.
   */
  const snapshotWithFallback = async (
    c: Context<AuthEnv>,
    projectNodeId: string,
    githubInstallationId: number,
  ) => {
    const userOcto = await userOctokit(c);
    let userSnap: Awaited<ReturnType<typeof fetchProjectSnapshot>> | null = null;
    if (userOcto) {
      try {
        userSnap = await fetchProjectSnapshot(userOcto, projectNodeId);
      } catch (err) {
        if (!deps.app) throw err;
        // Fall through to installation token. We deliberately swallow the
        // user-token error here — most failure modes (board not found via
        // user, permission missing) are exactly the ones the installation
        // path is meant to cover.
        console.warn("[kanban] user-token snapshot failed, falling back", {
          projectNodeId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (userSnap) {
      if (userSnap.ownerType === "User" || !deps.app) return userSnap;
      // Org-owned via user token: re-fetch through the installation so the
      // snapshot we persist matches the auth path Refresh/Drag will use.
      // If the installation can't reach the board, this throws and the
      // link PUT route surfaces the error without ever writing a row.
      const installOcto = await deps.app.forInstallation(githubInstallationId);
      return fetchProjectSnapshot(installOcto, projectNodeId);
    }
    if (!deps.app) {
      throw new Error("github app not configured and no user token available");
    }
    const installOcto = await deps.app.forInstallation(githubInstallationId);
    return fetchProjectSnapshot(installOcto, projectNodeId);
  };

  /**
   * Pick the right Octokit for a *known* board owner: user token for
   * User-owned boards (installation tokens can't see them), installation
   * token for Organization-owned boards (preserves the pre-existing path
   * + permission model). Used by refresh and drag, where the link row
   * already records the owner type.
   */
  const octokitForBoard = async (
    c: Context<AuthEnv>,
    ownerType: "User" | "Organization",
    githubInstallationId: number,
  ): Promise<Octokit | null> => {
    if (ownerType === "User") {
      return userOctokit(c);
    }
    if (!deps.app) return null;
    return deps.app.forInstallation(githubInstallationId);
  };

  r.get("/projects/:id/kanban/projects", auth, async (c) => {
    const id = c.req.param("id");
    const user = c.get("user")!;
    const ctx = await loadProject(id, user.id);
    if (!ctx) return c.json({ error: "project not found" }, 404);
    // Discovery uses the user OAuth token rather than the installation
    // token: user-owned Projects v2 boards are invisible to installation
    // tokens, and the user-to-server token sees both their own boards AND
    // boards in orgs they belong to — strictly more relevant for picker UX.
    const octokit = await userOctokit(c);
    if (!octokit) {
      return c.json(
        { error: "user oauth token unavailable; sign in again" },
        401,
      );
    }
    try {
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
    const user = c.get("user")!;
    const ctx = await loadProject(id, user.id);
    if (!ctx) return c.json({ error: "not linked" }, 404);
    const link = await deps.db.query.projectV2Links.findFirst({
      where: eq(projectV2Links.projectId, id),
    });
    if (!link) return c.json({ error: "not linked" }, 404);
    return c.json({ link });
  });

  r.put("/projects/:id/kanban/link", auth, async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      projectNodeId?: unknown;
    };
    const projectNodeId =
      typeof body.projectNodeId === "string" ? body.projectNodeId.trim() : "";
    if (!projectNodeId) {
      return c.json({ error: "projectNodeId required" }, 400);
    }
    const user = c.get("user")!;
    const ctx = await loadProject(id, user.id);
    if (!ctx) return c.json({ error: "project not found" }, 404);

    try {
      // Snapshot path: try the user OAuth token first (the only token that
      // can see user-owned Projects v2), then fall back to the App
      // installation token for org-owned boards the user isn't a member
      // of. The two-step keeps both common shapes working without forcing
      // the caller to pre-declare the owner type.
      const snapshot = await snapshotWithFallback(
        c,
        projectNodeId,
        ctx.installation.githubInstallationId,
      );

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
      if (isInstallationGoneError(err)) {
        return c.json(INSTALLATION_GONE_BODY, 502);
      }
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  r.delete("/projects/:id/kanban/link", auth, async (c) => {
    const id = c.req.param("id");
    const user = c.get("user")!;
    const ctx = await loadProject(id, user.id);
    if (!ctx) return c.json({ error: "project not found" }, 404);
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
    const user = c.get("user")!;
    const ctx = await loadProject(id, user.id);
    if (!ctx) return c.json({ error: "project not found" }, 404);
    // Carry project repo identity so the UI can decide whether an item
    // (which on a multi-repo Projects v2 board can come from any repo)
    // belongs to *this* project's repo. Used to gate the in-app Edit
    // pencil — sending users to /projects/:id/issues/:n on a foreign
    // repo's issue would route to the wrong record.
    const project = ctx.project;
    const projectRepo = { owner: project.owner, name: project.name };

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

    const user = c.get("user")!;
    const ctx = await loadProject(id, user.id);
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

    const ownerType: "User" | "Organization" =
      link.githubProjectOwnerType === "User" ? "User" : "Organization";
    const octokit = await octokitForBoard(
      c,
      ownerType,
      ctx.installation.githubInstallationId,
    );
    if (!octokit) {
      return c.json(
        {
          error:
            ownerType === "User"
              ? "user oauth token unavailable; sign in again"
              : "github app not configured",
        },
        ownerType === "User" ? 401 : 503,
      );
    }
    try {
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
  r.get("/projects/:id/kanban/stream", auth, async (c) => {
    const id = c.req.param("id");
    const user = c.get("user")!;
    // Gate the SSE handshake — a foreign id must return a normal 404, not
    // an indefinitely-open empty stream that leaks "this id exists".
    const ctx = await loadProject(id, user.id);
    if (!ctx) return c.json({ error: "project not found" }, 404);
    const projectRepo = { owner: ctx.project.owner, name: ctx.project.name };
    return streamSSE(c, async (sse) => {
      const loadSnapshot = async () => {

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
    const id = c.req.param("id");
    const user = c.get("user")!;
    const ctx = await loadProject(id, user.id);
    if (!ctx) return c.json({ error: "project not found" }, 404);
    const link = await deps.db.query.projectV2Links.findFirst({
      where: eq(projectV2Links.projectId, id),
    });
    if (!link) return c.json({ error: "not linked" }, 404);
    const ownerType: "User" | "Organization" =
      link.githubProjectOwnerType === "User" ? "User" : "Organization";
    const octokit = await octokitForBoard(
      c,
      ownerType,
      ctx.installation.githubInstallationId,
    );
    if (!octokit) {
      return c.json(
        {
          error:
            ownerType === "User"
              ? "user oauth token unavailable; sign in again"
              : "github app not configured",
        },
        ownerType === "User" ? 401 : 503,
      );
    }
    try {
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
