import { and, eq, isNull } from "drizzle-orm";
import type { IssueCommentCreateCall } from "@opencara/shared";
import type { Db } from "../db/client.js";
import { githubInstallations, issues, projects } from "../db/schema.js";
import type { GithubAppClient } from "../github/app.js";
import type { AgentCallResult } from "./index.js";

/**
 * Apply an `issue.comment.create` agent-call: post a comment on an
 * existing issue.
 *
 * No local mirror — the schema has no `issue_comments` table and the
 * webhook layer does not backfill `issue_comment` events. The comment
 * lives on GitHub only; the chat UI surfaces it on the next visit.
 */
export async function applyIssueCommentCreate(
  db: Db,
  projectId: string,
  githubApp: GithubAppClient,
  msg: Pick<IssueCommentCreateCall, "issueNumber" | "bodyMd">,
): Promise<AgentCallResult & { commentId?: number; htmlUrl?: string }> {
  const projectRow = await db
    .select({ project: projects, installation: githubInstallations })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.removedAt)))
    .innerJoin(
      githubInstallations,
      eq(projects.installationId, githubInstallations.id),
    )
    .limit(1);
  if (projectRow.length === 0) {
    return { ok: false, reason: "project not found" };
  }
  const { project, installation } = projectRow[0]!;

  const existing = await db.query.issues.findFirst({
    where: and(
      eq(issues.projectId, projectId),
      eq(issues.number, msg.issueNumber),
      isNull(issues.removedAt),
    ),
  });
  if (!existing) {
    return { ok: false, reason: `issue #${msg.issueNumber} not in project` };
  }

  const octokit = await githubApp.forInstallation(
    installation.githubInstallationId,
  );

  try {
    const resp = await octokit.rest.issues.createComment({
      owner: project.owner,
      repo: project.name,
      issue_number: msg.issueNumber,
      body: msg.bodyMd,
    });
    return {
      ok: true,
      commentId: resp.data.id,
      htmlUrl: resp.data.html_url,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `GitHub comment create failed: ${message}` };
  }
}
