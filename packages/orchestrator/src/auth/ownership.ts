import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { azureDevopsConnections, githubInstallations, projects } from "../db/schema.js";

// Per-user ACL helpers. Routes use these to gate every read or write
// that touches a project (or its installation). On miss they return
// undefined and the caller answers 404 — never 403 — so a curious
// client cannot probe whether an id exists in another user's account.

export type ProjectRow = typeof projects.$inferSelect;
export type InstallationRow = typeof githubInstallations.$inferSelect;

export async function loadOwnedProject(
  db: Db,
  projectId: string,
  userId: string,
): Promise<ProjectRow | undefined> {
  return db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.addedByUserId, userId)),
  });
}

/**
 * Load a project together with its GitHub installation in a single round-trip.
 * Project detail endpoints previously ran `loadOwnedProject()` and then a
 * separate `githubInstallations.findFirst()` serially (~2×61 ms on the remote
 * pooler). The FK `projects.installation_id` is NOT NULL with a cascade, so
 * every owned project has exactly one installation and an inner join is safe.
 * Returns undefined on an ownership miss so callers still answer 404, never 403.
 */
export async function loadOwnedProjectWithInstallation(
  db: Db,
  projectId: string,
  userId: string,
): Promise<{ project: ProjectRow; installation: InstallationRow } | undefined> {
  const rows = await db
    .select({ project: projects, installation: githubInstallations })
    .from(projects)
    .innerJoin(
      githubInstallations,
      eq(projects.installationId, githubInstallations.id),
    )
    .where(and(eq(projects.id, projectId), eq(projects.addedByUserId, userId)))
    .limit(1);
  return rows[0];
}

export async function loadOwnedInstallation(
  db: Db,
  installationId: string,
  userId: string,
): Promise<InstallationRow | undefined> {
  return db.query.githubInstallations.findFirst({
    where: and(
      eq(githubInstallations.id, installationId),
      eq(githubInstallations.addedByUserId, userId),
    ),
  });
}

export type AzureConnectionRow = typeof azureDevopsConnections.$inferSelect;

/**
 * Load an owned project together with whichever connection backs it.
 *
 * The platform-neutral counterpart to `loadOwnedProjectWithInstallation`, which
 * INNER JOINs `github_installations` and therefore cannot see an Azure DevOps
 * project (whose `installation_id` is NULL). Using the GitHub-only helper on a
 * shared route makes Azure projects 404 — the "Project not found." symptom
 * recorded in .claude/lessons.md, arrived at from a different direction.
 *
 * Both joins are LEFT joins, so exactly one side is populated per row, matching
 * the `projects_platform_connection_ck` CHECK constraint.
 */
export async function loadOwnedProjectWithConnection(
  db: Db,
  projectId: string,
  userId: string,
): Promise<
  | {
      project: ProjectRow;
      installation: InstallationRow | null;
      azureConnection: AzureConnectionRow | null;
    }
  | undefined
> {
  const rows = await db
    .select({
      project: projects,
      installation: githubInstallations,
      azureConnection: azureDevopsConnections,
    })
    .from(projects)
    .leftJoin(githubInstallations, eq(projects.installationId, githubInstallations.id))
    .leftJoin(
      azureDevopsConnections,
      eq(projects.azdoConnectionId, azureDevopsConnections.id),
    )
    .where(and(eq(projects.id, projectId), eq(projects.addedByUserId, userId)))
    .limit(1);
  return rows[0];
}
