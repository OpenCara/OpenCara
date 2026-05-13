import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { githubInstallations, projects } from "../db/schema.js";

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
