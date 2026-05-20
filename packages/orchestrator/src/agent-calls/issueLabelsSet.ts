import { and, eq, isNull } from "drizzle-orm";
import type { IssueLabelsSetCall } from "@opencara/shared";
import type { Db } from "../db/client.js";
import { githubInstallations, issues, projects } from "../db/schema.js";
import type { GithubAppClient } from "../github/app.js";
import type { AgentCallResult } from "./index.js";

/**
 * Apply an `issue.labels.set` agent-call: replace the full label set on
 * an existing issue. Empty array clears all labels. Replace semantics
 * match GitHub REST `setLabels` — callers must include any existing
 * labels they want to keep.
 *
 * The local mirror uses placeholder color `""` for newly-set labels;
 * the webhook payload carries real colors and reconciles on the next
 * `issues.labeled` / `issues.unlabeled` event.
 */
export async function applyIssueLabelsSet(
  db: Db,
  projectId: string,
  githubApp: GithubAppClient,
  msg: Pick<IssueLabelsSetCall, "issueNumber" | "labels">,
): Promise<AgentCallResult> {
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
    await octokit.rest.issues.setLabels({
      owner: project.owner,
      repo: project.name,
      issue_number: msg.issueNumber,
      labels: msg.labels,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `GitHub setLabels failed: ${message}` };
  }

  try {
    // Preserve known colors for labels still present; fill new names with "".
    const known = new Map(existing.labels.map((l) => [l.name, l.color]));
    const merged = msg.labels.map((name) => ({
      name,
      color: known.get(name) ?? "",
    }));
    await db
      .update(issues)
      .set({ labels: merged, updatedAt: new Date() })
      .where(
        and(
          eq(issues.projectId, projectId),
          eq(issues.number, msg.issueNumber),
          isNull(issues.removedAt),
        ),
      );
  } catch (err) {
    console.warn("[issue-labels-set] local update failed (webhook will retry)", {
      issueNumber: msg.issueNumber,
      err,
    });
  }

  return { ok: true };
}
