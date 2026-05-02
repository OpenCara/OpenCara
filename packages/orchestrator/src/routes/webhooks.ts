import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { githubInstallations, platformEvents, projects } from "../db/schema.js";
import type { GithubAppClient } from "../github/app.js";
import { upsertInstallation, softRemoveProjectsForRepos } from "../github/installations.js";
import { upsertIssueFromWebhook, type IssuePayload } from "../github/issues.js";
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
      const projectRowId = await resolveProjectId(deps.db, payload);

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

async function resolveProjectId(db: Db, payload: WebhookPayload): Promise<string | null> {
  const repoId = payload.repository?.id;
  if (!repoId) return null;
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
