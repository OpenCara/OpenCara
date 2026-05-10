import { ulid } from "ulid";
import { and, eq, inArray, sql } from "drizzle-orm";
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

  // Atomic draft preservation: write bodyMd from the webhook only when the
  // row HAS NO draft at the moment Postgres applies the UPDATE. The earlier
  // implementation read draftBodyMd in a separate SELECT and decided in
  // application code, leaving a small race where an agent could set a draft
  // between our read and our write. The CASE expression collapses
  // read+decide+write into one statement so the draft can't slip past us.
  //
  // Other fields (title/labels/state/etc.) still update unconditionally —
  // those changes always come from GitHub and aren't part of the draft
  // overlay.
  await db
    .insert(issues)
    .values({ id: ulid(), ...row })
    .onConflictDoUpdate({
      target: [issues.projectId, issues.number],
      set: {
        githubIssueId: row.githubIssueId,
        githubNodeId: row.githubNodeId,
        title: row.title,
        bodyMd: sql`CASE WHEN ${issues.draftBodyMd} IS NULL THEN ${row.bodyMd} ELSE ${issues.bodyMd} END`,
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

// Push the in-app body draft back to GitHub via PATCH and re-upsert the
// local row from the response. Returns the refreshed issue row. The
// follow-up `issues.edited` webhook GitHub fires on its way back will hit
// upsertIssueFromWebhook and idempotently update the same row again — by
// design, no special suppression needed.
export async function pushIssueBodyToGithub(
  app: GithubAppClient,
  project: { id: string; owner: string; name: string; installationId: string },
  issueNumber: number,
  bodyMd: string,
  db: Db,
): Promise<typeof issues.$inferSelect> {
  const inst = await db.query.githubInstallations.findFirst({
    where: (gi, { eq }) => eq(gi.id, project.installationId),
  });
  if (!inst) throw new Error(`installation row ${project.installationId} not found`);
  const octokit = await app.forInstallation(inst.githubInstallationId);

  const res = await octokit.request(
    "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
    {
      owner: project.owner,
      repo: project.name,
      issue_number: issueNumber,
      body: bodyMd,
    },
  );
  // Clear the draft BEFORE re-upserting from GitHub's response — otherwise
  // upsertIssueFromWebhook's draft-protection clause would skip writing
  // bodyMd, leaving us with the OLD GitHub-mirrored body even though we
  // just published the new one. With draftBodyMd cleared, the upsert
  // correctly mirrors res.data.body into bodyMd.
  await db
    .update(issues)
    .set({ draftBodyMd: null, draftUpdatedAt: null })
    .where(and(eq(issues.projectId, project.id), eq(issues.number, issueNumber)));

  // The PATCH response shape matches the webhook `payload.issue` shape, so
  // the existing normalizer applies cleanly. Action "edited" keeps removedAt
  // null (the issue is alive).
  await upsertIssueFromWebhook(db, project.id, "edited", res.data as IssuePayload);

  const refreshed = await db.query.issues.findFirst({
    where: (i, { eq, and }) =>
      and(eq(i.projectId, project.id), eq(i.number, issueNumber)),
  });
  if (!refreshed) {
    throw new Error(
      `issue ${project.owner}/${project.name}#${issueNumber} disappeared after PATCH+upsert`,
    );
  }
  return refreshed;
}

/**
 * Set or clear the implementation-agent label on an issue.
 *
 * Convention (mirrors the existing `issue-implement` flow's routing): an
 * issue can have at most one `agent:<name>` label at a time. The label is
 * auto-created on the repo if missing, with a single distinctive color so
 * all `agent:*` labels cluster visually.
 *
 * Implementation note: we use targeted DELETE + POST against GitHub
 * directly, not the wholesale PUT label-set replace. The PUT path looked
 * cleaner but it requires either a fresh GitHub-side read (extra round
 * trip + race window) or trusting the local mirror — and the local mirror
 * lags webhooks, so a PUT built from it can silently delete unrelated
 * labels added by other integrations or users in between webhook events.
 * DELETE per existing `agent:*` then POST the new one keeps unrelated
 * labels untouched and avoids the mirror-staleness footgun entirely.
 *
 * Returns the refreshed issue row from our DB.
 */
export const AGENT_LABEL_COLOR = "5856d6";
export const AGENT_LABEL_PREFIX = "agent:";

export async function setIssueAgentLabel(
  app: GithubAppClient,
  project: { id: string; owner: string; name: string; installationId: string },
  issueNumber: number,
  agentName: string | null,
  db: Db,
): Promise<typeof issues.$inferSelect> {
  const inst = await db.query.githubInstallations.findFirst({
    where: (gi, { eq }) => eq(gi.id, project.installationId),
  });
  if (!inst) throw new Error(`installation row ${project.installationId} not found`);
  const octokit = await app.forInstallation(inst.githubInstallationId);

  const issueRow = await db.query.issues.findFirst({
    where: (i, { eq, and, isNull }) =>
      and(
        eq(i.projectId, project.id),
        eq(i.number, issueNumber),
        isNull(i.removedAt),
      ),
  });
  if (!issueRow) throw new Error(`issue ${issueNumber} not found in ${project.id}`);

  const targetLabel = agentName ? `${AGENT_LABEL_PREFIX}${agentName}` : null;

  // Read the *current* labels from GitHub. Local mirror lags; using it for
  // the deletion list could leave a freshly-added (but unmirrored)
  // `agent:other` label in place. One extra round-trip — worth it.
  const listRes = await octokit.request(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/labels",
    {
      owner: project.owner,
      repo: project.name,
      issue_number: issueNumber,
      per_page: 100,
    },
  );
  const liveLabels = (listRes.data as Array<{ name?: string }>)
    .map((l) => l.name ?? "")
    .filter(Boolean);
  const existingAgentLabels = liveLabels.filter((n) =>
    n.startsWith(AGENT_LABEL_PREFIX),
  );

  // Drop every existing `agent:*` label except (if applicable) the one we
  // are about to set — DELETE is idempotent enough but skipping a no-op is
  // free and clearer in the log.
  for (const name of existingAgentLabels) {
    if (targetLabel && name === targetLabel) continue;
    await octokit
      .request(
        "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
        {
          owner: project.owner,
          repo: project.name,
          issue_number: issueNumber,
          name,
        },
      )
      .catch((err: unknown) => {
        // 404 here means another writer already removed it — fine.
        if ((err as { status?: number }).status !== 404) throw err;
      });
  }

  if (targetLabel) {
    // Auto-create on the repo if missing. 422 from POST means another
    // concurrent writer just created it (TOCTOU window between the GET
    // 404 and our POST) — treat as success.
    let labelExists = true;
    try {
      await octokit.request("GET /repos/{owner}/{repo}/labels/{name}", {
        owner: project.owner,
        repo: project.name,
        name: targetLabel,
      });
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        labelExists = false;
      } else {
        throw err;
      }
    }
    if (!labelExists) {
      try {
        await octokit.request("POST /repos/{owner}/{repo}/labels", {
          owner: project.owner,
          repo: project.name,
          name: targetLabel,
          color: AGENT_LABEL_COLOR,
          description: `Implementation agent: ${agentName}`,
        });
      } catch (err) {
        // 422 = "already_exists" — fine, race resolved by the other writer.
        if ((err as { status?: number }).status !== 422) throw err;
      }
    }

    // Skip the add if the issue already had this exact label (we kept it
    // above and didn't delete it). Otherwise add. Also tolerant of the race
    // where the label was just added by something else.
    if (!existingAgentLabels.includes(targetLabel)) {
      await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
        {
          owner: project.owner,
          repo: project.name,
          issue_number: issueNumber,
          labels: [targetLabel],
        },
      );
    }
  }

  // Re-read GitHub's current labels after our writes so the mirror reflects
  // ground truth (rather than computing it client-side and risking drift).
  const finalRes = await octokit.request(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/labels",
    {
      owner: project.owner,
      repo: project.name,
      issue_number: issueNumber,
      per_page: 100,
    },
  );
  const fresh = (finalRes.data as Array<{ name?: string; color?: string }>)
    .map((l) => ({ name: l.name ?? "", color: l.color ?? "" }))
    .filter((l) => l.name);
  await db
    .update(issues)
    .set({ labels: fresh, updatedAt: new Date() })
    .where(and(eq(issues.projectId, project.id), eq(issues.number, issueNumber)));

  const refreshed = await db.query.issues.findFirst({
    where: (i, { eq, and, isNull }) =>
      and(
        eq(i.projectId, project.id),
        eq(i.number, issueNumber),
        // Guard against a deletion racing the label update — webhooks can
        // soft-delete this issue while we're mid-flight on GitHub's side.
        isNull(i.removedAt),
      ),
  });
  if (!refreshed) {
    throw new Error(
      `issue ${project.owner}/${project.name}#${issueNumber} disappeared after label updates`,
    );
  }
  return refreshed;
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
