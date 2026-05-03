import { ulid } from "ulid";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { issues } from "../db/schema.js";
import type { GithubAppClient } from "./app.js";

// Subset of GitHub's REST/webhook issue payload that we persist. Both
// webhook `payload.issue` and REST `GET /repos/.../issues[]` items match
// this shape (the REST endpoint also returns PRs — callers must filter by
// `pull_request === undefined` before calling these helpers).
export interface IssuePayload {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  state_reason?: string | null;
  labels?: Array<{ name?: string; color?: string }>;
  assignees?: Array<{ login?: string; id?: number }>;
  user?: { login?: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  pull_request?: unknown;
}

function normalizeLabels(input: IssuePayload["labels"]): { name: string; color: string }[] {
  return (input ?? [])
    .map((l) => ({ name: l.name ?? "", color: l.color ?? "" }))
    .filter((l) => l.name);
}

function normalizeAssignees(
  input: IssuePayload["assignees"],
): { login: string; id: number }[] {
  return (input ?? [])
    .filter((a): a is { login: string; id: number } =>
      typeof a.login === "string" && typeof a.id === "number",
    )
    .map((a) => ({ login: a.login, id: a.id }));
}

function rowFromPayload(projectId: string, p: IssuePayload, removed: boolean) {
  return {
    projectId,
    githubIssueId: p.id,
    githubNodeId: p.node_id,
    number: p.number,
    title: p.title,
    bodyMd: p.body ?? null,
    state: p.state,
    stateReason: p.state_reason ?? null,
    labels: normalizeLabels(p.labels),
    assignees: normalizeAssignees(p.assignees),
    authorLogin: p.user?.login ?? null,
    htmlUrl: p.html_url,
    createdAt: new Date(p.created_at),
    updatedAt: new Date(p.updated_at),
    closedAt: p.closed_at ? new Date(p.closed_at) : null,
    removedAt: removed ? new Date() : null,
  };
}

// Upsert a single issue from a webhook event. `action` controls whether the
// row is hard-state (deleted/transferred → removedAt set) or live.
export async function upsertIssueFromWebhook(
  db: Db,
  projectId: string,
  action: string,
  payload: IssuePayload,
): Promise<void> {
  // Skip PRs that masquerade as issues on some endpoints; webhook `issues`
  // events never carry pull_request, but defensive guard is cheap.
  if (payload.pull_request) return;

  const removed = action === "deleted" || action === "transferred";
  const row = rowFromPayload(projectId, payload, removed);

  await db
    .insert(issues)
    .values({ id: ulid(), ...row })
    .onConflictDoUpdate({
      target: [issues.projectId, issues.number],
      set: {
        githubIssueId: row.githubIssueId,
        githubNodeId: row.githubNodeId,
        title: row.title,
        bodyMd: row.bodyMd,
        state: row.state,
        stateReason: row.stateReason,
        labels: row.labels,
        assignees: row.assignees,
        authorLogin: row.authorLogin,
        htmlUrl: row.htmlUrl,
        updatedAt: row.updatedAt,
        closedAt: row.closedAt,
        removedAt: row.removedAt,
      },
    });
}

// One-shot REST backfill of every issue in a repo. Called from project add.
// GitHub's REST `/issues` endpoint also returns PRs — filtered out here. Runs
// to completion (no early-exit) so a large backlog still lands; caller is
// expected to fire-and-forget and log errors.
export async function backfillIssues(
  app: GithubAppClient,
  project: { id: string; owner: string; name: string; installationId: string },
  db: Db,
): Promise<{ inserted: number; updated: number; skipped: number }> {
  const inst = await db.query.githubInstallations.findFirst({
    where: (gi, { eq }) => eq(gi.id, project.installationId),
  });
  if (!inst) throw new Error(`installation row ${project.installationId} not found`);
  const octokit = await app.forInstallation(inst.githubInstallationId);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const iterator = octokit.paginate.iterator(
    "GET /repos/{owner}/{repo}/issues",
    {
      owner: project.owner,
      repo: project.name,
      state: "all",
      per_page: 100,
    },
  );

  for await (const { data } of iterator) {
    const incoming: IssuePayload[] = [];
    for (const item of data) {
      // Filter out PRs — REST endpoint returns both, only `pull_request`
      // marker distinguishes them.
      if ((item as { pull_request?: unknown }).pull_request) {
        skipped += 1;
        continue;
      }
      incoming.push(item as IssuePayload);
    }
    if (incoming.length === 0) continue;

    // Pre-compute existing rows just to keep the inserted/updated counts
    // honest for the response — the actual write below is an upsert so a
    // concurrent webhook landing between this read and the upsert can no
    // longer crash the backfill on a unique-constraint violation. Counts
    // remain approximate under that race, which is fine for diagnostics.
    const numbers = incoming.map((i) => i.number);
    const existing = await db
      .select({ number: issues.number })
      .from(issues)
      .where(and(eq(issues.projectId, project.id), inArray(issues.number, numbers)));
    const existingNumbers = new Set(existing.map((e) => e.number));

    for (const p of incoming) {
      const row = rowFromPayload(project.id, p, false);
      await db
        .insert(issues)
        .values({ id: ulid(), ...row })
        .onConflictDoUpdate({
          target: [issues.projectId, issues.number],
          set: {
            githubIssueId: row.githubIssueId,
            githubNodeId: row.githubNodeId,
            title: row.title,
            bodyMd: row.bodyMd,
            state: row.state,
            stateReason: row.stateReason,
            labels: row.labels,
            assignees: row.assignees,
            authorLogin: row.authorLogin,
            htmlUrl: row.htmlUrl,
            updatedAt: row.updatedAt,
            closedAt: row.closedAt,
            removedAt: row.removedAt,
          },
        });
      if (existingNumbers.has(p.number)) updated += 1;
      else inserted += 1;
    }
  }

  return { inserted, updated, skipped };
}
