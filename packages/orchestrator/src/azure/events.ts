import { z } from "zod";

/**
 * Normalize Azure DevOps service hook payloads into the event shape the flow
 * engine already understands.
 *
 * The engine's trigger matching, PR context and env injection were all written
 * against GitHub webhook payloads. Rather than teach every one of them a second
 * shape, service hook payloads are translated here into the same
 * `{ type, action, pull_request, repository, ... }` structure. The flow trigger
 * kinds are already platform-neutral (`scm.pull_request` and friends), so a
 * translated event drives the identical code path.
 *
 * This is a lossy, deliberate mapping — only the fields the engine reads are
 * populated. It is not an attempt at a general Azure-DevOps-to-GitHub adapter.
 */

/** Azure DevOps PR status values. */
const PrStatus = z.enum(["active", "abandoned", "completed", "notSet"]);

const PullRequestResourceSchema = z.object({
  pullRequestId: z.number(),
  status: PrStatus.optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  sourceRefName: z.string().optional(),
  targetRefName: z.string().optional(),
  isDraft: z.boolean().optional(),
  mergeStatus: z.string().optional(),
  lastMergeSourceCommit: z.object({ commitId: z.string() }).optional(),
  lastMergeTargetCommit: z.object({ commitId: z.string() }).optional(),
  createdBy: z
    .object({ displayName: z.string().optional(), uniqueName: z.string().optional() })
    .optional(),
  repository: z.object({
    id: z.string(),
    name: z.string(),
    project: z.object({ id: z.string(), name: z.string() }).optional(),
  }),
});

const CommentResourceSchema = z.object({
  comment: z.object({
    id: z.number().optional(),
    content: z.string().optional(),
    author: z
      .object({ displayName: z.string().optional(), uniqueName: z.string().optional() })
      .optional(),
  }),
  pullRequest: PullRequestResourceSchema,
});

const WorkItemResourceSchema = z.object({
  id: z.number().optional(),
  workItemId: z.number().optional(),
  rev: z.number().optional(),
  fields: z.record(z.unknown()).optional(),
  revision: z.object({ fields: z.record(z.unknown()).optional() }).optional(),
});

const EnvelopeSchema = z.object({
  id: z.string().optional(),
  eventType: z.string(),
  resource: z.unknown(),
});

export interface NormalizedAzureEvent {
  /** Delivery id for dedup — maps to `platform_events.delivery_id`. */
  deliveryId: string | null;
  /** Engine-facing event type: "pull_request" | "issue_comment" | "work_item". */
  type: string;
  /** Repository GUID, used to resolve the project. Null for work item events. */
  repositoryId: string | null;
  /** Team project GUID — how work item events resolve to a project. */
  projectId: string | null;
  /** GitHub-shaped payload the flow engine consumes. */
  payload: Record<string, unknown>;
}

/**
 * Translate one service hook delivery. Returns null for event types we don't
 * subscribe to or can't map — the caller records the raw delivery and stops.
 */
export function normalizeAzureEvent(raw: unknown): NormalizedAzureEvent | null {
  const envelope = EnvelopeSchema.safeParse(raw);
  if (!envelope.success) return null;
  const { eventType, resource } = envelope.data;
  const deliveryId = envelope.data.id ?? null;

  if (eventType === "git.pullrequest.created" || eventType === "git.pullrequest.updated") {
    const pr = PullRequestResourceSchema.safeParse(resource);
    if (!pr.success) return null;
    return {
      deliveryId,
      type: "pull_request",
      repositoryId: pr.data.repository.id,
      projectId: pr.data.repository.project?.id ?? null,
      payload: {
        action: prAction(eventType, pr.data.status),
        ...pullRequestPayload(pr.data),
      },
    };
  }

  if (eventType === "ms.vss-code.git-pullrequest-comment-event") {
    const parsed = CommentResourceSchema.safeParse(resource);
    if (!parsed.success) return null;
    const pr = parsed.data.pullRequest;
    return {
      deliveryId,
      type: "issue_comment",
      repositoryId: pr.repository.id,
      projectId: pr.repository.project?.id ?? null,
      payload: {
        action: "created",
        // The engine's comment path checks `issue.pull_request` to confirm the
        // comment is on a PR rather than a plain issue. On Azure DevOps this
        // event only ever fires for pull requests, so the marker is always set.
        issue: { number: pr.pullRequestId, pull_request: { url: null } },
        comment: {
          id: parsed.data.comment.id ?? null,
          body: parsed.data.comment.content ?? "",
          user: { login: authorLogin(parsed.data.comment.author) },
          html_url: null,
        },
        ...pullRequestPayload(pr),
      },
    };
  }

  if (eventType === "workitem.created" || eventType === "workitem.updated") {
    const wi = WorkItemResourceSchema.safeParse(resource);
    if (!wi.success) return null;
    const id = wi.data.id ?? wi.data.workItemId ?? null;
    // `fields` on an update is a map of {oldValue,newValue}; on a create it is
    // the plain field map. Both are passed through untouched — the board
    // trigger reads the old/new pair and the mirror reads current values.
    return {
      deliveryId,
      type: "work_item",
      repositoryId: null,
      projectId: projectIdFromWorkItem(wi.data),
      payload: {
        action: eventType === "workitem.created" ? "created" : "updated",
        work_item: { id, fields: wi.data.fields ?? {}, revision: wi.data.revision ?? null },
      },
    };
  }

  return null;
}

/**
 * Map an Azure DevOps PR event onto the GitHub action vocabulary the trigger
 * filters use.
 *
 * Azure DevOps has no distinct "synchronize" (new commits pushed) event — a
 * push to the source branch arrives as `git.pullrequest.updated`, the same
 * event as a title edit. Mapping updates to "synchronize" is the behaviour that
 * matters: it is what re-runs a review when the author pushes a fix. The cost
 * is that a metadata-only edit also re-triggers; flows that care can filter on
 * the commit sha, which the engine dedups on.
 */
function prAction(eventType: string, status: string | undefined): string {
  if (eventType === "git.pullrequest.created") return "opened";
  if (status === "completed" || status === "abandoned") return "closed";
  return "synchronize";
}

function pullRequestPayload(
  pr: z.infer<typeof PullRequestResourceSchema>,
): Record<string, unknown> {
  const projectName = pr.repository.project?.name ?? "";
  return {
    pull_request: {
      number: pr.pullRequestId,
      title: pr.title ?? "",
      body: pr.description ?? "",
      draft: pr.isDraft ?? false,
      state: pr.status === "active" ? "open" : "closed",
      merged: pr.status === "completed",
      head: {
        ref: shortRef(pr.sourceRefName),
        sha: pr.lastMergeSourceCommit?.commitId ?? "",
      },
      base: {
        ref: shortRef(pr.targetRefName),
        sha: pr.lastMergeTargetCommit?.commitId ?? "",
      },
      user: { login: authorLogin(pr.createdBy) },
      // Azure DevOps PR labels are a separate API call; the engine tolerates an
      // empty list (label filters simply never match), which is the honest
      // representation of "not fetched" here.
      labels: [],
    },
    repository: {
      id: pr.repository.id,
      name: pr.repository.name,
      full_name: projectName ? `${projectName}/${pr.repository.name}` : pr.repository.name,
    },
  };
}

/** "refs/heads/feature/x" → "feature/x". */
function shortRef(ref: string | undefined): string {
  return ref ? ref.replace(/^refs\/heads\//, "") : "";
}

function authorLogin(
  author: { displayName?: string | undefined; uniqueName?: string | undefined } | undefined,
): string {
  return author?.uniqueName ?? author?.displayName ?? "unknown";
}

/**
 * Work item payloads don't carry the project GUID at a fixed path — it appears
 * under `System.TeamProject` as a name, or on the revision. Returns null when
 * absent; the caller then resolves the project by subscription instead.
 */
function projectIdFromWorkItem(wi: z.infer<typeof WorkItemResourceSchema>): string | null {
  const fields = wi.fields ?? wi.revision?.fields ?? {};
  const raw = fields["System.TeamProject"];
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "newValue" in raw) {
    const nv = (raw as { newValue?: unknown }).newValue;
    if (typeof nv === "string") return nv;
  }
  return null;
}
