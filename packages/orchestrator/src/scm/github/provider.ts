import type { Octokit } from "@octokit/rest";
import { isSelfReviewError } from "../../github/errors.js";
import type {
  AddCommentResult,
  AddLabelResult,
  PostReviewResult,
  PullRequestState,
  ScmProvider,
  ScmPullRequestRef,
  ScmReviewEvent,
} from "../types.js";

export interface GithubProviderOptions {
  /** Authenticated as the installation that owns the repo. */
  octokit: Octokit;
  owner: string;
  repo: string;
}

/**
 * GitHub implementation of the action surface.
 *
 * This is a lift of the logic that used to live inline in
 * `flows/nodeRunners.ts`'s `actionRunner`, moved behind `ScmProvider` without
 * behavioural change — including the self-review downgrade below, which is
 * load-bearing for single-account setups where OpenCara both opens and reviews
 * the PR.
 */
export function createGithubProvider(opts: GithubProviderOptions): ScmProvider {
  const { octokit, owner, repo } = opts;

  const submitReview = (pr: ScmPullRequestRef, event: ScmReviewEvent, body: string) =>
    octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      owner,
      repo,
      pull_number: pr.number,
      body: body || "_(no review body)_",
      event,
      commit_id: pr.headSha,
    });

  return {
    platform: "github",

    async postReview(pr, event, body): Promise<PostReviewResult> {
      let res;
      let downgradedFrom: string | null = null;
      try {
        res = await submitReview(pr, event, body);
      } catch (err) {
        // GitHub forbids APPROVE / REQUEST_CHANGES on a PR opened by the same
        // identity (HTTP 422). When the App installation backing post_review
        // also opened the PR — common in single-account setups where opencara
        // is both the implementer and the reviewer — fall back to a
        // COMMENT-typed review and embed the original verdict line in the body
        // so downstream pr-review-fix can still read intent (see
        // flows/context.ts resolveReviewStateFromBody).
        if (!isSelfReviewError(err, event)) throw err;
        const verdictLabel = event === "REQUEST_CHANGES" ? "Request changes" : "Approve";
        const verdictToken = event === "REQUEST_CHANGES" ? "request_changes" : "approve";
        const downgradedBody = [
          `_Downgraded to "Commented" — GitHub forbids "${verdictLabel}" on a PR you opened. Verdict preserved below for review-fix flows._`,
          "",
          `verdict: ${verdictToken}`,
          "",
          body,
        ]
          .join("\n")
          .trim();
        try {
          res = await submitReview(pr, "COMMENT", downgradedBody);
        } catch (retryErr) {
          // Surface both errors so operators don't lose the original 422
          // context when the retry fails for an unrelated reason (transient
          // 5xx, PR closed mid-run, etc.).
          throw new Error(
            `post_review fallback to COMMENT failed after ${event} self-review 422: ${String(
              (retryErr as Error).message ?? retryErr,
            )} (original error: ${String((err as Error).message ?? err)})`,
            { cause: retryErr },
          );
        }
        downgradedFrom = event;
        console.warn(
          `[post_review] self-review on ${owner}/${repo}#${pr.number} downgraded ${event} -> COMMENT`,
        );
      }
      return {
        reviewId: res.data.id,
        htmlUrl: res.data.html_url,
        ...(downgradedFrom ? { downgradedFrom } : {}),
      };
    },

    async addComment(issueNumber, body): Promise<AddCommentResult> {
      const res = await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { owner, repo, issue_number: issueNumber, body: body || "_(no body)_" },
      );
      return { commentId: res.data.id, htmlUrl: res.data.html_url };
    },

    async addLabel(issueNumber, labels): Promise<AddLabelResult> {
      const res = await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
        { owner, repo, issue_number: issueNumber, labels },
      );
      return { labels: res.data.map((l) => l.name) };
    },

    async getPullRequestState(prNumber): Promise<PullRequestState> {
      const res = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: prNumber,
      });
      return {
        state: res.data.state === "open" ? "open" : "closed",
        merged: res.data.merged === true,
        labels: (res.data.labels ?? [])
          .map((l) => l.name)
          .filter((n): n is string => typeof n === "string"),
      };
    },
  };
}
