import { and, eq, isNull } from "drizzle-orm";
import type { IssueStateSetCall } from "@opencara/shared";
import type { Db } from "../db/client.js";
import { githubInstallations, issues, projects } from "../db/schema.js";
import type { GithubAppClient } from "../github/app.js";
import type { AgentCallResult } from "./index.js";

/**
 * Apply an `issue.state.set` agent-call: flip an existing issue to
 * open or closed.
 *
 * 1. Scope-check: the issue must belong to the run's project.
 * 2. Load installation, get an Octokit client.
 * 3. PATCH via REST `issues.update` (state + optional state_reason).
 * 4. Eagerly mirror locally; the `issues` webhook will reconcile if this
 *    fails (idempotent upsert).
 */
export async function applyIssueStateSet(
  db: Db,
  projectId: string,
  githubApp: GithubAppClient,
  msg: Pick<IssueStateSetCall, "issueNumber" | "state" | "stateReason">,
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
    await octokit.rest.issues.update({
      owner: project.owner,
      repo: project.name,
      issue_number: msg.issueNumber,
      state: msg.state,
      // undefined (not null) lets GitHub default state_reason on close
      // and leave it untouched on reopen.
      state_reason: msg.stateReason ?? undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `GitHub issue update failed: ${message}` };
  }

  try {
    const now = new Date();
    await db
      .update(issues)
      .set({
        state: msg.state,
        stateReason: msg.stateReason ?? null,
        closedAt: msg.state === "closed" ? (existing.closedAt ?? now) : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.projectId, projectId),
          eq(issues.number, msg.issueNumber),
          isNull(issues.removedAt),
        ),
      );
  } catch (err) {
    console.warn("[issue-state-set] local update failed (webhook will retry)", {
      issueNumber: msg.issueNumber,
      err,
    });
  }

  return { ok: true };
}
