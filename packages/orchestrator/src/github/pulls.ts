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

// Best-effort: idempotently link the implement PR to its source issue
// (via "Closes #<N>" in the PR body — the only programmatic path
// GitHub supports for the issue's Development panel) and copy the
// issue's `agent:<name>` label onto the PR so `pr-review-fix`'s
// label-based agent routing finds the same agent on the next
// iteration.
//
// Errors are caught and logged; the agent has already succeeded by
// the time this runs, and a flaky GitHub call here must not change
// the flow's outcome.
export async function linkPrToIssueAndCopyAgentLabel(
  args: LinkPrToIssueArgs,
): Promise<void> {
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
    console.error(
      `[github.pulls] list-prs failed for ${owner}/${repo}@${branchName}`,
      err,
    );
    return;
  }
  if (!pr) {
    console.warn(
      `[github.pulls] no open PR for ${owner}/${repo}@${branchName} — agent may not have opened one`,
    );
    return;
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
