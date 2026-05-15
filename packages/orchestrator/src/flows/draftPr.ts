import type { Octokit } from "@octokit/rest";

export interface MarkDraftPrReadyByHeadArgs {
  octokit: Octokit;
  owner: string;
  repo: string;
  headBranch: string;
}

export type MarkDraftPrReadyByHeadResult =
  | { kind: "marked-ready"; prNumber: number }
  | { kind: "already-ready"; prNumber: number }
  | { kind: "no-pr" };

interface ListedPullRequest {
  number: number;
  node_id?: string;
  draft?: boolean;
}

export async function markDraftPrReadyByHead(
  args: MarkDraftPrReadyByHeadArgs,
): Promise<MarkDraftPrReadyByHeadResult> {
  const { octokit, owner, repo, headBranch } = args;
  const res = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
    owner,
    repo,
    state: "open",
    head: `${owner}:${headBranch}`,
    per_page: 1,
  });
  const list = res.data as ListedPullRequest[];
  const pr = list.find((item) => typeof item.number === "number");
  if (!pr) return { kind: "no-pr" };
  if (!pr.draft) return { kind: "already-ready", prNumber: pr.number };
  if (!pr.node_id) {
    throw new Error(
      `open PR ${owner}/${repo}#${pr.number} is draft but the list response did not include node_id`,
    );
  }

  await octokit.graphql(
    `mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
        pullRequest {
          id
          isDraft
        }
      }
    }`,
    { pullRequestId: pr.node_id },
  );
  return { kind: "marked-ready", prNumber: pr.number };
}
