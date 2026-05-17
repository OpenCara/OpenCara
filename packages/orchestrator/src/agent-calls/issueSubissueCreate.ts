import { and, eq, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import type { IssueSubissueCreateCall } from "@opencara/shared";
import type { Db } from "../db/client.js";
import { githubInstallations, issues, projects } from "../db/schema.js";
import type { GithubAppClient } from "../github/app.js";
import type { AgentCallResult } from "./index.js";

/**
 * Apply an `issue.subissue.create` agent-call.
 *
 * 1. Load project + parent issue, refuse if parent not found.
 * 2. Get an Octokit client scoped to the project's installation.
 * 3. Create the issue via REST (`octokit.rest.issues.create`).
 * 4. Link it as a sub-issue via the GraphQL `addSubIssue` mutation.
 * 5. Insert the new issue into the local `issues` table eagerly.
 * 6. Return { ok: true, issueNumber, nodeId }.
 */
export async function applyIssueSubissueCreate(
  db: Db,
  projectId: string,
  githubApp: GithubAppClient,
  msg: Pick<IssueSubissueCreateCall, "parentIssueNumber" | "title" | "bodyMd" | "labels">,
): Promise<AgentCallResult & { issueNumber?: number; nodeId?: string }> {
  // 1. Load project and parent issue.
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

  const parentIssue = await db.query.issues.findFirst({
    where: and(
      eq(issues.projectId, projectId),
      eq(issues.number, msg.parentIssueNumber),
      isNull(issues.removedAt),
    ),
  });
  if (!parentIssue) {
    return {
      ok: false,
      reason: `parent issue #${msg.parentIssueNumber} not found in project`,
    };
  }

  // 2. Get installation-scoped Octokit.
  const octokit = await githubApp.forInstallation(
    installation.githubInstallationId,
  );

  // 3. Create the issue via REST.
  let newIssue: { id: number; number: number; node_id: string; html_url: string };
  try {
    const resp = await octokit.rest.issues.create({
      owner: project.owner,
      repo: project.name,
      title: msg.title,
      body: msg.bodyMd,
      labels: msg.labels,
    });
    newIssue = {
      id: resp.data.id,
      number: resp.data.number,
      node_id: resp.data.node_id,
      html_url: resp.data.html_url,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `GitHub issue create failed: ${message}` };
  }

  // 4. Link as sub-issue via GraphQL addSubIssue mutation.
  try {
    await (octokit as unknown as { graphql: (q: string, v: Record<string, unknown>) => Promise<unknown> }).graphql(
      `mutation AddSubIssue($parentId: ID!, $childId: ID!) {
        addSubIssue(input: { issueId: $parentId, subIssueId: $childId }) {
          issue { id }
        }
      }`,
      {
        parentId: parentIssue.githubNodeId,
        childId: newIssue.node_id,
      },
    );
  } catch (err) {
    // Non-fatal: the issue exists; the parent link just failed (e.g. the
    // GraphQL API doesn't support sub-issues on this installation tier).
    // Log and continue — the child issue is still useful even without the link.
    console.warn("[issue-subissue-create] addSubIssue GraphQL failed", {
      projectId,
      parentIssueNumber: msg.parentIssueNumber,
      childIssueNumber: newIssue.number,
      err,
    });
  }

  // 5. Eagerly insert the new issue into the local issues table.
  try {
    await db.insert(issues).values({
      id: ulid(),
      projectId,
      githubIssueId: newIssue.id,
      githubNodeId: newIssue.node_id,
      number: newIssue.number,
      title: msg.title,
      bodyMd: msg.bodyMd,
      state: "open",
      labels: (msg.labels ?? []).map((l) => ({ name: l, color: "" })),
      assignees: [],
      htmlUrl: newIssue.html_url,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (err) {
    // Webhook will backfill; ignore insertion errors (e.g. duplicate on race).
    console.warn("[issue-subissue-create] local insert failed (webhook will retry)", {
      issueNumber: newIssue.number,
      err,
    });
  }

  return { ok: true, issueNumber: newIssue.number, nodeId: newIssue.node_id };
}
