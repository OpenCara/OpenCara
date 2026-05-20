import { and, eq, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import type { IssueCreateCall } from "@opencara/shared";
import type { Db } from "../db/client.js";
import { githubInstallations, issues, projects } from "../db/schema.js";
import type { GithubAppClient } from "../github/app.js";
import type { AgentCallResult } from "./index.js";

/**
 * Apply an `issue.create` agent-call.
 *
 * Same flow as `issueSubissueCreate` minus the parent linkage:
 * 1. Load project + installation, refuse if missing.
 * 2. Get an Octokit client scoped to the project's installation.
 * 3. Create the issue via REST.
 * 4. Eagerly insert into the local `issues` table (webhook will reconcile).
 */
export async function applyIssueCreate(
  db: Db,
  projectId: string,
  githubApp: GithubAppClient,
  msg: Pick<IssueCreateCall, "title" | "bodyMd" | "labels">,
): Promise<AgentCallResult & { issueNumber?: number; nodeId?: string }> {
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

  const octokit = await githubApp.forInstallation(
    installation.githubInstallationId,
  );

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
    console.warn("[issue-create] local insert failed (webhook will retry)", {
      issueNumber: newIssue.number,
      err,
    });
  }

  return { ok: true, issueNumber: newIssue.number, nodeId: newIssue.node_id };
}
