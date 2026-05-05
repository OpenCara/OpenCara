import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  githubInstallations,
  issues,
  platformEvents,
  projectV2Links,
  projects,
} from "../db/schema.js";
import type { GithubAppClient } from "../github/app.js";
import { upsertInstallation, softRemoveProjectsForRepos } from "../github/installations.js";
import { upsertIssueFromWebhook, type IssuePayload } from "../github/issues.js";
import {
  backfillBoard,
  deleteItem,
  fetchItemSnapshot,
  upsertItem,
} from "../github/projectsV2.js";
import type { FlowEngine } from "../flows/engine.js";

interface WebhookDeps {
  db: Db;
  app: GithubAppClient;
  flowEngine?: FlowEngine;
}

interface WebhookPayload {
  action?: string;
  installation?: { id: number; account?: { id: number; login: string; type?: string } };
  repository?: { id: number; full_name: string };
  repositories?: Array<{ id: number; full_name: string }>;
  repositories_added?: Array<{ id: number; full_name: string }>;
  repositories_removed?: Array<{ id: number; full_name: string }>;
  issue?: IssuePayload;
  // projects_v2_item events arrive at the org/user level — no `repository`
  // field — so resolveProjectId has to fall back to the issue node id.
  projects_v2_item?: {
    node_id?: string;
    content_node_id?: string;
    content_type?: string;
    project_node_id?: string;
  };
  projects_v2?: {
    node_id?: string;
    title?: string;
  };
}

export function appWebhookRoutes(deps: WebhookDeps) {
  const app = new Hono();

  app.post("/", async (c) => {
    const signature = c.req.header("x-hub-signature-256");
    const eventType = c.req.header("x-github-event") ?? "unknown";
    const deliveryId = c.req.header("x-github-delivery") ?? cryptoRandom();
    const raw = await c.req.text();

    if (!signature || !(await deps.app.webhooks.verify(raw, signature))) {
      return c.json({ error: "invalid signature" }, 401);
    }

    let payload: WebhookPayload;
    try {
      payload = JSON.parse(raw) as WebhookPayload;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    try {
      const installationRowId = await resolveInstallationId(deps.db, payload, eventType);
      const projectRowId = await resolveProjectId(deps.db, payload, eventType);

      await deps.db
        .insert(platformEvents)
        .values({
          id: deliveryId,
          platform: "github",
          type: eventType,
          payload: payload as object,
          installationId: installationRowId,
          projectId: projectRowId,
          githubRepoId: payload.repository?.id,
          deliveryId,
        })
        .onConflictDoNothing();

      await handleMetaEvent(deps.db, eventType, payload);

      if (eventType === "projects_v2" || eventType === "projects_v2_item") {
        try {
          await handleProjectsV2Event(deps, eventType, payload);
        } catch (err) {
          // Same fail-soft shape as the issues path: don't let mirror
          // upkeep block the platform_events insert + flow engine fan-out.
          console.error("[webhooks] projects_v2 handler failed", {
            eventType,
            action: payload.action,
            err,
          });
        }
      }

      if (eventType === "issues" && projectRowId && payload.issue && payload.action) {
        try {
          await upsertIssueFromWebhook(deps.db, projectRowId, payload.action, payload.issue);
        } catch (err) {
          // Don't let issue normalization failure swallow the rest of the
          // webhook pipeline — platform_events row is already in, and the
          // flow engine still needs to fire.
          console.error("[webhooks] issue upsert failed", {
            projectId: projectRowId,
            number: payload.issue.number,
            err,
          });
        }
      }

      if (deps.flowEngine) {
        deps.flowEngine.onPlatformEvent({
          id: deliveryId,
          type: eventType,
          projectId: projectRowId,
          payload,
        });
      }
    } catch (err) {
      console.error("[webhooks] handler error", { eventType, deliveryId, err });
    }

    return c.json({ ok: true });
  });

  return app;
}

function cryptoRandom(): string {
  return crypto.randomUUID();
}

async function resolveInstallationId(
  db: Db,
  payload: WebhookPayload,
  eventType: string,
): Promise<string | null> {
  const installation = payload.installation;
  if (!installation) return null;

  if (eventType === "installation" && payload.action === "created") {
    const upserted = await upsertInstallation(db, installation);
    return upserted.id;
  }

  const row = await db.query.githubInstallations.findFirst({
    where: (gi, { eq }) => eq(gi.githubInstallationId, installation.id),
  });
  if (row) return row.id;

  const upserted = await upsertInstallation(db, installation);
  return upserted.id;
}

async function resolveProjectId(
  db: Db,
  payload: WebhookPayload,
  eventType: string,
): Promise<string | null> {
  const repoId = payload.repository?.id;
  if (!repoId) {
    // projects_v2_item webhooks fire at org/user scope and carry no
    // `repository` field; fall back to the issue node id we already
    // normalized into the issues table. If we haven't seen the issue
    // yet (e.g. the repo wasn't backfilled and no `issues` webhook
    // fired before this Status change), the event lands as
    // projectId=null and the flow engine ignores it — same fail-soft
    // shape the original handler had.
    if (eventType === "projects_v2_item") {
      const nodeId = payload.projects_v2_item?.content_node_id;
      if (!nodeId) return null;
      const issueRow = await db.query.issues.findFirst({
        where: eq(issues.githubNodeId, nodeId),
      });
      return issueRow?.projectId ?? null;
    }
    return null;
  }
  const row = await db.query.projects.findFirst({
    where: (p, { eq, and, isNull }) =>
      and(eq(p.githubRepoId, repoId), isNull(p.removedAt)),
  });
  if (!row) return null;

  // Self-heal display name when GitHub renames the repo. We match by
  // repo id (stable across renames), so events keep landing on the
  // right project row, but the row's owner+name lag until the user
  // notices ("why are events for new-org/new-repo showing up under a
  // project named OldName?"). Cheap to keep in sync — one update per
  // webhook event, and only when something actually changed.
  const fullName = payload.repository?.full_name;
  const slash = fullName ? fullName.indexOf("/") : -1;
  if (fullName && slash > 0) {
    const owner = fullName.slice(0, slash);
    const name = fullName.slice(slash + 1);
    if (owner && name && (owner !== row.owner || name !== row.name)) {
      // Best-effort. A unique-on-(owner,name) collision (e.g. another
      // project already claims the new name in this org) leaves the
      // stale row alone — surfacing the mismatch via the events page
      // beats failing the webhook write.
      try {
        await db
          .update(projects)
          .set({ owner, name })
          .where(eq(projects.id, row.id));
      } catch (err) {
        console.warn("[webhooks] project rename sync failed", {
          projectId: row.id,
          old: `${row.owner}/${row.name}`,
          new: fullName,
          err,
        });
      }
    }
  }
  return row.id;
}

async function handleMetaEvent(
  db: Db,
  eventType: string,
  payload: WebhookPayload,
): Promise<void> {
  if (!payload.installation) return;

  if (eventType === "installation") {
    const row = await db.query.githubInstallations.findFirst({
      where: (gi, { eq }) => eq(gi.githubInstallationId, payload.installation!.id),
    });
    if (!row) return;

    if (payload.action === "deleted") {
      await db
        .update(projects)
        .set({ removedAt: new Date() })
        .where(eq(projects.installationId, row.id));
    } else if (payload.action === "suspend") {
      await db
        .update(githubInstallations)
        .set({ suspendedAt: new Date(), updatedAt: new Date() })
        .where(eq(githubInstallations.id, row.id));
    } else if (payload.action === "unsuspend") {
      await db
        .update(githubInstallations)
        .set({ suspendedAt: null, updatedAt: new Date() })
        .where(eq(githubInstallations.id, row.id));
    }
  }

  if (eventType === "installation_repositories" && payload.action === "removed") {
    const removed = payload.repositories_removed ?? [];
    const row = await db.query.githubInstallations.findFirst({
      where: (gi, { eq }) => eq(gi.githubInstallationId, payload.installation!.id),
    });
    if (row) {
      await softRemoveProjectsForRepos(
        db,
        row.id,
        removed.map((r) => r.id),
      );
    }
  }
}

/**
 * Mirror `projects_v2` and `projects_v2_item` webhooks into our local board
 * mirror.
 *
 * `projects_v2` events fire when the board itself changes — title rename,
 * Status field options reshuffled, board deletion. We treat `edited` as a
 * cue to refresh metadata (cheapest correct path: full backfill of items
 * for that board, since field option ids may have changed and existing
 * items now point at stale ids).
 *
 * `projects_v2_item` events fire when items are created/edited/deleted/
 * archived/restored on the board. We always have the project_node_id on
 * the payload, so we look up the link by that. If no opencara project has
 * linked this board, we ignore the event (the user hasn't opted in).
 */
async function handleProjectsV2Event(
  deps: WebhookDeps,
  eventType: string,
  payload: WebhookPayload,
): Promise<void> {
  if (!payload.installation) return;
  const installRow = await deps.db.query.githubInstallations.findFirst({
    where: (gi, { eq }) => eq(gi.githubInstallationId, payload.installation!.id),
  });
  if (!installRow) return;

  if (eventType === "projects_v2") {
    const projectNodeId = payload.projects_v2?.node_id;
    if (!projectNodeId) return;
    const link = await deps.db.query.projectV2Links.findFirst({
      where: eq(projectV2Links.githubProjectNodeId, projectNodeId),
    });
    if (!link) return;
    if (payload.action === "deleted") {
      // Drop the link entirely — items cascade. The opencara project keeps
      // its tab visible (empty state); the user can pick a new board.
      await deps.db.delete(projectV2Links).where(eq(projectV2Links.id, link.id));
      return;
    }
    if (payload.action === "edited") {
      // Title / Status options may have changed. A full backfill reconciles
      // both the link metadata and any items whose status_option_id was on
      // an option that got renamed or removed.
      const octokit = await deps.app.forInstallation(installRow.githubInstallationId);
      await backfillBoard(
        deps.db,
        { id: link.id, githubProjectNodeId: link.githubProjectNodeId },
        octokit,
      );
    }
    return;
  }

  if (eventType === "projects_v2_item") {
    const item = payload.projects_v2_item;
    const projectNodeId = item?.project_node_id;
    const itemNodeId = item?.node_id;
    if (!projectNodeId || !itemNodeId) return;
    const link = await deps.db.query.projectV2Links.findFirst({
      where: eq(projectV2Links.githubProjectNodeId, projectNodeId),
    });
    if (!link) return;

    if (payload.action === "deleted") {
      await deleteItem(deps.db, link.id, itemNodeId);
      return;
    }

    // For created / edited / reordered / archived / restored / converted:
    // the cheapest correct path is to fetch the single item's current state
    // via GraphQL and upsert. Parsing the partial diff out of `changes`
    // would be faster but the shape is field-type-dependent; refresh-on-event
    // keeps the mirror trustworthy without a webhook-payload taxonomy.
    const octokit = await deps.app.forInstallation(installRow.githubInstallationId);
    const snapshot = await fetchItemSnapshot(octokit, itemNodeId);
    if (!snapshot) {
      // Race: item was edited then deleted before we fetched. Drop the row.
      await deleteItem(deps.db, link.id, itemNodeId);
      return;
    }
    await upsertItem(deps.db, link.id, snapshot);
  }
}
