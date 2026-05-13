import { ulid } from "ulid";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { githubInstallations, projects } from "../db/schema.js";
import type { GithubAppClient } from "./app.js";

export interface InstallationLike {
  id: number;
  account?: { id: number; login: string; type?: string } | null | undefined;
  target_type?: string;
  repository_selection?: string;
  permissions?: Record<string, string>;
  events?: string[];
  suspended_at?: string | null;
}

export interface UpsertInstallationOptions {
  // Set when an authenticated user round-trips through /auth/github/setup
  // after installing the app. We persist it on INSERT only — webhook-driven
  // updates carry no user context and must not clobber an existing
  // attribution. A NULL row is claimed later by the first project-add.
  addedByUserId?: string | null;
}

export async function upsertInstallation(
  db: Db,
  payload: InstallationLike,
  options: UpsertInstallationOptions = {},
): Promise<{ id: string; githubInstallationId: number }> {
  const accountType = (payload.account?.type ?? payload.target_type ?? "Organization") as
    | "User"
    | "Organization";
  const accountLogin = payload.account?.login ?? "unknown";
  const accountId = payload.account?.id ?? 0;
  const existing = await db.query.githubInstallations.findFirst({
    where: eq(githubInstallations.githubInstallationId, payload.id),
  });
  if (existing) {
    await db
      .update(githubInstallations)
      .set({
        accountType,
        accountLogin,
        accountId,
        targetType: payload.target_type ?? accountType,
        repositorySelection: payload.repository_selection ?? "selected",
        permissions: payload.permissions ?? {},
        events: payload.events ?? [],
        suspendedAt: payload.suspended_at ? new Date(payload.suspended_at) : null,
        // Claim an unattributed row when we have a user; never overwrite
        // a row that's already attributed (different user round-tripping
        // through /auth/github/setup must not steal it).
        ...(options.addedByUserId && existing.addedByUserId == null
          ? { addedByUserId: options.addedByUserId }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(githubInstallations.id, existing.id));
    return { id: existing.id, githubInstallationId: payload.id };
  }
  const id = ulid();
  await db.insert(githubInstallations).values({
    id,
    githubInstallationId: payload.id,
    accountType,
    accountLogin,
    accountId,
    targetType: payload.target_type ?? accountType,
    repositorySelection: payload.repository_selection ?? "selected",
    permissions: payload.permissions ?? {},
    events: payload.events ?? [],
    suspendedAt: payload.suspended_at ? new Date(payload.suspended_at) : null,
    addedByUserId: options.addedByUserId ?? null,
  });
  return { id, githubInstallationId: payload.id };
}

export async function softRemoveProjectsForRepos(
  db: Db,
  installationRowId: string,
  githubRepoIds: number[],
): Promise<void> {
  if (githubRepoIds.length === 0) return;
  for (const repoId of githubRepoIds) {
    await db
      .update(projects)
      .set({ removedAt: new Date() })
      .where(eq(projects.githubRepoId, repoId));
  }
  void installationRowId;
}

export interface AvailableRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export async function syncInstallationRepos(
  app: GithubAppClient,
  githubInstallationId: number,
): Promise<AvailableRepo[]> {
  const octokit = await app.forInstallation(githubInstallationId);
  const repos: AvailableRepo[] = [];
  let page = 1;
  while (true) {
    const res = await octokit.request("GET /installation/repositories", {
      per_page: 100,
      page,
    });
    for (const r of res.data.repositories) {
      repos.push({
        id: r.id,
        owner: r.owner.login,
        name: r.name,
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch,
      });
    }
    if (res.data.repositories.length < 100) break;
    page += 1;
  }
  return repos;
}
