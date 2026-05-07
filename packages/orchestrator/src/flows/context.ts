import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { issues } from "../db/schema.js";
import type { GithubAppClient } from "../github/app.js";

export interface PullRequestContext {
  envExtras: Record<string, string>;
  stdin: {
    pr: unknown;
    diff: string;
    previousOutput?: string;
    /** Set on `pull_request_review` events — the reviewer's verdict.
     *  Surfaced to the agent so the review-fix flow can read it as
     *  the next instruction without scraping env vars. */
    review?: { state?: string; body?: string | null; user?: { login?: string } };
  };
}

export interface IssueStatusContext {
  envExtras: Record<string, string>;
  stdin: {
    issue: {
      id: string;
      number: number;
      title: string;
      bodyMd: string | null;
      state: string;
      labels: { name: string; color: string }[];
      assignees: { login: string; id: number }[];
      htmlUrl: string;
    } | null;
    status: { from: string | null; to: string | null };
    project: { number: number | null; nodeId: string | null };
    contentType: string | null;
  };
}

interface GithubInstallationLike {
  githubInstallationId: number;
}

interface ProjectLike {
  id: string;
  owner: string;
  name: string;
}

interface PullRequestPayload {
  pull_request: {
    number: number;
    head: { sha: string; ref?: string };
    base: { sha: string };
  };
  repository: { full_name: string };
  // Present on `pull_request_review` events (the review-fix flow's
  // wake-up signal). When set, surfaced into envExtras so the agent
  // node downstream can read the reviewer's verdict.
  review?: {
    state?: string;
    body?: string | null;
    user?: { login?: string };
  };
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

  const envExtras: Record<string, string> = {
    OPENCARA_REPO: payload.repository.full_name,
    OPENCARA_PR_NUMBER: String(prNumber),
    OPENCARA_PR_HEAD_SHA: payload.pull_request.head.sha,
    OPENCARA_PR_BASE_SHA: payload.pull_request.base.sha,
  };
  if (payload.pull_request.head.ref) {
    envExtras["OPENCARA_PR_HEAD_REF"] = payload.pull_request.head.ref;
  }
  if (payload.review) {
    if (payload.review.state) envExtras["OPENCARA_REVIEW_STATE"] = payload.review.state;
    if (payload.review.body) envExtras["OPENCARA_REVIEW_BODY"] = payload.review.body;
    if (payload.review.user?.login)
      envExtras["OPENCARA_REVIEW_AUTHOR"] = payload.review.user.login;
  }

  return {
    envExtras,
    stdin: { pr: payload.pull_request, diff, review: payload.review },
  };
}

interface ProjectsV2ItemPayload {
  changes?: {
    field_value?: {
      from?: { name?: string } | null;
      to?: { name?: string } | null;
    };
  };
  projects_v2_item?: {
    content_node_id?: string;
    project_node_id?: string;
    content_type?: string;
  };
}

// Build the agent-facing context for a Projects v2 status-change event. The
// issue row itself is looked up locally (populated by the issues webhook /
// backfill) so the agent gets full title + labels + assignees without
// hitting GitHub on the dispatch path. If the issue isn't in the DB yet
// (event arrived before the backfill / the corresponding issues webhook),
// stdin.issue is null but env vars + status info are still provided.
export async function buildIssueStatusContext(
  db: Db,
  project: ProjectLike,
  payload: ProjectsV2ItemPayload,
): Promise<IssueStatusContext> {
  const fv = payload.changes?.field_value;
  const item = payload.projects_v2_item;
  const fromName = fv?.from?.name ?? null;
  const toName = fv?.to?.name ?? null;
  const contentNodeId = item?.content_node_id ?? null;
  const contentType = item?.content_type ?? null;

  let issueRow:
    | (typeof issues.$inferSelect)
    | undefined;
  if (contentNodeId) {
    // Project-scope the lookup: github_node_id index isn't unique, so the
    // same issue could in principle be linked to multiple project rows
    // (today projects.githubRepoId is unique, so this is defensive — but
    // free correctness for future multi-tenant changes).
    issueRow = await db.query.issues.findFirst({
      where: and(eq(issues.githubNodeId, contentNodeId), eq(issues.projectId, project.id)),
    });
  }

  const envExtras: Record<string, string> = {
    OPENCARA_REPO: `${project.owner}/${project.name}`,
    OPENCARA_STATUS_FROM: fromName ?? "",
    OPENCARA_STATUS_TO: toName ?? "",
  };
  if (issueRow) {
    envExtras["OPENCARA_ISSUE_NUMBER"] = String(issueRow.number);
    envExtras["OPENCARA_ISSUE_NODE_ID"] = issueRow.githubNodeId;
  } else if (contentNodeId) {
    envExtras["OPENCARA_ISSUE_NODE_ID"] = contentNodeId;
  }

  return {
    envExtras,
    stdin: {
      issue: issueRow
        ? {
            id: issueRow.id,
            number: issueRow.number,
            title: issueRow.title,
            bodyMd: issueRow.bodyMd,
            state: issueRow.state,
            labels: issueRow.labels,
            assignees: issueRow.assignees,
            htmlUrl: issueRow.htmlUrl,
          }
        : null,
      status: { from: fromName, to: toName },
      project: { number: null, nodeId: item?.project_node_id ?? null },
      contentType,
    },
  };
}
