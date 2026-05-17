import type { Octokit } from "@octokit/rest";
import { AGENT_LABEL_COLOR, AGENT_LABEL_PREFIX } from "./issues.js";

// GitHub recognizes any of close/closes/closed/fix/fixes/fixed/
// resolve/resolves/resolved as PR-body closing keywords. Anchor on
// `#<N>\b` so `#12` doesn't match against `#123`.
function hasClosingKeyword(body: string, issueNumber: number): boolean {
  const re = new RegExp(
    String.raw`(?:close[ds]?|fixe?[ds]?|resolve[ds]?)\s+#${issueNumber}\b`,
    "i",
  );
  return re.test(body);
}

interface IssueLabel {
  name?: string;
}

export interface LinkPrToIssueArgs {
  octokit: Octokit;
  owner: string;
  repo: string;
  branchName: string;
  issueNumber: number;
  issueLabels: ReadonlyArray<IssueLabel>;
}

/** Outcome of `linkPrToIssueAndCopyAgentLabel`:
 *  - `linked`: a PR existed and the body / label work ran (idempotently).
 *  - `no-pr`: the PR list call succeeded but no open PR exists on the
 *    branch. The implement agent likely skipped `gh pr create`; caller
 *    should fail the flow run loudly.
 *  - `transient-failure`: the list call itself failed (network / 5xx).
 *    Caller should keep the flow's outcome as-is — this isn't evidence
 *    of agent misbehavior. */
export type LinkPrToIssueResult =
  | { kind: "linked"; prNumber: number }
  | { kind: "no-pr" }
  | { kind: "transient-failure"; reason: string };

export type AutoMergeMethod = "squash" | "merge" | "rebase";

export interface AutoMergePullRequestArgs {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  method: AutoMergeMethod;
  requireChecks: boolean;
  requireApproval: boolean;
  priorHeadSha?: string | null;
  maxMergeableAttempts?: number;
  mergeableDelayMs?: number;
}

export type AutoMergePullRequestResult =
  | { kind: "merged"; sha: string | null; message: string }
  | { kind: "skipped"; reason: string };

interface AutoMergePr {
  number: number;
  mergeable: boolean | null;
  mergeable_state?: string | null;
  head: { sha: string };
}

// Idempotently link the implement PR to its source issue (via
// "Closes #<N>" in the PR body — the only programmatic path GitHub
// supports for the issue's Development panel) and copy the issue's
// `agent:<name>` label onto the PR so `pr-review-fix`'s label-based
// agent routing finds the same agent on the next iteration.
//
// Returns the outcome so the caller can decide whether a missing PR
// should fail the flow (it should) versus a flaky GitHub call (it
// shouldn't). Body / label POST failures inside an otherwise-linked
// run are still logged and swallowed — those don't change agent
// behavior.
export async function linkPrToIssueAndCopyAgentLabel(
  args: LinkPrToIssueArgs,
): Promise<LinkPrToIssueResult> {
  const { octokit, owner, repo, branchName, issueNumber, issueLabels } = args;

  let pr: { number: number; body: string | null } | null = null;
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner,
      repo,
      head: `${owner}:${branchName}`,
      state: "open",
      per_page: 1,
    });
    const list = res.data as Array<{ number: number; body?: string | null }>;
    if (list.length > 0 && typeof list[0]!.number === "number") {
      pr = { number: list[0]!.number, body: list[0]!.body ?? null };
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[github.pulls] list-prs failed for ${owner}/${repo}@${branchName}`,
      err,
    );
    return { kind: "transient-failure", reason };
  }
  if (!pr) {
    console.warn(
      `[github.pulls] no open PR for ${owner}/${repo}@${branchName} — agent may not have opened one`,
    );
    return { kind: "no-pr" };
  }

  const body = pr.body ?? "";
  if (!hasClosingKeyword(body, issueNumber)) {
    const newBody = body.length > 0 ? `${body}\n\nCloses #${issueNumber}` : `Closes #${issueNumber}`;
    try {
      await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: pr.number,
        body: newBody,
      });
    } catch (err) {
      console.error(
        `[github.pulls] patch PR body failed for ${owner}/${repo}#${pr.number}`,
        err,
      );
    }
  }

  const agentLabel = pickAgentLabel(issueLabels);
  if (agentLabel) {
    await ensureRepoLabelExists(octokit, owner, repo, agentLabel);
    try {
      await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
        {
          owner,
          repo,
          // PR labels use the issues endpoint — `pull_number` shares
          // the same numeric namespace as `issue_number` on GitHub.
          issue_number: pr.number,
          labels: [agentLabel],
        },
      );
    } catch (err) {
      // 422 from this endpoint normally means the label already
      // exists on the PR — idempotent no-op, fine to swallow.
      if ((err as { status?: number }).status !== 422) {
        console.error(
          `[github.pulls] add-label failed for ${owner}/${repo}#${pr.number} (${agentLabel})`,
          err,
        );
      }
    }
  }
  return { kind: "linked", prNumber: pr.number };
}

export async function autoMergePullRequest(
  args: AutoMergePullRequestArgs,
): Promise<AutoMergePullRequestResult> {
  const {
    octokit,
    owner,
    repo,
    pullNumber,
    method,
    requireChecks,
    requireApproval,
    priorHeadSha,
  } = args;
  const maxAttempts = Math.max(1, args.maxMergeableAttempts ?? 5);
  const delayMs = Math.max(0, args.mergeableDelayMs ?? 2000);

  let pr: AutoMergePr | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: pullNumber,
    });
    pr = res.data as AutoMergePr;
    if (pr?.mergeable !== null) break;
    if (attempt < maxAttempts) await sleep(delayMs);
  }
  if (!pr) return { kind: "skipped", reason: `pull request #${pullNumber} not found` };
  if (pr.mergeable === null) {
    return {
      kind: "skipped",
      reason: `GitHub is still computing mergeability for PR #${pullNumber} after ${maxAttempts} attempts`,
    };
  }
  if (pr.mergeable === false) {
    return {
      kind: "skipped",
      reason: `PR #${pullNumber} is not mergeable (${pr.mergeable_state ?? "unknown"})`,
    };
  }
  if (priorHeadSha && pr.head.sha === priorHeadSha) {
    return {
      kind: "skipped",
      reason: "fix agent did not push a new HEAD commit; skipping auto-merge",
    };
  }

  if (requireChecks) {
    const checks = await getRequiredCheckState({
      octokit,
      owner,
      repo,
      ref: pr.head.sha,
    });
    if (checks.kind === "blocked") {
      return { kind: "skipped", reason: checks.reason };
    }
  }

  const reviewState = await getReviewGateState({
    octokit,
    owner,
    repo,
    pullNumber,
  });
  if (reviewState.changesRequested) {
    return {
      kind: "skipped",
      reason: "PR has outstanding changes_requested reviews",
    };
  }
  if (requireApproval && !reviewState.approved) {
    return {
      kind: "skipped",
      reason: "PR has no current approving review",
    };
  }

  try {
    const res = await octokit.request(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
      {
        owner,
        repo,
        pull_number: pullNumber,
        merge_method: method,
        sha: pr.head.sha,
      },
    );
    const data = res.data as { sha?: string | null; message?: string };
    return {
      kind: "merged",
      sha: data.sha ?? null,
      message: data.message ?? "Pull Request successfully merged",
    };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 405 || status === 409) {
      return { kind: "skipped", reason: errorMessage(err) };
    }
    throw err;
  }
}

async function getRequiredCheckState(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
}): Promise<{ kind: "passing" } | { kind: "blocked"; reason: string }> {
  const { octokit, owner, repo, ref } = args;
  const res = await octokit.request(
    "GET /repos/{owner}/{repo}/commits/{ref}/status",
    { owner, repo, ref },
  );
  const status = res.data as {
    state?: string;
    statuses?: Array<{ context?: string; state?: string }>;
  };
  if (status.state === "failure" || status.state === "error") {
    return {
      kind: "blocked",
      reason: "required checks are failing",
    };
  }
  if (status.state === "pending") {
    return {
      kind: "blocked",
      reason: "required checks are pending",
    };
  }
  return { kind: "passing" };
}

async function getReviewGateState(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
}): Promise<{ approved: boolean; changesRequested: boolean }> {
  const { octokit, owner, repo, pullNumber } = args;
  const res = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
    { owner, repo, pull_number: pullNumber, per_page: 100 },
  );
  const latestByUser = new Map<string, string>();
  for (const review of res.data as Array<{
    state?: string;
    user?: { login?: string };
  }>) {
    const login = review.user?.login;
    if (!login || !review.state) continue;
    latestByUser.set(login, review.state.toUpperCase());
  }
  let approved = false;
  let changesRequested = false;
  for (const state of latestByUser.values()) {
    if (state === "APPROVED") approved = true;
    if (state === "CHANGES_REQUESTED") changesRequested = true;
  }
  return { approved, changesRequested };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickAgentLabel(labels: ReadonlyArray<IssueLabel>): string | null {
  for (const l of labels) {
    if (typeof l.name === "string" && l.name.startsWith(AGENT_LABEL_PREFIX)) {
      return l.name;
    }
  }
  return null;
}

// Mirror the auto-create pattern from `setIssueAgentLabel` in
// issues.ts: GET /labels/{name}; on 404 POST /labels with the agent
// color. 422 from the create call means a concurrent writer raced
// us — treat as success.
async function ensureRepoLabelExists(
  octokit: Octokit,
  owner: string,
  repo: string,
  name: string,
): Promise<void> {
  try {
    await octokit.request("GET /repos/{owner}/{repo}/labels/{name}", {
      owner,
      repo,
      name,
    });
    return;
  } catch (err) {
    if ((err as { status?: number }).status !== 404) {
      console.error(
        `[github.pulls] check-label failed for ${owner}/${repo} (${name})`,
        err,
      );
      return;
    }
  }
  try {
    const agentName = name.slice(AGENT_LABEL_PREFIX.length);
    await octokit.request("POST /repos/{owner}/{repo}/labels", {
      owner,
      repo,
      name,
      color: AGENT_LABEL_COLOR,
      description: `Implementation agent: ${agentName}`,
    });
  } catch (err) {
    if ((err as { status?: number }).status !== 422) {
      console.error(
        `[github.pulls] create-label failed for ${owner}/${repo} (${name})`,
        err,
      );
    }
  }
}
