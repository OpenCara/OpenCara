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
    // Only `id` is load-bearing (it resolves the project). Everything else is
    // display, and a trimmed payload variant must not cause the whole delivery
    // to be dropped.
    name: z.string().optional(),
    project: z.object({ id: z.string(), name: z.string().optional() }).optional(),
  }),
});

/**
 * The PR-comment event's `resource` IS the comment — there is no `comment`
 * wrapper and no pull request object anywhere in the payload. The only route
 * back to the PR is `_links`, whose `self.href` has the form:
 *
 *   https://dev.azure.com/{org}/_apis/git/repositories/{repoGuid}/pullRequests/{id}/threads/{t}/comments/{c}
 *
 * Verified against a live delivery; Microsoft's published sample is truncated
 * before this point, which is what two earlier guesses got wrong.
 */
const CommentEventResourceSchema = z.object({
  id: z.number().optional(),
  content: z.string().optional(),
  commentType: z.string().optional(),
  author: z
    .object({ displayName: z.string().optional(), uniqueName: z.string().optional() })
    .optional(),
  _links: z
    .object({
      self: z.object({ href: z.string() }).optional(),
      repository: z.object({ href: z.string() }).optional(),
    })
    .optional(),
});

/** Pull the repository GUID and PR number out of a comment's self link. */
export function idsFromCommentLink(
  href: string | undefined,
): { repositoryId: string; pullRequestId: number } | null {
  if (!href) return null;
  const m = /\/repositories\/([0-9a-fA-F-]{36})\/pullRequests\/(\d+)\b/.exec(href);
  if (!m || !m[1] || !m[2]) return null;
  const n = Number.parseInt(m[2], 10);
  return Number.isFinite(n) ? { repositoryId: m[1], pullRequestId: n } : null;
}

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
    // The live payload puts the comment directly on `resource`, with no pull
    // request object at all — so the PR is identified from `_links` and its
    // details are fetched later, exactly as GitHub's `issue_comment` path does.
    // The older wrapped/flat shapes are still accepted in case Azure DevOps
    // varies by resourceVersion.
    const flat = CommentEventResourceSchema.safeParse(resource);
    const ids = flat.success ? idsFromCommentLink(flat.data._links?.self?.href) : null;
    if (flat.success && ids) {
      return {
        deliveryId,
        type: "issue_comment",
        repositoryId: ids.repositoryId,
        projectId: projectIdFromRepositoryLink(flat.data._links?.repository?.href),
        payload: {
          action: "created",
          // `issue.pull_request` is the marker the trigger checks to confirm a
          // comment is on a PR rather than a plain issue.
          issue: { number: ids.pullRequestId, pull_request: { url: null } },
          comment: {
            id: flat.data.id ?? null,
            body: flat.data.content ?? "",
            user: { login: authorLogin(flat.data.author) },
            html_url: null,
          },
          repository: { id: ids.repositoryId, name: "", full_name: "" },
          // No pull_request key: the flow engine fetches it (buildAzurePull
          // RequestContext), because this payload simply does not carry one.
        },
      };
    }

    const parsed = CommentResourceSchema.safeParse(resource);
    const prCandidate =
      (resource as { pullRequest?: unknown } | null)?.pullRequest ?? resource;
    const prParsed = PullRequestResourceSchema.safeParse(prCandidate);
    if (!parsed.success && !prParsed.success) return null;
    const pr = parsed.success ? parsed.data.pullRequest : prParsed.data!;
    const commentRaw =
      (resource as { comment?: { id?: number; content?: string; author?: unknown } } | null)
        ?.comment ?? {};
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
          id: commentRaw.id ?? null,
          body: commentRaw.content ?? "",
          user: {
            login: authorLogin(
              commentRaw.author as
                | { displayName?: string; uniqueName?: string }
                | undefined,
            ),
          },
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
 *
 * KNOWN GAP — nothing here ever produces `pull_request_review`, so the
 * `scm.pull_request_review` trigger (the review→fix half of
 * `development-lifecycle`) cannot fire on Azure DevOps. There is no
 * reviewer-vote service hook event to subscribe to, and a vote arrives as the
 * same `git.pullrequest.updated` as a push, with no "what changed" marker to
 * tell them apart. A lossy proxy — treat an update carrying a non-zero reviewer
 * vote as a review — would re-fire on every later update to the same PR, so it
 * needs dedup work first. Documented in README + ROADMAP; the
 * "no Azure DevOps event yields pull_request_review" suite in
 * azure/__tests__/webhooks.test.ts is the tripwire that fails when this is
 * implemented (delete it and the docs together).
 */
function prAction(eventType: string, status: string | undefined): string {
  if (eventType === "git.pullrequest.created") return "opened";
  if (status === "completed" || status === "abandoned") return "closed";
  return "synchronize";
}

export function pullRequestPayload(
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
      name: pr.repository.name ?? "",
      full_name: [projectName, pr.repository.name].filter(Boolean).join("/") || pr.repository.id,
    },
  };
}

/** Team project GUID from a comment's repository link, when present. */
function projectIdFromRepositoryLink(href: string | undefined): string | null {
  if (!href) return null;
  const m = /dev\.azure\.com\/[^/]+\/([0-9a-fA-F-]{36})\/_apis\/git\//.exec(href);
  return m?.[1] ?? null;
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
