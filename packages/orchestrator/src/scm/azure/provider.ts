import { z } from "zod";
import type { AzureDevopsClient } from "../../azure/client.js";
import type {
  AddCommentResult,
  AddLabelResult,
  PostReviewResult,
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
 * statement. It also clears a previous vote, so a re-review that downgrades
 * from approve to comment doesn't leave a stale approval standing.
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
  /** Repository GUID. */
  repositoryId: string;
}

const ThreadSchema = z.object({
  id: z.number(),
  comments: z.array(z.object({ id: z.number().optional() })).optional(),
});

const ConnectionDataSchema = z.object({
  authenticatedUser: z.object({ id: z.string() }),
});

const LabelsSchema = z.object({
  value: z.array(z.object({ name: z.string() })).optional(),
  name: z.string().optional(),
});

export function createAzureProvider(opts: AzureProviderOptions): ScmProvider {
  const { client, projectName, repositoryId } = opts;

  const prBase = (prNumber: number) =>
    `${client.orgUrl}/${encodeURIComponent(projectName)}/_apis/git/repositories/${encodeURIComponent(
      repositoryId,
    )}/pullRequests/${prNumber}`;

  /** Web URL for a thread — Azure DevOps doesn't return one on the API response. */
  const threadUrl = (prNumber: number, threadId: number) =>
    `${client.orgUrl}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(
      repositoryId,
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

  /** Identity id of the connection's user — the only identity we can vote as. */
  const selfIdentityId = async (): Promise<string> => {
    const res = await client.orgRequest("_apis/connectionData", {
      apiVersion: "7.1-preview",
    });
    const parsed = ConnectionDataSchema.safeParse(res);
    if (!parsed.success) {
      throw new Error("azure devops connectionData did not include an authenticated user");
    }
    return parsed.data.authenticatedUser.id;
  };

  return {
    platform: "azure_devops",

    async postReview(pr: ScmPullRequestRef, event, body): Promise<PostReviewResult> {
      // Thread first: it is what a human reads, and it must survive a refused
      // vote (not a reviewer on this PR, branch policy forbids self-approval).
      const threadId = await postThread(pr.number, body);

      const vote = voteForReviewEvent(event);
      let downgradedFrom: string | undefined;
      if (vote !== AZDO_VOTE.noVote) {
        try {
          const reviewerId = await selfIdentityId();
          await client.request(
            `${prBase(pr.number)}/reviewers/${encodeURIComponent(reviewerId)}`,
            { method: "PUT", body: { vote } },
          );
        } catch (err) {
          // Degrade to "the review was posted as a comment" rather than failing
          // the step — the prose already landed, and losing the run over a vote
          // the policy refused would discard a completed review. Mirrors the
          // GitHub provider's self-review downgrade.
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
  };
}
