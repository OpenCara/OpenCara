import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { githubInstallations, projects } from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import type { GithubAppClient } from "../../github/app.js";
import { syncInstallationRepos, upsertInstallation } from "../../github/installations.js";
import { backfillIssues } from "../../github/issues.js";
import { ulid } from "ulid";
import { ensureBuiltinFlowsForProject } from "../../flows/builtin.js";

interface InstallationRoutesDeps {
  db: Db;
  app?: GithubAppClient;
}

export function installationRoutes(deps: InstallationRoutesDeps) {
  const r = new Hono<AuthEnv>();
  r.use("*", requireUser());

  r.get("/", async (c) => {
    const rows = await deps.db.select().from(githubInstallations);
    return c.json({ installations: rows });
  });

  r.get("/:id/available-repos", async (c) => {
    if (!deps.app) return c.json({ error: "github app not configured" }, 503);
    const id = c.req.param("id");
    const inst = await deps.db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.id, id),
    });
    if (!inst) return c.json({ error: "installation not found" }, 404);

    const repos = await syncInstallationRepos(deps.app, inst.githubInstallationId);
    const managed = await deps.db
      .select({ githubRepoId: projects.githubRepoId, removedAt: projects.removedAt })
      .from(projects)
      .where(eq(projects.installationId, id));
    const managedActive = new Set(
      managed.filter((m) => !m.removedAt).map((m) => m.githubRepoId),
    );
    const available = repos.filter((repo) => !managedActive.has(repo.id));
    return c.json({ available });
  });

  r.post("/:id/projects", async (c) => {
    if (!deps.app) return c.json({ error: "github app not configured" }, 503);
    const id = c.req.param("id");
    const user = c.get("user")!;
    const body = (await c.req.json()) as { githubRepoId?: number };
    const repoId = body.githubRepoId;
    if (!repoId) return c.json({ error: "githubRepoId required" }, 400);

    const inst = await deps.db.query.githubInstallations.findFirst({
      where: eq(githubInstallations.id, id),
    });
    if (!inst) return c.json({ error: "installation not found" }, 404);

    const repos = await syncInstallationRepos(deps.app, inst.githubInstallationId);
    const repo = repos.find((r) => r.id === repoId);
    if (!repo) return c.json({ error: "repo not in this installation" }, 404);

    const existing = await deps.db.query.projects.findFirst({
      where: eq(projects.githubRepoId, repoId),
    });
    if (existing) {
      if (existing.removedAt) {
        await deps.db
          .update(projects)
          .set({ removedAt: null })
          .where(eq(projects.id, existing.id));
      }
      return c.json({ project: { ...existing, removedAt: null } }, 200);
    }
    const newId = ulid();
    await deps.db.insert(projects).values({
      id: newId,
      installationId: id,
      githubRepoId: repo.id,
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      private: repo.private,
      addedByUserId: user.id,
    });
    await ensureBuiltinFlowsForProject(deps.db, newId);
    // Fire-and-forget. Backfilling 100s of issues over GitHub's REST API can
    // take many seconds; we don't want to block the user's "add project"
    // request on it. Webhooks will keep state fresh from now on; this just
    // catches up the existing issues.
    void backfillIssues(deps.app!, {
      id: newId,
      owner: repo.owner,
      name: repo.name,
      installationId: id,
    }, deps.db).catch((err) => {
      console.error("[installations] issue backfill failed", {
        projectId: newId,
        owner: repo.owner,
        name: repo.name,
        err,
      });
    });
    return c.json(
      { project: { id: newId, owner: repo.owner, name: repo.name, githubRepoId: repo.id } },
      201,
    );
  });

  void upsertInstallation;
  return r;
}
