import type { GithubAppClient } from "../github/app.js";

export interface PullRequestContext {
  envExtras: Record<string, string>;
  stdin: {
    pr: unknown;
    diff: string;
    previousOutput?: string;
  };
}

interface GithubInstallationLike {
  githubInstallationId: number;
}

interface ProjectLike {
  owner: string;
  name: string;
}

interface PullRequestPayload {
  pull_request: {
    number: number;
    head: { sha: string };
    base: { sha: string };
  };
  repository: { full_name: string };
}

export async function buildPullRequestContext(
  app: GithubAppClient,
  installation: GithubInstallationLike,
  project: ProjectLike,
  payload: PullRequestPayload,
): Promise<PullRequestContext> {
  const oct = await app.forInstallation(installation.githubInstallationId);
  const prNumber = payload.pull_request.number;

  const diffRes = await oct.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner: project.owner,
    repo: project.name,
    pull_number: prNumber,
    mediaType: { format: "diff" },
  });
  const diff = String(diffRes.data);

  return {
    envExtras: {
      OPENCARA_REPO: payload.repository.full_name,
      OPENCARA_PR_NUMBER: String(prNumber),
      OPENCARA_PR_HEAD_SHA: payload.pull_request.head.sha,
      OPENCARA_PR_BASE_SHA: payload.pull_request.base.sha,
    },
    stdin: { pr: payload.pull_request, diff },
  };
}
