import { Hono } from "hono";
import { ulid } from "ulid";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { azureDevopsConnections, platformEvents, projects } from "../db/schema.js";
import type { TokenCipher } from "../auth/session.js";
import { normalizeAzureEvent, refinePullRequestAction } from "../azure/events.js";
import { parseBasicAuthPassword, secretMatches } from "../azure/webhookAuth.js";
import type { FlowEngine } from "../flows/engine.js";

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
 *
 * ACCEPTED TRADE-OFF: resolving before authenticating means an unauthenticated
 * caller can tell "this repository GUID is connected" (401) from "it isn't"
 * (200 unmatched) — a small existence oracle. It is accepted rather than
 * overlooked. Closing it would mean either answering 401 for unknown repos
 * (which lets a stray event type disable a working subscription, since Azure
 * auto-disables on repeated failure) or 200 for a bad secret (which hides a
 * genuine misconfiguration). The leak requires already knowing a v4 GUID, and
 * reveals only whether it is connected here.
 */

interface AzureWebhookDeps {
  db: Db;
  cipher: TokenCipher;
  /** Absent only when no platform is configured; deliveries are then recorded but not dispatched. */
  flowEngine?: FlowEngine;
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
      //
      // But answering 200 silently made this branch invisible: Azure DevOps
      // reported "succeeded" while nothing happened here, and there was no way
      // to tell an unsubscribed event from a payload our schema rejects. Log
      // enough shape to fix the schema — event type and key NAMES only, never
      // values, since this request is not yet authenticated.
      console.warn("[webhooks-azure] unmapped delivery", {
        eventType: (payload as { eventType?: unknown })?.eventType,
        publisherId: (payload as { publisherId?: unknown })?.publisherId,
        topLevelKeys: describeKeys(payload),
        resourceKeys: describeKeys((payload as { resource?: unknown })?.resource),
        pullRequestKeys: describeKeys(
          (payload as { resource?: { pullRequest?: unknown } })?.resource?.pullRequest,
        ),
      });
      return c.json({ ok: true, ignored: true });
    }

    // Resolve the project BEFORE authenticating, so the secret we compare
    // against is the one belonging to this specific project's connection.
    const resolved = await resolveProject(deps.db, normalized);
    if (!resolved) {
      // Unknown repo/project. Answer 200 for the same reason as above; there is
      // nothing an operator can fix by seeing a 404 here — but log the ids so
      // "the webhook fires and nothing happens" is diagnosable without a
      // deploy. Ids only, no payload contents.
      console.warn("[webhooks-azure] delivery matched no project", {
        type: normalized.type,
        repositoryId: normalized.repositoryId,
        projectId: normalized.projectId,
      });
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

/** Key names of an object, for diagnostics. Never returns values. */
function describeKeys(v: unknown): string[] | null {
  return v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : null;
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
  // `removedAt` guard: removing a project deletes its subscriptions, but that
  // teardown is best-effort against a remote API — a failed delete (or a
  // subscription recreated by hand in Azure DevOps) would otherwise keep
  // dispatching agent runs for a project the user believes is gone.
  //
  // AMBIGUITY, harmless today: work item events carry only the team project,
  // not a repository, so when one Azure DevOps team project backs several
  // OpenCara projects this matches all of them and `.limit(1)` picks an
  // arbitrary row. That is fine while work item events drive nothing, but board
  // mirroring MUST resolve this properly — the right key is the work item's own
  // linked repository or an explicit board↔project link, not "first match".
  // Tracked in ROADMAP.md under Boards / kanban parity.
  const where = normalized.repositoryId
    ? and(
        eq(projects.platform, "azure_devops"),
        eq(projects.externalRepoId, normalized.repositoryId),
        isNull(projects.removedAt),
      )
    : normalized.projectId
      ? and(
          eq(projects.platform, "azure_devops"),
          eq(projects.azdoProjectId, normalized.projectId),
          isNull(projects.removedAt),
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
  // One id for both the platform_events row and the engine's event, so a flow
  // run's trigger_event_id resolves back to the stored delivery.
  const eventId = normalized.deliveryId ?? ulid();

  // Decide whether this `updated` actually moved code BEFORE storing it, since
  // the comparison is against the PR's previous delivery and this one is about
  // to become that. `previousPrHeadSha` also excludes `eventId` explicitly, so
  // a reordering here (or a retry of a delivery already stored) cannot make an
  // event its own predecessor — which would demote every push and silently
  // switch reviews off. See refinePullRequestAction for the why.
  const event = await refinePullRequestAction(normalized, (pullRequestId) =>
    previousPrHeadSha(deps.db, resolved.project.id, pullRequestId, eventId),
  );

  await deps.db
    .insert(platformEvents)
    .values({
      id: eventId,
      platform: "azure_devops",
      type: normalized.type,
      payload: rawPayload as never,
      azdoConnectionId: resolved.connection.id,
      projectId: resolved.project.id,
      deliveryId: normalized.deliveryId,
    })
    .onConflictDoNothing();

  if (!deps.flowEngine) {
    console.log(
      `[webhooks-azure] recorded ${normalized.type} for ${resolved.project.owner}/${resolved.project.name} (no flow engine configured)`,
    );
    return;
  }

  // The engine consumes the NORMALIZED payload, not the raw service hook body:
  // trigger matching, PR context and env injection are all written against the
  // GitHub webhook shape, and normalizeAzureEvent is what makes an Azure
  // delivery look like one. `platform_events.payload` keeps the raw body for
  // forensics.
  deps.flowEngine.onPlatformEvent({
    id: event.deliveryId ?? eventId,
    type: event.type,
    projectId: resolved.project.id,
    payload: event.payload,
  });
}

/**
 * Source commit of the newest earlier `pull_request` delivery for this PR, or
 * null when there is none to compare against.
 *
 * Reads the RAW service hook body (that is what `platform_events.payload`
 * stores), so the path is Azure's, not the normalized one. Deliveries whose
 * payload variant omits the merge commit are skipped rather than returned as
 * null — otherwise one trimmed delivery landing between two real ones would
 * blind the comparison.
 *
 * Cost: served by `platform_events_project_id_received_at_idx`. The 90-day
 * bound is what keeps this cheap — verified on the live plan, it becomes part
 * of the index condition, so the scan covers a window of the project's
 * deliveries rather than its whole history (which only grows). A PR that sits
 * untouched for longer than that falls back to the fail-open branch, which
 * costs one extra review on its next push.
 *
 * Fails open (null ⇒ the event keeps `synchronize`): a lookup that errors must
 * not be able to suppress a review.
 */
async function previousPrHeadSha(
  db: Db,
  projectId: string,
  pullRequestId: number,
  excludeEventId: string,
): Promise<string | null> {
  const sha = sql<
    string | null
  >`${platformEvents.payload}->'resource'->'lastMergeSourceCommit'->>'commitId'`;
  try {
    const rows = await db
      .select({ sha })
      .from(platformEvents)
      .where(
        and(
          eq(platformEvents.projectId, projectId),
          eq(platformEvents.type, "pull_request"),
          ne(platformEvents.id, excludeEventId),
          sql`${platformEvents.receivedAt} > now() - interval '90 days'`,
          sql`${platformEvents.payload}->'resource'->>'pullRequestId' = ${String(pullRequestId)}`,
          sql`${sha} IS NOT NULL`,
        ),
      )
      .orderBy(desc(platformEvents.receivedAt))
      .limit(1);
    return rows[0]?.sha ?? null;
  } catch (err) {
    console.error("[webhooks-azure] previous head sha lookup failed", {
      projectId,
      pullRequestId,
      err,
    });
    return null;
  }
}
