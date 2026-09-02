interface PullRequestPayload {
  action?: string;
  pull_request?: { number?: number; title?: string; user?: { login?: string } };
  sender?: { login?: string };
}
interface IssuesPayload {
  action?: string;
  issue?: { number?: number; title?: string; user?: { login?: string } };
  label?: { name?: string };
  sender?: { login?: string };
}
interface PushPayload {
  ref?: string;
  commits?: unknown[];
  pusher?: { name?: string };
}
interface InstallationPayload {
  action?: string;
  installation?: { account?: { login?: string } };
}

/**
 * Azure DevOps deliveries are stored as the raw service-hook envelope
 * (`{ eventType, resource }`), not the GitHub-like shape the engine
 * normalises them into at dispatch time.
 */
interface AzureEnvelope {
  eventType?: string;
  resource?: {
    pullRequestId?: number;
    status?: string;
    createdBy?: { displayName?: string };
    author?: { displayName?: string };
    _links?: { self?: { href?: string } };
    id?: number;
    workItemId?: number;
    revisedBy?: { displayName?: string };
  };
}

function summarizeAzure(type: string, p: AzureEnvelope): string {
  const et = p.eventType ?? "";
  const r = p.resource ?? {};
  if (et.startsWith("git.pullrequest.")) {
    const action =
      et === "git.pullrequest.created"
        ? "opened"
        : r.status === "completed" || r.status === "abandoned"
          ? r.status
          : "updated";
    return `PR #${r.pullRequestId ?? "?"} ${action} by ${r.createdBy?.displayName ?? "?"}`;
  }
  if (et === "ms.vss-code.git-pullrequest-comment-event") {
    const num = /\/pullRequests\/(\d+)\b/.exec(r._links?.self?.href ?? "")?.[1] ?? "?";
    return `PR #${num} comment by ${r.author?.displayName ?? "?"}`;
  }
  if (et.startsWith("workitem.")) {
    const id = r.workItemId ?? r.id ?? "?";
    const action = et === "workitem.created" ? "created" : "updated";
    return `WI #${id} ${action} by ${r.revisedBy?.displayName ?? "?"}`;
  }
  return type;
}

interface IssueCommentPayload {
  action?: string;
  issue?: { number?: number; pull_request?: unknown };
  sender?: { login?: string };
}

export function summarizeEvent(type: string, payload: unknown): string {
  if (!payload || typeof payload !== "object") return type;
  if ("eventType" in payload && "resource" in payload) {
    return summarizeAzure(type, payload as AzureEnvelope);
  }
  switch (type) {
    case "pull_request": {
      const p = payload as PullRequestPayload;
      const num = p.pull_request?.number;
      const action = p.action ?? "?";
      const who = p.sender?.login ?? p.pull_request?.user?.login ?? "?";
      return `PR #${num} ${action} by @${who}`;
    }
    case "issues": {
      const p = payload as IssuesPayload;
      const num = p.issue?.number;
      const action = p.action ?? "?";
      const label = p.label?.name ? ` (${p.label.name})` : "";
      const who = p.sender?.login ?? p.issue?.user?.login ?? "?";
      return `Issue #${num} ${action}${label} by @${who}`;
    }
    case "issue_comment": {
      const p = payload as IssueCommentPayload;
      const kind = p.issue?.pull_request ? "PR" : "Issue";
      return `${kind} #${p.issue?.number} comment ${p.action ?? "created"} by @${p.sender?.login ?? "?"}`;
    }
    case "push": {
      const p = payload as PushPayload;
      const branch = p.ref?.replace("refs/heads/", "") ?? "?";
      const count = p.commits?.length ?? 0;
      const who = p.pusher?.name ?? "?";
      return `${count} commit${count === 1 ? "" : "s"} pushed to ${branch} by ${who}`;
    }
    case "installation":
    case "installation_repositories": {
      const p = payload as InstallationPayload;
      return `${p.action ?? "?"} on @${p.installation?.account?.login ?? "?"}`;
    }
    default:
      return type;
  }
}
