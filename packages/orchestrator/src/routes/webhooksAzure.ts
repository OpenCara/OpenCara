import { Hono } from "hono";
import { ulid } from "ulid";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { azureDevopsConnections, platformEvents, projects } from "../db/schema.js";
import type { TokenCipher } from "../auth/session.js";
import { normalizeAzureEvent } from "../azure/events.js";
import { parseBasicAuthPassword, secretMatches } from "../azure/webhookAuth.js";

/**
 * Inbound Azure DevOps service hooks.
 *
 * Mirrors the GitHub handler's shape (`routes/webhooks.ts`) — same fast-ACK,
 * same fail-soft background processing — with two differences forced by the
 * platform:
 *
 *  - **Authentication is HTTP Basic**, not an HMAC signature over the body.
 *  - **The secret is per-connection**, so which connection sent this delivery
 *    cannot be known before checking. The handler resolves the project from the
 *    payload's repository/project id first, then verifies against exactly that
 *    project's connection secret — never against "any connection that matches",
 *    which would let one org's secret authenticate another org's events.
 */

interface AzureWebhookDeps {
  db: Db;
  cipher: TokenCipher;
}

export function azureWebhookRoutes(deps: AzureWebhookDeps) {
  const app = new Hono();

  app.post("/", async (c) => {
    const auth = c.req.header("authorization");
    const raw = await c.req.text();

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const normalized = normalizeAzureEvent(payload);
    if (!normalized) {
      // An event type we don't subscribe to, or one whose shape we can't map.
      // 200 rather than 4xx: Azure DevOps disables a subscription after
      // repeated failures, and we do not want an unmapped variant to silently
      // tear down a working hook.
      return c.json({ ok: true, ignored: true });
    }

    // Resolve the project BEFORE authenticating, so the secret we compare
    // against is the one belonging to this specific project's connection.
    const resolved = await resolveProject(deps.db, normalized);
    if (!resolved) {
      // Unknown repo/project. Answer 200 for the same reason as above; there is
      // nothing an operator can fix by seeing a 404 here.
      return c.json({ ok: true, unmatched: true });
    }

    const expectedSecret = deps.cipher.decrypt(resolved.connection.webhookSecretEnc);
    if (!secretMatches(parseBasicAuthPassword(auth), expectedSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    // Fast-ACK, matching the GitHub path: Azure DevOps retries and eventually
    // disables a subscription whose endpoint is slow, so nothing below blocks
    // the 200. Every step is fail-soft and logged.
    setImmediate(() => {
      void processDelivery(deps, normalized, payload, resolved).catch((err: unknown) => {
        console.error("[webhooks-azure] background processing failed", {
          eventType: normalized.type,
          deliveryId: normalized.deliveryId,
          err,
        });
      });
    });

    return c.json({ ok: true });
  });

  return app;
}

interface ResolvedProject {
  project: typeof projects.$inferSelect;
  connection: typeof azureDevopsConnections.$inferSelect;
}

async function resolveProject(
  db: Db,
  normalized: ReturnType<typeof normalizeAzureEvent>,
): Promise<ResolvedProject | null> {
  if (!normalized) return null;
  // PR and comment events identify the repository directly. Work item events
  // carry only the team project, so they match every project row under it.
  const where = normalized.repositoryId
    ? and(
        eq(projects.platform, "azure_devops"),
        eq(projects.externalRepoId, normalized.repositoryId),
      )
    : normalized.projectId
      ? and(
          eq(projects.platform, "azure_devops"),
          eq(projects.azdoProjectId, normalized.projectId),
        )
      : null;
  if (!where) return null;

  const rows = await db
    .select({ project: projects, connection: azureDevopsConnections })
    .from(projects)
    .innerJoin(
      azureDevopsConnections,
      eq(projects.azdoConnectionId, azureDevopsConnections.id),
    )
    .where(where)
    .limit(1);
  return rows[0] ?? null;
}

async function processDelivery(
  deps: AzureWebhookDeps,
  normalized: NonNullable<ReturnType<typeof normalizeAzureEvent>>,
  rawPayload: unknown,
  resolved: ResolvedProject,
): Promise<void> {
  // Dedup on the delivery id, same contract as the GitHub handler's
  // x-github-delivery. Azure DevOps does not document at-least-once delivery as
  // explicitly as GitHub, but the payload id is stable across retries and the
  // insert is cheap insurance.
  await deps.db
    .insert(platformEvents)
    .values({
      id: normalized.deliveryId ?? ulid(),
      platform: "azure_devops",
      type: normalized.type,
      payload: rawPayload as never,
      azdoConnectionId: resolved.connection.id,
      projectId: resolved.project.id,
      deliveryId: normalized.deliveryId,
    })
    .onConflictDoNothing();

  // Flow dispatch for Azure DevOps projects lands with the ADO provider. Until
  // then the delivery is recorded (so the wiring is verifiable end-to-end from
  // the activity feed) but drives nothing.
  console.log(
    `[webhooks-azure] recorded ${normalized.type} for ${resolved.project.owner}/${resolved.project.name}`,
  );
}
