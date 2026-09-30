import { z } from "zod";
import type { ReviewMapFileStatus } from "@opencara/shared";
import {
  AzureDevopsApiError,
  AzureDevopsAuthError,
  type AzureDevopsClient,
} from "../../azure/client.js";
import type {
  AddCommentResult,
  AddLabelResult,
  PostReviewResult,
  PullRequestFile,
  PullRequestFileListing,
  PullRequestState,
  ScmProvider,
  ScmPullRequestRef,
  ScmReviewEvent,
} from "../types.js";

/**
 * Azure DevOps implementation of the action surface.
 *
 * ## Reviews are two things here, not one
 *
 * GitHub's "submit review" is a single call carrying both a verdict and a body.
 * Azure DevOps splits them:
 *
 *   - the prose is a **comment thread** on the PR;
 *   - the verdict is a **reviewer vote** — a numeric score on the reviewer
 *     entry, which is what actually gates completion.
 *
 * So `postReview` does both, in that order: the thread first, because it is the
 * part a human reads and the part we must not lose if the vote is refused
 * (Azure DevOps rejects a vote from an identity that is not a reviewer on the
 * PR, and self-votes behave differently across policy configurations).
 *
 * ## Identity
 *
 * Votes are attributed to the connection's user, not a bot. There is no
 * app-identity equivalent to GitHub's `opencara[bot]`, which is why review→fix
 * loops must key on the connecting user rather than a bot login.
 */

/**
 * Azure DevOps reviewer vote scale. Only three of the five values are reachable
 * from OpenCara's verdict vocabulary; the middle two ("approved with
 * suggestions" = 5, "waiting for author" = -5) have no GitHub counterpart.
 */
export const AZDO_VOTE = {
  approved: 10,
  approvedWithSuggestions: 5,
  noVote: 0,
  waitingForAuthor: -5,
  rejected: -10,
} as const;

/**
 * Map a review verdict onto a vote.
 *
 * COMMENT maps to `noVote` rather than being skipped: posting a commented
 * review on GitHub explicitly does not endorse or block, and 0 is exactly that
 * statement. `postReview` writes this value like any other — that is what
 * clears a previous vote, so a re-review downgrading from approve to comment
 * doesn't leave a stale approval standing for a branch policy to honour.
 */
export function voteForReviewEvent(event: ScmReviewEvent): number {
  switch (event) {
    case "APPROVE":
      return AZDO_VOTE.approved;
    case "REQUEST_CHANGES":
      return AZDO_VOTE.rejected;
    case "COMMENT":
      return AZDO_VOTE.noVote;
  }
}

export interface AzureProviderOptions {
  client: AzureDevopsClient;
  /** Team project name or GUID — the path segment above the repo. */
  projectName: string;
  /** Repository GUID — what the REST API addresses the repo by. */
  repositoryId: string;
  /**
   * Repository NAME, used only to build browsable URLs. Azure DevOps redirects
   * a `_git/<guid>` URL, but the canonical form uses the name, and that is what
   * ends up in `flow_run_steps.output` for a human to click.
   */
  repositoryName: string;
}

const ThreadSchema = z.object({
  id: z.number(),
  comments: z.array(z.object({ id: z.number().optional() })).optional(),
});

const ConnectionDataSchema = z.object({
  authenticatedUser: z.object({ id: z.string() }),
});

// Azure reports `active` | `completed` (merged) | `abandoned`; anything else
// is treated as closed-not-merged by the caller, so a plain string suffices.
const PullRequestStatusSchema = z.object({ status: z.string() });

/** Iteration list on a PR: `{value: [{id, ...}]}`. */
const IterationsSchema = z.object({
  value: z.array(z.object({ id: z.number() })),
});

/**
 * One entry of `GET pullRequests/{n}/iterations/{id}/changes`. Azure's
 * GitChange carries the rename's OLD path in `sourceServerItem` (with
 * `originalPath` as the TFVC-era fallback), not on `item`.
 */
const IterationChangesSchema = z.object({
  changeEntries: z
    .array(
      z.object({
        changeType: z.string().optional().default(""),
        sourceServerItem: z.string().optional(),
        originalPath: z.string().optional(),
        // Normally `{objectId, path, isFolder}`; GitChange's `item` is
        // documented as able to arrive as a bare string too. Accept both so
        // one odd entry can't fail the whole listing — the loop below skips
        // anything without a path.
        item: z
          .union([
            z.object({
              path: z.string().optional(),
              isFolder: z.boolean().optional(),
            }),
            z.string(),
          ])
          .optional(),
      }),
    )
    .optional()
    .default([]),
  // Present when the server truncated the page at $top. Optional because the
  // field isn't guaranteed across api-versions; the overfetch check below
  // covers its absence.
  hasMore: z.boolean().optional(),
});

/** `GET .../items?...&includeContent=true` returns `{content: "..."}` for files. */
const ItemContentSchema = z.object({ content: z.string() });

/**
 * Map Azure's `changeType` onto the review-map status vocabulary.
 *
 * The field is documented as a comma list of GitChangeType flags
 * ("rename,edit" for a renamed-and-edited file), so match on split tokens,
 * NOT raw substrings — a substring check for "delete" would misfire on the
 * real token "undelete". Priority: a rename stays "renamed" even when the
 * entry also carries "edit"; delete and add are mutually exclusive; anything
 * else (edit, encoding, merge…) is a content change → "modified".
 */
function statusForChangeType(changeType: string): ReviewMapFileStatus {
  const kinds = new Set(changeType.split(",").map((t) => t.trim()));
  if (kinds.has("rename") || kinds.has("sourceRename") || kinds.has("targetRename")) {
    return "renamed";
  }
  if (kinds.has("delete")) return "removed";
  if (kinds.has("add")) return "added";
  return "modified";
}

/** Azure paths arrive repo-rooted with a leading `/`; the shared vocabulary wants "src/a.ts". */
function stripLeadingSlash(path: string): string {
  return path.replace(/^\//, "");
}
const LabelListSchema = z.object({
  value: z.array(z.object({ name: z.string().optional() })).default([]),
});
const LabelsSchema = z.object({
  value: z.array(z.object({ name: z.string() })).optional(),
  name: z.string().optional(),
});

/**
 * Should a failed reviewer-vote call fail the step instead of degrading to
 * "posted as a comment"?
 *
 * The downgrade exists for ONE situation: Azure DevOps refused the vote itself
 * (branch policy forbids self-approval, we aren't a reviewer on the PR). Those
 * are 4xx and genuinely unfixable by retrying, so swallowing them preserves the
 * review the agent already wrote.
 *
 * Everything else must surface. In particular a dead connection —
 * `AzureDevopsAuthError`, raised when the refresh token is gone or rejected —
 * would otherwise make EVERY subsequent review "succeed" with `downgradedFrom`
 * set, hiding a state that needs the user to reconnect the organization. A
 * transient 5xx/429 is likewise a step that should fail and be rerun, not a
 * verdict silently dropped.
 */
function isUnrecoverableVoteError(err: unknown): boolean {
  if (err instanceof AzureDevopsAuthError) return true;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" && (status >= 500 || status === 429);
}

export function createAzureProvider(opts: AzureProviderOptions): ScmProvider {
  const { client, projectName, repositoryId, repositoryName } = opts;

  const prBase = (prNumber: number) =>
    `${client.orgUrl}/${encodeURIComponent(projectName)}/_apis/git/repositories/${encodeURIComponent(
      repositoryId,
    )}/pullRequests/${prNumber}`;

  /**
   * Web URL for the PR itself — Azure DevOps doesn't return one on the API
   * response. Built from the repo NAME (the canonical browsable form), not the
   * GUID the REST calls above use.
   */
  const prWebUrl = (prNumber: number) =>
    `${client.orgUrl}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(
      repositoryName,
    )}/pullrequest/${prNumber}`;

  const threadUrl = (prNumber: number, threadId: number) =>
    `${prWebUrl(prNumber)}?discussionId=${threadId}`;

  const postThread = async (prNumber: number, content: string): Promise<number> => {
    const res = await client.request(`${prBase(prNumber)}/threads`, {
      method: "POST",
      body: {
        comments: [{ parentCommentId: 0, content: content || "_(no review body)_", commentType: "text" }],
        // "active" surfaces the thread as needing attention; "closed" would
        // hide a review behind a resolved marker.
        status: "active",
      },
    });
    const parsed = ThreadSchema.safeParse(res);
    if (!parsed.success) throw new Error("azure devops thread response had no id");
    return parsed.data.id;
  };

  /**
   * Identity id of the connection's user — the only identity we can vote as.
   * Memoized per provider instance: every review now issues a vote (including
   * the explicit 0 that clears a stale one), and the id cannot change for a
   * fixed connection within a step.
   */
  let selfIdentityPromise: Promise<string> | null = null;
  const selfIdentityId = (): Promise<string> => {
    selfIdentityPromise ??= (async () => {
      const res = await client.orgRequest("_apis/connectionData", {
        apiVersion: "7.1-preview",
      });
      const parsed = ConnectionDataSchema.safeParse(res);
      if (!parsed.success) {
        throw new Error("azure devops connectionData did not include an authenticated user");
      }
      return parsed.data.authenticatedUser.id;
    })();
    return selfIdentityPromise;
  };

  return {
    platform: "azure_devops",

    async postReview(pr: ScmPullRequestRef, event, body): Promise<PostReviewResult> {
      // Thread first: it is what a human reads, and it must survive a refused
      // vote (not a reviewer on this PR, branch policy forbids self-approval).
      const threadId = await postThread(pr.number, body);

      // The vote is ALWAYS written, including the explicit 0 for a COMMENT.
      // Skipping the call for 0 would leave a prior approval standing: a
      // reviewer agent approves, a later run posts a COMMENT raising a concern,
      // and Azure DevOps still shows "Approved" — which, depending on branch
      // policy, can satisfy a required-reviewer rule and let the PR merge with
      // the concern outstanding. Clearing costs one memoized identity lookup.
      const vote = voteForReviewEvent(event);
      let downgradedFrom: string | undefined;
      try {
        const reviewerId = await selfIdentityId();
        await client.request(
          `${prBase(pr.number)}/reviewers/${encodeURIComponent(reviewerId)}`,
          { method: "PUT", body: { vote } },
        );
      } catch (err) {
        // A broken connection or a transient outage must fail the step; only
        // an actual refusal of the vote degrades. Without this the first
        // category masquerades as the second forever.
        if (isUnrecoverableVoteError(err)) throw err;
        if (vote === AZDO_VOTE.noVote) {
          // Nothing was being asserted, so there is no verdict to downgrade —
          // e.g. we were never a reviewer on this PR and there is no stale vote
          // to clear. Worth a line, not a status change.
          console.warn(
            `[post_review] azure could not clear the reviewer vote on PR #${pr.number}; a prior vote may still stand:`,
            err instanceof Error ? err.message : err,
          );
        } else {
          // Degrade to "the review was posted as a comment" rather than failing
          // the step — the prose already landed, and losing the run over a vote
          // the policy refused would discard a completed review. Narrower than
          // it looks: the GitHub provider downgrades only on its specific
          // self-review 422, and this is the Azure equivalent of that check.
          downgradedFrom = event;
          console.warn(
            `[post_review] azure vote ${vote} on PR #${pr.number} refused; review posted as a comment:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      return {
        reviewId: threadId,
        htmlUrl: threadUrl(pr.number, threadId),
        ...(downgradedFrom ? { downgradedFrom } : {}),
      };
    },

    async addComment(issueNumber, body): Promise<AddCommentResult> {
      const threadId = await postThread(issueNumber, body || "_(no body)_");
      return { commentId: threadId, htmlUrl: threadUrl(issueNumber, threadId) };
    },

    async addLabel(issueNumber, labels): Promise<AddLabelResult> {
      // Azure DevOps takes one label per call, unlike GitHub's array.
      const applied: string[] = [];
      for (const name of labels) {
        const res = await client.request(`${prBase(issueNumber)}/labels`, {
          method: "POST",
          body: { name },
        });
        const parsed = LabelsSchema.safeParse(res);
        applied.push(parsed.success && parsed.data.name ? parsed.data.name : name);
      }
      return { labels: applied };
    },

    async getPullRequestState(prNumber): Promise<PullRequestState> {
      const [prRes, labelsRes] = await Promise.all([
        client.request(prBase(prNumber), { method: "GET" }),
        client.request(`${prBase(prNumber)}/labels`, { method: "GET" }),
      ]);
      const pr = PullRequestStatusSchema.safeParse(prRes);
      if (!pr.success) throw new Error("azure devops pull request response had no status");
      const labels = LabelListSchema.safeParse(labelsRes);
      return {
        // Azure statuses: active | completed (merged) | abandoned.
        state: pr.data.status === "active" ? "open" : "closed",
        merged: pr.data.status === "completed",
        labels: labels.success
          ? labels.data.value.map((l) => l.name).filter((n): n is string => typeof n === "string")
          : [],
      };
    },

    /**
     * PR files via the iterations API: `pullRequests/{n}/iterations` → the
     * LAST iteration (pushes append; ids only grow) → `/changes`. Azure gives
     * no per-file line counts, so additions/deletions stay 0 — the map uses
     * them only for display and edge weight, not correctness.
     */
    async listPullRequestFiles(pr, opts): Promise<PullRequestFileListing> {
      const iterationsRes = await client.request(`${prBase(pr.number)}/iterations`, {
        method: "GET",
      });
      const iterations = IterationsSchema.safeParse(iterationsRes);
      if (!iterations.success || iterations.data.value.length === 0) {
        throw new Error("azure devops pull request had no iterations to list changes for");
      }
      const iterationId = Math.max(...iterations.data.value.map((i) => i.id));

      // Fetch one past the cap so "there was more" is observable rather than
      // inferred from a hasMore flag the api-version may not return.
      const changesRes = await client.request(
        `${prBase(pr.number)}/iterations/${iterationId}/changes?$top=${opts.maxFiles + 1}`,
        { method: "GET" },
      );
      const changes = IterationChangesSchema.safeParse(changesRes);
      if (!changes.success) {
        throw new Error("azure devops pull request changes response was malformed");
      }

      const entries = changes.data.changeEntries;
      const truncated = entries.length > opts.maxFiles || changes.data.hasMore === true;
      const files: PullRequestFile[] = [];
      for (const entry of entries) {
        if (files.length >= opts.maxFiles) break;
        const item = entry.item;
        // Folder entries exist in the change list but aren't files; entries
        // without a path (a bare-string `item`, the PR root itself) carry
        // nothing to map.
        if (typeof item !== "object" || item === null || item.isFolder || !item.path) continue;
        const status = statusForChangeType(entry.changeType);
        // For a rename, Azure reports the old path on the ENTRY
        // (`sourceServerItem`, `originalPath` as fallback) — `item.path` is
        // the NEW path.
        const previousPath =
          status === "renamed"
            ? (entry.sourceServerItem ?? entry.originalPath)?.replace(/^\//, "")
            : undefined;
        files.push({
          path: stripLeadingSlash(item.path),
          ...(previousPath ? { previousPath } : {}),
          status,
          additions: 0,
          deletions: 0,
          // diffUrl left unset: the Azure files view has no reliable
          // per-file anchor to deep-link to.
        });
      }
      return { files, prUrl: prWebUrl(pr.number), truncated };
    },

    /**
     * File contents at a commit via the items endpoint. `path` arrives
     * WITHOUT the leading slash the API expects, and goes in the query string
     * — `client.request` re-parses the URL, so interpolating it into the path
     * segment would mangle `/` and spaces.
     */
    async readFileAtRef(path, ref): Promise<string | null> {
      const apiPath = path.startsWith("/") ? path : `/${path}`;
      const url =
        `${client.orgUrl}/${encodeURIComponent(projectName)}/_apis/git/repositories/` +
        `${encodeURIComponent(repositoryId)}/items` +
        `?path=${encodeURIComponent(apiPath)}` +
        `&versionDescriptor.version=${encodeURIComponent(ref)}` +
        `&versionDescriptor.versionType=commit` +
        `&includeContent=true`;
      try {
        const res = await client.request(url, { method: "GET" });
        const parsed = ItemContentSchema.safeParse(res);
        // A 200 without `content` means the path resolved to a folder or a
        // file Azure won't inline — nothing readable, which is not an error.
        return parsed.success ? parsed.data.content : null;
      } catch (err) {
        // The file not existing at that ref (renamed, deleted on head, bad
        // sha) is an expected miss, not a failure.
        if (err instanceof AzureDevopsApiError && err.status === 404) return null;
        throw err;
      }
    },
  };
}
