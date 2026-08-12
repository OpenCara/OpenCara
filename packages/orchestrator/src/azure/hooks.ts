import { z } from "zod";
import type { AzureDevopsClient } from "./client.js";

/**
 * Service hook subscriptions — Azure DevOps' equivalent of GitHub webhooks.
 *
 * Two structural differences from the GitHub side worth knowing:
 *
 *  1. **Authentication is HTTP Basic, not an HMAC signature.** There is no
 *     per-delivery signature to verify; the shared secret registered here IS
 *     the whole of inbound authentication. It is stored encrypted per
 *     connection and compared in constant time on delivery.
 *  2. **One subscription per event type, per project.** GitHub delivers every
 *     subscribed event to one endpoint from one App installation; here each
 *     (project, eventType) pair is its own subscription that must be created
 *     and torn down individually.
 */

/**
 * The event types OpenCara subscribes to. `git.pullrequest.merged` is
 * deliberately absent — the merge outcome arrives on `git.pullrequest.updated`,
 * and subscribing to both doubles every delivery.
 */
export const AZDO_EVENT_TYPES = [
  "git.pullrequest.created",
  "git.pullrequest.updated",
  // Comment on a pull request — the Azure DevOps analogue of
  // `issue_comment.created` on a PR, which drives comment-phrase triggers.
  "ms.vss-code.git-pullrequest-comment-event",
  "workitem.created",
  "workitem.updated",
] as const;

export type AzdoEventType = (typeof AZDO_EVENT_TYPES)[number];

const SubscriptionSchema = z.object({
  id: z.string(),
  eventType: z.string(),
  status: z.string().optional(),
});

const SubscriptionListSchema = z.object({
  value: z.array(SubscriptionSchema.extend({ consumerInputs: z.record(z.unknown()).optional() })),
});

export interface CreateSubscriptionsArgs {
  client: AzureDevopsClient;
  /** Team project GUID the subscriptions are scoped to. */
  projectId: string;
  /** Public URL Azure DevOps will POST to. Must be HTTPS — see below. */
  webhookUrl: string;
  /** Basic-auth password registered on each subscription. */
  webhookSecret: string;
  /** Repository GUID, to filter PR events down to this repo. */
  repositoryId: string;
}

export interface CreatedSubscription {
  id: string;
  eventType: string;
}

/**
 * Subscribe to every event type for one repository.
 *
 * Azure DevOps refuses a non-HTTPS consumer URL when basic auth is configured
 * (it would put credentials on the wire in clear), so this fails fast with an
 * actionable message rather than letting each subscription 400 separately.
 *
 * Partial failure is reported, not swallowed: the caller gets back what was
 * created so it can tear those down rather than leaving an org half-subscribed.
 */
export async function createSubscriptions(
  args: CreateSubscriptionsArgs,
): Promise<{ created: CreatedSubscription[]; errors: { eventType: string; error: string }[] }> {
  if (!args.webhookUrl.startsWith("https://")) {
    throw new Error(
      `Azure DevOps service hooks require an HTTPS endpoint (PUBLIC_BASE_URL is '${args.webhookUrl}'). ` +
        "Basic-auth credentials would otherwise be sent unencrypted, and Azure DevOps rejects the subscription.",
    );
  }

  const created: CreatedSubscription[] = [];
  const errors: { eventType: string; error: string }[] = [];

  for (const eventType of AZDO_EVENT_TYPES) {
    try {
      const body = {
        publisherId: "tfs",
        eventType,
        resourceVersion: "1.0",
        consumerId: "webHooks",
        consumerActionId: "httpRequest",
        publisherInputs: {
          projectId: args.projectId,
          // Work item events reject a `repository` input; PR events use it to
          // avoid waking us for every repo in the team project.
          ...(eventType.startsWith("workitem.")
            ? {}
            : { repository: args.repositoryId }),
        },
        consumerInputs: {
          url: args.webhookUrl,
          // Username is unused by our verifier but Azure DevOps wants the pair.
          basicAuthUsername: "opencara",
          basicAuthPassword: args.webhookSecret,
          // "all" gives us the full resource object; the default trimmed
          // payload omits fields the flow context needs (head/base commits).
          resourceDetailsToSend: "all",
          messagesToSend: "none",
          detailedMessagesToSend: "none",
        },
      };
      const res = await args.client.orgRequest("_apis/hooks/subscriptions", {
        method: "POST",
        body,
      });
      const parsed = SubscriptionSchema.safeParse(res);
      if (parsed.success) {
        created.push({ id: parsed.data.id, eventType });
      } else {
        errors.push({ eventType, error: "subscription response had no id" });
      }
    } catch (err) {
      errors.push({ eventType, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { created, errors };
}

/**
 * Best-effort teardown. Never throws, and never aborts the loop on one failure
 * — a partial teardown leaves exactly the leak this exists to prevent.
 *
 * Failures log at `error`, not `warn`: a subscription we could not delete is
 * effectively permanent (the webhook handler answers 200 for an unmatched repo,
 * so Azure never auto-disables it) and needs a human to remove it from the
 * project's Service Hooks page. Nothing retries.
 */
export async function deleteSubscriptions(
  client: AzureDevopsClient,
  subscriptionIds: string[],
): Promise<void> {
  for (const id of subscriptionIds) {
    try {
      await client.orgRequest(`_apis/hooks/subscriptions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch (err) {
      console.error(
        `[azure-hooks] could not delete subscription ${id} — it will keep delivering; remove it by hand from the Azure DevOps project's Service Hooks page:`,
        err,
      );
    }
  }
}

/**
 * Subscriptions currently pointing at our endpoint. Used to detect the ones
 * Azure DevOps auto-disables after repeated delivery failures — a silent
 * failure mode with no equivalent on the GitHub side.
 */
export async function listSubscriptions(
  client: AzureDevopsClient,
  webhookUrl: string,
): Promise<{ id: string; eventType: string; status: string | null }[]> {
  const raw = await client.orgRequest("_apis/hooks/subscriptions");
  const parsed = SubscriptionListSchema.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.value
    .filter((s) => (s.consumerInputs as { url?: string } | undefined)?.url === webhookUrl)
    .map((s) => ({ id: s.id, eventType: s.eventType, status: s.status ?? null }));
}
