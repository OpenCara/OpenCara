import { z } from "zod";
import { AzureDevopsAuthError, type AzureDevopsClient } from "../../azure/client.js";
import type {
  AddCommentResult,
  AddLabelResult,
  PostReviewResult,
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

const PullRequestStatusSchema = z.object({
  status: z.enum(["active", "completed", "abandoned", "notSet", "all"]).or(z.string()),
});
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
   * Web URL for a thread — Azure DevOps doesn't return one on the API response.
   * Built from the repo NAME (the canonical browsable form), not the GUID the
   * REST calls above use.
   */
  const threadUrl = (prNumber: number, threadId: number) =>
    `${client.orgUrl}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(
      repositoryName,
    )}/pullrequest/${prNumber}?discussionId=${threadId}`;

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
  };
}
